# Git Worktree 套件與隔離策略研究

日期：2026-08-26

## 結論

**新增硬性 dependency gate：GitHub stars 少於 1,000 的 package 一律不採用。** 這排除所有已找到的專用 worktree library；先前最佳專用候選 `@feniix/worktrees-core` 目前為 0 stars（[GitHub](https://github.com/feniix/worktrees-core)）。`simple-git` 為 3.9k stars，通過門檻，但官方沒有 worktree-specific API（[GitHub](https://github.com/steveukx/git-js)、[official README](https://github.com/steveukx/git-js#complex-requests)）。

在「不用低於 1,000 stars 的 package」與「不自行建 worktree lifecycle」同時成立時，**v1 建議改為 `simple-git` + 系統獨占的單一 checkout + 每 task 一條保留 branch**。v1 順序執行：每個 task 從 persisted base 建立 `agile/<taskId>` branch；Implement 成功後由 Harness commit；Review accepted/rejected 後切回固定 base，再處理下一 task；branch 與 Codex context ID 保留供日後重開。系統必須使用 dedicated checkout，不能切換使用者正在編輯的 checkout。若 Implement 中斷留下 dirty files，先建立固定身份的 WIP checkpoint commit，才能安全切回 base。

Worktree 仍是未來並行執行時更強的隔離模型，但不是順序 v1 的必要條件。等需要同時執行兩個 task，再重新評估原生 Git worktree 或符合 stars gate 的成熟 library。

## 已驗證事實：候選方案

| 方案 | 維護／runtime | Worktree API 與實作方式 | 與本產品的差距 | 判斷 |
|---|---|---|---|---|
| **系統 Git + `Bun.spawn`** | Bun 官方 API；無 npm dependency。Git 官方擁有完整 lifecycle 與穩定 porcelain output（[Bun](https://bun.sh/docs/runtime/child-process)、[Git](https://git-scm.com/docs/git-worktree.html)） | 真正執行 canonical Git lifecycle；本專案只需用 typed wrapper 擁有 policy。參數陣列不經 shell interpolation，且可固定 `cwd`、locale、Git config、identity 與 timeout | parser、idempotent reuse、路徑與 commit invariants 要自己寫；但使用者已明確不要自建 worktree lifecycle | **技術可行，但不符合產品決策** |
| **`@feniix/worktrees-core` 1.1.1** | 2026-04 發布；ESM + types、MIT、Node `>=22`、零 runtime dependency；上游未承諾 Bun；GitHub 0 stars（[npm](https://www.npmjs.com/package/@feniix/worktrees-core)、[repo](https://github.com/feniix/worktrees-core)） | 有 `list/create/remove/prune`、plan/validation/naming/typed errors；底層同步呼叫 `execFileSync("git", argv)`，是真正可嵌入的 worktree primitives，但仍由系統 Git 執行（[git source](https://github.com/feniix/worktrees-core/blob/main/src/git.ts)、[worktree source](https://github.com/feniix/worktrees-core/blob/main/src/worktrees.ts)） | 缺 async、lock/move/repair，以及本產品的 base、單一 commit、reachability、retention/reuse proofs | **低於 1,000 stars，禁止採用** |
| **`@metyatech/managed-worktree-system` 2.3.2** | 2026-05 發布；ESM + types、MIT、Node `>=22`；上游未承諾 Bun（[npm](https://www.npmjs.com/package/@metyatech/managed-worktree-system)、[repo](https://github.com/metyatech/managed-worktree-system)） | 完整擁有 `init/create/deliver/drop/list/prune/doctor/syncSeed` 與 mutation plans；Git 以 argv、`shell: false` 啟動（[README](https://github.com/metyatech/managed-worktree-system/blob/main/README.md)、[process source](https://github.com/metyatech/managed-worktree-system/blob/main/src/lib/process.mjs)） | `.mwt` seed、fetch/rebase/hooks/verify/push、deliver/drop worldview 與 local-only、rejected workspace retention 相衝突 | **真的管理 lifecycle，但 policy 過重** |
| **`simple-git` 3.36.0** | 2026-04 發布、活躍維護、內建 TS types、GitHub 3.9k stars；官方只承諾 Node，用系統 Git（[npm](https://www.npmjs.com/package/simple-git)、[repo](https://github.com/steveukx/git-js)）。本次 Bun 1.3.8 smoke test 通過；這不是上游 Bun 保證 | 沒有 worktree-specific API；但有 branch/checkout/status/add/commit 等 methods，適合 dedicated checkout 的 branch-only v1（[official README](https://github.com/steveukx/git-js)） | 若用 worktree 仍須自行管理 lifecycle；若用 branch-only，只保留 task/base/context mapping。應鎖定安全修補後版本，因上游曾公告 option-parsing command execution（[advisory](https://github.com/steveukx/git-js/security/advisories/GHSA-jcxm-m3jx-f287)） | **通過 stars gate；branch-only v1 採用** |
| **`git-worktree` 0.2.1** | npm 最後發布於 2021-08，package metadata 為 Node `>=12`、依賴 Execa 5（[npm](https://www.npmjs.com/package/git-worktree)、[package source](https://github.com/alexweininger/git-worktree/blob/main/package.json)） | 表面有 `add/list/remove/prune/lock/unlock/move`；source 實際拼接 command string 再交給 Execa，list 只抽 path，沒有 `-z`、HEAD/branch/locked/prunable 結構、base/ref/commit 驗證（[WorktreeClient](https://github.com/alexweininger/git-worktree/blob/main/src/WorktreeClient.ts)、[exec source](https://github.com/alexweininger/git-worktree/blob/main/src/utils/execUtils.ts)） | task path/branch/reason 直接插入 command string；其 exec helper catch 後不 rethrow，Git 失敗可能變成 `undefined`，不符合 fail-closed scheduler | **不採用** |
| **`git-workspace-service` 0.4.6** | 2026-05 發布，Node `>=18`；含 Octokit、credential、PR/event 等較大 surface（[repo/API](https://github.com/HaruHunab1320/git-workspace-service)、[package](https://github.com/HaruHunab1320/git-workspace-service/blob/main/package.json)） | 確實擁有 clone/worktree workspace records、provision/list/remove/cleanup 與 events；但底層仍用 `node:child_process.exec` 拼 command strings，cleanup 會 `worktree remove --force`（[source](https://github.com/HaruHunab1320/git-workspace-service/blob/main/src/workspace-service.ts)） | 預設 fetch remote、credential、push/PR/cleanup workflow 與 v1 local-only、retained-worktree 語義相反；沒有官方 Bun contract，且把 in-memory workspace state/外部 workflow 帶入現有 SQLite scheduler | **真的管理 lifecycle，但範圍過大且 policy 不合** |
| **`@agentproto/worktree` 0.5.2** | 2026-08 發布的 agent/workflow 專用套件；依賴其 driver、harness、tool、workflow-runtime 與 MCP SDK（[npm](https://www.npmjs.com/package/@agentproto/worktree)、[official monorepo](https://github.com/agentproto/ts/tree/main/packages/worktree)） | 提供 `provision → agent → gate → human approval → cleanup` workflow，而不是單獨、無主張的 Git primitive | 會引入第二套 agent/workflow contract；其 pass/cleanup 流程也不是本產品的 terminal rejection + retained workspace | **不採用** |
| **`isomorphic-git` 1.41.9** | 2026-08 仍發布；純 JavaScript、Node/browser、內建 types（[npm](https://www.npmjs.com/package/isomorphic-git)） | 不 shell out，但官方完整 command index 沒有 worktree add/list/remove/repair；只有單一 `dir`/`gitdir` 的 checkout、branch、commit 等 API（[command index](https://isomorphic-git.org/docs/en/alphabetic)、[checkout](https://isomorphic-git.org/docs/en/checkout.html)） | 要自行實作 linked-worktree administrative layout，風險與維護成本遠高於呼叫 canonical Git | **能力缺口，不採用** |
| **NodeGit／libgit2 binding** | NodeGit npm stable `0.27.0` 最後正式 release 是 2020；2026 source 是 Node `>=20` 的 `0.28.0-alpha`，仍使用 NAN/node-gyp/native binary（[releases](https://github.com/nodegit/nodegit/releases)、[package source](https://github.com/nodegit/nodegit/blob/master/package.json)） | 不 shell out；NodeGit 暴露 experimental `Worktree.add/list/lookup/lock/prune/validate` 等 libgit2 binding（[API](https://www.nodegit.org/api/)） | API 標 experimental，完整 remove/repair 與本產品 Git CLI parity 仍不足。Bun 官方保證的是多數 **Node-API** extension；NodeGit 使用 NAN，不是可據此視為相容（[Bun Node-API](https://bun.sh/docs/runtime/node-api)） | **native/alpha 風險不值得** |

專用 worktree candidates 全數未通過 1,000-stars gate；因此不再建議引入。v1 若拒絕自有 worktree lifecycle，改採通過門檻的 `simple-git` 管理 dedicated checkout 內的 task branches。

## 已驗證事實：Git 提供的邊界

Git linked worktree 共用 object database 與大部分 refs，但各自保存 `HEAD`、index 等 per-worktree state；同一 repo 因此可以同時有多個工作目錄。`git worktree add -b <branch> <path> <commit>` 能在同一命令建立 task branch/worktree；`list --porcelain -z` 可重建 path、HEAD、branch、locked/prunable 狀態；保留 worktree 不要求 merge。只有乾淨 worktree 才能正常 remove，`--force` 會繞過此保護（[Git worktree description/options](https://git-scm.com/docs/git-worktree.html)）。

v1 internal manager 只需擁有以下操作，不需要包裝 Git 全 API：

1. canonicalize repo root，將 `baseRef` 一次 resolve 為 full commit SHA；
2. 由 validated task ID 決定唯一 path/branch，執行 `worktree add -b`；
3. restart 時用 `worktree list --porcelain -z`、branch ref、HEAD 與 merge-base fail-closed 地驗證是否可復用；
4. 在 task worktree 查 status、stage/commit，再驗證 `base..branch` 恰好一個 reachable commit；
5. accepted/rejected 都保留；v1 不暴露 remove/prune/merge/push。

這些操作與現有 `TaskWorktreeManager` surface 一致；唯一通用化建議是 parser 最終採 Git 推薦的 `--porcelain -z`，但 validated internal path 已大幅縮小目前 newline ambiguity。

## 推論：worktree、branch switching、commit-only

| 策略 | Review rejected 後立即排下一 task | 保留／重開原 task | crash 與 dirty state | v1 評估 |
|---|---|---|---|---|
| **每 task worktree + branch** | 下一 task 在另一目錄、從 persisted base 建立，rejected files 不可能因 branch switch 被帶入 | path、branch、commit、Codex context 都可持久引用；不需改變 controller repo | dirty rejected/中斷現場只污染該 task 目錄 | **未來並行方案；v1 暫不採用** |
| **每 task branch、共用一個 dedicated working directory** | 已提交且 clean 時可切到新 branch；Git switch 會更新同一 index/working tree（[Git switch](https://git-scm.com/docs/git-switch)） | branch 保留 commit，context ID 保存在 SQLite；重開時切回 task branch | mid-Implement crash 先建立固定身份 WIP checkpoint，然後才能切回 base；dedicated checkout 不影響使用者工作目錄 | **順序 v1 採用** |
| **commit-only，完成後 reset 同一 branch** | reset 回 base 可避免已提交 diff；`reset --hard` 會丟棄 tracked changes，且可能刪除擋路的 untracked files（[Git reset](https://git-scm.com/docs/git-reset/2.51.0.html)） | 若沒有 branch/tag/ref，只在 SQLite 存 SHA 不會讓 commit 保持 reachable；Git GC 會清理 unreachable objects（[Git gc](https://git-scm.com/docs/git-gc.html)） | crash 點同時跨 working tree、index、branch ref、SQLite；補償/重播最複雜 | **不採用**；若加 persistent ref，實質已回到 branch 方案 |

因此，v1 接受 branch-only 較弱的目錄隔離，換取不自建 worktree lifecycle 且只使用通過 stars gate 的成熟 dependency。限制是一次只能執行一個 task，並由 scheduler 獨占 dedicated checkout；未來加入並行時再升級為 worktree。
