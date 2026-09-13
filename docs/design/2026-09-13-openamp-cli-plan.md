# OpenAmp CLI 產品與交付計畫

日期：2026-09-13。狀態：M0–M5 的本機實作及可重現驗證已完成；真實 macOS、模型供應商及 GitHub 發布驗收仍待獲授權的目標環境。

本計畫取代 [初步方向草案](2026-09-13-openamp-cli-direction.md) 的實作順序。OpenAmp 是暫名。Amp 的公開行為是產品參考，並非其內部架構的證據。

## 1. 已決定的產品方向

使用者已選定以下方向：

- 互動 CLI 優先。使用者與主 agent 持續對話，主 agent 按需要委派 Pi 子 agent。
- Pi 提供模型與工具執行。OpenAmp 提供多 agent 協作、工作目錄管理與交付。
- OpenAmp 通過驗收後，分階段取代 Roc 的 GitHub backlog 與 daemon 流程。
- 完成修改後自動建立 GitHub PR。使用者決定是否合併。
- 先完成計畫及圖，再開始實作。

已決定所有修改型 PR 在交付前必須通過獨立 agent 審查。以下仍是待原型驗證的建議預設，不應混同已實測能力：Node.js 執行、先沿用 Pi 原生 TUI、本機單一使用者、同時最多兩個子 agent，以及同一功能共用一個主 worktree。

## 2. 第一版要完成的使用情境

使用者在 Git repository 執行 OpenAmp，登入模型供應商後提出需求。主 agent 可以直接修改，或委派讀取型調查與獨立實作。使用者能看到每個 agent 在做什麼、補充指令、停止工作，並於退出後恢復對話。

例如「加入團隊邀請，請另一個 agent 先查現有登入流程」。主 agent 保持對話，調查 agent 回傳來源證據。需要平行實作時，寫入者取得獨立 worktree，主流程逐一整合結果。整體驗證及最終版本的獨立審查通過後，OpenAmp 自動 commit、push 功能分支並建立一個 PR，再回報連結、驗證及審查證據。

同一功能的後續修改更新同一分支和 PR，不因一次追問就建立新 PR。已合併或已關閉的 PR 不自動重新使用；新增功能以新的 change 身分處理。

純調查沒有修改時，回覆研究結果即可。PR 自動交付只適用於使用者要求修改且變更已達成驗收條件的工作。

### 第一版的範圍

| 必須包含 | 延後 |
| --- | --- |
| 登入、互動輸入、串流、取消及恢復 | 遠端 runner、雲端機器及常駐背景 daemon |
| 子 agent 狀態、傳訊及結果交付 | Web、手機介面與多人同步 |
| Pi 模型與 reasoning 設定可見 | 自動尋找最佳模型的路由演算法 |
| 有上限的委派與獨立工作目錄 | 子 agent 遞迴委派、跨 repository 實作 |
| 修改整合、驗證、強制獨立審查及自動 PR | 自動合併、GitHub merge queue、完整 CI 修復循環 |
| 已信任的 skills 與 repository 指引 | Plugin marketplace、MCP 管理介面及第三方任意 extension 相容性 |

首發支援以 macOS 為驗收平台。Linux 相容性列入發布前 smoke test；Windows 支援不作為這一版的完成條件。以上是建議的驗收範圍。

## 3. 架構與圖

- [互動架構圖](openamp-cli/architecture.html)：Pi 與 OpenAmp 的分工、子 process 和儲存關係。
- [委派到 PR 流程圖](openamp-cli/delivery-workflow.html)：正常交付、驗證失敗，以及使用者合併的分界。
- 圖的規格保留於 [architecture.json](openamp-cli/architecture.json) 與 [delivery-workflow.json](openamp-cli/delivery-workflow.json)。圖描述目標設計，不代表目前程式已具備這些模組。

圖的內容使用繁體中文。Archify 固定操作介面及 HTML 語言標記採英文 fallback。

兩張圖均通過 9/9 showcase 檢查，零錯誤、零警告；四種桌面尺寸均無溢出，最小與最大尺寸的明暗主題截圖已檢視。圖的 SHA-256、檢查範圍及截圖證據見 [圖表驗證紀錄](openamp-cli/diagram-validation.json)。這些結果只驗證文件圖表，不驗證 OpenAmp 功能。

