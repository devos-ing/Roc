<p align="center">
  <img src="https://raw.githubusercontent.com/devos-ing/Roc/main/output/imagegen/roc-avatar-tech.png" alt="Roc project avatar" width="220" />
</p>

[English](README.md) · [繁體中文](README.zh-HK.md)

# Roc

透過聊天把需求拆成程式開發任務，由本機 daemon 執行、建立 pull request，
並更新任務狀態。你負責審查及合併結果。

## 怎樣運作

```mermaid
flowchart LR
    A["聊天釐清需求"] --> B["批准任務與規格"]
    B --> C["Roc daemon"]
    C --> D["Pi：Scout → Implement → Review"]
    D --> E["Pull request 與任務狀態"]
```

**Pi 是唯一執行核心。** 在 Pi 選擇 Codex、Claude 或 GLM 模型，Roc 使用 Pi 的
工具與 agent loop，不會啟動 Codex CLI 或 Claude Code。
一個 daemon 每次執行一項任務，每項任務保留自己的 branch。
`done` 表示 PR 已發佈，仍須由你合併。

**開發版本：**請依照下方指令使用這份原始碼。Pi 統一架構尚未發佈到 npm。
自動測試不代表真實模型流程已通過；詳見[驗證狀態](README.details.zh-HK.md#驗證狀態)。

## 開始使用

需要 Bun 1.3+、Node.js 22.19+、Git、GitHub CLI，以及專案的 build/test 工具。
先在同一台機器使用本機任務佇列。

### 1. 安裝及設定 Pi

```bash
npm install -g @earendil-works/pi-coding-agent
pi
```

在 Pi 使用 `/login` 登入，再以 `/model` 選擇支援 `high` reasoning 的模型。
在模型選單按 **Ctrl+S** 儲存為啟動預設。
Claude、GLM 的 API key 設定見[provider 設定](README.details.zh-HK.md#pi-provider-設定)。

### 2. 設定 Roc 與專案

先在這份 Roc 原始碼目錄執行 `bun install`。再到你想讓 Roc 修改的專案執行以下指令，
把 entrypoint 替換為這份原始碼的絕對路徑：

```bash
export ROC_CLI_ENTRY=/absolute/path/to/Roc/src/cli/main.ts
cd /path/to/your-project
gh auth login
npx skills add mattpocock/skills --skill grilling --global --agent pi
npx skills add backnotprop/pstack --skill unslop --global --agent pi
bun "$ROC_CLI_ENTRY" onboard
pi
```

Onboarding 會建立資料庫、安裝 `roc-create-tasks`，並讓你選擇可信的 agent skills。
在 Pi 輸入：

```text
/skill:roc-create-tasks 加入團隊邀請功能。使用本機佇列，以及 ROC_CLI_ENTRY 指定的 Roc。
```

Skill 會透過提問釐清需求，提出任務與驗收條件，等你批准完整計劃後才儲存。

### 3. 啟動 daemon

退出 Pi，在同一個 terminal 執行；目標 branch 不是 `main` 時請替換名稱。
Pi 沒有內建 sandbox。下方變數表示你確認 Pi 工具擁有目前帳戶的權限；
無人看管的執行應另外使用 OS/container 隔離。

```bash
bun "$ROC_CLI_ENTRY" task list
ROC_ALLOW_UNSANDBOXED=1 bun "$ROC_CLI_ENTRY" scheduler run --base-branch main
```

保持 terminal 開啟。按 `Ctrl-C` 停止，再執行同一指令恢復已保存的工作。
任務 branch 位於相鄰的 `<project>.agile-checkout`。

### 4. 查看進度

另開 terminal，設定同一個 `ROC_CLI_ENTRY`，進入同一專案：

```bash
bun "$ROC_CLI_ENTRY" task board
```

看板是唯讀的。按 `Enter` 查看詳情，按 `Q` 離開。
也可使用 `task list`、`scheduler inspect` 或 `help`。

## 進一步設定

[詳細指南](README.details.zh-HK.md) 包含架構圖、provider 設定、GitHub Issues
共享任務、daemon 部署與恢復方式。先用同一台機器的兩個 clone，再搬移執行端。

開發與發版：[CONTRIBUTING.md](CONTRIBUTING.md)。
授權：[Apache 2.0](LICENSE)。
