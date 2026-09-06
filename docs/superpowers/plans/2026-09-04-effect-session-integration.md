# Effect session lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. If the user chooses delegated execution, use superpowers:subagent-driven-development instead. Steps use checkbox syntax for tracking.

**Goal:** 將 Roc 的 session lifecycle 改由 Effect 管理，取代原生 heartbeat、shutdown deadline 與重複 backend cleanup，同時保留現有任務結果、錯誤與 SQLite fencing。

**Architecture:** 最外層 session owns backend 與 DB，內層 daemon scope owns lease、tick worker 與 heartbeat。SIGINT/SIGTERM 先停止派發，給已開始的工作 250ms 排空，再封鎖晚到續行、結束 worker、釋放 lease、關閉 backend 和 DB。Fake 與正式 backend 共用此路徑，AgentHarness 和 BackendFactory 不改介面。

**Tech Stack:** Bun、TypeScript、Effect 3.22.1、現有 Zod 與 SQLite。固定 Effect 版本沿用對照實驗，不宣稱為最新版本。

---

## 歷史狀態與範圍（pre-implementation snapshot）

以下內容是實作前的原始計畫快照，不描述目前狀態。請先閱讀本文底部的
[Execution receipt — 2026-09-04](#execution-receipt--2026-09-04)：本機
deterministic 驗證已完成，Real Codex smoke 仍未驗證。原 P1 checkout
handoff 風險已有下述 fail-closed ownership follow-up，仍待獨立整合審查與使用者 review。

這是待執行計畫。此次只新增文件，未安裝正式 dependency、建立分支或修改 production code。前置證據見 [對照結果](/Users/roy/Documents/ChatGPT/agile-agents/docs/superpowers/plans/2026-09-04-effect-adoption-review.md)，不能把隔離實驗的 19 個通過測試算作正式整合通過。

工作根目錄為 `/Users/roy/Documents/ChatGPT/agile-agents`。本文相對路徑均相對執行時的 repository root；若在 worktree 執行，使用 worktree root。不要依賴被 git 忽略的 `.scratch` 才能編譯或執行正式測試。

不改 repository transaction、DB schema、Zod schema、model routing、durable retry、provider recovery、AgentHarness 或 BackendFactory。不得對整個 tick 加 `Effect.retry`。不引入 Context/Layer registry、Stream、Queue 或新的通用 event bus。

保留 Pi 的「事件處理完成才算 idle」及 OMP 的「deadline 不等於底層工作停止」。Roc 已直接 await harness delivery，不需要照搬 OMP 的任意 subscriber 集合。

來源採用前次查核的固定版本：[Pi lifecycle](https://github.com/earendil-works/pi/blob/e44d75c20a51142abc056c243b13c1d7bb4be687/packages/agent/src/agent.ts#L486-L590)、[OMP drain 與 seal](https://github.com/can1357/oh-my-pi/blob/c4da0d08e8275659f3e09cf381c7df7018a19025/packages/coding-agent/src/session/agent-session.ts#L4564-L4624)。Effect 的 [Scope](https://www.effect.website/docs/v3/resource-management/scope) 和 [TestClock](https://effect.website/docs/v3/testing/testclock) 使用 v3 文件。

## 必須保留的行為

| 情況 | 契約 |
| --- | --- |
| 收到第一個 signal | 同步關閉新 tick 入口，不等第一個 await |
| 收到第二個 signal | 不新增 cancellation、close 或完成 Promise |
| 已開始的 delivery 在 250ms 內返回 | 完成既有 transaction，再關閉 |
| cancellation 或 tick 超時 | 封鎖續行後才關閉資源，晚到工作不能查詢已關閉 DB |
| pending tick 期間 | 每 3 秒 heartbeat，lease 為 10 秒；idle delay 維持 1 秒 |
| lease 遺失 | 原始錯誤向外傳遞，不釋放新 owner's lease |
| cleanup 失敗 | 其他清理仍執行；有主錯誤時保留主錯誤，次要錯誤記安全診斷 |
| backend close 卡住 | 最多等待 250ms，記警告；不宣稱外部 process 已死亡 |
| startup 部分失敗 | 只釋放成功取得的資源；原有 AgileError code、runId 不變 |

停止派發與封鎖續行使用不同 signal。前者在 OS signal 抵達時設置，後者只在 drain 結束或期限到達時設置。提前用同一 signal 中止 tick 會丟掉本來可以完成的 delivery。

Heartbeat 在停止派發時結束，不在 250ms drain 期間繼續續租。正常 heartbeat 間隔加 grace 小於 10 秒 lease，但 event-loop 停頓仍可能令 lease 過期；transaction fencing 必須繼續擋住失效 owner。

## 檔案責任

| 檔案 | 變更 |
| --- | --- |
| `package.json`, `bun.lock` | 固定加入 effect 3.22.1 |
| `src/cli/session-lifecycle.ts`，新增 | 唯一 Promise 執行邊界、signal 訂閱與 bounded cleanup |
| `src/cli/runtime.ts` | backend/DB 的 scope 所有權，Fake 共用路徑，保留 preflight/model/error 邏輯 |
| `src/scheduler/daemon.ts` | Effect lease、heartbeat、worker、drain，刪除原生 run loop |
| `src/scheduler/scheduler.ts` | tick 增加可選的續行封鎖 signal，檢查每個外部 await 後的寫入 |
| `src/scheduler/task-hooks.ts` | hook workspace 和 runner 返回後，先檢查封鎖 signal |
| `src/cli/run.ts` | 移除不再使用的內部 runDaemon/schedulerSleep re-export |
| `test/scheduler/daemon.test.ts` | 保留六項既有語意，改用 TestClock/可觀察的啟動 latch |
| `test/scheduler/scheduler.test.ts` | 重用 setupAcceptedTask，新增晚到 delivery/hook/publication 邊界 |
| `test/cli/backend-session.test.ts` | 真正 session 入口、close once、startup rollback、signal 清理 |
| `test/cli/session-lifecycle.test.ts`，新增 | 錯誤 identity、bounded close、signal listener 清理 |
| `test/cli/scheduler.test.ts` | 移除舊 sleep implementation 測試，保留 CLI 與 Fake runtime 契約 |
| `docs/architecture.md` | 整合通過後描述新的資源所有權，不能提前宣稱已完成 |

## Task 1: 建立隔離工作區與基線

- [ ] 用 using-git-worktrees 建立 `codex/effect-session-lifecycle`。先檢查同名分支是否已存在；存在時確認用途，不覆蓋。保留 `.DS_Store`、`.codegraph/` 與使用者所有未提交變更。
- [ ] 將此計畫與對照結果納入可分享的文件，不依賴原工作目錄的 `.scratch`。不要自動 commit 其他未追蹤檔案。
- [ ] 在隔離工作區執行基線；controller 已提供加入 dependency 前的 frozen-install、20 pass/0 fail/107 assertions 與 typecheck exit 0 證據，完成後另記錄加入 dependency 後的相同檢查結果。

```bash
rtk bun install --frozen-lockfile
rtk bun test test/scheduler/daemon.test.ts test/cli/backend-session.test.ts test/cli/scheduler.test.ts test/integration/deterministic-orchestrator.test.ts
rtk bun run typecheck
```

前次測試結果是 20 pass。這次重新記錄實際結果；若基線已失敗，先區分既有問題，不把它歸因於 Effect。

- [ ] 加入固定依賴，更新 lockfile。

```bash
rtk bun add --exact effect@3.22.1
```

預期 package.json 只多出 `"effect": "3.22.1"`；不順便升級其他 dependencies。這是正式整合分支的 dependency，不是修改隔離實驗的 package.json。

## Task 2: 先鎖住晚到續行，repository 不改

修改 `src/scheduler/scheduler.ts`、`src/scheduler/task-hooks.ts`，測試放在既有 `test/scheduler/scheduler.test.ts`。這一步可獨立驗收，尚不需要 Effect daemon。

- [ ] 在 scheduler.test.ts 加入以下回歸測試。它重用現有 setupAcceptedTask、fake 與真實 SQLite，不建立新 fixtures framework。

```ts
test("sealed delivery does not touch a closed database", async () => {
  const { db, repo, fake } = setupAcceptedTask();
  repo.claimNext();
  repo.beginNextAttempt();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const seal = new AbortController();
  const reason = new Error("Scheduler session sealed");
  const scheduler = new Scheduler(repo, {
    async step(request) {
      const delivery = await fake.harness.step(request);
      entered.resolve();
      await release.promise;
      return delivery;
    },
    cancel: (id) => fake.harness.cancel(id),
  });
  const pending = scheduler.tick(undefined, seal.signal);
  const outcome = pending.then(() => undefined, (error: unknown) => error);
  try {
    await entered.promise;
    seal.abort(reason);
    db.close();
    release.resolve();
    expect(await outcome).toBe(reason);
  } finally {
    release.resolve();
    await outcome;
    db.close();
  }
});
```

- [ ] 執行 `rtk bun test test/scheduler/scheduler.test.ts -t 'sealed delivery'`。舊實作應得到 closed-database error 而非相同 reason。編譯器也會指出 tick 尚未接受第二個參數。
- [ ] 修改 tick 簽名，在所有下列位置插入相同檢查。匿名 callback 不需 JSDoc；更新 named function 的一句行為描述。

```ts
async tick(leaseOwnerId?: string, signal?: AbortSignal): Promise<TickResult>
```

上面是簽名變更，不是替代原本的 domain body。方法第一行插入 `signal?.throwIfAborted()`；JSDoc 改為「Advances one orchestration step unless its owning session has sealed continuation.」。逐一套用以下精確插入規則，保留其他分支原樣。

```ts
const delivery = await this.harness.step(request);
signal?.throwIfAborted();
```

兩個 hooks.run 呼叫改為傳入第四個參數，並在返回時檢查：

```ts
const posthook = await this.hooks.run(task, "posthook", leaseOwnerId, signal);
signal?.throwIfAborted();
const prehook = await this.hooks.run(claimed, "prehook", leaseOwnerId, signal);
signal?.throwIfAborted();
```

這兩段位於不同現有分支，不合併成同一區塊。publication 的成功與 catch 路徑都必須檢查：

```ts
const pullRequest = await this.publisher.publish({ ...publishing, publication });
signal?.throwIfAborted();
```

```ts
} catch (error) {
  signal?.throwIfAborted();
  this.repo.failPublishing(
    publishing.task.id,
    publicationFailureMessage(error),
    leaseOwnerId,
  );
  return { kind: "publication_failed", taskId: publishing.task.id };
}
```

- [ ] TaskHookService.run 的參數加 `signal?: AbortSignal`，方法第一行加入 `signal?.throwIfAborted()`。在 `await this.workspaces.prepare(...)` 成功後、對應 catch 第一行、以及 runner 的 try/catch 結束後、`this.repo.finishTaskHook` 前，各插入 `signal?.throwIfAborted()`。完整簽名如下。

```ts
async run(
  task: StoredTask,
  phase: TaskHookPhase,
  leaseOwnerId?: string,
  signal?: AbortSignal,
): Promise<TaskHookOutcome>
```

不能只在 Scheduler.tick 加 guard。TaskHookService 自己會在 await 後寫入 hook receipt；workspace failure 的 catch 也會記錄 receipt。

- [ ] 重用 setupAcceptedTask 的 hook runner 與 publisher，依同一 entered/release pattern 驗證下表。每個測試在釋放 gate 前 abort，再關閉 DB；結果必須是原始 seal reason，不能是 DB error。對 publication 同時測 resolve/reject，因為 catch 會呼叫 failPublishing。對 hook 分別測 workspace reject 與 runner resolve，覆蓋兩種寫入入口。

| 延遲點 | 不得執行的後續操作 |
| --- | --- |
| harness.step resolve | applyHarnessEvent |
| hook workspace reject | recordWorkspaceFailure/beginTaskHook |
| hook runner resolve | finishTaskHook |
| publisher resolve/reject | completePublication/failPublishing |

- [ ] 執行 `rtk bun test test/scheduler/scheduler.test.ts test/scheduler/task-hooks.test.ts test/store/orchestration-repository.test.ts`。所有既有無 signal 呼叫維持原語意。
- [ ] 檢查並提交此獨立 safety 變更，僅 stage 上述三個 source/test 目標及實際新增的相關測試，不包含其他工作。

## Task 3: 以 Effect 替換 daemon 所有權

修改 `src/scheduler/daemon.ts`，保留 LeaseStore type。Runtime 改成只有 ownerId；不再同時注入 sleep 與使用 Effect Clock。SchedulerDaemon constructor 的三個依賴保持 scheduler、leases、runtime，但 runtime 不含 now/sleep。

- [ ] 先把六個 daemon 測試改為呼叫 `runEffect`。使用 TestContext 和 TestClock，不以「函式回傳 Promise 前一定已 tick」作假設。缺少新方法時測試應失敗。
- [ ] 刪除原 run/tickWithHeartbeats/nextHeartbeat/activeWait 實作，新增以下 method。imports 使用 `Clock, Effect, Fiber`，沿用現有 Scheduler type。

```ts
/** Runs ticks under a lease and drains owned work before sealing continuation. */
runEffect(input: {
  stop: AbortSignal;
  cancel(): Promise<void>;
  drainMs?: number;
}): Effect.Effect<void, unknown> {
  const self = this;
  return Effect.scoped(Effect.gen(function* () {
    if (input.stop.aborted) return;
    const now = yield* Clock.currentTimeMillis;
    yield* Effect.acquireRelease(
      Effect.try({
        try: () => {
          if (!self.leases.acquireLease(
            self.runtime.ownerId,
            new Date(now).toISOString(),
            new Date(now + 10_000).toISOString(),
          )) throw new Error("Scheduler lease is already held");
        },
        catch: (error) => error,
      }),
      () => Effect.sync(() => self.leases.releaseLease(self.runtime.ownerId)),
    );
    const seal = new AbortController();
    let admitting = true;
    const worker = yield* Effect.gen(function* () {
      while (admitting && !input.stop.aborted) {
        const result = yield* Effect.tryPromise({
          try: () => self.scheduler.tick(self.runtime.ownerId, seal.signal),
          catch: (error) => error,
        });
        if (result.kind === "idle") yield* Effect.sleep(1_000);
        else yield* Effect.yieldNow();
      }
    }).pipe(Effect.forkScoped);
    yield* Effect.addFinalizer(() => Effect.gen(function* () {
      admitting = false;
      yield* Effect.all([
        Fiber.await(worker),
        Effect.exit(Effect.tryPromise({ try: input.cancel, catch: (error) => error })),
      ], { concurrency: "unbounded" }).pipe(
        Effect.interruptible,
        Effect.timeoutOption(input.drainMs ?? 250),
      );
      seal.abort(new Error("Scheduler session sealed"));
      yield* Fiber.interrupt(worker);
    }));
    const heartbeat = Effect.gen(function* () {
      yield* Effect.sleep(3_000);
      const timestamp = yield* Clock.currentTimeMillis;
      yield* Effect.try({
        try: () => {
          if (!self.leases.heartbeatLease(
            self.runtime.ownerId,
            new Date(timestamp).toISOString(),
            new Date(timestamp + 10_000).toISOString(),
          )) throw new Error("Scheduler lease was lost");
        },
        catch: (error) => error,
      });
    }).pipe(Effect.forever);
    const stopped = Effect.async<void>((resume) => {
      /** Wakes the owner while allowing the pending tick to finish its grace period. */
      const onStop = (): void => resume(Effect.void);
      input.stop.addEventListener("abort", onStop, { once: true });
      if (input.stop.aborted) onStop();
      return Effect.sync(() => input.stop.removeEventListener("abort", onStop));
    });
    yield* Effect.raceFirst(Fiber.join(worker), Effect.raceFirst(heartbeat, stopped));
  }));
}
```

register finalizer 的順序是契約的一部分。drain/seal finalizer 在 worker 的 forkScoped 後登記，所以先 drain/seal，才 interrupt worker、release lease。不要將主 race 改成直接 race tick effect，否則 stop 會提前打斷 grace。

`input.cancel` 是下一步提供的安全 cancellation callback，會個別記錄 cancel/hook failure。此處只等待其 Exit，不重試，也不能讓 cancellation failure 跳過 seal。

- [ ] 添加下列 TestClock 情境到 daemon.test.ts，和既有六項行為一起驗收。

```ts
test("Effect drain seals a stuck tick at the configured deadline", async () => {
  const entered = Promise.withResolvers<void>();
  const cancelling = Promise.withResolvers<void>();
  const stop = new AbortController();
  let tickSignal: AbortSignal | undefined;
  let released = false;
  const daemon = new SchedulerDaemon({
    async tick(_owner, signal) {
      tickSignal = signal;
      entered.resolve();
      return new Promise(() => {});
    },
  }, {
    acquireLease: () => true,
    heartbeatLease: () => true,
    releaseLease: () => { released = true; return true; },
  }, { ownerId: "test-owner" });
  await Effect.runPromise(Effect.gen(function* () {
    const fiber = yield* Effect.fork(daemon.runEffect({
      stop: stop.signal,
      cancel: () => { cancelling.resolve(); return new Promise(() => {}); },
      drainMs: 250,
    }));
    yield* Effect.promise(() => entered.promise);
    stop.abort();
    yield* Effect.promise(() => cancelling.promise);
    yield* TestClock.adjust(249);
    expect(tickSignal?.aborted).toBe(false);
    expect(released).toBe(false);
    yield* TestClock.adjust(1);
    yield* Fiber.join(fiber);
    expect(tickSignal?.aborted).toBe(true);
    expect(released).toBe(true);
  }).pipe(Effect.provide(TestContext.TestContext)));
});
```

新增 imports 為 `Effect, Fiber, TestClock, TestContext`。這只是 deadline 的一個 boundary test，不新增完整 timing matrix。

- [ ] 執行 `rtk bun test test/scheduler/daemon.test.ts`。保持 lease conflict、pending heartbeat、takeover、stale delivery 與停止語意，不只是替換 assertions 讓新程式通過。

## Task 4: 單一 session 邊界與 bounded cleanup

新增 `src/cli/session-lifecycle.ts`。這個 module 只供 Fake 與正式 session 使用，不建立可註冊的 service framework。

- [ ] 先在 `test/cli/session-lifecycle.test.ts` 寫 resource-finalizer 與 error identity 測試，再建立下列完整 module。

```ts
import { Cause, Effect, Exit, Option, type Scope } from "effect";
import type { Logger } from "../runtime/logger";

/** Runs one scoped session and removes its signal listeners on every exit. */
export async function runSession(
  body: (stop: AbortSignal) => Effect.Effect<void, unknown, Scope.Scope>,
): Promise<void> {
  const stop = new AbortController();
  const program = Effect.scoped(Effect.gen(function* () {
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        /** Closes admission synchronously; repeated signals share the same shutdown. */
        const onSignal = (): void => stop.abort();
        process.on("SIGINT", onSignal);
        process.on("SIGTERM", onSignal);
        return onSignal;
      }),
      (onSignal) => Effect.sync(() => {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
      }),
    );
    yield* body(stop.signal);
  }));
  const exit = await Effect.runPromiseExit(program);
  if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
}

/** Reports a fixed safe diagnostic without allowing logging to block teardown. */
export function reportCleanup(logger: Logger, runId: string, code: string) {
  return Effect.tryPromise({
    try: () => logger.write({
      level: "warn", code, category: "infra", component: "cli",
      retryable: false, runId, message: "Scheduler cleanup did not finish normally",
    }),
    catch: () => undefined,
  }).pipe(Effect.catchAll(() => Effect.void), Effect.interruptible, Effect.timeoutOption(100), Effect.asVoid);
}

/** Bounds backend cleanup and preserves a pre-existing session failure. */
export function closeBackendEffect(
  close: () => Promise<void>,
  sessionExit: Exit.Exit<unknown, unknown>,
  logger: Logger,
  runId: string,
) {
  return Effect.gen(function* () {
    const result = yield* Effect.exit(Effect.tryPromise({
      try: close, catch: (error) => error,
    }).pipe(Effect.interruptible, Effect.timeoutOption(250)));
    if (Exit.isFailure(result)) {
      yield* reportCleanup(logger, runId, "SCHEDULER_BACKEND_CLOSE_FAILED");
      if (Exit.isSuccess(sessionExit)) yield* Effect.die(Cause.squash(result.cause));
    } else if (Option.isNone(result.value)) {
      yield* reportCleanup(logger, runId, "SCHEDULER_BACKEND_CLOSE_TIMEOUT");
    }
  });
}
```

fixed safe message 不串入原始 exception、token 或 provider response。100ms 只限制診斷等待；逾時的 logger Promise 不會因而真的停止。這不是新的使用者設定。

測試檔的最小完整起點如下，其餘 cleanup 個案直接重用此 logger，不建立 logging fixture matrix。

```ts
import { expect, test } from "bun:test";
import { Effect } from "effect";
import { closeBackendEffect, runSession } from "../../src/cli/session-lifecycle";

test("session failure survives failed cleanup and removes signal listeners", async () => {
  const primary = new Error("primary");
  const warnings: string[] = [];
  const logger = {
    async write(input: { code: string }) { warnings.push(input.code); },
    async error() {},
  };
  const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  let closes = 0;
  await expect(runSession(() => Effect.gen(function* () {
    yield* Effect.acquireRelease(Effect.void, (_resource, exit) => closeBackendEffect(
      async () => { closes += 1; throw new Error("secondary secret"); },
      exit, logger, "run-cleanup",
    ));
    yield* Effect.fail(primary);
  }))).rejects.toBe(primary);
  expect(closes).toBe(1);
  expect(warnings).toEqual(["SCHEDULER_BACKEND_CLOSE_FAILED"]);
  expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
});
```

- [ ] 加一個 close-only failure case，body 成功時應向外拋出原 cleanup error；加一個 never-resolving close case，使用 TestClock 驗證 250ms 後產生 timeout code 且 DB finalizer 仍執行。新測試不可真的等待長時間。
- [ ] 執行 `rtk bun test test/cli/session-lifecycle.test.ts`。全案 typecheck 在 Task 5 接通 runtime 後執行，避免把尚未轉換的舊 run caller 當成完成狀態。範例程式碼未在此次 planning turn 編譯；implementation 必須以實際 compiler 結果修正，不能把文件當驗證證據。

## Task 5: 接上真實與 Fake session，刪除舊 lifecycle

修改 runtime.ts、run.ts 及其測試。此 task 要與 daemon API 變更一起保持編譯通過，不能交付一半新一半舊的 owner。

- [ ] 先把 backend-session.test.ts 的既有 closeCalls expectation 由 2 改為 1。cleanupCalls 仍為 1。舊 runtime 應失敗，因為 signal shutdown 與 outer finally 都會呼叫 close。
- [ ] `daemonFor` 的 runtime 參數改為 `{ ownerId: runId }`，不再傳入 now/schedulerSleep。
- [ ] `runBackendSession` 回傳 runSession 的 Promise，將原方法主體放入它的 Effect.gen callback；callback 接收 stop signal。將現有 branch setup、preflight、advisor、error normalization 的程式保留，依以下表格做機械式 await 轉換，不改順序或訊息。

| 現有步驟 | Effect 接法 |
| --- | --- |
| createTaskBranchManager | Effect.tryPromise，catch 用既有 BACKEND_BRANCH_STARTUP_FAILED/attachRunId |
| preflight.assertReady | Effect.tryPromise，catch 用既有 GITHUB_PREFLIGHT_FAILED/attachRunId |
| backend factory | acquireRelease，closeBackendEffect 為唯一 backend finalizer |
| createModelAdvisor 與 compatible 檢查 | Effect.try 包住現有完整同步區塊，保留 BACKEND_MODEL_CATALOG_INCOMPATIBLE |
| openDatabase | Effect.try，catch 用既有 SCHEDULER_DATABASE_OPEN_FAILED/attachRunId |
| repo/hooks/publisher 建立 | Effect.sync 包住現有完整同步區塊 |
| STARTED/STOPPED log | Effect.tryPromise，保留既有欄位與錯誤處理 |

branch-manager bridge 的完整替代區塊如下。不新增自訂 bridge helper。

```ts
const branches = yield* Effect.tryPromise({
  try: () => createTaskBranchManager(input.repoPath, input.baseRef),
  catch: (error) => attachRunId(error, runId, {
    code: "BACKEND_BRANCH_STARTUP_FAILED",
    category: "startup", retryable: false, component: "cli",
    message: `Could not validate the ${backendLabel} repository and base ref`,
  }),
});
if (stop.aborted) return;
yield* Effect.tryPromise({
  try: async () => { await options.preflight?.assertReady(); },
  catch: (error) => attachRunId(error, runId, {
    code: "GITHUB_PREFLIGHT_FAILED",
    category: "startup", retryable: false, component: "cli",
    message: "GitHub authentication or repository access is unavailable",
  }),
});
if (stop.aborted) return;
```

`backendLabel` 保留現有的 `const backendLabel = input.backend`。兩個 try/catch 原區塊由以上區塊取代，不保留原 Promise 路徑。

- [ ] 在任何 backend 取得之前預先登記 DB finalizer，使用唯一 db reference，確保取得順序仍為 backend → DB，而釋放順序為 backend → DB。不得重新排序成先 DB 後 backend，否則現有 DB-open-failure 契約會改變。

```ts
let db: ReturnType<typeof openDatabase> | undefined;
yield* Effect.addFinalizer(() => Effect.sync(() => db?.close()));
const backend = yield* Effect.acquireRelease(
  Effect.tryPromise({ try: () => startBackend({ branches }), catch: (error) => error }),
  (resource, exit) => closeBackendEffect(() => resource.close(), exit, logger, runId),
);
if (stop.aborted) return;
```

logger 使用現有 loggerFor；在上述 block 前建立。`db = yield* Effect.try(...)` 仍使用原本 SCHEDULER_DATABASE_OPEN_FAILED normalization。不要再保留 backend.close 的 outer finally。

- [ ] 在 branch setup 後、preflight 後、backend factory 返回後檢查 `if (stop.aborted) return`。factory 沒有 AbortSignal 參數，不能假裝能中止它；如果 factory 永不返回，這次仍不能保證 bounded startup。factory 自己在 reject 前清理部分啟動資源的責任不變。
- [ ] 把原本 runDaemon 內的 active-attempt cancellation 移入 runtime 的 daemon.runEffect callback。下列區塊放在 repo、hooks、backend、logger 都已建立後。

```ts
yield* daemonFor(repo, backend.harness, runId, hooks, publisher).runEffect({
  stop,
  /** Requests both agent and hook cancellation while recording only safe diagnostics. */
  async cancel() {
    const active = repo.getRunningAttempt();
    await Promise.allSettled([
      Promise.resolve().then(() => active === undefined
        ? undefined : backend.harness.cancel(active.descriptor.attemptId)),
      Promise.resolve().then(() => hooks.stop()),
    ].map((action) => action.catch(() => logger.write({
        level: "warn", code: "SCHEDULER_CANCELLATION_FAILED", category: "infra",
        component: "cli", retryable: false, runId,
        message: "Scheduler cancellation did not finish normally",
    }))));
  },
});
```

Cancellation 與 logger 等待都被外層 drain deadline 限制，不另建 timeout。兩個 action 各自排程，即使一個同步 throw，另一個仍會被請求；各自記固定 diagnostic，不讓 pending action 擋住其他已知失敗的記錄。logger 本身失敗由 allSettled 觀察，不產生 unhandled rejection。

- [ ] runFake 同樣使用 runSession，DB 由 acquireRelease 取得，cancel callback 使用 fake.harness.cancel 與 hooks.stop。它沒有 backend close handle，不新增假 close。保留 fakePublisher 和 createStaticModelAdvisor。
- [ ] 刪除 runtime 的原 runDaemon、schedulerSleep 及 run.ts 對它們的 re-export。所有正式入口只在 runSession 使用一次 runPromiseExit。daemon 與 cancellation helper 不得各自建立 runPromise runtime。
- [ ] scheduler.test.ts 移除舊 schedulerSleep implementation 測試；其 idle/heartbeat 語意已移到 daemon TestClock。將原假的 runDaemon signal test 改為下面真實 session 邊界案例，不保留只因舊 stub 需要的 API。

在 backend-session.test.ts 使用現有 createRepository、seedReadyTask、sessionInput 與 compatibleCatalog，新增測試時用 factory-local latches 控制 first step、cancel、close，不用 process.emit 後立即假設排程已完成。既有 close-once 測試在 first step 後連續 emit SIGINT/SIGTERM，斷言一次 close 和無剩餘 listener。取消卡住案例的 harness.step 與 cancel 都回傳 pending Promise，runBackendSession 必須完成且 DB 可由第二個 connection 讀取，lease 已釋放；之後釋放 step，不能有晚到 transaction 或 unhandled rejection。

- [ ] 執行以下測試並記錄新增測試的實際名稱與數量，不使用前次試驗數字。

```bash
rtk bun test test/cli/backend-session.test.ts test/cli/scheduler.test.ts test/cli/session-lifecycle.test.ts test/scheduler/daemon.test.ts
rtk bun run typecheck
```

## Task 6: 正式驗收、文件與提交

- [x] 保留現有 deterministic-orchestrator 的三任務 rejection/recovery/dedup 測試。再於 scheduler.test.ts 加入下列完整 Fake Harness 測試，新增 Effect 與 SchedulerDaemon imports。publication receipt 返回時請求 stop，grace 讓同一 tick 完成 transaction。直接 runUntilIdle 的舊測試不能替代這條整合路徑。

```ts
test("Effect daemon completes the accepted Fake Harness flow", async () => {
  const { db, repo, scheduler, publisher } = setupAcceptedTask();
  const stop = new AbortController();
  const publish = publisher.publish.bind(publisher);
  publisher.publish = async (input) => {
    const receipt = await publish(input);
    stop.abort();
    return receipt;
  };
  const daemon = new SchedulerDaemon(scheduler, repo, { ownerId: "effect-vertical" });
  try {
    await Effect.runPromise(daemon.runEffect({ stop: stop.signal, async cancel() {} }));
    const task = db.query<{ status: string }, [string]>(
      "SELECT status FROM tasks WHERE id = ?",
    ).get("T1");
    expect(task?.status).toBe("done");
    const lease = db.query<{ owner_id: string }, []>(
      "SELECT owner_id FROM scheduler_lease WHERE lease_key = 'scheduler'",
    ).get();
    expect(lease).toBeNull();
  } finally {
    stop.abort();
    db.close();
  }
});
```
- [x] 跑受影響範圍，確認 Codex/Pi/ZCode 的既有 fake-client vertical tests 沒有介面回歸，不啟用實際 Pi/ZCode 不安全 backend。

```bash
rtk bun test test/scheduler test/cli test/store/orchestration-repository.test.ts test/runtime/errors-and-logging.test.ts test/integration/deterministic-orchestrator.test.ts test/agents/codex test/agents/pi/vertical.test.ts test/agents/zcode/vertical.test.ts
rtk bun run check
rtk proxy git diff --check
```

`bun run check` 包含 lint、typecheck、repository test script。外部測試保持原有 opt-in guard，不能因缺少權限而自行啟用。若失敗，報告確切 command/test 與是否基線已有，不提高 timeout 掩蓋 lifecycle hang。

- [x] 列出所有變更後的 await→repository 續行點，逐一確認 Task 2 的 guards 覆蓋到；並用 literal search 確認舊 nextHeartbeat、tickWithHeartbeats、shutdown Promise 和 schedulerSleep 已不在 production lifecycle。
- [x] 在 docs/architecture.md 加入下列段落，只有整合通過後才能寫入。

```text
The session runtime uses Effect scopes for backend and database ownership.
The daemon owns its lease, heartbeat and tick worker in a nested scope.
Signals close admission immediately; pending work has a bounded grace period
before a separate continuation signal prevents late scheduler, hook and
publication callbacks from accessing the database. SQLite lease fencing
remains authoritative. Backend close is requested once before database close;
a close timeout reports incomplete cleanup rather than confirmed process exit.
```

- [x] 檢查實际刪除與新增的 ownership code。不能保留兩套 production paths 或加 feature flag 掩蓋尚未完成的遷移。
- [x] 按相依順序提交 safety guards、Effect lifecycle 整合、驗證/文件。每個 commit 必須可編譯與測試；Task 3–5 尚未完全接通時不要提交 broken intermediate state。只 stage 本計畫檔案，不使用 git add .。

## 合併條件與停止條件

合併前必須同時滿足：相同 task/retry/model 行為、所有必要測試通過、late delivery/hook/publication 不訪問已關閉 DB、lease takeover 安全、單一 backend close、signal listeners 清理、原始錯誤 identity 及安全診斷保留、舊 owner 已移除。

真實 Codex smoke 另行取得執行授權及成本預算，在專用 checkout 執行一條 accepted Scout → Implement → detached Review，並檢查 cancellation 後 subprocess 是否退出。不得直接拿使用者工作目錄跑實際 agent。未執行時交付必須標示「本機 deterministic 驗證完成，Real Codex smoke 未驗證」，不能宣稱 production-ready 全面驗收。

如果 audit 發現 backend callback 直接持有並寫 repository、或現有 guards 之外還有寫入來源，先停止在此邊界並補明確設計，不建立全 repository Proxy 或資料庫 wrapper。若 close timeout 後真實 child 仍持有 checkout、繼續修改檔案，不能只因 SQLite 已安全就接受整合，須另行處理 adapter teardown。

Rollback 不需要 DB migration。未合併時保留整合分支即可；已合併且需回復時逐一 revert 本次明確 commits，不 reset 使用者 worktree、不刪除 DB、attempt 或工作分支。可獨立保留經驗證的 continuation guards。

## 計畫自檢

- [x] 文件包含 production source、test、dependency 與 architecture 的修改位置。
- [x] 指出 lifecycle 範圍以外不改動的 schema、repository、retry 與 provider 介面。
- [x] 區分 admission stop、grace drain、continuation seal、resource close。
- [x] 列出 startup 不可取消、external side effect 不可撤回及 backend close timeout 的限制。
- [x] 列出先失敗後實作的測試、命令、驗收與回退方式。
- [x] 執行時用 compiler/tests 驗證文件內的候選程式碼，完成後填入真實結果。

## Execution receipt — 2026-09-04

Local deterministic validation complete; Real Codex smoke unverified;
the historical P1 below has a checkout-ownership follow-up implemented locally,
pending independent integration review and final user review. No merge is authorized.

The acceptance test `Effect daemon completes the accepted Fake Harness flow`
uses the real in-memory SQLite repository and the existing accepted-task Fake
Harness fixture. It invokes `SchedulerDaemon.runEffect`, requests stop only
after the real publication receipt returns, and proves that `T1` reaches
`done` and the scheduler lease row is absent. This is a post-implementation
integration acceptance test, not a retroactive RED/GREEN feature test.

Actual commands, all with real external agents disabled:

```text
rtk bun test test/scheduler/scheduler.test.ts
# 17 pass, 0 fail, 68 assertions

rtk proxy env AGILE_REAL_CODEX=0 bun test test/scheduler test/cli test/store/orchestration-repository.test.ts test/runtime/errors-and-logging.test.ts test/integration/deterministic-orchestrator.test.ts test/agents/codex test/agents/pi/vertical.test.ts test/agents/zcode/vertical.test.ts
# 218 pass, 0 fail, 1,071 assertions, 28 files; includes the deterministic three-task rejection/recovery/dedup flow and Codex/Pi/ZCode fake-client vertical coverage

rtk proxy env AGILE_REAL_CODEX=0 bun run check
# exit 0: 429 pass, 1 opt-in Real Codex skip, 0 fail, 1,668 assertions, 57 files
```

The unchanged lint baseline remains exit 0 with 30 warnings and 9 infos; this
work added no diagnostics. The first full check found one import-order error
in the newly edited scheduler test, which was fixed before the recorded clean
run. No timeout was increased.

Await-to-repository audit: `Scheduler.tick` checks the continuation seal after
each external await before repository work: `harness.step` before
`applyHarnessEvent`; `hooks.run` for posthook and prehook before their durable
outcomes; and `publisher.publish` before `completePublication` or
`failPublishing`. `TaskHookService` also checks after workspace preparation and
hook runner completion before writing hook receipts. Literal production search
found no `nextHeartbeat`, `tickWithHeartbeats`, `schedulerSleep`, `runDaemon`,
or retained shutdown-Promise owner path. The only Promise execution boundary is
`Effect.runPromiseExit` in `src/cli/session-lifecycle.ts`; no feature flag
keeps a second lifecycle path.

Historical P1 finding before the follow-up: a backend close may return from the session's 250ms wait while
the Codex child continues its existing two-second graceful-exit period before
SIGKILL. The stable dedicated checkout can then be reused before that child is
quiescent. SQLite sealing prevents late database continuations but cannot stop
late child filesystem writes. Backend startup is likewise not cancellable while
the `BackendFactory` Promise is pending because the interface has no
`AbortSignal`. No provider policy, interface, or timeout was changed here.

### Current checkout-handoff follow-up

The [checkout handoff safety plan](2026-09-04-checkout-handoff-safety.md) adds a
persistent exclusive guard before checkout setup. Clean teardown releases it
last; factory uncertainty, cancellation rejection, drain timeout and failed or
timed-out backend close retain it even after late completion. Different DB paths
cannot bypass it. The controlled CodexClient/non-agent child test observes a
write after session return and then proves successor refusal before checkout
validation, with the lock still retained after child exit. This resolves reuse
through the cooperative session API; it does not claim that a deadline kills
all writers or that hostile detached descendants cannot exist.

Stop all pre-guard Roc sessions before upgrading. A retained lock requires
manual recovery: stop every session, inspect the exact lock metadata, verify
and terminate remaining backend/hook/checkout-mutating children, inspect the
checkout, then remove only the exact `<canonical-repo>.agile-checkout.lock`.
Never delete a live owner's guard or use PID absence, elapsed time or SQLite
lease expiry as automatic takeover proof. Preserve checkout, DB and task branches.
See [architecture](../../architecture.md) for the full recovery contract.

The follow-up execution receipt records current checks separately from the
historical numbers above. Real external agents remain disabled; Real Codex
smoke is unverified. Independent branch review and user acceptance remain pending.
