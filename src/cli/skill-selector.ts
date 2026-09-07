import type { Readable, Writable } from "node:stream";
import { styleText } from "node:util";
import { isCancel, multiselect } from "@clack/prompts";
import { skillIdentityKey } from "../domain/skill-allowlist";
import type { DefaultSkillCandidate } from "../skills/policy";
import type { SkillSelectionResult } from "./types";

type SkillPromptConfig = {
  message: string;
  options: {
    value: string;
    label: string;
    hint: string;
    disabled: boolean;
  }[];
  initialValues: string[];
  required: false;
  showInstructions: true;
  input?: Readable;
  output?: Writable;
};

type SkillPrompt = (input: SkillPromptConfig) => Promise<string[] | symbol>;

type TerminalOutput = Writable & {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
};

export type SkillSelectorTerminal = {
  input?: Readable;
  output?: TerminalOutput;
};

/** Maps trusted candidates into Clack's stable prompt configuration. */
export function buildSkillPromptConfig(
  candidates: DefaultSkillCandidate[],
  terminal?: SkillSelectorTerminal,
): SkillPromptConfig {
  return {
    message: "Use Roc's default skill allowlist?",
    options: candidates.map((candidate) => ({
      value: skillIdentityKey(candidate.identity),
      label: candidate.identity.name,
      hint: styleText(
        "dim",
        candidate.installed
          ? candidate.identity.source
          : "pstack · Not installed",
      ),
      disabled: !candidate.installed,
    })),
    initialValues: candidates
      .filter((candidate) => candidate.initiallySelected)
      .map((candidate) => skillIdentityKey(candidate.identity)),
    required: false,
    showInstructions: true,
    ...(terminal?.input === undefined ? {} : { input: terminal.input }),
    ...(terminal?.output === undefined ? {} : { output: terminal.output }),
  };
}

/** Runs the skill checklist and normalizes selection or cancellation. */
export async function selectSkillAllowlist(
  candidates: DefaultSkillCandidate[],
  prompt: SkillPrompt = multiselect,
  terminal?: SkillSelectorTerminal,
): Promise<SkillSelectionResult> {
  const result = await prompt(buildSkillPromptConfig(candidates, terminal));
  if (typeof result === "symbol" || isCancel(result)) {
    return { kind: "cancelled" };
  }
  const selected = new Set(result);
  return {
    kind: "selected",
    identities: candidates
      .filter(
        (candidate) =>
          candidate.installed &&
          selected.has(skillIdentityKey(candidate.identity)),
      )
      .map((candidate) => candidate.identity),
  };
}
