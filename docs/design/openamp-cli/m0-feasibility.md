# OpenAmp M0 技術可行性結果

日期：2026-09-13。狀態：M0 通過。本紀錄只證明當時的技術方向；後續 production implementation 與驗證見 [M1–M5 里程碑證據](milestone-evidence.md)。

## 結論

保留提案的主要方向：OpenAmp 以 Node.js 使用 Pi 公開 SDK 及原生 `InteractiveMode`；主 agent 在同一 process，子 agent 使用獨立 RPC process。固定的 Pi 0.82.1 已提供所需 session、extension、受控 tools、steering、自訂持久化 entry 及 TUI 介面。

Pi 原生 TUI 可以由 inline extension 顯示 OpenAmp 狀態、agent widget 及 `/agents` command，不需要先建立自訂 renderer。M1 沿用原生 TUI。

## 執行證據

`tools/openamp-m0-probe.mjs` 使用 Pi 的 faux provider，不需要登入、網路或付費模型。自動 probe 和 focused test 證明：

- Node 可從 package public entry point import `InteractiveMode`、`createAgentSessionRuntime` 及 `RpcClient`。
- 明確 allowlist 只向模型提供 `bash` 及一個 custom tool；inline extension 正常載入。
- 同一 session 完成兩輪對話；custom tool 和允許的 shell command 正常執行。
- `tool_call` hook 拒絕 agent 的直接 remote-mutation command，沒有執行該命令。
- streaming 中的 steering message 進入 queue，之後送達並清空 queue。
- 取消 active stream 後保存 `aborted` 結果並回到 idle。
- session 關閉後以同一 session file 恢復，並找回穩定 result ID 的 custom entry。
- 公開 RPC client 可以啟動獨立 Node process、讀取 state 及正常停止。
- 原生 TUI 載入 `<inline:openamp-m0>`，顯示 `agents: 0 active`、OpenAmp agent widget 及 `/agents` notification，然後由 probe command 正常退出。

驗證命令：

```text
node tools/openamp-m0-probe.mjs
bun test test/openamp/m0-feasibility.test.ts
node tools/openamp-m0-probe.mjs --tui-manual
```

TUI 在 Linux orb 的終端以 Pi 0.82.1 和 faux model 實測；macOS 仍是 M1 的 acceptance platform，M0 不把 Linux 結果冒充 macOS 驗收。

## 發現的限制及決定

Pi 0.82.1 的 `RpcClient` 預設 `cliPath` 是相對的 `dist/cli.js`。從 Roc package 使用時，它會錯誤解析為 Roc checkout 下的 `dist/cli.js`。公開 export `@earendil-works/pi-coding-agent/rpc-entry` 可以用 `import.meta.resolve()` 正確解析，將這個絕對路徑傳給 `RpcClient` 後啟動成功。OpenAmp 必須集中提供這個參數；不能依賴 client 預設值。

Pi extension 的 `tool_call` 可以阻擋一般 agent bash tool，`user_bash` 也可以攔截 TUI 的 `!` command。這足以建立產品正常工具路徑的 command boundary，但不是 OS sandbox：同一使用者執行的惡意程式仍可能讀取憑證或繞過字串分類。M1–M3 應以受控 command runner、縮減 child process environment 和明確工具集實作；M4 前仍須通過 writer 故障注入，不能把 M0 結果描述成安全隔離。

這次 probe 沒有測試真實 provider 登入、付費模型品質、macOS terminal 相容性、compaction 時序、多個 child process、worktree 整合或 GitHub publication。後續本機測試已涵蓋 child process、worktree 整合及 GitHub publication fault-injection；前三項外部驗收仍未宣告完成。
