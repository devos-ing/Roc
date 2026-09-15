import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "../../src/openamp/command.ts";
import { ChangeDelivery } from "../../src/openamp/delivery.ts";
import type { AgentResult, ReviewDecision } from "../../src/openamp/state.ts";
import { AgentSupervisor } from "../../src/openamp/supervisor.ts";
import { ChangeWorkspace, createChange } from "../../src/openamp/workspace.ts";

test("delivery skips unrequested review and enforces requested review against real Git changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "openamp-optional-review-"));
  const source = join(root, "source");
  try {
    await runGit(root, ["init", "-b", "main", source]);
    await writeFile(join(source, "feature.txt"), "base\n");
    await runGit(source, ["add", "."]);
    await runGit(source, ["commit", "-m", "base"]);
    const store = await createChange(source, {
      id: "change-optional-review",
      base: "main",
    });
    const workspace = new ChangeWorkspace(store);
    class ReviewBoundary extends AgentSupervisor {
      calls = 0;
      decision: ReviewDecision = {
        decision: "accepted",
        findings: [],
        summary: "Checked the fixture change",
      };

      override async review(): Promise<AgentResult> {
        this.calls += 1;
        return {
          id: `review-${this.calls}`,
          runId: `review-run-${this.calls}`,
          role: "reviewer",
          summary: JSON.stringify(this.decision),
          cwd: store.state.workspace,
          baseCommit: store.state.baseCommit,
          commit: null,
          changed: false,
          createdAt: new Date().toISOString(),
          deliveredSessionId: null,
        };
      }
    }
    const supervisor = new ReviewBoundary(store, workspace);
    let remoteHead = "";
    let publicationCalls = 0;
    let savedBody = "";
    let savedTitle = "";
    let hasPullRequest = false;
    const delivery = new ChangeDelivery(store, workspace, supervisor, {
      validationRunner: async () => ({
        exitCode: 0,
        stdout: "fixture validation passed",
        stderr: "",
      }),
      commandRunner: async (command, args) => {
        let stdout = "";
        if (command === "git" && args[0] === "ls-remote") {
          const sha =
            args[2] === "refs/heads/main" ? store.state.baseCommit : remoteHead;
          stdout = sha ? `${sha}\t${args[2]}` : "";
        } else if (command === "git" && args[0] === "push") {
          publicationCalls += 1;
          remoteHead = args.at(-1)?.split(":")[0] ?? "";
        } else if (command === "gh" && args[0] === "repo") {
          stdout = JSON.stringify({ owner: { login: "fixture" } });
        } else if (command === "gh" && args[0] === "pr" && args[1] === "list") {
          stdout = JSON.stringify(
            hasPullRequest
              ? [
                  {
                    number: 1,
                    url: "https://example.invalid/pr/1",
                    state: "OPEN",
                    title: savedTitle,
                    body: savedBody,
                    headRefOid: remoteHead,
                    headRepositoryOwner: { login: "fixture" },
                  },
                ]
              : [],
          );
        } else if (
          command === "gh" &&
          args[0] === "pr" &&
          ["create", "edit"].includes(args[1] ?? "")
        ) {
          publicationCalls += 1;
          savedBody = args[args.indexOf("--body") + 1] ?? "";
          savedTitle = args[args.indexOf("--title") + 1] ?? "";
          hasPullRequest = true;
        } else if (!(command === "gh" && args[0] === "auth")) {
          throw new Error(
            `Unexpected publication-boundary command: ${command} ${args.join(" ")}`,
          );
        }
        return { exitCode: 0, stdout, stderr: "" };
      },
    });
    const input = {
      title: "Fixture feature",
      requirements: "Update the fixture feature",
      validationCommands: ["fixture-check"],
      inputGeneration: 0,
    };
    await writeFile(
      join(store.state.workspace, "feature.txt"),
      "implemented\n",
    );
    await delivery.deliver({ ...input, review: false });
    expect(supervisor.calls).toBe(0);
    expect(store.state.review).toBeNull();
    expect(savedBody).toContain("Not requested for head");
    expect(savedBody).not.toContain("Accepted for head");
    expect(await workspace.assertReady()).toBe(remoteHead);

    await delivery.deliver({ ...input, review: true });
    expect(supervisor.calls).toBe(1);
    expect(store.state.review?.decision).toBe("accepted");
    expect(savedBody).toContain(`Accepted for head \`${remoteHead}\``);

    supervisor.decision = {
      decision: "rejected",
      findings: [{ severity: "blocking", message: "Fixture defect" }],
    };
    const beforeRejection = publicationCalls;
    await writeFile(
      join(store.state.workspace, "feature.txt"),
      "changed again\n",
    );
    await expect(delivery.deliver({ ...input, review: true })).rejects.toThrow(
      "rejected",
    );
    expect(publicationCalls).toBe(beforeRejection);
    expect(store.state.phase).toBe("review_rejected");
    expect(store.state.review?.decision).toBe("rejected");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
