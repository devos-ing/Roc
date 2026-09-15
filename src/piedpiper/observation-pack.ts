import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

export const OBSERVATION_PACK_TOOL = "obs_recall";

const snapshotRoot = resolve(
  fileURLToPath(new URL("../third-party/sol-pi/", import.meta.url)),
);
const allowedSourceFiles = new Set([
  "LICENSE",
  "PROVENANCE.json",
  "extensions/observation-pack/index.ts",
  "extensions/observation-pack/ledger.ts",
  "extensions/observation-pack/observation.ts",
  "runtime-paths.ts",
  "tui.ts",
]);
const expectedUpstreamCommit = "d7ecfc089944f0d04b80122a0a9a6ca0d786f3d0";
const expectedPatchSha256 =
  "8bf0618ba036047b8dbacde65455e77e5eea8a803b626040a83623a78857373f";
const expectedManifestFingerprint =
  "7975b4c4b16729c8bcb370f05f192a6c0ac157bb6f0235261181a1e0dc3bfdf9";

type Provenance = {
  files: Record<string, string>;
  patchSha256: string;
  upstreamCommit: string;
};

type BuildProvenance = {
  files: Record<string, string>;
  sourceManifestFingerprint: string;
};

/** Returns a lower-case SHA-256 digest for one file payload. */
function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Lists the regular files below a snapshot using slash-separated paths. */
async function snapshotFiles(
  root: string,
  directory = root,
): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await snapshotFiles(root, path)));
    else if (entry.isFile()) files.push(relative(root, path));
    else throw new Error("ObservationPack contains a non-regular file");
  }
  return files.sort();
}

/** Parses the fixed source-provenance shape without accepting arbitrary paths. */
function parseProvenance(value: unknown): Provenance {
  if (typeof value !== "object" || value === null) {
    throw new Error("ObservationPack provenance is invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    JSON.stringify(Object.keys(record).sort()) !==
      JSON.stringify(["files", "patchSha256", "upstreamCommit"]) ||
    record.upstreamCommit !== expectedUpstreamCommit ||
    record.patchSha256 !== expectedPatchSha256 ||
    typeof record.files !== "object" ||
    record.files === null ||
    Array.isArray(record.files)
  ) {
    throw new Error("ObservationPack provenance identity is invalid");
  }
  const files = record.files as Record<string, unknown>;
  if (
    Object.keys(files).length !== allowedSourceFiles.size - 1 ||
    Object.keys(files).some(
      (path) => !allowedSourceFiles.has(path) || path === "PROVENANCE.json",
    ) ||
    Object.values(files).some(
      (hash) => typeof hash !== "string" || !/^[a-f0-9]{64}$/u.test(hash),
    )
  ) {
    throw new Error("ObservationPack provenance file list is invalid");
  }
  return {
    files: files as Record<string, string>,
    patchSha256: expectedPatchSha256,
    upstreamCommit: expectedUpstreamCommit,
  };
}

/** Validates the accepted raw vendor snapshot kept in this source tree. */
export async function validateObservationPackSnapshot(
  root = snapshotRoot,
): Promise<string> {
  const manifest = await readFile(resolve(root, "PROVENANCE.json"));
  const fingerprint = sha256(manifest);
  if (fingerprint !== expectedManifestFingerprint) {
    throw new Error("ObservationPack provenance fingerprint is invalid");
  }
  const provenance = parseProvenance(JSON.parse(manifest.toString("utf8")));
  const actual = await snapshotFiles(root);
  if (
    JSON.stringify(actual) !== JSON.stringify([...allowedSourceFiles].sort())
  ) {
    throw new Error(
      "ObservationPack source files do not match the closed allowlist",
    );
  }
  for (const [path, expected] of Object.entries(provenance.files)) {
    const resolved = resolve(root, path);
    if (
      dirname(resolved).startsWith(root) === false ||
      sha256(await readFile(resolved)) !== expected
    ) {
      throw new Error("ObservationPack source hash mismatch");
    }
  }
  return fingerprint;
}

/** Validates the compiled files that Pied Piper loads from a published package. */
export async function validateObservationPackRuntime(): Promise<void> {
  const manifestPath = resolve(snapshotRoot, "BUILD-PROVENANCE.json");
  try {
    const sourceManifest = await readFile(
      resolve(snapshotRoot, "PROVENANCE.json"),
    );
    const sourceFingerprint = sha256(sourceManifest);
    if (sourceFingerprint !== expectedManifestFingerprint) {
      throw new Error("ObservationPack provenance fingerprint is invalid");
    }
    parseProvenance(JSON.parse(sourceManifest.toString("utf8")));
    let build: unknown;
    try {
      build = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        await validateObservationPackSnapshot(snapshotRoot);
        return;
      }
      throw error;
    }
    if (
      typeof build !== "object" ||
      build === null ||
      (build as BuildProvenance).sourceManifestFingerprint !==
        sourceFingerprint ||
      typeof (build as BuildProvenance).files !== "object" ||
      (build as BuildProvenance).files === null
    ) {
      throw new Error("ObservationPack build provenance is invalid");
    }
    const files = (build as BuildProvenance).files;
    const actual = (await snapshotFiles(snapshotRoot)).filter((path) =>
      path.endsWith(".js"),
    );
    if (JSON.stringify(Object.keys(files).sort()) !== JSON.stringify(actual)) {
      throw new Error("ObservationPack build file list is invalid");
    }
    for (const [path, expected] of Object.entries(files)) {
      if (!/^[a-f0-9]{64}$/u.test(expected)) {
        throw new Error("ObservationPack build hash is invalid");
      }
      const resolved = resolve(snapshotRoot, path);
      if (dirname(resolved).startsWith(snapshotRoot) === false) {
        throw new Error("ObservationPack build path escapes its root");
      }
      if (sha256(await readFile(resolved)) !== expected) {
        throw new Error("ObservationPack compiled artifact hash mismatch");
      }
    }
  } catch (error) {
    throw new Error(
      `ObservationPack startup verification failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Validates then loads the vendor factory for an enabled native Pi session. */
export async function createPiedPiperObservationPackExtension(): Promise<ExtensionFactory> {
  await validateObservationPackRuntime();
  const { createObservationPackExtension } = await import(
    "../third-party/sol-pi/extensions/observation-pack/index.js"
  );
  return createObservationPackExtension();
}
