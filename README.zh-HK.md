# OpenAmp

[English](README.md) · [繁體中文](README.zh-HK.md)

OpenAmp 是以 Pi 建立的互動 CLI。對話式主 agent 可按需要委派調查或實作、
整合經核對的 worktree 結果，並在修改 ready 時自動建立 pull request。
每次修改型 PR 版本都必須先通過獨立唯讀 Review；是否合併只由使用者決定。

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

- `/agents` 顯示 researcher 與 writer 狀態。
- `/agent-send <run-id> <message>` 向一個執行中的子 agent 補充指令。
- `/agent-cancel <run-id>` 取消指定子 agent，而且不會暗中重啟。
- Pi 原生的模型、登入、session、取消及 compaction 命令繼續可用。

調查子 agent 只有讀取工具；writer 在獨立 worktree 工作，並回傳經 Git 核對的
commit 供明確整合。一般 agent command boundary 會拒絕遠端 Git／GitHub 修改。
只有 Delivery 可以 push、建立或更新 PR；它不會呼叫 merge 或啟用 auto-merge。

不在 Git repository 時，OpenAmp 仍提供可恢復的 Pi 對話，但停用 writer 委派及
PR 交付。GitHub 暫時不可用時，本地修改及狀態會保留，登入後可再交付。

## 開發

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
```

設計及 milestone 證據位於
[`docs/design/openamp-cli`](docs/design/openamp-cli/README.md)。舊 Roc Issue backlog
與 daemon 原始碼仍可在 repository history 找到，但不再屬於 OpenAmp package
或 executable surface。

授權：[Apache 2.0](LICENSE)。
