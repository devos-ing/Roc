#!/usr/bin/env bun
import { runCli } from "./run";

if (import.meta.main) {
  const code = await runCli(Bun.argv.slice(2), {
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
  });
  process.exitCode = code;
}
