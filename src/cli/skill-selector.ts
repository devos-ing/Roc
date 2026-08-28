import { type Readable, Writable } from "node:stream";
import { styleText } from "node:util";
import { isCancel, multiselect } from "@clack/prompts";
import type { DefaultSkillCandidate } from "../agents/codex/skill-policy";
import { skillIdentityKey } from "../domain/skill-allowlist";
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

type SkillSelectorTerminal = {
  input?: Readable;
  output?: TerminalOutput;
};

const sgrEscape = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/** Forwards terminal output while removing only SGR styling sequences. */
class SgrStrippingOutput extends Writable {
  /** Re-emits destination resize notifications for Clack's renderer. */
  private readonly resizeListener = (): boolean => this.emit("resize");

  /** Creates a writable filter that preserves non-style terminal control sequences. */
  constructor(private readonly destination: TerminalOutput) {
    super();
    this.destination.on("resize", this.resizeListener);
  }

  /** Reflects whether the wrapped destination is currently a terminal. */
  get isTTY(): boolean | undefined {
    return this.destination.isTTY;
  }

  /** Reflects the wrapped destination's current terminal width. */
  get columns(): number | undefined {
    return this.destination.columns;
  }

  /** Reflects the wrapped destination's current terminal height. */
  get rows(): number | undefined {
    return this.destination.rows;
  }

  /** Stops forwarding terminal resize notifications to prevent listener leaks. */
  dispose(): void {
    this.destination.off("resize", this.resizeListener);
  }

  /** Writes one chunk after removing Select Graphic Rendition escape sequences. */
  _write(
    chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const text = typeof chunk === "string" ? chunk : chunk.toString();
    this.destination.write(text.replace(sgrEscape, ""), callback);
  }
}

/** Opens Clack's checklist with terminal colors removed when NO_COLOR is set. */
async function promptForSkills(
  config: SkillPromptConfig,
): Promise<string[] | symbol> {
  const output = config.output ?? process.stdout;
  const colorlessOutput =
    process.env.NO_COLOR === undefined
      ? undefined
      : new SgrStrippingOutput(output);
  try {
    return await multiselect({ ...config, output: colorlessOutput ?? output });
  } finally {
    colorlessOutput?.dispose();
  }
}

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
  prompt: SkillPrompt = promptForSkills,
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
