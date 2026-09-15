# OpenAmp 互動 CLI 架構草案

> Workflow policy update: the [2026-09-15 minimal plan](2026-09-15-openamp-minimal-plan.md) supersedes the role model and milestone sequence below. The main coding thread plans and edits; Oracle advice and final review are optional. Requested final review uses a fresh session. Existing runtime and validation evidence remain relevant.

日期：2026-09-13。狀態：使用者已選定互動 CLI，以及主 agent 按需要委派 Pi 子 agent。以下實作選擇是提案，尚未以原型驗證。OpenAmp 是暫名。

本文件保留初步方向。後續產品決定、實作順序與驗收條件，以 [完整計畫](2026-09-13-openamp-cli-plan.md) 為準。使用者已選定 OpenAmp 分階段取代 Roc，完成修改後自動建立 GitHub PR，由使用者決定合併。

## 產品轉向

使用者進入專案後，直接與主 agent 對話、查看工具活動、補充要求，並按需要委派調查、實作或審查。GitHub Issue 不再是啟動對話的必要條件。

參考 Amp 公開的互動與委派行為。我們沒有 Amp 的內部實作證據，這份文件不聲稱複製其內部架構。

核心問題是：使用者能否在同一個終端掌握多個 Pi agents，並可靠地取得與整合它們的結果？

## 建議的實作形狀

先以 Node.js 啟動 Pi 的原生互動模式與受控 extension。Pi 負責主 agent 的模型呼叫、編輯工具、串流、對話儲存及 context compaction。OpenAmp 負責子 agent 的生命週期、工作目錄、結果交付及狀態顯示。

主 agent 透過 extension 的委派工具呼叫本地 supervisor。每個子 agent 使用獨立 Pi RPC process 和 session。第一版只允許主 agent 委派，避免遞迴產生無界工作。

| 模組 | 責任 |
| --- | --- |
| CLI 與 Pi 互動介面 | 輸入、工具活動、agent 狀態、模型設定及對話恢復 |
| 本地 supervisor | 啟動、傳訊、取消、並行上限，以及交付子 agent 結果 |
| Pi agent session | 執行模型與工具，保留各自的對話及用量 |
| Workspace 管理 | 固定起始 commit、配置寫入者 worktree，以及整合明確的結果 commit |

Supervisor 由 CLI process 持有，第一版不需要常駐 daemon。離開 CLI 時取消並確認子 process 結束。之後恢復對話不代表背景工作曾持續運行。

Pi 已有 session 持久化。OpenAmp 只另外儲存 parent、child、session 路徑、工作目錄、起始 commit、狀態及結果識別等必要 metadata。避免建立另一份完整對話紀錄。結果交付以穩定 ID 記錄，防止恢復後重複送入主對話。

## 使用者可見的第一版

以下指令是提案，尚未存在：

```text
openamp                    開始互動對話
openamp --resume <id>      恢復已儲存的對話
```

在對話內，使用者可以要求「請另一個 agent 調查這個錯誤」，並透過 agent 清單查看狀態、傳送補充要求或取消工作。

專家先用角色設定表達，例如調查與審查所用的 prompt、工具及模型。按需委派，不強制每次修改都經過 Scout、Implement、Review。

主 agent 與子 agent 各自的模型和 reasoning 設定必須可見。角色名稱不代表固定供應商，也不把模型選擇藏在不可查證的自動路由裡。

## 工作目錄與結果整合

調查用子 agent 預設只獲得必要讀取工具。工具權限需要實作，角色 prompt 不能充當權限限制。任意 shell 執行不能視為只讀。

需要修改程式碼的子 agent 各自取得 worktree，並以固定 commit 為基準。第一版不自動複製主目錄內未提交的修改；缺少必要上下文時要先說明。

Supervisor 回傳修改摘要、測試證據、起始 commit 及結果 commit。只有主工作流程可以整合結果，同時只進行一次整合。整合前確認目標狀態，遇到衝突或不明 Git 狀態便停止並保留工作。

Worktree 分離檔案狀態，並不提供 OS sandbox。子 agent 權限不得超過使用者已授予的執行權限。這個限制沿用 Roc 對 Pi 的現有說明。

## Roc 的沿用與替換

