# OpenAmp Oracle 實作計畫

> Workflow policy update: the [2026-09-15 minimal plan](../2026-09-15-openamp-minimal-plan.md) supersedes the role model and milestone sequence below. Oracle plans without code edits, implementation owns every edit, and final review uses a fresh Oracle session. Existing runtime and validation evidence remain relevant.

日期：2026-09-14。狀態：設計完成，尚未實作。

本計畫把 Amp 的 Oracle 概念轉成 OpenAmp 可驗證的產品契約。Oracle 是由主 agent 按需要呼叫的高推理、唯讀第二意見；它不是真相來源，也不取代每次 PR 交付前的強制獨立審查。

## 1. 決策摘要

- 新增同步 `ask_oracle` 工具。主 agent 只在困難推理、除錯、方案取捨或針對性審閱能實質改善答案時呼叫。
- Oracle 與 Delivery Review 使用同一個小型模型路由器及 Pi RPC 啟動能力，但保留不同 prompt、結果格式、持久化用途與完成條件。
- 所有修改型 PR 仍必須通過獨立、唯讀、綁定最終 head/base/requirements 的 Delivery Review。先前 Oracle 回答永遠不能充當這項核准。
- Oracle、researcher 及 reviewer 必須使用與相關產出者不同的模型，且**實際** thinking level 必須為 `high`；writer 預設為主模型的 `medium`。
- 第一版不提供同模型降級。沒有第二個可用的 `high` 模型時，Oracle 回報不可用，Delivery Review 阻止發布。先證明 dual-model 工作流成立，再考慮是否需要另外設計降級政策。
- 第一版不加入自動品質評分、模型名稱猜測、通用 provider framework、遞迴 Oracle 或多輪 agent 辯論。

「不同模型」第一版只採可驗證定義：canonical `provider/model` 不同。不同 provider 或名稱不保證底層模型家族不同，因此 live acceptance 會另外明確選擇兩個已知不同家族；runtime 不從名稱推測模型血緣。

## 2. 目前能力與缺口

OpenAmp 已有必要的生命週期骨架：

- `src/openamp/supervisor.ts` 以獨立 Pi RPC process 執行有上限的子 agent，支援佇列、取消、結果持久化及唯讀角色。
- `src/openamp/delivery.ts` 產生 immutable review bundle，要求另一個 reviewer session 回傳嚴格決策，並在 head、remote base 或需求變更時使審查失效。
- `src/openamp/state.ts` 已記錄每個 run 的實際 model 與 effort。
- `src/openamp/extension.ts` 已有主 agent 工具、取消 signal、parent session 綁定及結果交付。

缺口是所有 RPC child 目前由 Pi 自行選擇預設模型及 thinking level；OpenAmp 只在啟動後記錄結果，沒有先做角色路由，也沒有可由主 agent 隨選呼叫的 Oracle。

固定的 Pi 0.82.1 已確認提供所需 public surface：

- `RpcClientOptions.model` 可傳 `provider/model`，額外 CLI args 可傳 `--thinking high`。
- RPC 的 `get_available_models`、`get_available_thinking_levels` 及 `get_state` 可查目錄、能力及最後的有效設定。
- SDK 的 `ModelRegistry.getAvailable()` 只列出目前可用的模型；`AgentSession.setModel()` 會驗證 auth。
- Pi 可能把不支援的 thinking level clamp 至較低等級，所以 OpenAmp 必須讀回 effective state，不可只相信啟動參數。

這些能力足以實作路由，不需要改 Pi、直接呼叫 provider API，或搬回 Roc 的 scheduler。

## 3. 使用者與 agent 契約

主 agent 得到一個工具：

```text
ask_oracle(question, context?) -> answer + route evidence
```

- `question` 必須是單一、可判斷的問題；`context` 只包含決策限制、已檢查的證據及相關路徑，不複製完整對話或工具 transcript。
- Oracle 可讀目前功能 workspace 及使用既有 read/grep/find/ls 工具，不能使用 shell、修改檔案、委派、整合或發布。
- 工具同步等待答案，讓答案成為目前主 agent 回合的正式 tool result。`AbortSignal` 會取消 queued 或 running Oracle。
- 回答採一般文字並附 effective provider/model 及 thinking level。Oracle 不輸出 Delivery Review 的 `accepted/rejected` schema。
- 主 agent 仍負責核對證據、整合判斷及對使用者作答。Oracle 的意見不自動改變 change phase，也不觸發 PR。

