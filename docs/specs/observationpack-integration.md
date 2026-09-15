# ObservationPack integration

Status: implemented for Pied Piper's native Pi sessions.

## Scope

ObservationPack keeps a large tool result reachable without retaining its full
text in every later provider request. It is optional, defaults to disabled, and
does not claim token or cost savings.

| ID | Required behavior |
| --- | --- |
| `op-default-off` | A new interactive Pied Piper change presents a checkbox list with ObservationPack clear. `--plugins` reopens the list for a resumed change. The durable change record retains a confirmed selection; cancellation changes nothing. |
| `op-runtime-load` | An enabled main Pi session and every enabled RPC child register the package-owned extension and explicitly allow `obs_recall`; disabled sessions do neither. Existing parent and child read-only/write boundaries remain intact. |
| `op-snapshot-integrity` | The accepted raw snapshot remains under `src/third-party/sol-pi/` with upstream `d7ecfc089944f0d04b80122a0a9a6ca0d786f3d0`, patch SHA-256 `8bf0618ba036047b8dbacde65455e77e5eea8a803b626040a83623a78857373f`, and manifest fingerprint `7975b4c4b16729c8bcb370f05f192a6c0ac157bb6f0235261181a1e0dc3bfdf9`. |
| `op-packaged-artifact` | The package emits the vendor extension into `dist/third-party/sol-pi/` and records its exact file hashes in `BUILD-PROVENANCE.json`, bound to the raw manifest fingerprint. Startup validates the executable artifact before registering it. |
| `op-recall-integrity` | The accepted recall patch remains recorded in `docs/validation/2026-09-13-observationpack-recall-integrity.patch`; the vendor implementation retains its content-addressed objects, append-only ledger, paging limits, and fail-open context projection. |

Observation archives remain beside their Pi sessions until a user removes them
after affected sessions stop. This feature adds no retention service, provider
call, daemon, legacy Roc command, or automatic benchmark.
