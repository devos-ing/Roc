#!/usr/bin/env node
import { runPiedPiper } from "./cli.js";

/** Runs Pied Piper and reports a concise startup or runtime failure. */
async function main() {
  try {
    process.exitCode = await runPiedPiper(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `Pied Piper: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

await main();