系統 prompt 只給簡短使用準則：一般問題自己處理；只有第二意見可能改變高影響決策，或直接調查後仍有具體疑點時才呼叫。這避免每回合固定付出雙模型成本。

## 4. 兩條分離的流程

```diagram
                         ┌─────────────────────────┐
使用者 ─▶ 主 Pi session ─▶│ ask_oracle（可選、諮詢） │──▶ 主 agent 判斷
                         └───────────┬─────────────┘
                                     │
                                     ▼
                           ┌───────────────────┐
                           │ 共用 RouteResolver │
                           └─────────┬─────────┘
                                     │
              ┌──────────────────────┴──────────────────────┐
              ▼                                             ▼
     唯讀 Oracle Pi session                         唯讀 Reviewer Pi session
     自然語言建議，不形成 gate                      嚴格 JSON，綁定版本形成 gate
                                                            │
最終 head + base + requirements + validation ───────────────┘
                                                            │ accepted
                                                            ▼
                                                     Delivery 發布 PR
```

共用部分只有「挑選及驗證 Pi route」與既有 process lifecycle。以下資料絕不共用：

| Oracle | Delivery Review |
| --- | --- |
| 由主 agent 視需要呼叫 | 每次修改型交付必須執行 |
| 問題與 bounded context | 完整 immutable diff bundle、head/base/spec hash |
| 自然語言建議 | 嚴格 `accepted/rejected` JSON |
| 可以過時，僅供主 agent 判斷 | 新 input/head/base 立即失效 |
| 不能解除發布 gate | 唯一能滿足獨立審查 gate 的結果 |

## 5. 最小模型路由

### 5.1 路由輸入與證據

新增純路由函式，輸入只有 purpose、Pi 可用模型目錄、目前主模型、相關產出者模型及可選的明確 Oracle model。它回傳按優先次序排列的候選；明確指定時只回傳一項。每項格式如下，不建立 provider adapter：

```ts
interface AgentRoute {
  requestedModel: string;
  requestedThinking: "medium" | "high";
  rationale: "explicit" | "different_model";
}
```

run 啟動後再保存 `effectiveModel` 及 `effectiveThinking`。既有 `model`、`effort` 欄位作為 effective 值；新增 requested route 及 rationale，讓恢復及 UI 不需從結果猜測。OpenAmp 另外驗證 effective model 不在 producer set，不能只因 route 被明確指定便稱為 dual-model。所有文字維持既有 bounded metadata 規則。

### 5.2 選擇順序

1. 若新 change 以 `--oracle-model <provider/model>` 明確指定 reasoning lane，解析並持久化 canonical model。它若與 producer 相同便拒絕；resume 不能暗中改變它。
2. 未明確指定時，把 Pi `getAvailable()` 中可 reasoning、且不在 producer set 的模型按 canonical `provider/model` 排序，選第一個；不依賴 Pi 未承諾的目錄順序。
3. RPC 啟動時明確傳入 model 及 thinking，隨後以 `getState()` 驗證 canonical model、與 producer 的差異和 effective thinking。任何不符都在 prompt 前停止；明確設定不靜默改選其他模型。
4. 自動候選不能實際達到 `high` 時，可在 prompt 前試下一個不同模型；所有候選都失敗便回報 dual-model route 不可用，不採同模型 fallback。

producer set 對 Oracle 是呼叫時的主模型；對 Delivery Review 則是 change 期間記錄的所有主 session models，加上目前 `integratedResultIds` 對應 writer runs 的 effective models。`session_start` 保存初始模型，Pi `model_select` event 追加 canonical model，避免使用者在實作後切換模型便遺失來源。第一版不分析 Git author 或從模型名稱推測來源。

角色預設：

| purpose | 模型偏好 | thinking | 不符合時 |
| --- | --- | --- | --- |
| writer | 委派當下的主模型 | `medium` | 啟動失敗，不靜默換模型 |
| researcher | reasoning lane，必須不同模型 | `high` | 無 dual-model high route 則失敗 |
| oracle | reasoning lane，必須不同模型 | `high` | 工具回報不可用 |
| delivery review | reasoning lane，必須避開所有已知 producer | `high` | 阻止 PR 發布 |

主互動 session 的模型及 thinking 仍由使用者透過 Pi 原生操作控制；OpenAmp 不強制把主 session 改成 `medium`。只有建立 child 時才固定該 run 的 route snapshot。

### 5.3 不降級政策

不同 session、全新 context、唯讀工具及不同角色 prompt 能提供結構隔離，但同一模型缺少使用者要求先驗證的模型多樣性。因此第一版不把同模型新 session 稱為 Oracle 或 dual-model review。

