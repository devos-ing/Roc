/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TextContent, ToolResultMessage } from "@earendil-works/pi-ai";

/** Only tool results larger than this participate. */
export const THRESHOLD_BYTES = 10 * 1024;
/** Provider requests that still carry the full payload before the placeholder takes over. */
export const FULL_SENDS = 2;
/** Placeholder excerpt budget, split evenly between head and tail, whole lines only. */
export const PLACEHOLDER_EXCERPT_BYTES = 1024;

const CHARS_PER_TOKEN = 4;
const OBSERVATION_ID_PATTERN = /^obs_[a-f0-9]{24}$/u;
const READ_OBJECT_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;
const CREATE_OBJECT_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
const INTEGRITY_BUFFER_BYTES = 64 * 1024;
const LEDGER_READ_BUFFER_BYTES = 64 * 1024;
const MAX_LEDGER_RECORD_BYTES = 64 * 1024;

/**
 * Receipts from the evidence-preserving reducer are already a reduction of a
 * long log. Packing them again would replace verified evidence with an excerpt.
 */
const EVIDENCE_REDUCER_RECEIPT_PREFIX = "sol_pi_evidence_receipt_v1";

export interface Observation {
	readonly id: string;
	readonly contentHash: string;
	readonly filePath: string;
	readonly toolName: string;
	readonly text: string;
	readonly bytes: number;
	readonly lines: number;
	readonly tokens: number;
}

export function hash(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

export function estimateTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function countLines(text: string): number {
	if (text.length === 0) return 0;
	let lines = text.endsWith("\n") ? 0 : 1;
	for (const character of text) {
		if (character === "\n") lines += 1;
	}
	return lines;
}

function countBufferLines(buffer: Buffer): number {
	if (buffer.length === 0) return 0;
	let lines = buffer[buffer.length - 1] === 0x0a ? 0 : 1;
	for (const byte of buffer) {
		if (byte === 0x0a) lines += 1;
	}
	return lines;
}

export function isPureTextResult(message: AgentMessage): message is ToolResultMessage {
	return (
		message.role === "toolResult" &&
		!message.isError &&
		message.content.length > 0 &&
		message.content.every((block) => block.type === "text")
	);
}

function textFromResult(message: ToolResultMessage): string {
	return (message.content as TextContent[]).map((block) => block.text).join("\n");
}

function containsReducerReceipt(text: string): boolean {
	return text.split("\n").some((line) => line === EVIDENCE_REDUCER_RECEIPT_PREFIX);
}

/**
 * Archived payloads live under SoL-Pi's session-derived runtime root.
 *
 * They are content addressed inside one session. A resume reuses the same
 * directory; a fork rebuilds its own object from the unmodified session history.
 */
export function observationPath(runtimeRoot: string, id: string): string {
	return join(runtimeRoot, "observation-pack", "objects", `${id}.txt`);
}

export function isObservationId(id: string): boolean {
	return OBSERVATION_ID_PATTERN.test(id);
}

export function createObservation(message: ToolResultMessage, runtimeRoot: string): Observation | undefined {
	const text = textFromResult(message);
	if (containsReducerReceipt(text)) return undefined;
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes <= THRESHOLD_BYTES) return undefined;
	if (!runtimeRoot) throw new Error("Persistent SoL-Pi runtime directory is unavailable");

	const contentHash = hash(text);
	const id = `obs_${hash(`${message.toolName}\0${message.toolCallId}\0${contentHash}`).slice(0, 24)}`;
	return {
		id,
		contentHash,
		filePath: observationPath(runtimeRoot, id),
		toolName: message.toolName,
		text,
		bytes,
		lines: countLines(text),
		tokens: estimateTokens(text),
	};
}

/**
 * Write the payload to its content-addressed path, refusing symlinks and
 * verifying an existing object byte for byte before reusing it.
 */
