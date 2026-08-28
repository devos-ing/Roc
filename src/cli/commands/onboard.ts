import { homedir } from "node:os";
import { resolve } from "node:path";
import type { Command } from "commander";
import {
  buildDefaultSkillCandidates,
  loadDefaultSkillPolicy,
} from "../../agents/codex/skill-policy";
import {
  type AgileCycleSetting,
  AgileCycleSettingSchema,
  activeAgileCycle,
} from "../../domain/agile-cycle";
import { loadRocSettingsIfPresent, saveRocSettings } from "../../settings";
import {
  installRocCreateTasksSkill,
  SkillInstallError,
} from "../../skills/install";
import { openDatabase } from "../../store/database";
import {
  commandProjectRoot,
  errorMessage,
  projectDatabasePath,
} from "../command-context";
import {
  renderAllowlistStep,
  renderCycleStep,
  renderDatabaseStep,
  renderOnboardingComplete,
  renderOnboardingHeader,
  renderOnboardingStopped,
  renderSettingsStep,
  renderSkillsStep,
} from "../presentation";
import type { CliCommandContext, CliIo } from "../types";

/** Prompts for and validates one global Agile cycle setting. */
async function promptCycleSetting(
  io: CliIo,
  now: Date,
): Promise<AgileCycleSetting> {
  if (!io.ask) throw new Error("Interactive input is required for onboard");
  const choice = (
    await io.ask("Agile cycle: 1) Daily 2) Weekly 3) Custom")
  ).trim();
  if (choice === "1") return { type: "daily" };
  if (choice === "2") return { type: "weekly" };
  if (choice !== "3") throw new Error("Choose Daily, Weekly, or Custom");
  const days = Number((await io.ask("Custom cycle duration in days")).trim());
  if (!Number.isInteger(days) || days <= 0) {
    throw new Error("Custom duration must be a whole number greater than zero");
  }
  return AgileCycleSettingSchema.parse({
    type: "custom",
    days,
    anchorDate: activeAgileCycle({ type: "daily" }, now).id,
  });
}

/** Builds the copyable retry command for an onboarding invocation. */
function onboardingRetryCommand(global: boolean): string {
  return global
    ? "npx roc-it@latest onboard --global"
    : "npx roc-it@latest onboard";
}

/** Runs local or global onboarding and preserves its stepwise transcript. */
async function executeOnboard(
  context: CliCommandContext,
  options: { global?: boolean },
): Promise<number> {
  const global = options.global === true;
  const retryCommand = onboardingRetryCommand(global);
  const sourcePath = resolve(
    import.meta.dir,
    "..",
    "..",
    "..",
    "skills",
    "roc-create-tasks",
    "SKILL.md",
  );
  const root = global
    ? (context.runtime.homeRoot ?? homedir())
    : await commandProjectRoot(context, { allowCurrentDirectory: true });
  const scope = global
    ? { kind: "global" as const, root }
    : { kind: "project" as const, root };
  const completedSteps: string[] = [];
  context.io.out(renderOnboardingHeader(scope));
  try {
    let installed: Awaited<ReturnType<typeof installRocCreateTasksSkill>>;
    if (global) {
      const databaseStep = renderDatabaseStep({ scope });
      completedSteps.push(databaseStep);
      context.io.out(databaseStep);
      installed = await installRocCreateTasksSkill({ sourcePath, root });
    } else {
      const dbPath = projectDatabasePath(root);
      const db = openDatabase(dbPath);
      try {
        const databaseStep = renderDatabaseStep({ dbPath, scope });
        completedSteps.push(databaseStep);
        context.io.out(databaseStep);
        installed = await installRocCreateTasksSkill({ sourcePath, root });
      } finally {
        db.close();
      }
    }
    const skillsStep = renderSkillsStep(installed);
    completedSteps.push(skillsStep);
    context.io.out(skillsStep);
    const homeRoot = context.runtime.homeRoot ?? homedir();
    if (context.runtime.listWorkspaceSkills === undefined) {
      throw new Error("Codex skill discovery is required for onboard");
    }
    if (context.io.selectSkills === undefined) {
      throw new Error("Interactive skill selection is required for onboard");
    }
    const priorSettings = await loadRocSettingsIfPresent(homeRoot);
    const policy = await loadDefaultSkillPolicy(
      homeRoot,
      priorSettings?.skills?.allowlist,
    );
    const candidates = buildDefaultSkillCandidates(
      await context.runtime.listWorkspaceSkills(root),
      policy,
    );
    const selection = await context.io.selectSkills(candidates);
    if (selection.kind === "cancelled") throw new Error("Onboarding cancelled");
    const setting = await promptCycleSetting(
      context.io,
      context.runtime.now?.() ?? new Date(),
    );
    const settingsPath = await saveRocSettings(
      { cycle: setting, skills: { allowlist: selection.identities } },
      homeRoot,
    );
    const allowlistStep = renderAllowlistStep(selection.identities.length);
    completedSteps.push(allowlistStep);
    context.io.out(allowlistStep);
    const cycleStep = renderCycleStep(setting);
    completedSteps.push(cycleStep);
    context.io.out(cycleStep);
    const settingsStep = renderSettingsStep(settingsPath);
    completedSteps.push(settingsStep);
    context.io.out(settingsStep);
    context.io.out(
      renderOnboardingComplete({
        unslopMissing: candidates.some(
          ({ identity, installed }) => identity.name === "unslop" && !installed,
        ),
      }),
    );
    return 0;
  } catch (error) {
    const partialSkills =
      error instanceof SkillInstallError &&
      (error.completed.created.length > 0 || error.completed.skipped.length > 0)
        ? renderSkillsStep(error.completed)
        : undefined;
    context.io.err(
      renderOnboardingStopped({
        completedSteps:
          partialSkills === undefined
            ? completedSteps
            : [...completedSteps, partialSkills],
        failure: errorMessage(error),
        retryCommand,
      }),
    );
    return 1;
  }
}

/** Registers onboarding and its option for selecting global installation scope. */
export function registerOnboardCommand(
  program: Command,
  context: CliCommandContext,
): void {
  program
    .command("onboard")
    .description("Set up Roc, its skills, and your Agile cycle")
    .option("--global", "install Roc skills globally without project state")
    .action(async (options: { global?: boolean }) => {
      context.exitCode = await executeOnboard(context, options);
    });
}
