# Fake Codex Harness 選型研究

日期：2026-08-25

## 結論

**Slice 2 要做 Fake Harness，但只做一個很薄、in-process、由我們擁有的 deterministic fake。** 不要模擬完整 Codex JSON-RPC，不要引入另一個 agent runtime，也不要把 SQLite scheduler 搬到工作流平台。現有專案只有 Bun、TypeScript、Zod，而且 SQLite 已有 `attempts`、逐筆 `usage` 與 `events.idempotency_key UNIQUE`；這正好足以在自己的 normalized boundary 測試重送、去重與重啟恢復（[package.json](../../package.json)、[migration source](../../src/store/migrations.ts)）。

採 **hybrid**：

1. 自己擁有小型 `AgentHarness`、Zod event/scenario schemas、Fake 與 adapter conformance tests。
2. 借用 OpenAI Agents SDK `ScriptedModel` 的 exact script、fail-fast、`assertComplete()` 思路；其官方 testing module 是 deterministic、provider-neutral、in-memory、無真實 API call，亦能注入 model error、usage 與精確 stream（[official testing guide source](https://github.com/openai/openai-agents-js/blob/main/docs/src/content/docs/guides/testing.mdx)）。
3. 借用 Pi 的可注入 stream／排隊回應與 backend conformance 思路，但不加入 Pi dependency；Pi 的 agent package 已輸出 session-backend conformance helpers，但它驗證的是 Pi `SessionRepo`，不是本產品的 ticket/attempt/event contract（[testing export](https://github.com/badlogic/pi-mono/blob/main/packages/agent/src/harness/session/testing/index.ts)、[conformance source](https://github.com/badlogic/pi-mono/blob/main/packages/agent/src/harness/session/testing/conformance.ts)）。
4. Slice 3 才實作 Codex app-server adapter，並以官方產生的 TypeScript/JSON schemas 與 recorded protocol fixtures 驗證相同 normalized contract；app-server 官方支援 schema generation、thread lifecycle、streaming notifications、review 與 token-usage updates（[Codex app-server docs](https://developers.openai.com/codex/app-server)）。

本次範圍決策是 **只記錄 token delta 與每 task/attempt totals，不在 v1 阻擋超額 dispatch**。Fake 仍必須輸出 token delta，因為 accounting、duplicate replay 與 restart reconciliation 都依賴它；額度 enforcement 不屬於 Fake。

目前 `TicketSpec`、`WeeklyPlan`、`ModelDecision` 仍要求正整數 token ceiling/budget（[domain schemas](../../src/domain/schemas.ts)）。Slice 2 開始前應另做一次小型 schema/spec 對齊：改為 observability-only/optional，或明確採 placeholder；不要讓 Fake 暗中實作已移出 v1 的 hard limit。

## 選項比較

| 選項 | Bun 相容性 | Deterministic script | failure／replay／token | 依賴、lock-in、SQLite fit | 判斷 |
|---|---|---|---|---|---|
| **自有 thin in-process fake** | 與現有 Bun process 相同；專案已以 `bun test` 執行且只依賴 Zod（[package.json](../../package.json)） | 可精確控制每一次 Scout／Implement／Review delivery | 可原樣重送同一 `eventId`、送出 immutable usage delta、infra failure 或 review result；SQLite 的 unique idempotency key 負責去重（[migration](../../src/store/migrations.ts)） | 無新 runtime、無 provider lock-in，直接打現有 attempts/usage/events | **採用** |
| **Codex app-server／Codex SDK 當 fake seam** | app-server 是外部 process；TS SDK 官方 runtime contract 是 Node.js 18+，不是 Bun contract（[SDK package](https://github.com/openai/codex/blob/main/sdk/typescript/package.json)） | 官方 app-server 是 live Codex protocol，文件沒有提供 scripted fake；SDK 可用 `codexPathOverride` 換 executable（[SDK constructor](https://github.com/openai/codex/blob/main/sdk/typescript/src/codex.ts)） | 真實 protocol 有 streamed events 與 usage；SDK override seam 對應 `codex exec` subprocess/JSONL，而不是計畫中的 app-server v2（[SDK exec source](https://github.com/openai/codex/blob/main/sdk/typescript/src/exec.ts)、[app-server docs](https://developers.openai.com/codex/app-server)） | protocol 對齊度高，但若 Slice 2 fake 完整 JSON-RPC，會過早鎖定外部細節 | **Slice 3 real adapter；不作 Slice 2 fake** |
| **OpenAI Agents SDK `@openai/agents/testing`** | 官方 repo 有隔離的 Bun install/run integration test（[Bun integration test](https://github.com/openai/openai-agents-js/blob/main/integration-tests/bun.test.ts)） | `ScriptedModel` 支援 fixed steps、request-aware responder、精確 stream 與 `assertComplete()`（[testing guide](https://github.com/openai/openai-agents-js/blob/main/docs/src/content/docs/guides/testing.mdx)） | 支援 injected model errors、retry step consumption 與 usage；但 event identity、scheduler crash、role lineage、SQLite reconciliation 仍須自建（[testing guide](https://github.com/openai/openai-agents-js/blob/main/docs/src/content/docs/guides/testing.mdx)） | 會把 Agents SDK Runner/Model contract 帶進 Codex-first backend | **抄模式，不加 dependency** |
| **Pi Agent Harness／faux provider** | repo 有 Bun smoke coverage，但 `@earendil-works/pi-agent-core` 的正式 engine 是 Node.js 22.19+，並依賴 TypeBox 等套件（[package](https://github.com/badlogic/pi-mono/blob/main/packages/agent/package.json)、[repo](https://github.com/badlogic/pi-mono)） | agent loop 可注入 stream；官方 tests 的 faux provider 依序消耗 queued responses，能產生 text/thinking/tool-call 與 estimated usage（[agent README](https://github.com/badlogic/pi-mono/blob/main/packages/agent/README.md)、[faux-provider test](https://github.com/badlogic/pi-mono/blob/main/packages/ai/test/faux-provider.test.ts)） | 能測 model/provider error 與 agent events；Pi 的 exported conformance 聚焦 session persistence，不處理本產品的 task claim、review follow-up 或 SQLite idempotency（[session testing types](https://github.com/badlogic/pi-mono/blob/main/packages/agent/src/harness/session/testing/types.ts)） | 中高依賴，綁 Pi message/session/provider protocol，重疊未來 Codex backend | **只作設計參考** |
| **Temporal TypeScript testing** | `@temporalio/testing` 正式要求 Node.js 20.3+，且依賴 client、worker、workflow、core bridge（[package](https://github.com/temporalio/sdk-typescript/blob/main/packages/testing/package.json)） | 官方提供 Activity mocks、time-skipping test environment 與 workflow-history replay（[Temporal TS testing docs](https://docs.temporal.io/develop/typescript/best-practices/testing-suite)） | 對 durable retry、timer 與 history replay 很強 | 它的價值建立在 Temporal workflow/server semantics；用它會取代或重複現有 SQLite state machine | **MVP 過重；分散式多 worker 時再評估** |
| **Apache Airflow** | Airflow workflows 以 Python 定義，並作為 scheduler/web platform 運行（[official docs](https://airflow.apache.org/docs/apache-airflow/stable/index.html)） | 可用 pytest、DAG loader 與 `dag.test()` 測 DAG/task（[official best practices](https://airflow.apache.org/docs/apache-airflow/stable/best-practices.html#testing-a-dag)） | 可測 batch workflow，但不提供 Codex normalized-event fake 或本產品的 stable event ID | 會把 Bun CLI/TUI replatform 成 Python orchestration deployment，仍需另做 model fake | **不同層次，不採用** |
| **Make.com** | 遠端 SaaS API，不是可嵌入 Bun 的 testing library；Scenario 是由 modules 組成、在 Make region endpoint 建立與執行（[Scenarios API](https://developers.make.com/api-documentation/api-reference/scenarios)） | API 執行的是已部署 automation scenario，不是本地 deterministic scripted test | API 暴露 execution/error/incomplete-execution 等運行資料，但沒有本產品所需的本地 event replay/SQLite crash seam（[Scenarios API](https://developers.make.com/api-documentation/api-reference/scenarios)） | 外部服務與 scenario schema lock-in，不符合 local-first 單 process | **可參考 UX，不作 backend/test harness** |
| **Vercel AI SDK `ai/test`** | `ai` package 正式 engine 是 Node.js 22+（[package](https://github.com/vercel/ai/blob/main/packages/ai/package.json)） | `MockLanguageModelV4`、mock IDs 與 simulated readable stream 可做 repeatable model tests（[official testing docs source](https://github.com/vercel/ai/blob/main/content/docs/03-ai-sdk-core/55-testing.mdx)） | 可指定 usage 與 stream chunks；task-role、duplicate delivery、restart state 仍須自建（[official testing docs source](https://github.com/vercel/ai/blob/main/content/docs/03-ai-sdk-core/55-testing.mdx)） | 將未使用的 AI SDK provider protocol 引入 Codex-first 系統 | **不採用** |

「Apache make」沒有足夠明確的產品名稱；上表分別評估最合理的兩個意圖：Apache 的 workflow orchestrator（Airflow）與 Make.com automation platform。兩者解決的是 workflow deployment/integration，不是 agent backend 的 deterministic test double。若指的是另一個 Apache 專案，需要以專案全名另行評估。

## 我們只需要擁有的 API

不要建立 `FakeCodexAppServer`。擁有 provider-neutral、一次只交付一個 event 的 boundary 即可：

```ts
export interface AgentHarness {
  step(input: HarnessStepRequest): Promise<HarnessDelivery>;
  cancel(attemptId: string): Promise<void>;
}

type HarnessStepRequest = {
  mode: "dispatch" | "reconcile";
  attempt: {
    attemptId: string;
    taskId: string;
    role: "scout" | "implement" | "review";
    retryIndex: 0 | 1 | 2;
    model: string;
    effort: "medium" | "high" | "xhigh";
    contextRef?: ContextRef;
  };
  deliveryCursor?: string;
};

type HarnessDelivery =
  | { kind: "event"; nextCursor: string; event: HarnessEvent }
  | { kind: "idle"; nextCursor?: string }
  | { kind: "closed"; nextCursor?: string };
```

`HarnessEvent` 用 strict Zod discriminated union，只要五類：

- `attempt.started`：可帶 `threadId`；
- `attempt.output`：Scout capsule、implementation evidence 或 structured review；
- `attempt.usage_delta`：`inputTokens`、`cachedInputTokens`、`outputTokens`、`reasoningOutputTokens`，需要時保留 `cacheWriteInputTokens`；Codex SDK 的 official event type包含這些 usage 欄位，而現有 SQLite usage table 尚未存 cache-write input，Slice 3 前要明確決定保留或捨棄（[Codex SDK events](https://github.com/openai/codex/blob/main/sdk/typescript/src/events.ts)、[local migration](../../src/store/migrations.ts)）；
- `attempt.completed`：角色成功；review 的 `accepted | rejected` 是成功完成的 semantic result，不是 infrastructure error（[approved failure semantics](../superpowers/specs/2026-08-24-agent-agile-orchestrator-design.md#4-product-flow)）；
- `attempt.failed_infra`：錯誤 code、可重試判斷與安全訊息。

每個 event 都有固定的 `eventId`、`attemptId`、`sequence`、`occurredAt`。`deliveryCursor` 與 `eventId` 必須分開：scenario 可以先交付 event `u1`，下一次再交付完全相同的 `u1`；cursor 前進，但 SQLite 只接受一次 `u1`。這直接驗證現有 unique idempotency key，而不需要假的 network stack（[local event constraint](../../src/store/migrations.ts)）。Codex app-server 採 JSON-RPC；request/response 以 `id` 關聯，但 notification 本身沒有 request ID，因此 real adapter 仍須負責產生 normalized stable identity，不能把 JSON-RPC framing 當 domain event identity（[app-server protocol](https://developers.openai.com/codex/app-server)）。

Fake-specific API 只再加：

```ts
createFakeHarness(scenario: unknown): {
  harness: AgentHarness;
  assertComplete(): void;
};
```

Scenario 以 `(taskId, role, retryIndex)` match，另有 `expect` 驗證 model、effort、contextRef；`deliveries` 就是固定 event list。所有 scenario 在 scheduler claim 任何 task **之前**一次完成 Zod preflight；缺少 script、額外 call、model/context 不符、未消耗 delivery 都是 test configuration error。這採用 OpenAI Agents testing 對 unexpected/unconsumed steps 的 fail-fast 契約，但不採用其 Runner（[official testing guide source](https://github.com/openai/openai-agents-js/blob/main/docs/src/content/docs/guides/testing.mdx)）。

現有 `attempts` table 尚無 transport cursor（[local migration](../../src/store/migrations.ts)）。O1/O6 最小的持久化增量是一個 nullable `harness_cursor`（或等價的一對 attempt receipt 欄位），並在「套用 event effects」的同一 transaction 更新。重送 event 即使因 `eventId` 去重，也要把 cursor 前推；否則 restart 後會永久重播同一 delivery。Fake 的 process memory 不能成為 recovery source of truth。

## 哪些 fault 不應放進 Fake Harness

- **Role/backend fault** 放在 scenario：infra failure、stream 中斷、review accepted/rejected、usage event 重送。
- **Scheduler/SQLite crash** 放在 scheduler 的 test-only fault hook，例如 `afterEventInsert`、`afterUsageInsert`、`afterReviewInsert`、`afterFollowUpInsert`、`beforeCommit`。Fake 在 restart 後從 persisted `deliveryCursor` 或最後 durable receipt 重送同一 event；scheduler 的 transaction/idempotency 才是被測主體。
- **真實 Codex protocol drift** 放在 Slice 3 recorded fixtures + generated schema tests。app-server 可按 Codex version 產生 TS/JSON schemas，所以不需要現在手寫完整 fake server（[schema generation docs](https://developers.openai.com/codex/app-server)）。

若把 crash point 也塞進 Fake，測試只會證明 Fake 的內部狀態；無法證明 SQLite transaction 在真正的 process death 後仍不重複 follow-up、usage 或 completion event。

## Slice 2 最小驗收組

這組驗收直接覆蓋既有設計的 retry、semantic rejection 與 restart/idempotency 規則（[error handling and recovery](../superpowers/specs/2026-08-24-agent-agile-orchestrator-design.md#15-error-handling-and-recovery)）。

1. 同一 scenario 重跑兩次，event IDs、timestamps、順序與 token totals 完全相同。
2. 同一 usage event delivery 兩次，ledger 只增加一次。
3. Scout/Implement infra failure 依 `retry_index` 前進；達上限後 task 成為 `failed_infra`，scheduler 選下一個 ready task。
4. Review `rejected` 在一個 transaction 寫 review、terminalize 原 task、建立且只建立一個 draft follow-up；原 task 不再 dispatch。
5. 在每個 durable write fault point crash、重開同一 SQLite DB、以 `mode: "reconcile"` 繼續，完成事件與 follow-up 都不重複。
6. `expect.model`、`expect.effort`、`expect.contextRef` 任一不符即 fail；可覆蓋 Model Advisor 與跨週 context inheritance。
7. `assertComplete()` 證明沒有 script 被意外跳過，也沒有多一次 agent call。
8. Fake 與未來 Codex adapter 共用同一 normalized-event conformance suite；real adapter 另外用 app-server generated schemas/recorded fixtures 測 transport。

這個範圍能完整回答 Slice 2 的 scheduler correctness，又把將來換 Codex protocol、甚至新增 Pi backend 的成本限制在 adapter，不會讓測試框架反過來決定產品架構。
