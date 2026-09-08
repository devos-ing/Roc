import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../src/cli/run";

test("publishes a validated manifest without creating a local executable queue", async () => {
  const root = await mkdtemp(join(tmpdir(), "roc-remote-command-"));
  const manifestPath = join(root, "approved.json");
  const output: string[] = [];
  await writeFile(
    manifestPath,
    JSON.stringify({
      cycleId: "2026-09-06-P7D",
      goal: "Publish remotely",
      tasks: [
        {
          id: "REMOTE-COMMAND",
          title: "Publish one remote task",
          priority: 1,
          spec: {
            problem: "The task is local to machine A",
            desiredOutcome: "The task is published for machine B",
            scope: ["remote publication"],
            nonGoals: [],
            acceptanceCriteria: ["one Issue is reported"],
            validation: ["bun test"],
            dependencies: [],
            risk: "medium",
            contextCandidates: [],
            tokenCeiling: 100,
          },
        },
      ],
    }),
  );
  try {
    expect(
      await runCli(
        ["task", "publish-github", manifestPath],
        {
          out: (text) => output.push(text),
          err: (text) => output.push(text),
        },
        {
          projectRoot: root,
          runScheduler: async () => {},
          async publishGitHubTasks(manifest, cwd) {
            expect(cwd).toBe(root);
            expect(manifest.tasks.map((task) => task.id)).toEqual([
              "REMOTE-COMMAND",
            ]);
            return [
              {
                taskId: "REMOTE-COMMAND",
                issueNumber: 12,
                issueUrl: "https://example.test/issues/12",
                envelopeHash: `sha256:${"a".repeat(64)}`,
              },
            ];
          },
        },
      ),
    ).toBe(0);
    expect(output).toEqual(["REMOTE-COMMAND: https://example.test/issues/12"]);
    expect(existsSync(join(root, ".agile", "runtime", "agile.db"))).toBeFalse();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
