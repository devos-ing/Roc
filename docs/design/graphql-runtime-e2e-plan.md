# GQL-M2：Scheduler GraphQL 整合與 E2E 驗證計劃

> 2026-09-11驗收修訂：使用者已批准將原R8完整GitHub workflow門檻縮為一個專用Issue的checkpoint寫入、更新與production GraphQL立即讀回。此測試已通過，見[驗證報告](../validation/graphql-checkpoint-smoke-2026-09-11.md)。以下原計劃保留歷史；關於R8必須建立PR或protected merge的敘述已由[目前spec](../specs/graphql-runtime.md)取代。完整真實PR/合併E2E改為可選、未測，不再阻擋這次交付。

步驟1–5已於2026-09-11獲准進行本機整合與唯讀驗證，批准紀錄位於`.scratch/startup-goal/graphql-runtime/implementation-approval.md`。本機實作與驗證紀錄見[GraphQL runtime verification](../validation/graphql-runtime-local.md)。步驟6真實GitHub寫入E2E仍待具體run packet批准。以下保留原計劃與完成定義。

目標是讓Roc的正式GitHub讀取改用GraphQL，並驗證從task discovery、批准與依賴，到角色執行、checkpoint、restart、PR與merge guards的完整流程。使用者是需要降低讀取請求與限流等待的Roc維護者。

## 入口與完成定義

[M1驗證報告](../validation/graphql-read-proof-2026-09-11.md)已證明非權威工具的完整讀取與效率：36 Issues、77 comments，三組配對内容全同，HTTP38→2，median7508→2152ms，GraphQL完整cost2。它沒有證明scheduler整合。

本計劃區分兩個狀態，避免把局部測試叫作完整E2E：

| 狀態 | 必須完成 | 尚未代表 |
| --- | --- | --- |
| `implementation-ready` | Production reader、fresh authority、Fake Harness vertical integration、本機CLI/process E2E、完整suite、production reader真實唯讀驗證 | M2完成、真實GitHub寫入/合併E2E或正式啟用 |
| `GitHub-workflow-E2E-verified` | 另經明確批准的隔離GitHub run通過checkpoint、PR、merge、dependency、restart與取消驗收，獨立QA及CTO outcome評估通過 | 已部署，或真實Pi/model E2E |

隔離GitHub workflow E2E是M2的必要最終驗收門檻。未通過前不能宣稱M2完成或啟用正式環境。具體測試repository尚未指定，不阻擋先批准並完成`implementation-ready`，但live階段會停在`awaiting_live_acceptance`，先提交確切run packet。

使用者尚未回覆是否縮小最終E2E範圍，本計劃採推薦的隔離GitHub workflow驗收。這只是規劃假設，不是現在建立Issues、PR或merge的授權。

## 範圍與非目標

修改讀取端及其必要的授權接線，保留task identity、plan/spec/approval hash、executor-owned唯一checkpoint、依賴PR與Git ancestry、未知write的readback、ownership、安全退出及錯誤淨化。

GitHub writes、PR publication、merge與protection機制沿用；測試會經過它們，但不重寫。沒有webhook、持久cache、資料庫、平台重構、provider/model routing或UI設計改動。不操作另一交付線的#104–108、現有ownership lock或暫停監控。

## 六個有順序的工作步驟

### 1. 固定M1基線並抽出production讀取核心

保存M1 tool、test、report的可重現快照、來源HEAD及SHA-256。可在未來另行同意的交付方式中使用本地baseline commit，但本計劃不要求現在commit或push。

Production新模組只負責固定queries、驗證過的aliases/variables、schema decode、完整cursor收集及安全錯誤分類。不要把M1的整份CLI、配對、HTTP預算或報告程式搬進`src/`。

保留現有facade與`RemoteIssue` domain契約：

- `read()`讀取B=25、OPEN/CLOSED、`roc:task`的完整managed snapshot。
- `get()`讀取單件Issue與完整comments/labels，用於角色與write-readback邊界。
- `getMany()`只讀已驗證的Issue numbers，每批至多25，供完整plan確認。
- 三者共用分頁與decode，任何partial/errors/null必要欄位、duplicate、cursor異常、count漂移都整次無結果。Managed Issues達1000維持拒絕，不截斷回傳。
- Nullable author不取得信任；comment numeric database ID不能由GraphQL node ID猜測。