### 架構決定 A：沿用 Pi 原生 TUI

以 Node.js 啟動 Pi 的 `InteractiveMode` 和 `AgentSessionRuntime`。一個受控 extension 提供委派工具、狀態顯示及子 agent 操作。本地 supervisor 與 CLI 同 process，沒有額外網路服務。

選擇這條路，是因為 Pi 已提供輸入編輯、事件、session、模型及 context compaction。自行建立整套 TUI 會先花時間重做這些功能。M0 必須證明原生介面可顯示 agent 狀態、取消與傳訊；若不成立，才採用 pi-tui 加 RPC 的自訂介面。

不把現有 `GitHubTaskRunner` 改成萬用 session 管理器。其契約綁定 Issue、批准規格與角色 attempt，會迫使一般對話攜帶不需要的資料。

### 架構決定 B：Pi 負責執行，OpenAmp 負責協作

| 模組 | 對外行為 | 必須隱藏的細節 |
| --- | --- | --- |
| CLI 與 extension | 對話、agent 清單、補充指令與取消 | 終端繪製、Pi event 轉換、session 更換後重新綁定 |
| Supervisor | 委派、傳訊、查狀態、取消 | process、佇列、並行上限、恢復、結果交付與用量歸屬 |
| Workspace | 準備功能工作目錄與子 worktree，整合指定結果 | Git 身分、基準 SHA、所有權、衝突及恢復檢查 |
| Delivery | 驗證並建立或更新該功能的 PR | 分支與 PR 身分、遠端查證、發布紀錄及未知結果處理 |

子 agent 使用獨立 Pi RPC process。Pi 的 cwd 是 process 狀態，不能把多個寫入者塞進同一 process 後依賴臨時切換 cwd。

所有層都只服務目前的 Pi backend。測試注入替身，不因此建立多供應商 agent framework 或通用事件平台。

### 架構決定 C：最少的本地持久化

Pi session 是對話及模型事件的唯一來源。OpenAmp 另外保留可驗證的協作與交付紀錄，供 process 已退出時恢復狀態。建議以版本化 JSON metadata、穩定 ID、暫存檔原子替換及單一寫入者實作，不引入資料庫。

不把 access token、完整工具輸出或第二份 chat transcript 存入 metadata。憑證仍由 Pi 和 GitHub CLI 管理。用量區分主 agent、子 agent 與 compaction；未回報的成本顯示 unavailable，不能算作零。

## 4. CLI 與對話契約

以下命令已由 OpenAmp extension 提供，並已確認不與這個固定 Pi 版本的既有命令衝突：

| 入口 | 使用者得到的行為 |
| --- | --- |
| `openamp` | 在目前 repository 開始新對話，顯示工作目錄、分支、模型與交付政策 |
| `openamp --resume <id>` | 驗證既有 session 與 workspace 後恢復同一功能 |
| `openamp --base <ref>` | 明確選擇新功能的基準；開始前顯示解析後的 commit 與 PR target |
| `/agents` | 顯示子 agent 的角色、模型、狀態、最近活動與結果 |
| agent 操作選單 | 傳送補充要求、查看結果、取消指定子 agent |
| Pi 原有模型與 session 操作 | 沿用相容命令，避免重新建立第二套選單 |

普通對話輸入送給主 agent。傳訊給子 agent 必須有明確目標，不能把一則使用者訊息廣播給所有寫入者。子結果以 agent 工具結果或 custom message 顯示，不能偽裝成使用者訊息。

第一次取消操作停止目前主 agent 回合；子 agent 是否仍在執行必須可見。關閉整個 CLI 則停止收新工作並取消所有子 agent。若清理無法確認，保留 ownership 與 attention 狀態，不顯示全部停止。

第一版取消後不暗中自動重啟工作。使用者的停止指令也禁止尚未開始的自動發布。

## 5. 協作資料與狀態

以下是資料責任，不是最終 TypeScript schema：

