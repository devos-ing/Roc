<p align="center">
  <img src="https://raw.githubusercontent.com/devos-ing/Roc/main/output/imagegen/roc-avatar-tech.png" alt="Roc 專案頭像" width="220" />
</p>

<p align="center">
  <a href="README.md">English</a> · <strong>繁體中文</strong>
</p>

# Roc

Roc 是一個本機命令列工具，帶領 Codex agents 走完整的敏捷軟件開發流程。
每個任務都會經過三個步驟：**Scout → Implement → Review**。

Scout 先研究任務，Implement 負責編寫程式，Review 則檢查完成後的指定
commit。Roc 會把進度和 token 用量儲存在 SQLite，因此重新啟動後也能繼續
工作。

如果 Review 拒絕工作結果，Roc 會關閉原本的任務，並建立一個包含程式碼和
意見的草稿 follow-up 任務。它會回到 ready backlog，不會無限重複同一個
任務。

Roc 目前提供：

- 永遠不使用 `low` thinking effort 的模型設定；
- 每個任務都有獨立 Git branch 和工作資料夾；
- Review 只讀取 Implement 完成的指定 commit；
- 儲存任務進度和 token 用量，並支援重新啟動；
- 在終端顯示 token 用量圖表；
- 一次性把已核准的 GitHub Issues 匯入 ready backlog；
- 限制 agents 可以使用的 skills 清單。

Roc 目前一次只處理一個任務。它不會合併或 push 程式碼、刪除任務 branch、
同時執行多個任務，或限制 token 用量。

## 快速開始

使用前需要：