M1 `--pair`目前把當前`GitHubRemoteIssueReader.read()`當REST baseline。切換後必須退役該current-checkout命令，或明確拒絕並指向凍結M1版本。禁止產生名為REST-vs-GraphQL的GraphQL-vs-GraphQL比較。歷史報告保留，不為benchmark留下永久legacy production reader。

### 2. 接入共用transport、限流與取消

沿用`GitHubRemoteIssueReader → GitHubRateLimitRunner → BunGitHubCommandRunner → gh api graphql`，以最小改動接到现有runtime生命週期。

新增狹窄的explicit read intent，固定GraphQL query可重試，mutation與未知命令不可重播。HTTP200仍要檢查GraphQL errors，至少區分quota、permission與partial/schema。只有quota read進入共用可取消等待；permission不重試，partial結果丟棄。

Pager在每個dispatch前及response後檢查取消。Daemon stop中止共用等待與in-flight reads並drain；單worker停止不能取消其他workers的共用等待，但自身停止後不能發下一頁、role或副作用。保留現有安全`AgileError`，不輸出raw GraphQL response、query變數中的敏感值或token。

### 3. 在claim前確認fresh candidate與完整依賴plan

`list()`只負責發現候選。已知plan Issue numbers只作定位，不是授權cache。

在store提供單一fresh-plan介面，重讀已知完整plan，重新驗plan ID、cycle/goal、task IDs、完整DAG、spec/approval、唯一executor checkpoint。Candidate必須仍為OPEN、approved且未blocked；dependency可為合法CLOSED+done，不能套用candidate的OPEN規則。

Admission順序固定為：

```text
list選候選
→ fresh完整plan
→ candidate與dependency checkpoint確認
→ 現有PR/head/merge evidence檢查及fetch/ancestry
→ 第二次fresh-plan確認相同授權與證據版本
→ initial checkpoint save及exact readback
→ role執行
```

任何candidate、dependency、plan member或checkpoint變動都停止這次claim。保留既有role、hook、publication、merge最後policy callback與checkpoint寫前/寫後的fresh檢查。Negative list omission仍要direct confirmation，不能直接當成撤回批准。

GraphQL若暫時看不到剛經REST寫入的checkpoint，沿用`GITHUB_CHECKPOINT_UNCONFIRMED`與ownership retention，不新增盲目write retry。已確認的attempt、hook、publication及merge不能因restart重播。

這個設計移除已知list snapshot授權缺口，但GitHub沒有跨請求交易快照。最後fresh read至write仍有TOCTOU；報告必須明說，不能聲稱原子性。

### 4. 完成本機整合與process E2E

採一條主要vertical trace，加少量有力的失敗測試，不建立完整protocol或logging矩陣。

| 測試層 | 真實部分 | 替身部分與通過條件 |
| --- | --- | --- |
| Reader contract | 新production parser/pager/facade | Stateful protocol fixtures，26+Issues、103comments、101labels、兩個獨立overflow；批准/checkpoint在102/103，完整canonical相同；partial輸出0次 |
| Scheduler vertical integration | Production reader、store、pool、runner、checkpoint與merge協調 | Fake GitHub protocol、Fake Harness、隔離本機Git。T1→T2 dependency，Scout→Implement→獨立Review→PR→confirmed merge/done→T2 release；restart無重播 |
| Freshness/failure | 實際store與runner的邊界 | 在list後及PR/ancestry前後撤回批准、改spec、刪改或重複checkpoint、缺plan member；未確認授權副作用0次，未知write保留ownership |
| 本機CLI/process E2E | 真實CLI子程序、connectGitHub、production讀取與inspect/task view | Temp repo及可執行gh shim；確認固定GraphQL argv、200partial/403/quota分類、SIGINT/timeout/drain及sanitized logs |

Single-task取消、daemon shutdown與restart重用既有Fake Harness，驗證取消不波及siblings、停止後沒有新request、readback與cleanup完成後才釋放slot/ownership。

上述可稱本機整合或process E2E，不能稱真實GitHub network或真實模型E2E。

### 5. 跑完整suite與production reader唯讀驗證

