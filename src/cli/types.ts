import type { RealBackendName } from "../agents/registry";
import type { AgileCycleSetting } from "../domain/agile-cycle";
import type { BacklogManifest } from "../domain/schemas";
import type { SkillIdentity } from "../domain/skill-allowlist";
import type { GitHubIssueCandidate } from "../github/import-source";
import type { PublishedRemoteTask } from "../github/remote-tasks";
import type { AgileError } from "../runtime/errors";
import type { DefaultSkillCandidate, DiscoveredSkill } from "../skills/policy";

export type CliTerminalInput = NodeJS.ReadStream;
export type CliTerminalOutput = NodeJS.WriteStream;

export type SkillSelectionResult =
  | { kind: "selected"; identities: SkillIdentity[] }
  | { kind: "cancelled" };

export type CliIo = {
  /** Writes one normal-output record. */
  out(text: string): void;
  /** Writes one diagnostic-output record. */
  err(text: string): void;
  /** Prompts for one interactive answer when input is available. */
  ask?(question: string, signal?: AbortSignal): Promise<string>;
  /** Selects an Agile cycle with keyboard navigation, returning undefined on cancellation. */
  selectCycle?(
    initialValue?: AgileCycleSetting["type"],
  ): Promise<AgileCycleSetting["type"] | undefined>;
  /** Selects exact trusted skills through an interactive terminal checklist. */
  selectSkills?(
    candidates: DefaultSkillCandidate[],
  ): Promise<SkillSelectionResult>;
  /** Supplies the input stream for commands that need direct terminal control. */
  input?: CliTerminalInput;
  /** Supplies the output stream for commands that need direct terminal control. */
  output?: CliTerminalOutput;
};

export type RealSchedulerRunInput = {
  backend: RealBackendName;
  dbPath: string;
  repoPath: string;
  baseRef: string;
  /** Limits concurrently active tasks in this scheduler session. */
  concurrency?: number;
  /** Names the GitHub branch that pull requests target, independently of the local base ref. */
  baseBranch?: string;
  /** Selects local backlog execution or trusted GitHub task admission. */
  source?: "local" | "github";
};

export type SchedulerRunInput =
  | { backend: "fake"; dbPath: string; scenario: unknown }
  | RealSchedulerRunInput;

export type CliRuntime = {
  /** Runs one scheduler invocation through an injected backend boundary. */
  runScheduler(input: SchedulerRunInput): Promise<void>;
  /** Reads raw approved GitHub Issue candidates for an import command. */
  readGitHubIssues?(): Promise<GitHubIssueCandidate[]>;
  /** Publishes one approved manifest to the current project's GitHub repository. */
  publishGitHubTasks?(
    manifest: BacklogManifest,
    cwd: string,
  ): Promise<PublishedRemoteTask[]>;
  /** Records a normalized operational error at the resolved runtime location. */
  logError?(
    error: AgileError,
    input: { dbPath: string; repoPath?: string },
  ): Promise<void>;
  /** Returns installed trusted skills for onboarding without starting an agent. */
  listWorkspaceSkills?(cwd: string): Promise<DiscoveredSkill[]>;
  /** Connects and verifies the default model through Pi during onboarding. */
  configureModel?(io: CliIo, cwd: string): Promise<string>;
  projectRoot?: string;
  homeRoot?: string;
  /** Supplies the clock used for cycle calculations. */
  now?: () => Date;
};

export type CliCommandContext = {
  io: CliIo;
  runtime: CliRuntime;
  exitCode: number;
};
