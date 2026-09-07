#!/usr/bin/env bun
import { createInterface } from "node:readline/promises";
import { runCli } from "./run";
import { selectSkillAllowlist } from "./skill-selector";

if (import.meta.main) {
  const cancelled = new AbortController();
  let prompt: ReturnType<typeof createInterface> | undefined;
  try {
    process.exitCode = await runCli(Bun.argv.slice(2), {
      out: (text) => process.stdout.write(`${text}\n`),
      err: (text) => process.stderr.write(`${text}\n`),
      ask: (question, signal) => {
        if (!prompt) {
          prompt = createInterface({
            input: process.stdin,
            output: process.stdout,
          });
          prompt.on("SIGINT", () => {
            cancelled.abort();
            process.emit("SIGINT");
          });
          prompt.on("close", () => cancelled.abort());
        }
        return prompt.question(`${question}: `, {
          signal: signal
            ? AbortSignal.any([signal, cancelled.signal])
            : cancelled.signal,
        });
      },
      selectSkills: selectSkillAllowlist,
      input: process.stdin,
      output: process.stdout,
    });
  } finally {
    prompt?.close();
  }
}