Focused tests通過後，執行：

```sh
rtk bun run check
```

這是`package.json`定義的lint、typecheck與完整Bun suite。保存每階段exit、總測試/斷言數、skips/todos/crash/timeout、起訖、HEAD及實際變更檔hash。不能用test filter稱full suite；必需測試被跳過時記`full suite incomplete`。既有環境gates要列exact test與原因，不能用舊live報告填補。

確認production package只包含預期runtime，沒有引入M1 measurement CLI或開發技能。不執行publish，package檔案檢查不等於npm發布。

之後以production `connectGitHub`/reader的只讀入口做三組穩定live驗證，不啟動現有真實daemon、不取得或移除其ownership、不寫GitHub。內容以凍結M1 conformance或同一穩定資料上的獨立基準核對，不硬套歷史digest到已更新的repository。

Idle/list硬門檻保持：等價資料HTTP至少減少50%，median不超過可比REST基準120%，每次完整cost乘idle每小時120次不超過reported hourly limit20%。若基線資料或環境已變，先重建可比的凍結基準讀取，不能把舊7.508秒直接當作新環境SLA。

完整scheduler trace另分列list、fresh plan、role/hook、checkpoint readback、dependency PR/ancestry、publication/merge及restart的HTTP、cost、latency、refresh與retry。**不對新增freshness的完整流程承諾50%降幅**；正確授權、無重播、有界讀取與安全取消是hard gates。

此階段通過後才標`implementation-ready`，尚未完成M2。

### 6. 隔離GitHub workflow E2E與最終驗收

先完成前述程式、測試、報告及可執行runbook，再提交具體live run packet。它必須列出：

- 專用repository、base branch、branch prefix、required checks/protection與merge方式。
- Publisher/executor identities與既有認證的可用性，不要求在本輪登入。
- 明確的測試Issues、checkpoint writes、PR、merge、HTTP及時間預算。
- 允許的臨時controller啟停、timeout/abort/quota停止條件，以及owner隔離。
- 建立資料的保留/清理政策；失敗時保留哪些checkpoint、worktree、PR與ownership證據。

只有這份具體run packet獲批准後才做真實writes。历史private fixture repo只作參考，沒有假定它現在可用或已授權。

最小trace使用**真實GitHub + 固定Fake Harness**，經正式GraphQL讀取、store/pool/runner及現有write/PR/merge路徑：

1. 在隔離plan完成T1，經checkpoint write/readback、PR checks與protected merge到done。
2. T2必須等待fresh的T1 done/PR/head/merge/ancestry證據，合法closed done dependency可釋放。
3. 在已確認checkpoint後重啟隔離controller，確認不重播已確認role、publication或merge。
4. 撤回一件測試中task的批准，確認取消並且沒有後續PR或merge。
5. 由真實GitHub讀回所有測試record、PR heads、checks、merge commits及final Issue states，核對完整證據鏈。

固定Fake Harness用來排除模型變異，不消耗真實模型tokens。此結果可稱 **GitHub workflow E2E**，不能稱real Pi/provider E2E。真實Pi/provider流程列為optional/not evaluated；若另需驗證，先指定provider、模型、token預算與授權，不偷偷擴大成昂貴模型測試。

此run通過獨立QA、CTO User Outcome Replay後，才交使用者接受M2與決定正式啟用。通過E2E不會自動merge或deploy。

## 驗收與停止條件

| ID | 可驗證條件 |
| --- | --- |
| R1 | read/get/getMany共用完整contract，長分頁與1000bound通過，partial snapshot輸出0次 |
| R2 | Fresh candidate/dependency/full-plan、PR/ancestry前後版本確認成立前，claim或授權副作用0次 |
| R3 | 一條scheduler垂直流程完成，restart重播已確認role/write/publication/merge為0次 |
| R4 | Permission重試0次；quota共享等待可取消；單worker與daemon取消分離；未知write保留ownership |
| R5 | 真實CLI/process測試通過；安全logs沒有raw遠端資料或憑證 |
| R6 | Focused、full `bun run check`、package邊界及diff檢查有新鮮完整結果，未執行項明列 |
| R7 | Production reader live內容等價、idle效益門檻通過、full-workflow成本完整揭露 |
| R8 | 隔離真實GitHub workflow E2E通過；沒有以Fake network或舊REST live證據冒充 |
| R9 | 獨立QA及CTO Outcome Replay通過，使用者尚未批准前不部署 |

