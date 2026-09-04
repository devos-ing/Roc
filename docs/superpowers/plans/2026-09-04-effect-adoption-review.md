# Effect lifecycle comparison Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement approved follow-up work task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 用相同生命週期契約比較原生 async 與 Effect，決定 Roc 的下一個導入範圍。

**Architecture:** 本次完成隔離對照實驗，沒有替換 production runtime。兩個版本共用真實 SQLite repository 與可控制的 backend，分別管理 worker、heartbeat、drain 和資源關閉。下一個候選範圍是完整 session lifecycle，不是只在 daemon 外包 Effect。

**Tech Stack:** Bun 1.3.8、TypeScript、SQLite；實驗固定 Effect 3.22.1，不代表最新版本。

## 決策

撤回前版「daemon 102 行對 117 行，所以暫不導入」的判斷。那次比較只測了一個狹窄包裝，不能回答完整 lifecycle 是否更適合 Effect。

這次兩個實作都通過相同的 9 個情境。原生實作 82 行，Effect 81 行，均包含 imports、註解與空行，不含共用契約與測試。一行差異沒有決策意義。

我的建議是讓 Effect 進入下一輪真實 session 整合驗證。已有證據的收益是把 worker、heartbeat、計時與逆序清理交給同一套 runtime，減少自行維護的 controller、timer 和錯誤暫存狀態。這不是 Effect 全面勝出，更不是已經完成 production migration。

原生 async 仍是可行方案。Pi 和 OMP 證明這些行為可以直接實作；它們沒有使用 Effect，不代表 Roc 不該用。

## Pi 與 Oh My Pi 提供的參考

查核日期為 2026-09-04，引用固定 revision，避免 main 後續變動。

