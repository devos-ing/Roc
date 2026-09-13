# OpenAmp M1–M5 里程碑驗證

日期：2026-09-13。範圍：固定 Pi 0.82.1、Linux orb、本機 Git fixtures、可控制的 Pi/GitHub 替身及實際 npm archive 安裝。

## 結論

M1–M5 的 repository 內 production implementation 和可重現 acceptance 已完成。Review 政策確定為強制：每個修改型 revision 必須由未參與該 revision 實作的獨立唯讀 Pi session 審查固定 head、base 與需求；任何一項改變都使舊 Review 失效。blocking finding 或 Review unavailable 會阻止發布，nonblocking findings 會保留在 PR 證據。

## 逐項證據

| 里程碑 | 實作與驗證結果 |
| --- | --- |
| M1 | `openamp`／`--resume` 啟動 Pi 原生 TUI；功能 branch 與 worktree 專用且可恢復；來源 checkout 的 dirty file 保持原狀；正常 agent command boundary 阻止 remote mutation，agent shell 使用隔離 HOME 且不接收一般 publication credentials。 |
| M2 | Supervisor 最多啟動兩個獨立 Pi RPC child，其餘 durable queue；支援指定 run 的 steering／取消；result 先落盤，只交付原 parent session 一次；重啟不盲目重播未確認 process。 |
| M3 | writer 使用獨立 branch/worktree，OpenAmp 驗證實際 commit、base、history、diff 及 clean state；結果逐一整合；衝突保留兩邊 worktree 與 refs，不 reset 工作。 |
| M4 | Delivery 在 validation 後提供完整 immutable diff bundle 給獨立 read-only Review，綁定 head/remote base/requirements hash/input generation，發布前重驗 remote base 與新輸入；記錄 publication intent 與 command ledger；lost push/PR response 先查 remote；追問更新同一 PR；無 merge operation。 |
| M5 | package/bin/README/architecture/release workflow 已切換至 OpenAmp；Roc onboarding skill 已移除；npm archive 不含 Roc CLI、scheduler、daemon 或 skills，安裝後由 Node 成功執行 `openamp --help`。 |

核心故障案例在 `test/openamp/openamp.test.mjs`：publication command／credential boundary、兩個 writer 的循序整合與衝突保留、並行第三個 child 排隊、未確認 result message 的恢復、錯誤 session 不接收結果、cherry-pick receipt 遺失、矛盾 Review JSON 拒絕、Review rejected 零發布、固定 reviewed SHA push、remote base／新輸入使 review 失效，以及 push／PR response 遺失後不重複建立 PR。

## 驗證命令

```text
bun run lint
bun run typecheck
bun run test
npm pack --dry-run --json --ignore-scripts
```

`bun run test` 是 OpenAmp release gate，涵蓋 M0、M1–M4、release workflow、實際 pack/install 與 Node CLI smoke test。舊 Roc source/tests 留在 repository 作遷移及歷史回復參考，不進 package，也不屬於 OpenAmp release gate。

## 尚未冒充完成的外部驗收

- 真實 macOS terminal smoke test。
- 真實 provider 登入及付費模型品質。
- 獲授權測試 repository 的 push、GitHub PR create/update 與遠端 CI。
- npm 名稱最終保留及 package publish。

上述操作需要合適環境、憑證、測試目標及明確外部副作用授權。本輪沒有 push、建立 PR、merge、publish 或 deployment；本機故障注入結果不代表 GitHub 已接受真實請求。
