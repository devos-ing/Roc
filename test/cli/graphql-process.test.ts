import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { git } from "../helpers/git";
import { memoryPlan } from "../helpers/github-plan";

test("real CLI inspect and task view use GraphQL; partial/403 logs stay safe and quota/inflight SIGINT drain gh", async () => {
  const root = await mkdtemp(join(tmpdir(), "roc-graphql-cli-"));
  const main = resolve("src/cli/main.ts");
  const helper = resolve("test/helpers/graphql-github.ts");
  try {
    await git(["init"], root);
    const issues = memoryPlan([["answer.ts"]]).issues;
    await writeFile(join(root, "issues.json"), JSON.stringify(issues));
    const gh = join(root, "gh");
    await writeFile(
      gh,
      `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
import { graphqlResponse } from ${JSON.stringify(helper)};
const args = process.argv.slice(2);
appendFileSync("calls.jsonl", JSON.stringify({ args, pid: process.pid }) + "\\n");
if (args[0] === "repo") { console.log("acme/test"); process.exit(0); }
if (args[0] === "api" && args[1] === "user") { console.log("owner"); process.exit(0); }
if (args[0] !== "api" || args[1] !== "graphql" || !args.includes("--include")) process.exit(9);
const mode = process.env.FIXTURE_MODE;
if (mode === "hang") await new Promise(() => setInterval(() => {}, 1000));
if (mode === "403") { console.log('HTTP/2.0 403 Forbidden\\n\\n{"message":"secret-token"}'); console.error("secret-token HTTP 403"); process.exit(1); }
const body = graphqlResponse(JSON.parse(readFileSync("issues.json", "utf8")), ["gh", ...args]);
if (mode === "partial") body.errors = [{ type: "INTERNAL", message: "secret-token" }];
if (mode === "quota") { body.errors = [{type:"RATE_LIMITED",message:"secret-token"}]; body.data.rateLimit.remaining = 0; }
console.log("HTTP/2.0 200 OK\\n\\n" + JSON.stringify(body));
`,
    );
    await chmod(gh, 0o755);
    for (const mode of ["success", "task", "partial", "403", "quota", "hang"]) {
      await writeFile(join(root, "calls.jsonl"), "");
      const child = Bun.spawn({
        cmd: [
          process.execPath,
          main,
          ...(mode === "task"
            ? ["task", "list", "--all"]
            : ["scheduler", "inspect"]),
        ],
        cwd: root,
        env: {
          ...process.env,
          PATH: `${root}:${process.env.PATH}`,
          FIXTURE_MODE: mode,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = new Response(child.stdout).text();
      const stderr = new Response(child.stderr).text();
      const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
      try {
        if (mode === "quota" || mode === "hang") {
          for (let attempt = 0; attempt < 200; attempt++) {
            if (
              (await readFile(join(root, "calls.jsonl"), "utf8")).includes(
                '"graphql"',
              )
            )
              break;
            await Bun.sleep(10);
          }
          await Bun.sleep(50);
          child.kill("SIGINT");
        }
        const code = await child.exited;
        const output = await stdout;
        const diagnostic = await stderr;
        expect(output + diagnostic).not.toContain("secret-token");
        if (mode === "success") {
          expect(code).toBe(0);
          expect(JSON.parse(output).tasks[0].id).toBe("issue-41");
        } else if (mode === "task") {
          expect(code).toBe(0);
          expect(output).toContain("issue-41");
        } else {
          expect(code).not.toBe(0);
          expect(output).not.toContain('"tasks"');
        }
        if (mode === "403") expect(diagnostic).toContain("permission");
        if (mode === "partial")
          expect(diagnostic).toContain("incomplete response");
        const calls = (await readFile(join(root, "calls.jsonl"), "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(calls.filter((call) => call.args[1] === "graphql")).toHaveLength(
          1,
        );
        expect(calls.every((call) => call.args[0] !== "issue")).toBe(true);
        for (const call of calls)
          expect(() => process.kill(call.pid, 0)).toThrow();
      } finally {
        clearTimeout(timeout);
        child.kill();
        await child.exited;
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