- Pi 在 run lifecycle 的 finally 結束狀態，abort 與 waitForIdle 分開。事件 subscriber 處理完成後才算 idle。[Pi lifecycle](https://github.com/earendil-works/pi/blob/e44d75c20a51142abc056c243b13c1d7bb4be687/packages/agent/src/agent.ts#L486-L590)
- OMP 的 core emitter 不等待 async subscriber，session 因此另外追蹤並排空 event handlers。[OMP event handlers](https://github.com/can1357/oh-my-pi/blob/c4da0d08e8275659f3e09cf381c7df7018a19025/packages/coding-agent/src/session/agent-session.ts#L2390-L2434)
- OMP 同步關閉新工作入口，重複 dispose 共用一個 Promise。等待有期限；期限到了先 seal，再關閉 writer，避免晚到的 callback 寫入。[OMP dispose](https://github.com/can1357/oh-my-pi/blob/c4da0d08e8275659f3e09cf381c7df7018a19025/packages/coding-agent/src/session/agent-session.ts#L4347-L4390)、[OMP drain 與 seal](https://github.com/can1357/oh-my-pi/blob/c4da0d08e8275659f3e09cf381c7df7018a19025/packages/coding-agent/src/session/agent-session.ts#L4564-L4624)

檢查的 root、agent、ai、coding-agent manifests 沒有直接宣告 effect 或 @effect/*，選讀的 runtime 使用 Promise 與 AbortController。這不是對整個 repository 或 transitive dependencies 的斷言。

借用的是上述契約，不複製 OMP 全套 session machinery。它們的 conversation persistence 也不能替代 Roc 的 SQLite lease、attempt 狀態和 event dedup。

## 實際差異

| 面向 | 原生 async 實驗 | Effect 實驗 |
| --- | --- | --- |
| 資源所有權 | owned flag、巢狀 finally | acquireRelease、scope 逆序清理 |
| Worker 與 heartbeat | 各自的 AbortController、Promise.race、手動 join | forkScoped、Fiber.join、raceFirst |
| Grace deadline | bounded helper 建立 timer 並在 finally 取消 | timeoutOption 配合 interruptible |
| 停止入口 | 共用 start.stop，立即 abort，回傳相同 done | 相同；仍需 AbortSignal 到 Effect 的 listener |
| Grace drain | allSettled 等 worker 與 cancel | Fiber.await 加 Effect.exit，並行等待 |
| 晚到寫入 | 明確 seal，再關閉 store | 相同；fiber interruption 不取代 seal |
| 錯誤 | failed/failure 暫存，再拋原始錯誤 | Exit/Cause 在 Promise 邊界解包 |
| 時間測試 | 本次使用短實際 delay | 額外用 TestClock 推進 heartbeat 與 30 秒 deadline |

Effect 的 finalizer 不應直接套 timeout 就假設能中止所有工作。本實驗在可放棄等待的 Promise 部分明確使用 interruptible，保留外層清理。資源清理的逆序規則由 [Effect Scope](https://www.effect.website/docs/v3/resource-management/scope) 提供。

TestClock 測試確認 29,999ms 時尚未關閉，再推進 1ms 才完成 drain deadline，無須真的等 30 秒。[Effect TestClock](https://effect.website/docs/v3/testing/testclock)

原生方案也能使用注入 clock 或 fake timers；本次沒有做原生虛擬時鐘版本，不能據此聲稱只有 Effect 可以 deterministic testing。兩個實驗也都保留 running/completed 狀態，Effect 沒有消除所有協調邏輯。

## 驗證結果

共同情境各跑兩個版本，共 18 tests，全部通過。

1. 真實事件 transaction 完成後才關閉資源。
2. 停止時等待 event handler，重複 stop 共用完成 Promise，只取消與關閉一次。
3. cancellation 不回應時按期限關閉，晚到寫入被 seal 擋住。
4. pending tick 期間偵測 lease 遺失，不釋放新 owner's lease。
5. pending tick 期間維持 heartbeat，關閉後 heartbeat 不再執行。
6. backend startup 拋錯，已取得的 lease 和 DB 仍被釋放。
7. backend close 拋錯，原始 error identity 保留，DB 仍關閉。
8. backend close 卡住，期限後仍釋放 DB。
9. tick 與 cleanup 同時失敗，對外保留 tick error identity。

加上 Effect TestClock 測試，總計 19 pass、0 fail、53 assertions。隔離 TypeScript check 通過。

先以未實作版本確認基本測試失敗，再完成 happy path。加入生命週期情境後出現 8 個預期失敗，再補齊兩個實作；最後加入 close deadline、雙重錯誤與 TestClock 檢查。

目前 production 的 daemon、backend session、CLI scheduler 與 deterministic orchestrator 回歸測試為 20 pass、0 fail、107 assertions。它們驗證既有程式，沒有跑在 Effect 替代版本上。

## 實驗檔案與重跑方式

全部保留在本機忽略目錄，沒有加入正式 dependency，也沒有刪除試驗。

- [共同契約](/Users/roy/Documents/ChatGPT/agile-agents/.scratch/effect-lifecycle-comparison/contracts.ts)
- [原生實作](/Users/roy/Documents/ChatGPT/agile-agents/.scratch/effect-lifecycle-comparison/native.ts)
- [Effect 實作](/Users/roy/Documents/ChatGPT/agile-agents/.scratch/effect-lifecycle-comparison/effect.ts)
- [共同測試與 TestClock](/Users/roy/Documents/ChatGPT/agile-agents/.scratch/effect-lifecycle-comparison/comparison.test.ts)
- [上游查核筆記](/Users/roy/Documents/ChatGPT/agile-agents/.scratch/effect-pi-omp-references.md)

在 /Users/roy/Documents/ChatGPT/agile-agents/.scratch/effect-lifecycle-comparison 執行：

```bash
rtk bun install --frozen-lockfile
rtk bun test comparison.test.ts
rtk bun run typecheck
```

預期 19 pass、0 fail，typecheck exit 0。實驗自己的 package.json 與 bun.lock 固定依賴；.scratch 不會隨一般 git commit 分享，需要保留這些檔案才能在另一台機器重跑。

在 repository root 執行：

```bash
rtk bun test test/scheduler/daemon.test.ts test/cli/backend-session.test.ts test/cli/scheduler.test.ts test/integration/deterministic-orchestrator.test.ts
rtk proxy git diff -- src test package.json bun.lock
rtk proxy git diff --check
```

預期既有回歸測試 20 pass，production 與 dependency diff 為空。

## 本次工作

- [x] 查核 Pi 與 OMP 的 lifecycle、event drain 與 write barrier。
- [x] 為原生 async 與 Effect 設定相同契約。
- [x] 實作兩個隔離版本，使用相同真實 SQLite fixture。
- [x] 驗證 9 個共同情境與 Effect TestClock。
- [x] 重跑 4 個既有測試檔，確認 production 與根目錄 dependency 未改動。
- [x] 更新結論，保留可重跑的實驗。

## 下一步整合計畫

詳細待執行步驟見 [Effect session 整合計畫](/Users/roy/Documents/ChatGPT/agile-agents/docs/superpowers/plans/2026-09-04-effect-session-integration.md)。以下保留原比較結果的摘要，執行時以詳細計畫為準。

以下是建議的驗證順序，尚未執行，也不是全面遷移的批准。

1. 先在 test/cli/backend-session.test.ts 與 test/cli/scheduler.test.ts 鎖定真實入口的停止契約。沿用 Fake Harness，涵蓋延遲 delivery、重複 signal、部分 startup 失敗。確認所有會寫 repository 的 callback 是否都受同一入口管理。
2. 在隔離整合分支加入固定版本的 Effect dependency，於 src/cli/runtime.ts 與 src/scheduler/daemon.ts 建立單一 Effect-owned session。可抽出 src/cli/session-lifecycle.ts 放 scope 與 finalizers，但不建立通用 service registry。最外層只保留一個 Promise boundary，現有 AgentHarness interface 不改。
3. 將 backend、DB、lease、worker 和 heartbeat 的所有權接上真實資源。先建立寫入封鎖機制，再移除舊 shutdown 與 heartbeat 協調。Effect 版本需要刪除被替代的原生 lifecycle，不能讓兩套 owner 並存。
4. 重跑上述 20 個既有測試，加一條 Fake Harness 的 Scout → Implement → detached Review 流程，以及受控的 Real Codex cancellation smoke。外部測試須另行確認環境與授權，不在此次隔離實驗執行。
5. 通過後才接受整合分支的 production code、root package.json 與 lockfile 變更。若真實 adapter 仍有 scope 外的 callback 或寫入入口，先修所有權，不能只靠 tests 綠燈宣告完成。

Repository transaction、SQLite fencing、Zod schema、model routing、durable retry 和 provider recovery 都維持原設計。不要對整個 Scheduler.tick 套 Effect.retry，以免重播 side effects。

## 尚未證明的部分

本實驗是完整 lifecycle 契約的縮小模型，不是真實 backend 整合。只有一個 tick worker，假設 tick Promise 已包含該次事件處理；沒有重現 OMP 的任意 fire-and-forget subscriber 集合。seal 是測試邊界實作，不是宣稱 production 已有通用 seal API。

尚未驗證永不返回的 backend startup、OS signal/subprocess 結束、所有 adapter 的 cancellation、全套 repository tests、bundle 大小、啟動時間或吞吐量。逾時放棄等待 close 也不代表外部資源已真的停止。取消失敗、close timeout 與次要 cleanup error 的 sanitized logging 需在正式整合驗證。

此次未證明 typed errors、Layer、Stream 或 Schedule 對 Roc 的收益；它們不列入採用理由。

Ponytail 把試驗限制在 lifecycle，避免附帶改寫 schema 和 dependency injection。Unslop 用於整理比較與結論，沒有把「依賴較少」或「框架較完整」當成預設答案。
