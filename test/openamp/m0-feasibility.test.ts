import { expect, test } from "bun:test";
import { join } from "node:path";

const probePath = join(
  import.meta.dir,
  "..",
  "..",
  "tools",
  "openamp-m0-probe.mjs",
);

test("Pi public Node APIs satisfy the deterministic OpenAmp M0 contract", async () => {
  const probe = Bun.spawn(["node", probePath], {
    cwd: join(import.meta.dir, "..", ".."),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    probe.exited,
    new Response(probe.stdout).text(),
    new Response(probe.stderr).text(),
  ]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  const result = JSON.parse(stdout) as {
    node: string;
    publicExports: Record<string, boolean>;
    session: {
      extension: boolean;
      activeTools: string[];
      turns: number;
      allowedCommand: boolean;
      remoteMutationBlocked: boolean;
      sessionRecovered: boolean;
      resultRecovered: boolean;
    };
    steering: { queued: boolean; delivered: boolean; modelCalls: number };
    cancellation: { aborted: boolean; returnedToIdle: boolean };
    rpc: {
      started: boolean;
      stateReadable: boolean;
      stopped: boolean;
      requiresExplicitCliPath: boolean;
    };
  };

  expect(result.node).toMatch(/^v(?:2[2-9]|[3-9]\d)\./);
  expect(result.publicExports).toEqual({
    InteractiveMode: true,
    createAgentSessionRuntime: true,
    RpcClient: true,
  });
  expect(result.session).toEqual({
    extension: true,
    activeTools: ["bash", "probe_status"],
    turns: 2,
    allowedCommand: true,
    remoteMutationBlocked: true,
    sessionRecovered: true,
    resultRecovered: true,
  });
  expect(result.steering).toEqual({
    queued: true,
    delivered: true,
    modelCalls: 2,
  });
  expect(result.cancellation).toEqual({
    aborted: true,
    returnedToIdle: true,
  });
  expect(result.rpc).toEqual({
    started: true,
    stateReadable: true,
    stopped: true,
    requiresExplicitCliPath: true,
  });
});
