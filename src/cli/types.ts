import type {
  DefaultSkillCandidate,
  DiscoveredSkill,
} from "../codex/skill-policy";
import type { SkillIdentity } from "../domain/skill-allowlist";
import type { GitHubIssueCandidate } from "../github/import-source";
import type { AgileError } from "../runtime/errors";

export type SkillSelectionResult =
  | { kind: "selected"; identities: SkillIdentity[] }
  | { kind: "cancelled" };

export type CliIo = {
  /** Writes one normal-output record. */
  out(text: string): void;
  /** Writes one diagnostic-output record. */
  err(text: string): void;
  /** Prompts for one interactive answer when input is available. */
  ask?(question: string): Promise<string>;
  /** Selects exact trusted skills through an interactive terminal checklist. */
  selectSkills?(
    candidates: DefaultSkillCandidate[],
  ): Promise<SkillSelectionResult>;
};

export type SchedulerRunInput =
  | { backend: "fake"; dbPath: string; scenario: unknown }
  | { backend: "codex"; dbPath: string; repoPath: string; baseRef: string };

export type CliRuntime = {
  /** Runs one scheduler invocation through an injected backend boundary. */
  runScheduler(input: SchedulerRunInput): Promise<void>;
  /** Reads raw approved GitHub Issue candidates for an import command. */
  readGitHubIssues?(): Promise<GitHubIssueCandidate[]>;
  /** Records a normalized operational error at the resolved runtime location. */
  logError?(
    error: AgileError,
    input: { dbPath: string; repoPath?: string },
  ): Promise<void>;
  /** Returns Codex's complete skill catalog for one onboarding workspace. */
  listWorkspaceSkills?(cwd: string): Promise<DiscoveredSkill[]>;
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