| 紀錄 | 必要資訊 |
| --- | --- |
| Conversation | 主 Pi session ID、repository 身分、change ID、交付設定 |
| Change | 主 worktree、功能分支、PR base、目前 head、已整合結果及 PR 身分 |
| Agent run | run ID、parent session、角色、有效模型與 effort、cwd、固定基準 SHA、狀態與結果 ID |
| Result | run ID、摘要、來源或測試證據、實際修改路徑、結果 commit、成功或失敗分類 |
| Publication | change ID、repository、base/head branch、預期 SHA、發布意圖、查證結果與 PR URL |

主 agent 加最多兩個子 agent 是第一版建議上限。子 agent 不獲得委派工具。容量用完時顯示 queued；只有 supervisor 可以分配名額。工作收到取消後，要確認 process 結束才釋放名額。

| 狀態 | 進入條件 | 下一步 |
| --- | --- | --- |
| `queued` | 委派已記錄，等待容量 | 啟動或取消 |
| `running` | process、session 與模型已確認 | 完成、失敗或取消 |
| `cancelling` | 已發送取消，尚未確認退出 | 確認退出後 `cancelled`，否則要求處理 |
| `completed` | 已取得並保存完整結果 | 交付結果；寫入結果可等待整合 |
| `failed` | 有明確失敗結果 | 顯示原因，由主流程決定後續 |
| `interrupted` | 重啟時不能證明先前執行已完成 | 查證既有 session、檔案與 process，不能盲目重播 |
| `cancelled` | 已確認停止 | 保留既有修改，等待後續決定 |

`completed` 只描述 agent run。功能可以另處於待整合、待驗證、待發布或 `pr_open`。`pr_open` 不是 `merged`。第一版沒有自動合併，也不需要常駐輪詢合併狀態。

### 結果交付與恢復

先保存結果，再把包含 result ID 的 custom message 加入正確的 parent session，最後標記交付完成。恢復時讀取 parent session 的持久化紀錄核對 ID；若訊息已存在，不能再插入一次。

Pi 的排隊訊息不一定已寫入 session，不能把 `sendMessage` 回傳當作持久化成功。M0/M2 必須測試排隊、compaction、重啟及 session 切換的時序。無法確定是否已交付時顯示待確認，不承諾跨兩份檔案的交易式 exactly-once。

使用者切換對話時，子 agent 結果仍屬於原 parent。第一版若不能可靠路由，便在切換前要求停止或等待現有子 agent，不把結果送到新對話。UI 明確呈現這項限制。

啟動前先寫入 run 意圖，再記錄子 session 身分。PID 不足以單獨證明 ownership。恢復時不得因 PID 不存在就刪除有未確認工作的 lock，也不能殺死身分不符的 process。

## 6. Git 工作目錄與修改整合

同一功能的持續對話共用一個主 worktree 和 branch。這沿用「同一功能接續開發」的使用需求，但不沿用 Roc 的 ticket-chain 資料模型。

建議新 repository 對話從已確認的 PR target commit 建立專用功能 worktree，預設使用 repository 的遠端預設分支。使用者可以明確選擇其他基準；若基準包含相對 PR target 的既有差異，開始前要說明這些差異也會出現在 PR，不能暗中納入。

原始工作目錄的未提交修改保留原狀，不自動搬入或提交。CLI 開始時列明來源 commit 與工作目錄；若任務必須依賴未提交修改，先要求使用者提供明確基準。離線或沒有 remote 時可以選擇本地 ref，發布維持不可用。M1 要把這個限制驗證為可理解的使用流程。

沒有 Git repository 時可以提供一般對話，但修改委派與自動 PR 顯示不可用，不暗中執行 git init。

寫入型子 agent 從主 worktree 的一個乾淨 checkpoint 建立自己的 worktree。主 agent 尚未提交的 OpenAmp 自有修改，先形成可追蹤的內部 commit。此 commit 不代表已發布或已完成驗收。

子 agent 完成時提交其工作並回傳明確的 base/head。Supervisor 驗證 branch、歷史、實際 diff 與 dirty 狀態，不信任模型文字中的 commit SHA。多個內部 commits 可以組成一項結果，無需保留 Roc「只准一個 commit」的限制。

