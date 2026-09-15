# Optional Oracle tool verification

Date: 2026-09-15. Scope: optional Oracle consultation and non-cancelling wait behavior.

## Behavior

- `--oracle-model <provider/model>` persists an explicit per-change Oracle setting. Main-model selection remains native Pi. New Oracle runs and configured final reviewers snapshot the Oracle model and high effort; mismatch is rejected before prompting.
- `ask_oracle` starts read-only consultation. `agent_wait` observes an existing owned run and returns status on expiry. Advice arrives once through the parent result-message path and cannot grant publication approval.
- The Pi event listener starts before the prompt. Active inference has no caller-wait execution deadline. Bounded state requests distinguish a dead process or rejected preflight from healthy inference.
- Children retain the actual Pi config directory under isolated HOME. Results follow the client stop operation. Cleanup rejection retains cancelling/attention state; shutdown reports unresolved ownership.

## Observed verification

- Build, typecheck, and focused Biome checks passed.
- Focused integration uses a real Git feature checkout, ChangeStore, AgentSupervisor, and controlled external Pi client. It covers same-run wait expiry, model/effort snapshot persistence, role tool restriction, mismatch before prompt, fast settlement, rejected preflight, cancellation without advice delivery, and rejected cleanup.
- Existing optional-review integration passed, preserving skipped/requested-review behavior.
- A live Pi RPC consultation used openai-codex/gpt-6-astra at high effort, returned READY, delivered one result on the same run after an expired short wait, and recorded a session file. The smoke ran with an isolated HOME and used a disposable Git fixture. The fixture was removed afterward; summary evidence remains in the task scratch directory.
- Independent source review found a rejected-preflight hang in the initial event loop. The fix detects confirmed idle-without-start, marks failure, and cleans up. Re-review found no remaining issues in that fix.

No unit or end-to-end tests were written or run. This verifies the Oracle component and transport; it does not establish complete native-TUI/checklist acceptance or all providers. Provider-level request timeouts still apply. The legacy injected-client fallback retains its prior wait behavior; the production Pi client uses events. Pi's own stop implementation remains the transport cleanup contract; no OS sandbox or new process manager is introduced.