export async function ensureStored(observation: Observation): Promise<void> {
	const directoryPath = dirname(observation.filePath);
	await mkdir(directoryPath, { recursive: true, mode: 0o700 });
	const directoryStats = await lstat(directoryPath);
	if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
		throw new Error(`Observation directory is not a regular directory for ${observation.id}`);
	}

	let handle: FileHandle | undefined;
	try {
		handle = await open(observation.filePath, CREATE_OBJECT_FLAGS, 0o600);
		await handle.writeFile(observation.text, { encoding: "utf8" });
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
		const existingHandle = await open(observation.filePath, READ_OBJECT_FLAGS);
		try {
			const existing = await existingHandle.stat();
			if (!existing.isFile()) {
				throw new Error(`Content-addressed observation is not a regular file for ${observation.id}`);
			}
			if (existing.size !== observation.bytes) {
				throw new Error(`Content-addressed observation size mismatch for ${observation.id}`);
			}
			const existingContent = await existingHandle.readFile();
			if (hash(existingContent) !== observation.contentHash) {
				throw new Error(`Content-addressed observation hash mismatch for ${observation.id}`);
			}
		} finally {
			await existingHandle.close();
		}
	} finally {
		await handle?.close();
	}
}

/** Returns the session-local ledger that authoritatively binds observation ids to content hashes. */
function ledgerPath(observationPath: string): string {
	return join(dirname(dirname(observationPath)), "ledger.jsonl");
}

/** Extracts one requested observation hash from a validated ledger record. */
function recordLedgerHash(line: string, id: string, contentHash: string | undefined): string | undefined {
	let entry: unknown;
	try {
		entry = JSON.parse(line);
	} catch {
		throw new Error("Stored observation ledger record is malformed");
	}
	if (
		typeof entry !== "object" ||
		entry === null ||
		(entry as { event?: unknown }).event !== "full" ||
		(entry as { id?: unknown }).id !== id
	) {
		return contentHash;
	}
	const candidate = (entry as { contentHash?: unknown }).contentHash;
	if (typeof candidate !== "string" || !/^[a-f0-9]{64}$/u.test(candidate)) {
		throw new Error(`Stored observation ledger hash is malformed for ${id}`);
	}
	if (contentHash !== undefined && contentHash !== candidate) {
		throw new Error(`Stored observation ledger hash conflicts for ${id}`);
	}
	return candidate;
}

/** Reads the ledger digest for the requested observation id and rejects missing, malformed, or conflicting records. */
async function readLedgerContentHash(observationPath: string, id: string): Promise<string> {
	const path = ledgerPath(observationPath);
	let handle: FileHandle;
	try {
		handle = await open(path, READ_OBJECT_FLAGS);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			throw Object.assign(new Error("Stored observation ledger is missing"), { code: "ENOENT" });
		}
		throw error;
	}
	try {
		const stats = await handle.stat();
		if (!stats.isFile()) throw new Error("Stored observation ledger is not a regular file");
		const decoder = new StringDecoder("utf8");
		const buffer = Buffer.alloc(LEDGER_READ_BUFFER_BYTES);
		let position = 0;
		let pending = "";
		let contentHash: string | undefined;
		/** Consumes complete bounded JSONL records accumulated from one or more read chunks. */
		const consumeCompleteRecords = (): void => {
			let newline = pending.indexOf("\n");
			while (newline >= 0) {
				const line = pending.slice(0, newline);
				pending = pending.slice(newline + 1);
				if (Buffer.byteLength(line, "utf8") > MAX_LEDGER_RECORD_BYTES) {
					throw new Error("Stored observation ledger record exceeds limit");
				}
				if (line) contentHash = recordLedgerHash(line, id, contentHash);
				newline = pending.indexOf("\n");
			}
		};
		while (position < stats.size) {
			const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, stats.size - position), position);
			if (bytesRead === 0) throw new Error("Stored observation ledger changed while reading");
			position += bytesRead;
			pending += decoder.write(buffer.subarray(0, bytesRead));
			consumeCompleteRecords();
			if (Buffer.byteLength(pending, "utf8") > MAX_LEDGER_RECORD_BYTES) {
				throw new Error("Stored observation ledger record exceeds limit");
			}
		}
		pending += decoder.end();
		consumeCompleteRecords();
		if (Buffer.byteLength(pending, "utf8") > MAX_LEDGER_RECORD_BYTES) {
			throw new Error("Stored observation ledger record exceeds limit");
		}
		if (pending) contentHash = recordLedgerHash(pending, id, contentHash);
		if (contentHash === undefined) throw new Error(`Stored observation ledger hash is missing for ${id}`);
		return contentHash;
	} finally {
		await handle.close();
	}
}