整合一次只處理一項結果。先保存整合意圖與預期主 head，再以 Git 的 patch 或 cherry-pick 能力整合並記錄新 head。若整合前後主 head 出現非預期變化，停止並保留工作。多次對話仍在同一主 worktree 接續，不重建功能目錄。

主 agent 的修改與整合不能同時進行。整合期間暫停主 agent 新的寫入工具，工具完成後才取得整合時段。這是本產品自有工具的協作規則，不宣稱能限制任意外部程序修改 Git。

衝突時保留所有 worktrees 與結果 refs。不要 reset 使用者的修改，不重複套用已整合結果，也不要把衝突當成要重新請模型從頭實作的理由。

讀取型子 agent 僅啟用必要讀取與搜尋工具。不能用角色 prompt 宣稱只讀，也不能把任意 shell 視為只讀。寫入者仍可執行專案工具；Pi 沒有 OS sandbox，工作目錄分離不等於權限隔離。

主 agent 與子 agent 的一般工具不能擁有發布或合併介面。OpenAmp 提供的 command boundary 必須拒絕 `git push`、所有 `gh`、package publish、authenticated upload 及其他普通遠端修改命令。Agent shell 使用臨時隔離 HOME，忽略一般 Git 設定，且不接收 GitHub、npm、askpass 或 SSH-agent 憑證；Delivery 使用啟動時另外捕捉的受控 command environment。相同 OS 使用者的惡意程式碼仍可能刻意尋找原始憑證或另寫網路 client，因此這只能防止產品正常工具路徑意外越權，不宣稱為安全 sandbox。M0 先驗證 Pi 能否提供這個工具邊界；M3 再以實際 writer 驗證。若無法可靠維持「只有 Delivery 可發布、只有使用者可合併」，停止 M4 並先修訂執行隔離方案。

## 7. 自動 PR 的交付契約

交付前固定 repository、功能分支、base branch 與驗證命令。優先使用專案現有 scripts 和規範；無法確認必要驗證時顯示原因，不默認成功。

完成流程為：整合全部選定結果，形成最終本地 commit，執行功能整體驗證，以獨立 agent 審查該版本，保存發布意圖，再 push 功能分支及建立或更新 PR。驗證及審查後 workspace 必須仍對應該 commit；測試產生的新修改不能暗中夾帶發布。交付使用確定性程式檢查身分與遠端結果，不能只靠「請幫我開 PR」的 prompt。

每個修改型 PR 及其後續更新都必須由沒有參與該版本實作的另一個 Pi session，透過 OpenAmp 產生的完整 immutable diff bundle 唯讀檢查固定的最終 head、遠端 base 和目前需求版本。接受條件是明確 `accepted` 且沒有 blocking finding；非阻擋 finding 保留在交付證據及 PR 說明。審查不能修改實作。任何新 commit、需求變更或遠端 base 變更都使舊審查失效；Delivery 在審查前及發布前重驗遠端 base，修正後必須重新驗證並審查新的 head。審查無法完成或仍有 blocking finding 時，變更不是 ready，不自動建立或更新 PR。

主 agent 宣告 ready 時必須列出需求、完成證據與未解決事項。Supervisor 確認沒有尚未處理的使用者輸入、未整合的選定結果或活躍寫入者，再啟動交付。發布前收到新要求會使舊 ready 宣告失效。已送到 GitHub 的請求則先查證結果，不回滾或隱藏已建立的 PR；新要求另列為待完成工作。

建立 PR 是這個產品的預設行為，啟動時可見。第一版不推送 base branch、不呼叫 merge API，也不啟用 auto-merge。一般查詢與未完成工作不觸發 PR。

驗證未通過時保留工作並回報。第一版不自動發布失敗的 draft PR，也不建立無上限修復循環。建議最多一次自動修正回合，之後交由使用者決定是否繼續。

PR 必須包含需求摘要、實際變更、驗證命令與結果、未解決限制，以及可追蹤的 change ID。先以 repository、base/head branch 查找既有 PR，再建立新 PR。資料不完整、同分支有歧義或遠端 head 不符時停止。

