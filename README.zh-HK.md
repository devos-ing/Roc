# OpenAmp

[English](README.md) · [繁體中文](README.zh-HK.md)

OpenAmp 是以 Pi 建立的互動 CLI。對話式主 agent 可按需要委派調查或實作、
整合經核對的 worktree 結果，並在修改 ready 時自動建立 pull request。
主 agent 會規劃、修改程式碼及執行檢查。獨立唯讀 Review 改為按需要要求；
若要求 Review，必須通過才交付。未要求 Review 的 PR 會明確標示；是否合併只由使用者決定。

## 環境需求

- Node.js 22.19 或以上
- Git 與 GitHub CLI
- 已透過 Pi 設定的模型／provider
- 目標專案本身的 build 與 test 工具

## 開始使用

```bash
npm install --global openamp
openamp
```

OpenAmp 會建立專用的 `openamp/<change-id>` 功能 worktree。啟動它的原 checkout
及當中的未提交檔案保持不變。TUI 會顯示解析後的 workspace、branch、Pi 模型
及 OpenAmp 狀態。

```bash
openamp --base main
openamp --resume change-abc123def456
```

互動命令：

- `/plan` 展開或收起已保存的工作清單及證據備註。
- `/agents` 顯示 researcher 與 writer 狀態。
- `/agent-send <run-id> <message>` 向一個執行中的子 agent 補充指令。
- `/agent-cancel <run-id>` 取消指定子 agent，而且不會暗中重啟。
- Pi 原生的模型、登入、session、取消及 compaction 命令繼續可用。

調查子 agent 只有讀取工具；writer 在獨立 worktree 工作，並回傳經 Git 核對的
commit 供明確整合。一般 agent command boundary 會拒絕遠端 Git／GitHub 修改。
只有 Delivery 可以 push、建立或更新 PR；它不會呼叫 merge 或啟用 auto-merge。

不在 Git repository 時，OpenAmp 仍提供可恢復的 Pi 對話，但停用 writer 委派及
PR 交付。GitHub 暫時不可用時，本地修改及狀態會保留，登入後可再交付。

## 工作清單與進度

多步驟工作由主 agent 使用 `update_plan` 更新清單。Pi 原生 widget 顯示完成數量、目前步驟、阻塞原因、執行中的子 agent、最近工具活動及交付狀態。輸入 `/plan` 可查看全部步驟。

清單最多 12 項，同時只可有一項進行中。完成項目需要證據備註，阻塞項目需要原因；備註是 agent 的紀錄，不代表獨立驗證。恢復工作時會載入清單，每次主 agent 開始新回合也會收到最新清單，包括 compaction 之後。工具活動只保存名稱及狀態，不會在工作狀態中複製參數或輸出。勾選清單不等於 PR 審查核准。

## 按需要詢問 Oracle

主 coding model 繼續使用 Pi 原生模型設定。可為目前工作指定獨立 Oracle：

```bash
openamp --oracle-model openai-codex/gpt-6-astra
```

使用 Pi 中已登入的完整 `provider/model`。設定隨 change 保存；恢復時不傳此參數便保留原設定。Oracle 必須先確認指定模型及 `high` effort，才會收到問題，不會暗中換模型。

請主 agent 使用 `ask_oracle` 提出具體問題。工具先回傳 run ID 及狀態，唯讀建議會送回主對話一次。`agent_wait` 等待逾時不會停止工作；需要取消時使用 `/agent-cancel <run-id>`。Oracle 建議不等於 PR 審查核准。

## 開發

```bash
bun install --frozen-lockfile
bun run build
bun run typecheck
bun test
```

OpenAmp 以 TypeScript 實作。npm package 只包含編譯後的 `dist/openamp` Node.js
runtime，不會把 TypeScript source 當作 executable 發布。

設計及 milestone 證據位於
[`docs/design/openamp-cli`](docs/design/openamp-cli/README.md)。舊 Roc Issue backlog
與 daemon 原始碼仍可在 repository history 找到，但不再屬於 OpenAmp package
或 executable surface。

授權：[Apache 2.0](LICENSE)。
