# GraphQL 讀取驗證

2026-09-11 的三組唯讀對照顯示，對 `devos-ing/Roc` 當時的 36 個 managed Issues、77 則 comments，候選 GraphQL reader 取得與現行 reader 相同的完整內容，並降低請求數與讀取耗時。這是 GQL-M1 的非權威驗證工具，尚未接入 scheduler。

## 結果

| 指標 | 現行 reader | GraphQL 候選 |
| --- | --- | --- |
| 每次完整讀取 HTTP | 38 | 2 |
| 完整讀取耗時中位數 | 7,508 ms | 2,152 ms |
| 完整讀取最大耗時 | 7,938 ms | 2,656 ms |
| 每次 GraphQL 完整讀取 cost | 基準另外記錄各 quota bucket | 2 |

HTTP 請求減少 94.7%，完整讀取延遲中位數減少 71.3%。六個讀取結果共用同一 canonical digest：

```text
sha256:b2684511a4c632998d15246b1d380f667018cc96dfc55e5e9377c0f748bccbe0
```

正規化包含 Issue number、title、body、url、state、label names，以及 comment databaseId、body、author.login。只排除來源排序與 GraphQL 額外欄位，不刪除批准或 checkpoint 內容。

| 配對 | 順序 | REST ms / HTTP | GraphQL ms / HTTP | Digest |
| --- | --- | --- | --- | --- |
| 1 | REST → GraphQL | 7,508 / 38 | 2,656 / 2 | 相同 |
| 2 | GraphQL → REST | 7,313 / 38 | 1,989 / 2 | 相同 |
| 3 | REST → GraphQL | 7,938 / 38 | 2,152 / 2 | 相同 |

量測期間為 2026-09-11T03:27:52Z 至 03:28:21Z。總計 120 HTTP，沒有 overshoot、替補、quota failure、permission failure 或 timeout。各 leg 的完整 wall time 包含認證 helper、CLI、網路、資料組裝與 digest 計算。

每次 GraphQL 有兩個 cost=1 的 query，完整 cost=2，當次 reported hourly limit=5000。若只有每 30 秒一次 idle 刷新，推算每小時 240 points，為額度的 4.8%。此推算不含 task completion 提前喚醒、角色、依賴及 PR 讀取。

## 工具與驗證邊界

[驗證工具](../../tools/github-read-proof.ts) 維持原始 `GitHubRemoteIssueReader.read()` 的 `gh issue list`、四路 comments 併發與完整 REST pagination。候選透過固定 GraphQL query，逐頁讀取 B=25 Issues 及各 Issue 的 comments、labels。兩者沒有接到 production store、scheduler 或 GitHub 寫入。

經使用者批准，REST 採串流觀測停止門檻，達限時取消所有在途子程序，並完整排空。因 `gh` 內部分頁不可預先攔截，允許在途 overshoot，報告不將其稱為硬上限。GraphQL 直接 request 在 dispatch 前扣除預算，禁止自動 redirect 與 retry。

每個 leg 的工作期限是 30 秒，取消後的子程序排空可能稍微延長總耗時。此次 session 門檻為 199，之前單次 REST 預檢耗用的 1 HTTP 不列入配對統計。

可重現命令如下。它會執行真實唯讀 GitHub 請求，輸出 metadata-only JSON，不保存 token、Issue/comment bodies 或原始 stderr。

```sh
rtk bun tools/github-read-proof.ts --live --pair --repo devos-ing/Roc --max-http 199
```

只有三組完整配對、六個 digest 全部相同、HTTP 至少減少50%、GraphQL median 至多為基準120%、idle cost 至多為 hourly limit20% 時，工具才輸出 `passed` 與 exit0。缺少 quota metadata、不完整讀取或無法解釋的 mismatch 都不能通過。

## 離線證據

[Focused tests](../../test/github/graphql-read-proof.test.ts) 共13個測試、131個斷言，涵蓋26個 Issues、101 labels、103 comments，批准與 checkpoint 在第102及103筆。另一個 Issue 也有獨立 comments overflow。

失敗案例涵蓋 cursor 循環、重複 ID、count drift、partial errors、nullable 必要欄位、quota、permission、1000-Issue 上限、更新與刪除、撤回批准、固定唯讀指令、取消、達限、overshoot、失敗計數，以及跨組 digest 不同。移除完整 cost 加總的 ablation 使測試失敗，還原後通過。

相同核心版本的13個 proof tests 加 reader/rate-limit 回歸曾通過25個測試、178個斷言；最後 A1 小修正後重跑 proof 為13個測試、131個斷言。Typecheck、指定檔案 Biome 與 diff/whitespace checks 均通過。獨立 QA 已核對安全邊界及最後 A1 修正；live 結果另有獨立算術與 digest 檢查。

## 來源與限制

基準 HEAD 為 `864e9153a16458664a793c9196a67577645e8b80`，branch 為 `codex/graphql-read-proof`。量測版本的 SHA-256：

- Tool：`b1a19fa107193462c53d861d6faf2c9ec83b405cf0983a6cc1d2fa59b1322bbd`
- Test：`d769b5e080c79f816449c3c7ae133f78752c789f301af7410822b796f5c051b1`
- Local live JSON：`7185995edc67e8e7f512c6cd9a3f1484bc9856fe72ec197b389cb7a48c9fee8a`

完整安全統計、process receipt、驗算及角色 packets 保存在本 worktree 的 `.scratch/startup-goal/graphql-reads/`。此報告提供可獨立閱讀的結果與重現命令，沒有聲稱已發布或整合到 production。

Verified 是本次三組小型資料的內容等價與量測結果，以及離線長歷史分頁測試。Idle hourly load 是根據實測 cost 的推算。較大 repository、不同帳戶、不同網路與活躍更新時的效能仍未驗證，不能由三組樣本推出 p95 或 SLA。

GitHub 跨 connection 讀取不是交易快照。正式接入 scheduler 仍需另行設計與批准 candidate/dependency 的 fresh authority boundary、TOCTOU 處理、取消及整合回歸；GQL-M1 不授權該變更。