Push 或 PR 建立逾時，可能已在 GitHub 成功。先查遠端 branch SHA 和對應 PR，再決定是否重試。只有讀回的 repository、branch、head 與預期值一致，才能標記 `pr_open` 並回報成功。重啟後以同一 publication 意圖續查，不建立第二個 PR。

GitHub 無法使用、沒有權限或沒有 remote 時，仍能完成本地修改與驗證，狀態為待發布並保留 commit。恢復登入後重試發布，不重新執行實作。

PR 建立後，CLI 顯示連結及 head。GitHub CI 尚未完成時如實顯示未知或待執行，不能把本地測試通過說成 GitHub checks 通過。

## 8. 實作里程碑與依賴

里程碑按 M0 → M1 → M2 → M3 → M4 → M5 前進。每個里程碑必須交付可執行行為與證據，不以「模組檔案已建立」作為完成。

| 里程碑 | 交付成果 | 驗收與停止條件 |
| --- | --- | --- |
| M0：技術可行性（已通過） | [Pi TUI/extension/RPC 相容性 probe 及決策紀錄](openamp-cli/m0-feasibility.md) | 固定 Pi 版本的 public exports、Node 啟動退出、受控工具及遠端修改拒絕規則、兩輪對話、streaming steer、取消、session 恢復與結果持久化均已驗證；`RpcClient` 必須明確傳入 public `rpc-entry` 路徑 |
| M1：單 agent CLI | 新對話、登入、功能 workspace、模型顯示、修改、取消與恢復 | 一個小型修改任務跨兩次啟動接續完成；原目錄 dirty files 不變；無 Git 狀態有明確處理 |
| M2：可靠委派 | 讀取型子 agent、上限、agent 清單、傳訊、結果路由及恢復 | 主對話可繼續；結果只交付一次；停止、崩潰與切換 session 不遺失或誤投結果 |
| M3：協同實作 | 子 worktrees、驗證結果 commit、主 workspace 循序整合、獨立審查能力 | 兩項獨立修改整合至同一功能；衝突保留工作；未確認 Git 結果不重播；writer 的正常工具路徑不能修改遠端 |
| M4：自動 PR | 最終驗證、強制獨立審查、publication 紀錄、GitHub 建立或更新 PR | 一次需求產生一個 PR；追問經重新驗證及審查後更新同一 PR；模擬 lost response 不重複發布；非 Delivery agent 不發布；不呼叫 merge |
| M5：替代 Roc | 新包安裝驗證、文件與設定切換、舊執行入口退役 | OpenAmp 完整流程通過；舊 worktree/session 可保留與辨識；發布包無 Roc runtime queue/daemon 路徑 |

M0–M5 的本機實作結果及逐項證據見 [里程碑驗證紀錄](openamp-cli/milestone-evidence.md)。M4 的 GitHub fault-injection 使用可控制替身，未將模擬結果冒充真實遠端發布。

### 程式碼落點

目前 production runtime 的責任如下：

- `src/openamp/cli.mjs`：Node 入口與 Pi 互動模式啟動。
- `src/openamp/extension.mjs`：委派工具、UI 操作與 Pi session 事件綁定。
- `src/openamp/supervisor.mjs`：子 agent process、狀態與結果交付。
- `src/openamp/state.mjs`：必要的協作、change 與 publication 紀錄。
- `src/openamp/workspace.mjs`：功能 workspace 與子結果整合。
- `src/openamp/delivery.mjs`：驗證與自動 PR。

保持模組數量由實際責任決定。可以合併尚未需要獨立介面的檔案，不先建立 Plugin API、通用 backend registry 或新的 event bus。

## 9. 重用、遷移及退役

原始規劃基準是 checkout 的 HEAD `0469ef7156021e722e710f3db3266a5a372526ad`；實作以規劃分支提交 `d0e69c7fa529bcf3c5f0f46629daf1df54a06351` 為基準。OpenAmp 使用自己的功能 worktree，沒有把來源 checkout 的 dirty files 搬入或提交。

