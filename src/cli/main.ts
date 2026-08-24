#!/usr/bin/env bun
import { helpText } from "./help";

if (import.meta.main) {
  process.stdout.write(helpText);
}
