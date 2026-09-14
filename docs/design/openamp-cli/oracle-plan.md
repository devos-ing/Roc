# OpenAmp Oracle 實作計畫

日期：2026-09-14。狀態：設計完成，尚未實作。

本計畫把 Amp 的 Oracle 概念轉成 OpenAmp 可驗證的產品契約。Oracle 是由主 agent 按需要呼叫的高推理、唯讀第二意見；它不是真相來源，也不取代每次 PR 交付前的強制獨立審查。

## 1. 決策摘要

- 新增同步 `ask_oracle` 工具。主 agent 只在困難推理、除錯、方案取捨或針對性審閱能實質改善答案時呼叫。
- Oracle 與 Delivery Review 使用同一個小型模型路由器及 Pi RPC 啟動能力，但保留不同 prompt、結果格式、持久化用途與完成條件。
- 所有修改型 PR 仍必須通過獨立、唯讀、綁定最終 head/base/requirements 的 Delivery Review。先前 Oracle 回答永遠不能充當這項核准。
- 優先使用與產出者不同的模型，並要求 Oracle、researcher 及 reviewer 的**實際** thinking level 為 `high`；writer 預設為 `medium`。
- 雙模型是品質偏好而不是 PR 的絕對可用性條件。沒有第二個可用模型時，可由同模型的新 Pi session 以 `high` 執行，但必須記錄及顯示 `same_model_fallback`。完全沒有可實際執行 `high` 的模型時，Oracle 回報不可用，Delivery Review 則阻止發布。
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
- 回答採一般文字並附 effective provider/model、thinking level 及是否降級。Oracle 不輸出 Delivery Review 的 `accepted/rejected` schema。
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
  rationale: "explicit" | "different_model" | "same_model_fallback";
  diversity: "different_model" | "same_model";
}
```

run 啟動後再保存 `effectiveModel` 及 `effectiveThinking`。既有 `model`、`effort` 欄位作為 effective 值；新增 requested route、rationale 與獨立的 diversity，避免明確指定成同一模型時被誤報為 dual-model。恢復及 UI 不需從結果猜測。所有文字維持既有 bounded metadata 規則。

### 5.2 選擇順序

1. 若新 change 以 `--oracle-model <provider/model>` 明確指定 reasoning lane，解析並持久化 canonical model。resume 不能暗中改變它。
2. 未明確指定時，把 Pi `getAvailable()` 中可 reasoning、且不在 producer set 的模型按 canonical `provider/model` 排序，選第一個；不依賴 Pi 未承諾的目錄順序。
3. 找不到不同模型時，選目前主模型並標記 `same_model_fallback`。
4. RPC 啟動時明確傳入 model 及 thinking，隨後以 `getState()` 驗證 canonical model 和 effective thinking。任何不符都在 prompt 前停止；明確設定不靜默改選其他模型。
5. 自動候選不能實際達到 `high` 時，可在 prompt 前試下一個候選；所有候選都失敗才採同模型 `high`。仍無法達到 `high` 則回報不可用。

producer set 對 Oracle 是呼叫時的主模型；對 Delivery Review 則是 change 期間記錄的所有主 session models，加上目前 `integratedResultIds` 對應 writer runs 的 effective models。`session_start` 保存初始模型，Pi `model_select` event 追加 canonical model，避免使用者在實作後切換模型便遺失來源。第一版不分析 Git author 或從模型名稱推測來源。

角色預設：

| purpose | 模型偏好 | thinking | 不符合時 |
| --- | --- | --- | --- |
| writer | 委派當下的主模型 | `medium` | 啟動失敗，不靜默換模型 |
| researcher | reasoning lane，優先不同模型 | `high` | 無 high route 則失敗 |
| oracle | reasoning lane，優先不同模型 | `high` | 工具回報不可用 |
| delivery review | reasoning lane，優先避開所有已知 producer | `high` | 阻止 PR 發布 |

主互動 session 的模型及 thinking 仍由使用者透過 Pi 原生操作控制；OpenAmp 不強制把主 session 改成 `medium`。只有建立 child 時才固定該 run 的 route snapshot。

### 5.3 降級政策

同模型 fallback 仍是不同 session、全新 context、唯讀工具及不同角色 prompt，所以保留「獨立 agent 審查」的結構隔離，但缺少模型多樣性。UI、`/agents`、state 及 PR body 都必須把此事標為降級，不能稱為 dual-model review。

第一版允許這種 fallback 通過 PR gate，理由是單一已登入模型不應令整個交付功能永久不可用；真正不可降級的是獨立 session、唯讀限制、`high` effective thinking、immutable bundle 與版本綁定。若實際品質證據顯示同模型審查不足，再以獨立產品決策增加 strict diversity 模式，不先加入未要求的設定矩陣。

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
- UI 至少顯示 role、status、effective route、`high` 及 fallback，讓成本來源及是否真正 dual-model 可見。Pi 未提供的 token/cost 不估算為零。

## 8. 實作順序

每一步均維持可執行主幹，不把文件中的完整終態一次塞入單一修改。

### O0：角色路由與可觀察證據

- 在 `src/openamp` 增加一個只處理 Pi model route 的小模組；不依賴舊 `src/scheduler/model-routing.ts`。
- 從主 session context 取得可用目錄及目前模型，讓 supervisor 對 child 傳入明確 model/thinking。
- 保存 requested/effective route、rationale、diversity，並更新 `/agents` 顯示。
- 先套用 writer=`medium`、researcher/reviewer=`high`，但不改變 Delivery gate。

完成條件：Fake RPC 證明每個角色收到正確啟動參數，effective state 不符會在 prompt 前失敗，恢復後仍顯示原 route。

### O1：隨選 Oracle

- 加入 `oracle` role、`AgentSupervisor.oracle()` 及 `ask_oracle` 工具。
- 加入專用唯讀 prompt、bounded input/output、signal cancellation 及同步 tool result。
- 更新主 agent system prompt 與 TUI 狀態，明確說明 Oracle 是建議而非發布核准。

完成條件：主 session 能在一個困難決策中取得另一個 Pi session 的高推理回答；取消 queued/running Oracle 均不會晚到或重複注入結果。

### O2：強化 Delivery Review

- Delivery 產生 producer set，強制 reviewer 使用已驗證的 `high` route。
- 在 state 及 PR body 記錄 review 的 effective model/thinking、rationale 與 diversity 狀態。
- 保持現有 strict JSON、immutable bundle、input generation、head/base 重驗及 rejected 零發布行為。

完成條件：Oracle 回答不能滿足 gate；review route 不可用或 effective thinking 低於 `high` 時沒有任何 publication command；同模型 fallback 通過時 PR 明確披露降級。

### O3：受授權的真實雙模型驗收

- 在指定測試 repository 以已知不同家族的兩個已登入模型執行一條 Scout/research → Implement/write → independent Review 流程。
- 確認 researcher/reviewer 為模型 B `high`、writer 為模型 A `medium`，並核對 state、TUI、review bundle 與 PR evidence。
- 模擬測試不能替代這一步；付費模型及 GitHub mutation 必須先取得明確目標與授權。

完成條件：一個真實修改由 dual-model review 接受並建立或更新一個 PR，且沒有 merge；若 Pi auth/catalog、effective thinking 或 route 穩定性不成立，停止發布並修正 O0，不以 prompt 掩蓋。

## 9. 最小測試集

### 純路由邊界

- 目錄同時有主模型 A 與 high-capable B 時，Oracle/reviewer 選 B；交換目錄順序不改變 canonical 排序結果。
- writer 固定 A `medium`，不因 reasoning lane 存在而改用 B。
- B 啟動後被 Pi clamp 時，prompt 尚未送出，且自動路由嘗試下一個合格候選。
- 只有 A 可 high 時選 A 並記錄 `same_model_fallback`；A 也不可 high 時 Oracle 失敗且 Review 阻止發布。
- 明確 `--oracle-model` 不可用時回報 canonical route 錯誤，不偷偷換成看似相近名稱。

### Fake Harness 垂直案例

一條案例涵蓋 researcher B/high → writer A/medium → Oracle B/high 建議 → 整合 → reviewer B/high 接受 → 一次 PR publication，逐項核對 requested/effective route 與 rationale。

另外保留以下 load-bearing failure：

- Oracle queued 及 streaming 時取消，沒有 completed result 或遲到 custom message。
- Oracle 完成與 process crash 之間的結果保存時序，重啟不自動重播或誤當 Review。
- reviewer 回傳 accepted，但 effective thinking 不符、head/base/input 已變或含 blocking finding 時，publication ledger 仍為零。
- 同模型 fallback 的 review 可通過，但 state、TUI 及 PR body 都顯示降級。
- Oracle 自然語言中的 `accepted` 字樣不能寫入 `state.review` 或解除 gate。

不建立完整 provider/model 組合、提示詞快照矩陣或成本預測測試。

## 10. 預計修改落點

| 檔案 | 變更 |
| --- | --- |
| `src/openamp/routing.ts` | 唯一新增 production module；純 Pi route 選擇與 rationale |
| `src/openamp/cli.ts` | 解析及保存可選 `--oracle-model`，把 route catalog 連至 extension/supervisor |
| `src/openamp/extension.ts` | `ask_oracle`、主模型 snapshot、system prompt 及 route UI |
| `src/openamp/supervisor.ts` | 明確 model/thinking 啟動、effective 驗證、Oracle lifecycle |
| `src/openamp/state.ts` | Oracle role、Oracle model、主模型集合、requested route、rationale、diversity、input/head snapshot |
| `src/openamp/delivery.ts` | reviewer producer set、high/diversity gate 與 PR evidence |
| `test/openamp/openamp.test.mjs` | 純路由與垂直/failure cases；延伸既有 Fake RPC，不建立第二套 harness |
| `README.md`、`README.zh-HK.md` | 使用者可見工具、雙模型與 fallback 說明 |

若實作時 route selection 能保持在現有 supervisor 且不造成 Oracle/Review 重複，便省略 `routing.ts`；只有兩個 caller 確實共用純決策時才新增檔案。

## 11. 停止條件與完成定義

遇到以下任一情況先停止相應里程碑，不宣稱 Oracle 已完成：

- Pi 目錄不能在不暴露憑證下可靠列出可用模型。
- `--model` / `--thinking` 與 effective `getState()` 無法一致驗證。
- AbortSignal 無法停止 queued/running Oracle，或結果可能被投遞到錯誤 session。
- Oracle/reviewer 能取得修改或發布工具。
- Delivery 無法把 review route 證據綁定至同一個 reviewed head。

功能完成必須同時具備：可選 Oracle、強制獨立 Delivery Review、明確 requested/effective route、不同模型優先、誠實 fallback、確定性故障測試，以及一個經授權的真實雙模型 acceptance。只有文件或 Fake Harness 綠燈不等於真實雙模型能力已驗收。

## 12. 參考

- [OpenAmp 完整計畫](../2026-09-13-openamp-cli-plan.md)
- [OpenAmp M0 技術可行性](m0-feasibility.md)
- [OpenAmp M1–M5 證據](milestone-evidence.md)
- [Amp Oracle 公開說明](https://ampcode.com/docs/tools#oracle)
- [Amp The Dial](https://ampcode.com/docs/the-dial)
- 固定 Pi 套件文件：`node_modules/@earendil-works/pi-coding-agent/docs/rpc.md`、`docs/sdk.md` 及 `docs/usage.md`