只有一個模型時，一般主 agent 對話及 writer 工作仍可使用；`ask_oracle` 明確回報需要第二個模型，修改型 PR 保持本地 ready 但不自動發布。這個限制比加入 fallback、strict mode 和相關測試分支更簡單，也能直接證明雙模型是否帶來預期價值。未來若真實使用顯示可用性問題，再獨立審閱降級政策。

## 6. 生命週期、取消與恢復

- `AgentRole` 增加 `oracle`；Oracle 與 reviewer 都走唯讀 tool allowlist。Change state 另保存可選 `oracleModel` 與去重的 `mainModelsUsed`，既有 state 恢復時以未指定 Oracle model 及目前 session model 補上，不改寫歷史 run 證據。
- `AgentSupervisor.oracle()` 與既有 `review()` 都在 `delegate()` 之上建立專用 run、等待結果並把 caller signal 連到同一個 idempotent cancel 路徑。
- Oracle 與所有 child 共用目前 `maxActive = 2`。容量用完時顯示 queued，不繞過 supervisor 另開 process。
- Oracle run 使用 `deliveryOnly` 類型的同步結果路徑，避免完成時又向 parent session 注入第二份 async custom message；reviewer 仍只回給 Delivery。
- process exit 前先保存 result，再回傳 tool result。取消後不保存為 completed，也不釋放未確認退出的容量。
- 重啟時不自動重播 Oracle 問題或 Delivery Review。中斷中的 run 依既有規則成為 `interrupted`；已完整保存但未回給 tool call 的 Oracle 結果只保留為診斷證據，主 agent 必須重新提問才能採用。
- Oracle 開始時記錄 `inputGeneration` 與 workspace head（若有）。它們用於在結果旁顯示「可能已過時」，不把諮詢提升成 Delivery gate。Delivery Review 繼續使用現有的強制失效檢查。

## 7. 安全與成本邊界

- Oracle/reviewer 不取得 bash、write/edit、委派、Delivery 或 GitHub 工具；沿用 boundary extension 和 publication credential 隔離。
- 傳給模型的是使用者問題、bounded context 與它自行讀取的 repository 內容；不把 token、環境變數、完整其他 agent transcript 或 Delivery credentials 寫入 prompt/state。
- 每次工具呼叫最多一個 Oracle session，沒有遞迴；整體仍受兩個 active child 上限約束。
- 第一版不做自動 fan-out 或 majority vote。是否呼叫 Oracle 由主 agent 的工具政策決定，使用者也可直接要求主 agent 詢問。
- UI 至少顯示 role、status、effective route 及 `high`，讓成本來源及 dual-model 證據可見。Pi 未提供的 token/cost 不估算為零。

## 8. 實作順序

每一步均維持可執行主幹，不把文件中的完整終態一次塞入單一修改。

### O0：先證明最小雙模型流程

- 先建立一個可刪除的薄 probe，不接入完整 OpenAmp state、TUI 或 GitHub Delivery。
- 明確指定已知不同家族的模型 A 與 B：A 以 `medium` 在暫存 Git repository 完成一項微小修改，B 以 `high` 唯讀審查固定 diff。
- 只核對四件事：兩個 RPC session 能啟動；`getState()` 回報預期且不同的 canonical models；effective thinking 分別為 `medium`/`high`；B 能讀到並評估 A 的實際 diff。
- probe 不發布 PR、不加入恢復框架，也不嘗試完整 E2E。模型呼叫需要先確認可用帳戶及成本授權。

完成條件：真實模型 A → 修改 → 模型 B → Review 的最短流程成功。若失敗，先修正 Pi 啟動、auth、cwd 或 route 假設，不開始 production Oracle。

### O1：最小角色路由與證據

- 在 `src/openamp` 增加一個只處理 Pi model route 的小模組；不依賴舊 `src/scheduler/model-routing.ts`。
- 從主 session context 取得可用目錄及目前模型，讓 supervisor 對 child 傳入明確 model/thinking。
- 保存 requested/effective route 及 rationale，並更新 `/agents` 顯示。
- 套用 writer=`medium`、researcher/reviewer=`high`，並在 prompt 前拒絕相同 effective model。

完成條件：一個聚焦 Fake RPC 測試證明角色參數與拒絕條件；不先建立完整模型、provider 或通知矩陣。

### O2：隨選 Oracle

