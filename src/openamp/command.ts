import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  allowFailure?: boolean;
}

/** Returns whether an unknown failure is an object record. */
function isErrorRecord(error: unknown): error is Record<string, unknown> {
  return typeof error === "object" && error !== null;
}

const COMMAND = String.raw`(?:^|[\s;&|()\x60])(?:[^\s;&|()\x60]+/)?`;
const REMOTE_MUTATION = [
  new RegExp(`${COMMAND}git\\b[^;&|\\n]*\\b(?:push|send-pack)(?:\\s|$)`, "iu"),
  new RegExp(
    `${COMMAND}git\\b[^;&|\\n]*\\bremote\\s+(?:add|remove|rename|set-url)(?:\\s|$)`,
    "iu",
  ),
  new RegExp(`${COMMAND}gh\\b`, "iu"),
  new RegExp(
    `${COMMAND}(?:npm|pnpm|yarn|bun)\\b[^;&|\\n]*\\b(?:publish|unpublish|deprecate)(?:\\s|$)`,
    "iu",
  ),
  new RegExp(
    `${COMMAND}(?:npm|pnpm|yarn|bun)\\b[^;&|\\n]*\\b(?:dist-tag|access|owner|token)\\s+(?:add|rm|remove|set|grant|revoke|create)(?:\\s|$)`,
    "iu",
  ),
  new RegExp(
    `${COMMAND}curl\\b[^;&|\\n]*(?:\\s-X\\s*(?:POST|PUT|PATCH|DELETE)\\b|--request(?:=|\\s)+(?:POST|PUT|PATCH|DELETE)\\b|(?:^|\\s)(?:(?:-d|-F|-T)(?:\\s|=|[^\\s])|(?:--data(?:-[a-z-]+)?|--form|--json|--upload-file)(?:\\s|=)))`,
    "iu",
  ),
  new RegExp(
    `${COMMAND}wget\\b[^;&|\\n]*(?:--post-data|--post-file|--method(?:=|\\s)+(?:POST|PUT|PATCH|DELETE)|--body-data|--body-file)(?:=|\\s)`,
    "iu",
  ),
  new RegExp(`${COMMAND}(?:ssh|scp|sftp)\\b`, "iu"),
  new RegExp(`${COMMAND}rsync\\b[^;&|\\n]*\\s[^\\s;&|:]+:`, "iu"),
];

/** Returns a stable reason when an agent command crosses the Delivery boundary. */
export function remoteMutationReason(command: string): string | undefined {
  const inspectable = command
    .replace(/\\\r?\n/gu, "")
    .replace(/\\([^\r\n])/gu, "$1")
    .replace(/["']/gu, "");
  return REMOTE_MUTATION.some((pattern) => pattern.test(inspectable))
    ? "OpenAmp agents cannot mutate Git or GitHub remotes; only Delivery can publish and only the user can merge"
    : undefined;
}

/** Returns an environment isolated from normal publication credential stores. */
export function agentEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  isolatedHome?: string,
): Record<string, string> {
  const result = Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  for (const name of Object.keys(result)) {
    if (
      /^(?:GH|GITHUB|GITLAB|NPM|SSH|GCM)_/iu.test(name) ||
      /^GIT_(?:CONFIG_|ASKPASS|SSH|CREDENTIAL)/iu.test(name) ||
      /^NODE_AUTH_TOKEN$/iu.test(name)
    ) {
      delete result[name];
    }
  }
  Object.assign(result, {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  });
  if (isolatedHome) {
    result.HOME = isolatedHome;
    result.XDG_CONFIG_HOME = isolatedHome;
    result.GNUPGHOME = isolatedHome;
  }
  return result;
}

/** Removes ambient repository overrides from OpenAmp-owned Git commands. */
function localGitEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    ...environment,
    GIT_TERMINAL_PROMPT: "0",
  };
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
export async function runCommand(
  command: string,
  args: string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      encoding: "utf8",
      maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
      signal: options.signal,
      timeout: options.timeoutMs ?? 120_000,
    });
    return {
      exitCode: 0,
      stdout: result.stdout.trimEnd(),
      stderr: result.stderr.trimEnd(),
    };
  } catch (error) {
    if (options.signal?.aborted) {
      throw new Error("Operation aborted", { cause: error });
    }
    const record = isErrorRecord(error) ? error : {};
    const stdout =
      typeof record.stdout === "string" ? record.stdout.trimEnd() : "";
    const stderr =
      typeof record.stderr === "string" ? record.stderr.trimEnd() : "";
    if (options.allowFailure) {
      return {
        exitCode: Number.isInteger(record.code) ? Number(record.code) : 1,
        stdout,
        stderr,
      };
    }
    const diagnostic =
      stderr ||
      stdout ||
      (error instanceof Error ? error.message : "unknown failure");
    throw new Error(`${command} ${args.join(" ")} failed: ${diagnostic}`);
  }
}

/** Runs a Git command with deterministic noninteractive local commit settings. */
export async function runGit(
  cwd: string,
  args: string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
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
