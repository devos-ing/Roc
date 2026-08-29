import type { AgileCycleSetting } from "../domain/agile-cycle";
import type { SkillInstallResult } from "../skills/install";

type OnboardingScope =
  | { kind: "global"; root: string }
  | { kind: "project"; root: string };

const createBacklogGuidance = [
  "  Install the grilling skill if needed:",
  "    npx skills add mattpocock/skills --skill grilling --global --agent codex --agent claude-code --agent cursor",
  "  Create your first backlog in Claude Code or Cursor:",
  "    /roc-create-tasks <requirement>",
  "  Create your first backlog in Codex:",
  "    $roc-create-tasks <requirement>",
];

/** Renders the stable identity, scope, and step heading for onboarding. */
export function renderOnboardingHeader(scope: OnboardingScope): string {
  const label =
    scope.kind === "global"
      ? `Global user account (${scope.root})`
      : `Project (${scope.root})`;
  return `Roc onboarding\nScope: ${label}\n\nSteps:`;
}

/** Renders the completed database step without implying one exists for global onboarding. */
export function renderDatabaseStep(input: {
  dbPath?: string;
  scope: OnboardingScope;
}): string {
  return input.scope.kind === "global"
    ? "1. Database: Not created (global scope)"
    : `1. Database: Ready (${input.dbPath})`;
}

/** Renders successful skill installation outcomes, including harmless identical copies. */
export function renderSkillsStep(result: SkillInstallResult): string {
  const outcomes = [
    ...result.created.map((path) => `  - Installed: ${path}`),
    ...result.skipped.map((path) => `  - Already installed: ${path}`),
  ];
  return ["2. Skills:", ...outcomes].join("\n");
}

/** Describes a validated Agile cycle setting in concise user-facing language. */
export function describeCycle(setting: AgileCycleSetting): string {
  if (setting.type === "daily") return "Daily";
  if (setting.type === "weekly") return "Weekly";
  return `Custom (${setting.days} days)`;
}

/** Renders the confirmed count of exact agent skill identities. */
export function renderAllowlistStep(selectedCount: number): string {
  return `3. Agent skills: ${selectedCount} allowed`;
}

/** Renders the completed selection of a valid Agile cycle. */
export function renderCycleStep(setting: AgileCycleSetting): string {
  return `4. Selected cycle: ${describeCycle(setting)}`;
}

/** Renders the completed global settings write. */
export function renderSettingsStep(settingsPath: string): string {
  return `5. Settings: Saved ${settingsPath}`;
}

/** Renders the successful onboarding summary and copyable follow-up commands. */
export function renderOnboardingComplete(
  input: { unslopMissing?: boolean } = {},
): string {
  return [
    "Result: Complete",
    "Next:",
    ...(input.unslopMissing
      ? [
          "  Install unslop from pstack if needed:",
          "    npx skills add backnotprop/pstack --skill unslop --global --agent codex --agent claude-code --agent cursor",
          "  Then choose it:",
          "    npx roc-it@latest onboard",
        ]
      : []),
    ...createBacklogGuidance,
    "  Inspect the resulting tasks:",
    "    npx roc-it@latest task list",
  ].join("\n");
}

/** Renders an empty task list with the accepted backlog-creation guidance. */
export function renderEmptyTaskList(): string {
  return ["No tasks.", "Next:", ...createBacklogGuidance].join("\n");
}

/** Renders a truthful partial-failure summary without suggesting rollback or success. */
export function renderOnboardingStopped(input: {
  completedSteps: string[];
  failure: string;
  retryCommand: string;
}): string {
  return [
    "Onboarding stopped",
    ...(input.completedSteps.length
      ? [
          "Completed work:",
          ...input.completedSteps.map((step) => `  - ${step}`),
        ]
      : []),
    `Failed: ${input.failure}`,
    "Retry:",
    `  ${input.retryCommand}`,
  ].join("\n");
}

/** Renders an onboarding usage error with the same retry path as operational failures. */
export function renderOnboardingUsageError(
  failure: string,
  retryCommand: string,
): string {
  return renderOnboardingStopped({
    completedSteps: [],
    failure,
    retryCommand,
  });
}