| 現有項目 | 採用方式 |
| --- | --- |
| Pi 0.82.1 及其 TUI、session、模型管理 | 優先直接使用固定版本；先查 public exports，相容性測試通過才調整版本 |
| `src/agents/pi/client.ts` | 沿用已驗證的 JSONL、取消及 process 清理行為；Bun.Subprocess 不能直接搬到 Node |
| `src/workspace/task-branch.ts` | 沿用 Git 身分、所有權及保留工作的檢查；移除對 Issue ID 和單 commit 的假設 |
| 登入、settings、skills trust、runtime errors | 重用必要行為，不重複保存憑證或弱化既有信任選擇 |
| PR publisher 與 GitHub CLI 呼叫 | 重用查證與去重機制；解除 spec approval/checkpoint 對一般互動工作的綁定 |
| Fake Harness 與 Git fixtures | 重用可控制失敗與副作用的測試能力；不把舊角色契約搬入新產品 |
| ObservationPack、功能 ticket-chain | 分開辨識其當前狀態；不作為 OpenAmp MVP 必要依賴，不覆蓋其工作或暗中改寫資料 |

新產品 runtime 使用 Node.js；Bun 只負責 repository 測試。封裝驗證會實際 npm pack、安裝，再由 Node 執行 `openamp --help`，不以 Bun 相容性代替 Node 驗證。

M0–M4 期間舊 Roc 入口只作遷移保護，不繼續增加兩套產品的功能。M5 前停止舊 daemon 接收新工作，盤點活躍 Issue、PR、worktree、lock 與 session。未完成的舊工作要在既有版本完成或明確保留待處理；不得自動轉成 OpenAmp conversation。

OpenAmp 不讀寫 Roc 設定，因而沒有永久 fallback 鏈。公開 package manifest、文件、release workflow、CLI bin 和 test gate 已切換到 OpenAmp；Roc 專屬 onboarding skill 已刪除。舊 source/tests 留在 repository 作遷移與歷史回復參考，但不進 npm archive，也不再屬於 OpenAmp release gate。

不自動清理舊 GitHub Issues、PR 或有修改的 worktrees。保留可回到先前 Roc release 的說明。命名與 npm 套件是否可用在發布前確認；本計畫不宣稱 OpenAmp 名稱已可發布。

## 10. 驗證計畫

採用最少但能證明核心行為的測試。重要整合案例使用真實本機 Git worktree，模型與 GitHub 通訊使用可控制替身。

完整垂直案例：開始功能對話 → 調查委派 → 兩項獨立實作 → 途中退出及恢復 → 循序整合 → 整體驗證與獨立審查 → 自動建立 PR → 追問後重新驗證及審查並更新同一 PR。保留主/子 session、worktree、SHA、有效模型/effort、驗證和審查紀錄。

必要邊界案例：

- 子 process 啟動中取消、退出失敗，以及 ownership 未確認。
- 結果已保存但未送出、訊息已入 parent session 但 metadata 未標記、compaction 後查證 ID。
- 切換 parent session 期間子 agent 完成，不得投遞至錯誤對話。
- 子 agent 回傳無效 SHA、外部改動主 head、整合衝突或整合結果未知。
- 原目錄未提交檔案保留；不能把它們納入功能 commit。
- Push/PR 成功但 response 遺失；既有 PR head 被外部更改。
- 驗證失敗、審查未接受、審查後 head 改變或取消都不觸發發布。
- 主 agent 或子 agent 嘗試 push、建立 PR 或呼叫 merge API 時，正常工具路徑拒絕且 Delivery 沒有發布紀錄；整個產品流程沒有 merge API 呼叫。

不增加完整 provider 矩陣、所有通知樣式、完整協定版本組合或 coverage 目標。每個 milestone 跑相關測試；最後執行適用的 lint、typecheck、測試及包安裝檢查。

發布前安排一個有明確測試 repository 的真實 Pi/GitHub acceptance。使用者已選定產品的自動 PR 行為，不等於本輪規劃可以任意選擇外部 repository 發布。實作交付時須記錄測試目標與授權。

### 設計刪減實驗