| 現有內容 | 處理方式 |
| --- | --- |
| Pi 登入與模型設定 | 沿用已驗證行為，整理產品名稱及設定歸屬 |
| Pi RPC client | 沿用協定與取消、清理經驗；目前使用 Bun.Subprocess，Node 路徑需改寫或採用 Pi 提供的 client |
| Git worktree 與 commit 檢查 | 沿用必要檢查，解除 GitHub Issue ID 和單一實作 commit 流程的綁定 |
| 用量與安全錯誤處理 | 沿用並加入 parent、child 歸屬 |
| GitHubTaskRunner 與角色契約 | 不作為互動 session 核心；其輸入與生命週期綁定批准的 Issue 和角色任務 |
| 強制 Scout → Implement → Review | 從預設互動路徑移除；獨立審查能力仍可按需要呼叫 |
| GitHub checkpoint 與 backlog scheduler | 留在目前 Roc 流程，待互動版本通過驗收後決定退役或另行交付 |

遷移先建立一條完整的互動路徑。新路徑通過驗收後，再依產品決定刪除過時的 Roc 路徑，避免長期維持兩套設定與狀態系統。本提案沒有重新命名套件，也沒有修改現有執行流程。

## 最小里程碑

1. 單 agent CLI：啟動 Pi 互動模式、登入、串流工具輸出、追加指令、取消，以及重新開啟對話。先驗證 Node 啟動、正常退出和 extension 整合。
2. 委派調查：主 agent 啟動一個讀取型子 agent。使用者看到狀態，可以傳訊和取消，結果只送回一次。這是第一個 OpenAmp 協作驗收點。
3. 委派實作：加入獨立 worktree、結果 commit、循序整合及按需獨立審查。以兩個不相依任務證明並行流程。

背景常駐執行、遠端機器、網頁與手機介面、多人協作、自動 GitHub backlog 和自動合併延後。第一版先交付本地可用的完整互動流程。

## 驗證與刪減實驗

最小測試組合是：一個主 agent 委派子 agent 並收到結果的垂直整合測試，加上取消清理、恢復不重複交付，以及 Git 衝突保留工作的必要邊界測試。執行中的修改遇到 process 中斷時標為 interrupted，不能自動重播有副作用的工具。

Pi 的 session 恢復能力有文件支持，但 Roc 現有 harness 不提供一般互動 reattach。必須以本專案固定版本實測多輪恢復、extension 重新綁定和子 agent 結果去重。

依 repository 的設計簡化規則，原型每次刪去一項設計並驗證使用情境：先省略獨立 daemon，再省略第二份對話儲存，最後省略自訂終端 renderer。若 Pi 既有能力仍滿足需求，就保留刪減。這些實驗尚未執行。

如果 Pi 原生介面無法呈現可用的 agent 狀態及操作，才考慮以 pi-tui 建立自訂介面並透過 RPC 控制主 agent。這個選擇由原型結果決定，避免提前重做終端編輯與顯示。

## 證據與未決事項

- 已驗證：目前 package.json 固定 Pi 0.82.1，包含 coding-agent、agent-core、ai 與 tui。
- 已驗證：src/agents/pi/client.ts 以獨立 process 的 cwd 運行 Pi RPC，並管理事件及 process 關閉。
- 已驗證：本機 Pi SDK 文件提供 InteractiveMode、AgentSessionRuntime、session 恢復和 steering。Pi README 明確把多 agent 實作留給 extensions 或外部協調。
- 已驗證：Amp 公開文件描述互動 CLI、獨立 agent 對話及工作目錄。這只證明公開行為。
- 推論：Pi 原生互動模式加 supervisor，能比另寫完整 CLI 更快驗證此產品方向。尚未做對照原型。
- 假設：OpenAmp 是暫名，第一版以本機單一使用者為目標。
- 待確認：最終命名及發布方式，以及現有 Roc backlog 功能的退役安排。這些決定不阻擋單 agent 原型。

參考：[Roc 現有架構](../architecture.md)、[Amp CLI](https://ampcode.com/docs/cli)、[Amp agent 委派](https://ampcode.com/docs/orbs/agent-to-agent)。Pi 版本證據來自本專案 node_modules/@earendil-works/pi-coding-agent/docs/sdk.md、docs/rpc.md 及 README.md。
