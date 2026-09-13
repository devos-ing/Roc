# OpenAmp 計畫交接

這個分支保存 Roc 轉向 OpenAmp 的產品計畫、架構圖與圖表驗證證據。尚未實作 OpenAmp，沒有新的 CLI 執行入口。

## 從這裡開始

- [完整計畫](../2026-09-13-openamp-cli-plan.md) 是目前的規劃依據。
- [初步方向](../2026-09-13-openamp-cli-direction.md) 保留早期討論，衝突時以完整計畫為準。
- [架構圖](architecture.html) 與 [交付流程圖](delivery-workflow.html) 是可在本機瀏覽器開啟的獨立 HTML。GitHub 會顯示原始碼，可下載後開啟。
- [圖表驗證紀錄](diagram-validation.json) 包含規格與 HTML 的 SHA-256、檢查範圍及截圖證據。

## 已確認的背景

使用者希望參考 Amp 的互動與委派方式，以 Pi agents 建立 CLI 優先的 OpenAmp。產品從 GitHub Issue 驅動的固定 Scout → Implement → Review 流程，轉向持續對話與按需要委派。

使用者已選定：

- 互動 CLI，由主 agent 按需要委派 Pi 子 agent。
- OpenAmp 通過驗收後，分階段取代 Roc 的 backlog 與 daemon 流程。
- 完成修改後自動建立 GitHub PR，合併由使用者決定。
- 先完成計畫與圖，再開始實作。

交付前是否必須由獨立 agent 審查仍未確認。計畫建議只在最終交付時強制審查。Node.js、Pi 原生 TUI、兩個子 agent 的並行上限及專用功能 worktree 都是待原型驗證的建議，不是已完成的功能。

## 下一步與完成條件

先審閱完整計畫並收斂審查政策。使用者同意開始實作後，從 M0 的 Pi TUI、extension、RPC、取消及恢復原型開始。M0 有驗證結果後才進入 M1。

里程碑順序為 M0 可行性 → M1 單 agent CLI → M2 可靠委派 → M3 協同實作 → M4 自動 PR → M5 替代 Roc。每個里程碑的驗收、停止條件與程式碼責任見完整計畫第 8–11 節。

## 分支與證據範圍

分支為 `codex/openamp-cli-plan`，從已提交的 `0469ef7156021e722e710f3db3266a5a372526ad` 建立。只提交本次 OpenAmp 文件與圖表，沒有帶入原工作目錄內其他未提交的功能、ObservationPack、套件或設定修改。

部分初始調查來自當時尚未提交的本機檔案。完整計畫已標記這項限制。開始實作前，以實際分支中的 package manifest、lockfile、Pi exports 與程式碼重新確認重用項目。

Pi SDK 文件隨安裝的固定版本套件提供，位於 `node_modules/@earendil-works/pi-coding-agent/docs/`。既有「同一功能共用 worktree」需求已摘要在完整計畫第 6 節，原始的另一項工作計畫不屬於此分支。

圖表通過 9/9 showcase 結構檢查及四種桌面尺寸檢查。截圖已檢視；此證據不代表 OpenAmp runtime 通過測試，也不代表 Amp 內部架構已被驗證。圖的固定操作介面使用英文。

## 架構預覽

![OpenAmp 架構提案](architecture.visual-check.1440x900.light.png)

## 交付流程預覽

![OpenAmp 從委派到 PR 的流程提案](delivery-workflow.visual-check.1440x900.light.png)