依 repository 規則，一次省去一項設計並重跑對應使用情境。順序是獨立 daemon、第二份 transcript、自訂 renderer、額外模型路由，以及可合併的薄包裝。必要的 process ownership、資料查證與恢復檢查不可因縮短程式碼而移除。

已採用前四項刪減：沒有 daemon、第二份 transcript、自訂 renderer 或額外模型路由。Delivery 不是只靠 prompt 的薄包裝；遠端身分查證、publication intent 及 lost-response reconciliation 是安全交付的必要控制，因此保留。

## 11. 風險與決策門檻

| 風險 | 驗證方式 | 不通過時的處理 |
| --- | --- | --- |
| Pi 原生 TUI 無法承載協作操作 | M0 真實鍵盤、streaming 與子結果操作 | 改用自訂 pi-tui，先更新設計再展開 M1 |
| Pi version/public exports 不符合 SDK 文件 | M0 Node import、啟動、退出與 session 恢復 | 優先縮小使用範圍或評估版本，不依賴未證實的內部路徑 |
| 非同步結果重複或誤投 | 故障注入與 session ID 查證 | 顯示待確認，必要時限制 active child 下的 session 切換 |
| 平行修改造成錯誤整合 | 真 Git 衝突與 head 變更測試 | 停止整合、保留修改，允許改為循序工作 |
| 自動 PR 重複或包含錯誤版本 | Lost-response 與遠端 SHA 查證 | 保持待發布或待處理，不回報完成 |
| Agent 工具繞過 Delivery 或觸發合併 | M0 command boundary 原型、M3 writer 故障注入及 M4 command ledger | 停止自動 PR 里程碑，先隔離遠端寫入能力；不以 prompt 代替控制 |
| Worktree 被誤認為 sandbox | 工具設定及文件檢查 | 明確承認 OS 權限限制，不以 prompt 當作權限隔離 |
| 取代 Roc 時遺失既有工作 | 活躍資料盤點及舊版本回退演練 | 延後退役，不自動轉換未完成工作 |

## 12. 規劃證據與實作前檢查點

已驗證：Pi 固定版本的本機 SDK 文件列出 `InteractiveMode`、`AgentSessionRuntime`、steering、custom messages 及持久化 custom entries。這證明有可用介面，不等於本計畫的整合已通過。

已驗證：Roc 的 Pi client 使用 Bun.Subprocess 和獨立 cwd。現有 harness 是角色 attempt 流程，不能直接當作一般對話恢復。

已驗證：Amp 公開文件描述互動 CLI、agent 委派和自訂 shipping prompt。OpenAmp 的 supervisor、metadata 與 Git 查證設計是本計畫的選擇。

M0 已驗證：Pi 原生 UI 能顯示 OpenAmp extension 狀態、agent widget 及 command；SDK session 能進行兩輪對話、steering、取消和持久化恢復；RPC process 能以明確解析的 public `rpc-entry` 啟動及停止。詳細證據及限制見 [M0 技術可行性結果](openamp-cli/m0-feasibility.md)。

實作前審閱已收斂：修改型 PR 必須通過綁定最終版本的獨立審查，遠端修改只屬於 Delivery，合併只屬於使用者。實作沿用 Node.js、Pi 原生 TUI、inline extension 及獨立 RPC process，並以專用 OpenAmp worktree 隔離來源工作目錄。

目前交付包含 OpenAmp production runtime、文件、M0 probe、M1–M5 本機驗證及發布封裝。沒有執行付費模型測試，沒有 push、建立真實 GitHub PR、merge 或發布 npm package；這些外部操作需要明確授權。

參考：[OpenAmp 架構](../architecture.md)、[舊 Roc 架構](../legacy/roc-architecture.md)、[Amp CLI](https://ampcode.com/docs/cli)、[Amp agent 委派](https://ampcode.com/docs/orbs/agent-to-agent)、[Amp shipping](https://ampcode.com/docs/orbs/shipping)。Pi SDK 與 extensions 的固定版本文件，安裝後位於 `node_modules/@earendil-works/pi-coding-agent/docs/sdk.md` 與 `docs/extensions.md`。分支交接與證據範圍見 [OpenAmp 交接](openamp-cli/README.md)。