任何partial authority、未知write被當成功、unsafe cancellation、敏感log或wrong dependency claim都停止採用。性能不能靠省略fresh checks換取。若read-after-write持續不能確認，停止rollout，沿用現有reconciliation與ownership處理。

## 回復與簡化

不改checkpoint或遠端資料格式，沒有migration。正式切換的回復採撤回未合併候選或回復可識別的runtime整合版本，不設永久雙reader開關，也不在GraphQL失敗後自動REST fan-out。執行任何正式revert前仍按已批准的交付流程處理，不由測試工具改真實repository。

實作時一次移除一個重複元素，例如measurement code混入runtime、重複decoder或多餘query欄位。只有conformance、authority與recovery測試維持通過才保留簡化。不可拿完整性或取消檢查做效能ablation。

## 責任與計劃邊界

CTO負責architecture、fresh authority及Outcome Replay。實作角色完成runtime接線與tests，沿用使用者允許選擇合適模型的原則。QA独立驗證與核對報告。協調者管理證據、範圍及批准；不建立新visible task。

預期變更集中於新production query module、`src/github/issue-reader.ts`、`execution-store.ts`、`rate-limit.ts`、必要runner metadata與`src/cli/runtime.ts`接線、`src/scheduler/github-runner.ts`的claim邊界，以及相應tests與docs。`github-pool.ts`只有在signal接線確有需要時才改；PR/merge商業邏輯沿用。

本計劃批准只允許先做到`implementation-ready`的程式與本機/唯讀驗證。隔離live mutation、任何真實daemon操作與正式rollout各自保持具體run/release gate。未知測試repo不使本次規劃停擺，也不能被省略後聲稱M2完成。

## Evidence Ledger 與角色裁決

| 分類 | 主張與來源 |
| --- | --- |
| Verified，2026-09-11 | HEAD `864e9153a16458664a793c9196a67577645e8b80`、M1未提交artifacts與固定hash仍存在；M1 report與live JSON證明工具結果，不證runtime |
| Verified | `src/cli/runtime.ts:42` 的connectGitHub建立currentreader；`src/github/issue-reader.ts:122`及`:271`分別get/read完整RESTcomments |
| Verified | `src/github/execution-store.ts:228` list/DAG、`:308` plan locators、`:355` checkpoint寫前與readback；`src/scheduler/github-runner.ts:370` dependencyBase取list checkpoint，既有role/publication/merge callback已有fresh checks |
| Verified | `src/github/rate-limit.ts:11` 現有argv判斷不足以識別GraphQLPOST read與200errors；`src/cli/runtime.ts:107`已有shared停止signal |
| Verified | `test/helpers/github-native.ts`、`github-plan.ts`為memory；`test/integration/github-native-execution.test.ts`與`automatic-merge.test.ts`多使用Fake Harness/recorded Pi與fake GitHub，不是真實GraphQL network E2E |
| Verified | `package.json`定義完整check；歷史`docs/validation/m1-m2-live-2026-09-09.md`為舊REST版本方法參考，非當前permission或通過證據 |
| Inferred | 共用小core與bounded plan reads能避免三套分頁；雙fresh-plan能移除已知list授權缺口，但非交易快照 |
| Assumed | GraphQL及時看見REST checkpoint writes，以uncertain-write測試與隔離live驗證；若不成立停止rollout |
| Assumed | B25、plan aliases與新增freshness成本可接受，以每query/full-flow計數驗證，不先承諾active降幅 |
| Assumed | 可取得隔離repo、protection與測試權限；具體live packet驗證，未取得則最終E2E保持pending |

CTO及QA兩個dependency-free planning roles已全部完成，按CTO→QA固定順序驗證七個必要欄位，沒有packet修補。使用一次CTO targeted review，裁決R8是最終release gate、real Pi為optional，以及撤回full-flow固定50%要求。原推薦與分歧保存在`.scratch/startup-goal/graphql-runtime/cto-packet.md`與`qa-packet.md`，沒有抹去歷史。