/** Hashes every stored byte while retaining only the requested page, so returned bytes are integrity-verified. */
async function verifyAndReadObservationPage(
	handle: FileHandle,
	size: number,
	expectedHash: string,
	offset: number,
	pageBytes: number,
): Promise<Buffer> {
	const digest = createHash("sha256");
	const buffer = Buffer.alloc(INTEGRITY_BUFFER_BYTES);
	const page = Buffer.alloc(pageBytes);
	let position = 0;
	while (position < size) {
		const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - position), position);
		if (bytesRead === 0) throw new Error("Stored observation changed while verifying integrity");
		digest.update(buffer.subarray(0, bytesRead));
		const pageStart = Math.max(offset, position);
		const pageEnd = Math.min(offset + pageBytes, position + bytesRead);
		if (pageEnd > pageStart) {
			buffer.copy(page, pageStart - offset, pageStart - position, pageEnd - position);
		}
		position += bytesRead;
	}
	if (digest.digest("hex") !== expectedHash) throw new Error("Stored observation content hash mismatch");
	return page;
}

function completeLineExcerpt(text: string, budgetBytes: number, fromEnd: boolean): string {
	const lines = text.split(/(?<=\n)/);
	const selected: string[] = [];
	let selectedBytes = 0;
	let index = fromEnd ? lines.length - 1 : 0;

	while (index >= 0 && index < lines.length) {
		const line = lines[index];
		if (line === undefined) break;
		const lineBytes = Buffer.byteLength(line, "utf8");
		if (selectedBytes + lineBytes > budgetBytes) break;
		if (fromEnd) selected.unshift(line);
		else selected.push(line);
		selectedBytes += lineBytes;
		index += fromEnd ? -1 : 1;
	}

	return selected.join("");
}

export function placeholderFor(observation: Observation): string {
	const headBudget = Math.floor(PLACEHOLDER_EXCERPT_BYTES / 2);
	const tailBudget = PLACEHOLDER_EXCERPT_BYTES - headBudget;
	const head = completeLineExcerpt(observation.text, headBudget, false);
	const tail = completeLineExcerpt(observation.text, tailBudget, true);
	return [
		`[large tool result replaced after its first ${FULL_SENDS} provider requests]`,
		`id: ${observation.id}`,
		`tool: ${observation.toolName}`,
		`original_bytes: ${observation.bytes}`,
		`original_lines: ${observation.lines}`,
		`estimated_tokens: ${observation.tokens}`,
		`retrieve: call obs_recall with {"id":"${observation.id}","offset":0}; continue with returned next_offset`,
		`[first complete lines, up to ${headBudget} bytes]`,
		head,
		`[middle omitted; last complete lines, up to ${tailBudget} bytes]`,
		tail,
		`[${observation.bytes} original bytes omitted]`,
	].join("\n");
}

export interface RecallChunk {
	readonly text: string;
	readonly bytes: number;
	readonly lines: number;
	readonly nextOffset: number;
	readonly eof: boolean;
}

function trimUtf8End(buffer: Buffer, limit: number): number {
	let end = limit;
	while (end > 0 && end < buffer.length && ((buffer[end] ?? 0) & 0xc0) === 0x80) end -= 1;
	return end;
}

export async function readRecallChunk(
	path: string,
	id: string,
	offset: number,
	limits: { readonly maxBytes: number; readonly maxLines: number },
): Promise<RecallChunk> {
	const expectedHash = await readLedgerContentHash(path, id);
	const handle = await open(path, READ_OBJECT_FLAGS);
	try {
		const fileStats = await handle.stat();
		if (!fileStats.isFile()) throw new Error("Stored observation is not a regular file");
		if (offset > fileStats.size) throw new Error(`Offset ${offset} exceeds observation size ${fileStats.size}`);
		const available = Math.max(0, fileStats.size - offset);
		const buffer = await verifyAndReadObservationPage(
			handle,
			fileStats.size,
			expectedHash,
			offset,
			Math.min(available, limits.maxBytes + 4),
		);
		let end = Math.min(buffer.length, limits.maxBytes);
		let newlineCount = 0;

		for (let index = 0; index < end; index += 1) {
			if (buffer[index] !== 0x0a) continue;
			newlineCount += 1;
			if (newlineCount === limits.maxLines) {
				end = index + 1;
				break;
			}
		}

		end = trimUtf8End(buffer, end);
		const chunk = buffer.subarray(0, end);
		const nextOffset = offset + chunk.length;
		return {
			text: chunk.toString("utf8"),
			bytes: chunk.length,
			lines: countBufferLines(chunk),
			nextOffset,
			eof: nextOffset >= fileStats.size,
		};
	} finally {
		await handle.close();
	}
}
