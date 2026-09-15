#!/usr/bin/env node
import { runOpenAmp } from "./cli.js";

/** Runs Pied Piper and reports a concise startup or runtime failure. */
async function main() {
  try {
    process.exitCode = await runOpenAmp(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `Pied Piper: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

await main();
