#!/usr/bin/env node
import { runOpenAmp } from "./cli.js";

/** Runs the OpenAmp process and reports a concise startup or runtime failure. */
async function main() {
  try {
    process.exitCode = await runOpenAmp(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `OpenAmp: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

await main();
