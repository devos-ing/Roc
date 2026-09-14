import { homedir } from "node:os";
import { resolve } from "node:path";
import type { Command } from "commander";
import {
  type AgileCycleSetting,
  AgileCycleSettingSchema,
  activeAgileCycle,
} from "../../domain/agile-cycle";
import { loadRocSettingsIfPresent, saveRocSettings } from "../../settings";
import { installPackagedSkills, SkillInstallError } from "../../skills/install";
import {
  buildDefaultSkillCandidates,
  loadDefaultSkillPolicy,
} from "../../skills/policy";
import { commandProjectRoot, errorMessage } from "../command-context";
import {
  formatOnboardingMessage,
  renderAllowlistStep,
  renderCycleStep,
  renderOnboardingComplete,
  renderOnboardingHeader,
  renderOnboardingStopped,
  renderSettingsStep,
  renderSkillsStep,
  renderTaskSourceStep,
} from "../presentation";
import type { CliCommandContext, CliIo } from "../types";

/** Prompts for and validates one global Agile cycle setting. */
async function promptCycleSetting(
  io: CliIo,
  now: Date,
  initialValue?: AgileCycleSetting["type"],
): Promise<AgileCycleSetting> {
  if (!io.selectCycle)
    throw new Error("Interactive cycle selection is required for onboard");
  const choice = await io.selectCycle(initialValue);
  if (choice === undefined) throw new Error("Onboarding cancelled");
  if (choice === "daily" || choice === "weekly") return { type: choice };
  if (!io.ask) throw new Error("Interactive input is required for onboard");
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
  const originalIo = context.io;
  const color = originalIo.output?.isTTY === true;
  context = {
    ...context,
    io: {
      ...originalIo,
      out: (message) =>
        originalIo.out(
          formatOnboardingMessage(message, color, originalIo.output?.columns),
        ),
      err: (message) =>
        originalIo.err(
          formatOnboardingMessage(message, color, originalIo.output?.columns),
        ),
    },
  };
  const global = options.global === true;
  const retryCommand = onboardingRetryCommand(global);
  const sourceRoot = resolve(import.meta.dir, "..", "..", "..", "skills");
  const root = global
    ? (context.runtime.homeRoot ?? homedir())
    : await commandProjectRoot(context, { allowCurrentDirectory: true });
  const scope = global
    ? { kind: "global" as const, root }
    : { kind: "project" as const, root };
  const completedSteps: string[] = [];
  context.io.out(renderOnboardingHeader(scope));
  try {
    const taskSourceStep = renderTaskSourceStep();
    completedSteps.push(taskSourceStep);
    context.io.out(taskSourceStep);
    const installed = await installPackagedSkills({ sourceRoot, root });
    const skillsStep = renderSkillsStep(installed);
    completedSteps.push(skillsStep);
    context.io.out(skillsStep);
    const homeRoot = context.runtime.homeRoot ?? homedir();
    if (context.runtime.listWorkspaceSkills === undefined) {
      throw new Error("Local skill discovery is required for onboard");
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
      priorSettings?.cycle.type,
    );
    if (!context.runtime.configureModel)
      throw new Error("Model setup is required for onboard");
    if (priorSettings?.execution?.allowUnsandboxed !== true) {
      const answer = await context.io.ask?.(
        "Roc's coding tools run with your account permissions. Use OS/container isolation for unattended work. Allow execution on this machine? [y/N]",
      );
      if (!/^(y|yes)$/i.test(answer?.trim() ?? ""))
        throw new Error("Execution was not authorized; onboarding cancelled");
    }
    const model = await context.runtime.configureModel(context.io, root);
    const settingsPath = await saveRocSettings(
      {
        cycle: setting,
        skills: { allowlist: selection.identities },
        execution: { allowUnsandboxed: true },
        ...(priorSettings?.models === undefined
          ? {}
          : { models: priorSettings.models }),
        ...(priorSettings?.efforts === undefined
          ? {}
          : { efforts: priorSettings.efforts }),
      },
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
    const modelStep = `6. Model: Connected (${model})`;
    completedSteps.push(modelStep);
    context.io.out(modelStep);
    context.io.out(renderOnboardingComplete());
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
    .description(
      "Set up Roc, Codex login, trusted skills, and your Agile cycle",
    )
    .option("--global", "install Roc skills globally without project state")
    .action(async (options: { global?: boolean }) => {
      context.exitCode = await executeOnboard(context, options);
    });
}
