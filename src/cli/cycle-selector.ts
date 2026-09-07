import { select } from "@clack/prompts";
import type { AgileCycleSetting } from "../domain/agile-cycle";
import type { SkillSelectorTerminal } from "./skill-selector";

/** Prompts for a cycle using arrow keys and Enter, preserving cancellation. */
export async function selectAgileCycle(
  initialValue: AgileCycleSetting["type"] = "weekly",
  terminal: SkillSelectorTerminal = {},
): Promise<AgileCycleSetting["type"] | undefined> {
  const result = await select<AgileCycleSetting["type"]>({
    ...terminal,
    message: "Choose your Agile cycle",
    initialValue,
    options: [
      { value: "daily", label: "Daily", hint: "A new cycle each day" },
      { value: "weekly", label: "Weekly", hint: "A new cycle each week" },
      { value: "custom", label: "Custom", hint: "Choose the number of days" },
    ],
  });
  return typeof result === "symbol" ? undefined : result;
}