- 加入 `oracle` role、`AgentSupervisor.oracle()` 及 `ask_oracle` 工具。
- 加入專用唯讀 prompt、bounded input/output、signal cancellation 及同步 tool result。
- 更新主 agent system prompt 與 TUI 狀態，明確說明 Oracle 是建議而非發布核准。

完成條件：主 session 能在一個困難決策中取得模型 B `high` 的回答；一個取消測試證明 Oracle 不會晚到或重複注入結果。

### O3：強化 Delivery Review

- Delivery 產生 producer set，強制 reviewer 使用已驗證且不同的 `high` route。
- 在 state 及 PR body 記錄 review 的 requested/effective model、thinking 與 rationale。
- 保持現有 strict JSON、immutable bundle、input generation、head/base 重驗及 rejected 零發布行為。

完成條件：在 O0 已證明的雙模型路徑上，Oracle 回答不能滿足 gate；相同模型、route 不可用或 effective thinking 低於 `high` 時沒有任何 publication command。最後才在獲授權的測試 repository 建立一個 PR，確認沒有 merge。

## 9. 最小測試集

只保留能使錯誤實作失敗的最小集合：

1. 一個 route test：A/medium 寫入、B/high Oracle/Review；明確選 A 作 reviewer 或 Pi 回報低於 `high` 時，在 prompt 前拒絕。
2. 一個 Oracle lifecycle test：正常回答及 running cancellation，確認沒有重複或遲到結果。
3. 一個既有 Delivery 測試的延伸：Oracle 文字不能解除 gate；只有 B/high 對固定 head/base/spec 的 accepted Review 才產生一次 publication。
4. O0 的一次真實雙模型 probe，以及 O3 最後一次經授權 PR smoke test。

先不加入 queued/streaming/restart 的所有排列、完整 provider/model 組合、提示詞快照矩陣、成本預測或大型 E2E。若最小流程暴露具體恢復或競態缺陷，再為該失敗增加單一回歸測試。

## 10. 預計修改落點

| 檔案 | 變更 |
| --- | --- |
| `src/openamp/routing.ts` | 唯一新增 production module；純 Pi route 選擇與 rationale |
| `src/openamp/cli.ts` | 解析及保存可選 `--oracle-model`，把 route catalog 連至 extension/supervisor |
| `src/openamp/extension.ts` | `ask_oracle`、主模型 snapshot、system prompt 及 route UI |
| `src/openamp/supervisor.ts` | 明確 model/thinking 啟動、effective 驗證、Oracle lifecycle |
| `src/openamp/state.ts` | Oracle role、Oracle model、主模型集合、requested route、rationale、input/head snapshot |
| `src/openamp/delivery.ts` | reviewer producer set、不同模型/high gate 與 PR evidence |
| `test/openamp/openamp.test.mjs` | 純路由與垂直/failure cases；延伸既有 Fake RPC，不建立第二套 harness |
| `README.md`、`README.zh-HK.md` | 使用者可見工具、雙模型要求及不可用時的行為 |

若實作時 route selection 能保持在現有 supervisor 且不造成 Oracle/Review 重複，便省略 `routing.ts`；只有兩個 caller 確實共用純決策時才新增檔案。

## 11. 停止條件與完成定義

遇到以下任一情況先停止相應里程碑，不宣稱 Oracle 已完成：

- Pi 目錄不能在不暴露憑證下可靠列出可用模型。
- `--model` / `--thinking` 與 effective `getState()` 無法一致驗證。
- AbortSignal 無法停止 queued/running Oracle，或結果可能被投遞到錯誤 session。
- Oracle/reviewer 能取得修改或發布工具。
- Delivery 無法把 review route 證據綁定至同一個 reviewed head。

功能完成必須同時具備：可選 Oracle、強制獨立 Delivery Review、明確 requested/effective route、不同模型要求、最小確定性測試，以及一個經授權的真實雙模型 acceptance。只有文件或 Fake Harness 綠燈不等於真實雙模型能力已驗收。

## 12. 參考

- [OpenAmp 完整計畫](../2026-09-13-openamp-cli-plan.md)
- [OpenAmp M0 技術可行性](m0-feasibility.md)
- [OpenAmp M1–M5 證據](milestone-evidence.md)
- [Amp Oracle 公開說明](https://ampcode.com/docs/tools#oracle)
- [Amp The Dial](https://ampcode.com/docs/the-dial)
- 固定 Pi 套件文件：`node_modules/@earendil-works/pi-coding-agent/docs/rpc.md`、`docs/sdk.md` 及 `docs/usage.md`
