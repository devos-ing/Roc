# README Design

## Audience and outcome

The README is an operator-first introduction for someone evaluating or running
Agile Agents locally. It must explain the problem the current implementation
solves, provide copyable commands, show the no-loop review flow, and direct
contributors to the durable project documentation.

## Structure

1. **Introduction** — describe the local, sequential Scout → Implement → Review
   scheduler, durable SQLite state, task isolation, review-rejection follow-ups,
   context handoff, model routing, skill allowlisting, and token reporting.
2. **Run it** — list prerequisites and the shortest source-based setup and first
   run. Do not imply that the package is published or globally installed.
3. **Core flow** — use one small Mermaid flowchart. Emphasize that review
   rejection terminates the original task, creates a linked draft follow-up,
   and immediately returns scheduling to the backlog.
4. **Commands** — include every command currently emitted by `agile help` in one
   shell code block, plus the package development commands in a second block.
5. **Contributing** — explain the Bun/TypeScript/Zod/SQLite stack, the core-test
   policy, the architecture/spec/research locations, and the required check.
6. **References** — link to the primary projects that materially informed the
   design: OpenAI Codex and Symphony, Pi, Beads, Gas Town, and OpenSpec. Link the
   local landscape research for the detailed comparison.

## Accuracy boundaries

- Describe only implemented CLI behavior.
- State that v1 is sequential and local; it does not merge, push, delete task
  branches, execute tasks concurrently, or enforce token budgets.
- Do not present weekly Grilling or the interactive TUI as available commands.
- Explain that skills are allowlisted for agent threads, not forced on every
  attempt.
- Use commands and flags verbatim from `src/cli/help.ts` and scripts verbatim
  from `package.json`.

## Acceptance checks

- `README.md` exists and follows the requested outline.
- The core flow fits in one Mermaid diagram.
- Every supported CLI command appears inside a code block.
- Setup and development commands are copyable from the repository root.
- References use primary upstream repository or documentation links.
- `bun run check` remains green because the change is documentation-only.