- [Bun](https://bun.sh/) 1.3.0 或以上版本
- Git
- 匯入 Issues 時需要 [GitHub CLI](https://cli.github.com/)，並先執行
  `gh auth login`
- 使用 Codex mode 時需要 [Codex CLI](https://github.com/openai/codex)
- 建立 backlog 時需要 `grilling` skill：

```bash
npx skills add mattpocock/skills --skill grilling --global --agent codex --agent claude-code --agent cursor
```

不用全域安裝也可以執行（Roc 執行時仍然需要 Bun）：

```bash
npx roc-it@latest help
```

你也可以使用 Bun 的 package runner `bunx`：

```bash
bunx roc-it@latest help
```

或者全域安裝指令：

```bash
npm install -g roc-it@latest
```

在單一專案中啟用 Roc。這會建立本機資料庫，並為 Codex、Claude Code 和
Cursor 安裝建立任務的 skill：

```bash
npx roc-it@latest onboard
```

啟用時會顯示專案範圍、每個已完成步驟、所選週期、設定檔路徑，以及可直接複製
的下一步指引：如需要先安裝 `grilling`、用已安裝的任務 skill 建立第一個 backlog，
以及查看產生的任務。若稍後步驟停止，Roc 會列出已完成工作並提供重試指令；它不會
聲稱已回復任何變更。

使用 `npx roc-it@latest onboard --global` 可改為在使用者帳戶下安裝 skill；
全域啟用不會建立專案資料庫。

### 敏捷週期

啟用時可以選擇每日、每週，或自訂日數。Roc 會把這個選擇儲存在
`~/.config/roc/settings.json`，並套用到所有專案。

```json
{ "cycle": { "type": "weekly" } }
```

你可以隨時查看目前的敏捷週期：

```bash
npx roc-it@latest cycle current
```

建立任務的 skill 會把這個值加入 backlog manifest。例如：

```json
{ "cycleId": "2026-08-28-P14D" }
```

使用已安裝的 skill，從需求建立 backlog。在 Claude Code 或 Cursor 中使用：

```text
/roc-create-tasks Add team invitations
```

在 Codex 中使用：

```text
$roc-create-tasks Add team invitations
```

這個 skill 會使用 `grilling` 釐清需求、預覽完整任務清單和相依關係、等待你的
明確批准，然後把 JSON backlog 儲存在 `.agile/backlog` 並匯入 Roc。

### 匯入已核准的 GitHub Issues

在 Git repository 內執行 `npx roc-it@latest task import-github`，即可匯入帶有
固定 `roc:ready` label 的 open Issues。Roc 會透過 `gh` 找出目前的 GitHub
repository；此指令不提供 repository 或 label 覆寫選項。

每個合資格 Issue 的內容必須依以下次序各自包含一次二級標題。清單段落必須使用
連字號項目。

```markdown
## Problem

需要處理這項工作的原因。

## Desired outcome

完成後應達到的結果。

## Scope

- 包含的工作

## Non-goals

- None

## Acceptance criteria

- 可觀察的完成條件

## Validation

- 驗證指令或檢查
```

Issue `#42` 會成為目前 Agile Cycle 內的 `github-42` 任務。匯入是單向的：
之後再次執行時會直接跳過同一 ID，不會重新解析或更新已儲存的任務。新任務會
立即成為已核准的 ready 任務。`tokenCeiling` 預設為 `12000`，只作規劃估算；
Roc 不會在到達這個數值時停止執行。

全域安裝也會提供相容別名 `agile`，因此 `agile task import-github` 會執行
相同指令。

查看產生的任務：

```bash
npx roc-it@latest task list
```

使用 Codex 執行 backlog：

```bash
npx roc-it@latest scheduler run
```

Codex mode 會在 `<project>.agile-checkout` 建立或重用工作資料夾。Roc 不會在
目前 project 的來源資料夾切換 branch 或建立 commit。

## 運作方式

Roc 使用一個簡單的敏捷循環，讓每個任務依次交給三個專門的 agents：

```mermaid
flowchart LR
    B[Ready backlog] --> S[Scout]
    S --> I[Implement]
    I --> R[Review]
    R -->|Accepted| D[Done]
    R -->|Changes needed| F[Draft follow-up]
    F -->|Approved| B[Ready backlog]
```

- **Scout：**了解任務、檢查程式碼，並準備實作計劃。
- **Implement：**在獨立工作資料夾編寫程式。Roc 的 trusted Harness 會驗證
  結果並儲存為 commit。
- **Review：**獨立檢查該 commit，接受結果，或建立一個包含清楚意見、尚未
  核准的草稿 follow-up 任務。

Roc 每次只處理一個小任務。當 Review 要求修改時，Roc 會把意見送到一個尚未
核准的草稿 follow-up。只有獲得批准後，它才會回到 ready backlog。Roc 會儲存
進度，讓流程在重新啟動後繼續。

## 里程碑

Roc 正在逐步成長。

### 產品

- [x] **GitHub Issues backlog** — 把已核准的 GitHub Issues 加入 Roc 的
  ready backlog。
- [ ] **可見的任務看板** — 在 terminal UI 查看任務進度。
- [ ] **平行執行任務** — 同時執行互不依賴的任務。
- [ ] **遠端核准** — 遠端檢查並核准等待中的工作。
- [ ] **通知** — 在工作完成、失敗或需要核准時收到更新。

### Agent 支援

- [x] **OpenAI Codex** — 現已支援。
- [ ] **Pi agents** — 使用 Pi 執行 Roc 任務。
- [ ] **Claude Code** — 使用 Claude Code 執行 Roc 任務。
- [ ] **Cursor** — 使用 Cursor agents 執行 Roc 任務。

## 指令

內建的 `npx roc-it@latest help` 會顯示公開指令樹：

```text
開始使用
npx roc-it@latest onboard [--global]

管理週期
npx roc-it@latest cycle current

規劃工作
npx roc-it@latest task import FILE
npx roc-it@latest task import-github
npx roc-it@latest task list
npx roc-it@latest task hook trust <task-id> <prehook|posthook>
npx roc-it@latest tokens [--no-color]

執行工作
npx roc-it@latest scheduler run [--base REF]
npx roc-it@latest scheduler inspect

取得說明
npx roc-it@latest help
```

## 參與貢獻

開發與測試說明請參閱 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 參考項目

Roc 參考了以下專案的做法，但不包含它們的程式碼：

| 專案 | Roc 參考的部分 |
| --- | --- |
| [OpenAI Codex](https://github.com/openai/codex) | 執行 agents、追蹤 token 用量，以及保持獨立 Review |
| [OpenAI Symphony](https://github.com/openai/symphony) | 選擇任務、使用獨立工作資料夾，以及顯示執行進度 |
| [Pi](https://github.com/earendil-works/pi) | 儲存 session branches、縮短 context，以及執行其他工具 |
| [Beads](https://github.com/gastownhall/beads) | 尋找 ready 任務、連結任務，以及建立 follow-up 工作 |
| [Gas Town](https://github.com/gastownhall/gastown) | Agent 角色、卡住的任務、review 步驟，以及 terminal 畫面構思 |
| [OpenSpec](https://github.com/Fission-AI/OpenSpec) | 清楚的計劃、設計和任務清單 |

完整比較和資料來源請參閱
[專案研究](docs/research/agent-agile-orchestration-landscape.md)。

## 授權條款

Roc 使用 [Apache License 2.0](LICENSE)。只要遵守授權條款，你可以使用、修改及
分享 Roc，也可以用於商業用途。
