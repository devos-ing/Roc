# Checkpoint REST 寫入與 GraphQL 讀回

2026-09-11T12:11:52Z–12:11:58Z，在既有隔離倉庫的一個[專用測試Issue](https://github.com/0xroylee/roc-m1-m2-live-b5a7u3o_/issues/14)完成小型真實讀寫驗證。

使用者先批准縮小最後验收範圍。本次只建立一個非managed Issue，對一個schema-valid checkpoint comment做POST與PATCH。沒有task envelope、approval或`roc:task`/`roc:ready` labels，不會被Roc scheduler接手。沒有啟動scheduler、建立PR或merge，也沒有變更repository protection或visibility。

## 結果

| 寫入 | Production GraphQL第一次讀回 | 結果 |
| --- | --- | --- |
| POST checkpoint revision 0 | 精確body與record相同，author為0xroylee，numeric comment ID為5634256100 | Pass |
| PATCH同一comment到revision 1 | 精確body與record相同，同一author及comment ID，讀到新revision | Pass |

兩次均未重試讀取或寫入。`ExecutionRecordSchema`驗證通過，渲染使用production `renderExecution()`，寫入使用production `GitHubRemoteIssueReader.writeComment()`，讀取使用同一facade的GraphQL `get()`；底層是真實`BunGitHubCommandRunner`與GitHub CLI。

測試先確認Issue不是managed task，再寫入和更新。紀錄phase為`needs_input`，attempts為空，只是合成的可見性fixture，沒有聲稱執行了任務。Checkpoint含Unicode及轉義字元，兩次raw body hash均與預期一致。

| Revision | Expected / actual body SHA-256 |
| --- | --- |
| 0 | `37d3c684f64dbbf89d9a92b909ff9fdd5f2db26672e5724075a93baad874dc88` |
| 1 | `b0cce9040b09a43a4eaba22738ab0b82a3d866a8195ac5c9cd0288771a092783` |

共6個成功命令：建立Issue、確認Issue、POST、GraphQL讀回、PATCH、GraphQL讀回。沒有自動retry。兩次寫後讀回的GraphQL命令分別耗時783ms及792ms；這是命令耗時，不是GitHub內部傳播延遲的量測。

Issue與最後revision的comment保留作證據。沒有把測試Issue加到managed task集合。

## 證據與限制

安全結果位於`.scratch/startup-goal/graphql-runtime/checkpoint-smoke/result.json`，SHA-256為`098ad42b3cc10c6ffdd99313cc5a6e06a29c245cdd744c3e3fb04297eec918c7`。獨立核對結果在同目錄`validation.json`，所有checks通過。測試腳本只在scratch，production code沒有因這次驗證改動。

這證明本次POST與PATCH後，production GraphQL第一次讀取已看見正確內容。它不是跨請求交易保證，也沒有證明所有負載下都無延遲。

既有完整本機測試、scheduler integration與真實唯讀對照保留。完整真實GitHub PR/protected merge workflow及真實Pi/provider E2E仍未測，依使用者修訂改列可選。沒有commit、push或deployment。
