import { styleText } from "node:util";
import type { AgileCycleSetting } from "../domain/agile-cycle";
import type { SkillInstallResult } from "../skills/install";
import { boxGuidance } from "./help-box";

type OnboardingScope =
  | { kind: "global"; root: string }
  | { kind: "project"; root: string };

const createBacklogGuidance = [
  "  Install the grilling skill if needed:",
  "    npx skills add mattpocock/skills --skill grilling --global --agent pi",
  "  Ask your coding assistant to create a backlog:",
  "    Use roc-create-tasks: <requirement>",
];

/** Renders the stable identity, scope, and step heading for onboarding. */
export function renderOnboardingHeader(scope: OnboardingScope): string {
  const label =
    scope.kind === "global"
      ? `Global user account (${scope.root})`
      : `Project (${scope.root})`;
  return `Welcome to Roc\n\nTurn your plan into coding tasks.\nChoose your skills, set a cycle, and connect Codex.\n\nScope: ${label}\n\nSetup steps:`;
}

/** Styles onboarding headings and outcomes while preserving a readable plain transcript. */
export function formatOnboardingMessage(
  message: string,
  color: boolean,
  width = 80,
): string {
  message = boxGuidance(message, width);
  if (!color) return message;
  return message
    .split("\n")
    .map((line) => {
      if (/^[╭│╰]/u.test(line))
        return styleText("cyan", line, { validateStream: false });
      if (line === "Welcome to Roc")
        return styleText(["bold", "cyan"], line, { validateStream: false });
      if (line === "Result: Complete")
        return styleText(["bold", "green"], line, { validateStream: false });
      if (line === "Onboarding stopped" || line.startsWith("Failed:"))
        return styleText(["bold", "red"], line, { validateStream: false });
      if (/^\d+\./.test(line)) {
        const colon = line.indexOf(":");
        return (
          styleText(["bold", "cyan"], line.slice(0, colon + 1), {
            validateStream: false,
          }) + line.slice(colon + 1)
        );
      }
      if (["Setup steps:", "Next:", "Retry:", "Completed work:"].includes(line))
        return styleText("bold", line, { validateStream: false });
      if (line.startsWith("Scope:") || line.startsWith("  - "))
        return styleText("dim", line, { validateStream: false });
      return line;
    })
    .join("\n");
}

/** Identifies GitHub as the task source without claiming authentication has been verified. */
export function renderTaskSourceStep(): string {
  return "1. Task source: GitHub Issues";
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
          "    npx skills add backnotprop/pstack --skill unslop --global --agent pi",
          "  Then choose it:",
          "    npx roc-it@latest onboard",
        ]
      : []),
    "  Connect GitHub if needed:",
    "    gh auth login",
    ...createBacklogGuidance,
    "  Inspect the resulting tasks:",
    "    npx roc-it@latest task list",
  ].join("\n");
}

/** Renders an empty task list with the accepted backlog-creation guidance. */
export function renderEmptyTaskList(width = 80): string {
  return boxGuidance(
    ["No tasks.", "Next:", ...createBacklogGuidance].join("\n"),
    width,
  );
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
