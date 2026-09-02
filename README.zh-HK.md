<p align="center">
  <img src="https://raw.githubusercontent.com/devos-ing/Roc/main/output/imagegen/roc-avatar-tech.png" alt="Roc 專案頭像" width="220" />
</p>

<p align="center">
  <a href="README.md">English</a> · <strong>繁體中文</strong>
</p>

# Roc

Roc 會讓程式開發任務依次經過幾個固定步驟：

```text
Ready → Scout → Implement → Review → Pull request → Done
```

- Scout 讀取任務，了解程式碼並準備實作計劃。
- Implement 在獨立 Git branch 編寫程式，完成後建立 commit。
- Review 只檢查該 commit，不會修改程式碼。
- Roc 會把通過 Review 的 commit 發佈成 pull request。

Roc 會把每個任務和執行記錄儲存在 SQLite。停止程式後，之後仍可繼續。
如果 Review 不接受結果，Roc 會建立一個包含意見的草稿 follow-up 任務，
不會不停重試同一項工作。

Roc 每次只執行一個任務。它會 push 已接受的任務 branch，並建立或更新
pull request。它不會 merge pull request 或刪除 branch。

## 開始使用

你需要 [Bun](https://bun.sh/) 1.3 或以上版本、Git、
[Codex CLI](https://github.com/openai/codex)，以及已執行 `gh auth login` 的
[GitHub CLI](https://cli.github.com/)。

在 Git 專案內執行：

```bash
npx roc-it@latest onboard
```

Onboarding 會建立 Roc 的本機資料庫，並安裝兩個 skills：

- `roc-create-tasks` 把需求整理成經你批准的 backlog。
- `pr-review-to-closure` 在重複審查 pull request 時追蹤問題。

重複 PR 審查 skill 需要 Python 3.9 或以上版本。Roc 的 scheduler 和 task
指令只需要 Bun。

在 Codex 建立 backlog：

```text
$roc-create-tasks 加入團隊邀請功能
```

這個 skill 會先顯示建議的任務，得到你批准後才會匯入。它需要
`grilling` skill，你可以用以下指令安裝：

```bash
npx skills add mattpocock/skills --skill grilling --global --agent codex
```

查看任務、開始執行，然後打開看板：

```bash
npx roc-it@latest task list
npx roc-it@latest scheduler run --base-branch main
npx roc-it@latest task board
```

Roc 會在名為 `<project>.agile-checkout` 的相鄰資料夾編寫任務程式碼。
目前 checkout 會留在原有 branch。

## 任務看板

看板是唯讀 terminal UI，目前使用英文介面。寬版保留四個任務欄和右側預覽；
窄版會上下排列，並以全畫面顯示詳情。實際畫面如下：

```text
Cycle 2026-W35 · 4 tasks · 8420 / 12000 tok

Ready · 1                   │ In progress · 1             │ Attention · 1               │ Done · 1
─────────────────────────── │ ─────────────────────────── │ ─────────────────────────── │ ───────────────────────────
    email  Add email login  │ ▌ ● api  Build auth API     │     tests  Fix auth tests   │   d to expand
    ready                   │     implement · implementing│     needs_input             │
                            │                             │     blocked by api          │

↑↓ move · Space preview · Enter details · d Done · ? help · q quit
```

選取色條、語意狀態色和精簡的 token 摘要讓你不用以完整卡片邊框也能看清下一步。
詳情會按狀態、執行資料、相依關係和任務摘要分類。按 `Space` 快速預覽，按
`Enter` 查看完整資料。

快捷鍵包括：`↑`/`↓` 或 `J`/`K` 移動、`Space` 預覽、`Enter` 詳情、`D` 展開
Done、`R` 更新、`?` 說明、`Esc` 返回，以及 `Q` 或 `Ctrl-C` 離開。`task board`
和較短的 `tui` 指令會打開同一個唯讀看板；兩者都不會啟動 scheduler 或改動
任務。執行 `npx roc-it@latest task board --all` 可以包括舊 cycle 的任務。

要保留歷史但停用過時的 draft、needs_input、needs_replan 或 ready 任務，可執行：

```bash
npx roc-it@latest task retire TASK_ID --reason "已過時的方案" [--replacement TASK_ID]
```

沒有 replacement 時 Roc 會顯示 Archived；有 replacement 時則顯示 Superseded。
一般 task list 和 board 會隱藏 retired 任務；使用 `task list --history` 或
`task board --history` 可查看保留的原因、replacement 和退休時間。

## 任務怎樣執行

```mermaid
flowchart LR
    B[Ready] --> S[Scout 準備計劃]
    S --> I[Implement 編寫程式並建立 commit]
    I --> R[Review 檢查 commit]
    R -->|接受| P[Posthook 和 pull request]
    P --> D[Done]
    R -->|拒絕| F[草稿 follow-up]
```

每個任務都有自己的 branch，全部放在專用 checkout。Review 只會收到
Implement 建立的 commit，而且不能修改 working tree。

Review 接受結果後，Roc 會執行已信任的 posthook，並確認 Implement commit
是乾淨的。之後它會 push `agile/<task-id>`，再建立或更新一個 pull request。
發佈失敗會令任務進入 `needs_replan`，本機 commit 則會保留作恢復之用。

`--base-branch` 指定 pull request 的 GitHub 目標 branch。如果任務 branch
需要從某個本機 commit 開始，另行使用 `--base`。

Roc 會記錄任務狀態、執行次數、事件、model 選擇和 token 用量。Token target
只用作規劃估算。Agent 用量到達 target 時，Roc 不會強制停止。

## 實驗性 ZCode backend

Roc 預設使用 Codex。它也可以使用 Z.ai 桌面應用程式的 headless ZCode server：

```bash
cd /absolute/path/to/project
ROC_ZCODE_EXPERIMENTAL=1 npx roc-it@latest scheduler run --base-branch main --backend zcode
```

ZCode 需要同一部電腦上已登入的 Z.ai 桌面應用程式。Roc 會從
`~/.zcode/v2/config.json` 讀取已啟用的 provider，再透過 `ZCODE_BIN` 啟動
應用程式附帶的 CLI。該 CLI 沒有公開文件，日後版本可能會改變。

ZCode 沒有協定層級的檔案系統 sandbox。無人看管的 session 可以寫入 task
checkout 以外的位置，而且停用 command sandbox 的要求會自動獲准。只應在
僅開放 task checkout 的 OS sandbox 或 container 內使用這個 backend。
設定 `ROC_ZCODE_EXPERIMENTAL=1` 表示你接受這項風險。

## 其他加入任務的方法

匯入 Roc backlog JSON 檔案：

```bash
npx roc-it@latest task import .agile/backlog/my-backlog.json
```

或者匯入帶有 `roc:ready` label 的 open GitHub Issues：

```bash
npx roc-it@latest task import-github
```

GitHub 匯入是單向操作。Roc 匯入 Issue ID 後會跳過同一個 Issue，
所以日後修改 Issue 不會更新已儲存的任務。

## 重複審查 pull request

再次審查 pull request 時，可以要求 agent 使用已安裝的
`pr-review-to-closure` skill。它會保留固定的 finding ID、把新 head 與上次
審查結果比較，並在必要檢查通過後提供 merge 判斷。除非你明確要求，這個
skill 不會留言、批准、commit、push 或 merge。

## 常用指令

```text
npx roc-it@latest onboard                 在目前專案設定 Roc
npx roc-it@latest cycle current           顯示目前 Agile cycle
npx roc-it@latest task list [--history]   列出目前任務或保留歷史
npx roc-it@latest task retire TASK_ID --reason TEXT [--replacement TASK_ID]
npx roc-it@latest task board [--all] [--history] 打開唯讀看板
npx roc-it@latest tui                     打開唯讀看板
npx roc-it@latest scheduler run --base-branch BRANCH [--base REF] [--backend <name>]
npx roc-it@latest scheduler inspect       查看 scheduler 狀態
npx roc-it@latest tokens [--no-color]     顯示 token 用量
npx roc-it@latest help                    顯示所有指令
```

如果想使用較短的指令，可以全域安裝 `roc-it`：

```bash
npm install -g roc-it@latest
roc-it help
```

## 目前限制

Roc 現時支援 Codex 和實驗性 ZCode backend。它仍未支援平行執行任務、
遠端批准或通知。Pi、Claude Code 和 Cursor backend 仍在計劃中。

## 詳細資料

- [系統架構說明](docs/architecture.md)
- [互動式系統架構圖](output/archify/roc-system-architecture.html)
- [參與開發](CONTRIBUTING.md)
- [研究和專案比較](docs/research/agent-agile-orchestration-landscape.md)

## 授權條款

Roc 使用 [Apache License 2.0](LICENSE)。
