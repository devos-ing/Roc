import type { RealBackendName } from "../agents/registry";
import type { AgileCycleSetting } from "../domain/agile-cycle";
import type { BacklogManifest } from "../domain/schemas";
import type { SkillIdentity } from "../domain/skill-allowlist";
import type { GitHubTaskSnapshot } from "../github/execution-view";
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
  repoPath: string;
  /** Names the GitHub target branch used to fetch each task's base. */
  baseBranch?: string;
  /** Selects the sole supported GitHub task source. */
  source?: "github";
  once?: boolean;
  /** Limits independent tasks to an integer from one through eight; defaults to two. */
  concurrency?: number;
  /** Opts into strict-policy squash merge of the exact independently reviewed PR head. */
  autoMerge?: boolean;
  /** Selects pull-request publication (default) or branch-only push without a pull request. */
  publicationMode?: "pr" | "branch";
};

export type SchedulerRunInput = RealSchedulerRunInput;

export type CliRuntime = {
  /** Runs one scheduler invocation through an injected backend boundary. */
  runScheduler(input: SchedulerRunInput): Promise<void>;
  /** Reads authoritative GitHub task checkpoints for inspection commands. */
  readTasks?(cwd: string): Promise<GitHubTaskSnapshot>;
  /** Publishes one approved manifest to the current project's GitHub repository. */
  publishGitHubTasks?(
    manifest: BacklogManifest,
    cwd: string,
  ): Promise<PublishedRemoteTask[]>;
  /** Records a normalized operational error at the resolved runtime location. */
  logError?(error: AgileError, input: { repoPath: string }): Promise<void>;
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
