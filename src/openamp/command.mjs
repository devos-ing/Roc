import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const REMOTE_MUTATION = [
  /(?:^|[\s;&|()`])git\b[^;&|\n]*\bpush(?:\s|$)/iu,
  /(?:^|[\s;&|()`])gh\b[^;&|\n]*\bpr\s+(?:create|edit|merge|close|reopen)(?:\s|$)/iu,
  /(?:^|[\s;&|()`])gh\b[^;&|\n]*\bapi(?:\s|$)/iu,
  /(?:^|[\s;&|()`])git\b[^;&|\n]*\bremote\s+(?:add|remove|rename|set-url)(?:\s|$)/iu,
];

/** Returns a stable reason when an agent command crosses the Delivery boundary. */
export function remoteMutationReason(command) {
  return REMOTE_MUTATION.some((pattern) => pattern.test(command))
    ? "OpenAmp agents cannot mutate Git or GitHub remotes; only Delivery can publish and only the user can merge"
    : undefined;
}

/** Returns an environment without common GitHub credentials or interactive Git prompts. */
export function agentEnvironment(environment = process.env) {
  const result = { ...environment, GIT_TERMINAL_PROMPT: "0" };
  for (const name of [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GIT_ASKPASS",
    "SSH_ASKPASS",
  ]) {
    delete result[name];
  }
  return result;
}

/** Removes ambient repository overrides from OpenAmp-owned Git commands. */
function localGitEnvironment(environment = process.env) {
  const result = { ...environment, GIT_TERMINAL_PROMPT: "0" };
  for (const name of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_NAMESPACE",
  ]) {
    delete result[name];
  }
  return result;
}

/** Runs an argv-only subprocess and returns bounded text output. */
export async function runCommand(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      encoding: "utf8",
      maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
      timeout: options.timeoutMs ?? 120_000,
    });
    return {
      exitCode: 0,
      stdout: result.stdout.trimEnd(),
      stderr: result.stderr.trimEnd(),
    };
  } catch (error) {
    const stdout =
      typeof error?.stdout === "string" ? error.stdout.trimEnd() : "";
    const stderr =
      typeof error?.stderr === "string" ? error.stderr.trimEnd() : "";
    if (options.allowFailure) {
      return {
        exitCode: Number.isInteger(error?.code) ? error.code : 1,
        stdout,
        stderr,
      };
    }
    const diagnostic = stderr || stdout || error?.message || "unknown failure";
    throw new Error(`${command} ${args.join(" ")} failed: ${diagnostic}`);
  }
}

/** Runs a Git command with deterministic noninteractive local commit settings. */
export async function runGit(cwd, args, options = {}) {
  return runCommand(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "commit.gpgSign=false",
      "-c",
      "user.name=OpenAmp",
      "-c",
      "user.email=openamp@local",
      ...args,
    ],
    { cwd, ...options, env: localGitEnvironment(options.env) },
  );
}
