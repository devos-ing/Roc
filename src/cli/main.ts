#!/usr/bin/env bun
import { createInterface } from "node:readline/promises";
import { runCli } from "./run";

if (import.meta.main) {
  let prompt: ReturnType<typeof createInterface> | undefined;
  try {
    process.exitCode = await runCli(Bun.argv.slice(2), {
      out: (text) => process.stdout.write(`${text}\n`),
      err: (text) => process.stderr.write(`${text}\n`),
      ask: (question) => {
        prompt ??= createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        return prompt.question(`${question}: `);
      },
    });
  } finally {
    prompt?.close();
  }
}
