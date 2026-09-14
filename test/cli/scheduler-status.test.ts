import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../src/cli/run";
import type { CliRuntime } from "../../src/cli/types";

const staleHint =
  "owner process is gone; the stale guard can be removed after verifying no scheduler is running";

/** Creates one empty temporary repository directory with its temp parent. */
async function createRepo(): Promise<{ root: string; repo: string }> {
  const root = await mkdtemp(join(tmpdir(), "roc-scheduler-status-"));
  const repo = join(root, "repo");
  await mkdir(repo);
  return { root, repo };
}

/** Runs scheduler status against one repository and returns its parsed report. */
async function schedulerStatus(
  repo: string,
): Promise<{ code: number; report: unknown; errors: string[] }> {
  const output: string[] = [];
  const errors: string[] = [];
  const runtime: CliRuntime = {
    projectRoot: repo,
    async runScheduler() {},
  };
  const code = await runCli(
    ["scheduler", "status"],
    {
      out: (line: string) => output.push(line),
      err: (line: string) => errors.push(line),
    },
    runtime,
  );
  return {
    code,
    report: JSON.parse(output.join("\n")),
    errors,
  };
}

/** Writes one ownership record beside the canonical repository path. */
async function writeLock(
  repo: string,
  record: Record<string, unknown>,
): Promise<void> {
  await writeFile(
    `${await realpath(repo)}.agile-checkout.lock`,
    JSON.stringify(record),
  );
}

test("reports no-lock without a guard file and exits non-zero", async () => {
  const { root, repo } = await createRepo();
  try {
    const { code, report, errors } = await schedulerStatus(repo);
    expect(code).toBe(1);
    expect(report).toEqual({ running: false, reason: "no-lock" });
    expect(errors).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports a live owner from the recorded pid and exits zero", async () => {
  const { root, repo } = await createRepo();
  try {
    await writeLock(repo, {
      version: 1,
      runId: "run-live",
      ownerPid: process.pid,
      acquiredAt: "2026-09-08T00:00:00.000Z",
      ownerToken: "token-live",
    });
    const { code, report, errors } = await schedulerStatus(repo);
    expect(code).toBe(0);
    expect(report).toEqual({
      running: true,
      pid: process.pid,
      runId: "run-live",
      acquiredAt: "2026-09-08T00:00:00.000Z",
    });
    expect(errors).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports a stale guard when the recorded owner exited and exits non-zero", async () => {
  const { root, repo } = await createRepo();
  try {
    const exited = Bun.spawn([process.execPath, "-e", "process.exit(0)"]);
    const deadPid = exited.pid;
    await exited.exited;
    await writeLock(repo, {
      version: 1,
      runId: "run-stale",
      ownerPid: deadPid,
      acquiredAt: "2026-09-08T00:00:00.000Z",
      ownerToken: "token-stale",
    });
    const { code, report, errors } = await schedulerStatus(repo);
    expect(code).toBe(1);
    expect(report).toEqual({
      running: false,
      staleLock: true,
      pid: deadPid,
      runId: "run-stale",
      acquiredAt: "2026-09-08T00:00:00.000Z",
      hint: staleHint,
    });
    expect(errors).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports an unreadable guard instead of claiming no daemon", async () => {
  const { root, repo } = await createRepo();
  try {
    await writeFile(
      `${await realpath(repo)}.agile-checkout.lock`,
      "not ownership metadata",
    );
    const { code, report, errors } = await schedulerStatus(repo);
    expect(code).toBe(1);
    expect(report).toMatchObject({
      running: false,
      reason: "unreadable-lock",
    });
    expect(JSON.stringify(report)).toContain("hint");
    expect(errors).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("registers scheduler status help with its exit-code semantics", async () => {
  const output: string[] = [];
  const errors: string[] = [];
  expect(
    await runCli(["scheduler", "status", "--help"], {
      out: (line: string) => output.push(line),
      err: (line: string) => errors.push(line),
    }),
  ).toBe(0);
  const help = output.join("\n");
  expect(help).toContain("daemon health");
  expect(help).toContain("exits 0");
  expect(errors).toEqual([]);
});
