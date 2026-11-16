# 範圍

完整規格：[spec.md](spec.md)（v0.2，2026-11-13）。本檔放 session 開頭要貼的交代、階段 0 的查證結果與 AC 現況；需求與 AC 編號沿用 spec。

## 交代

> 本次目標：DSH session 工作期間在背景產生精簡歷史 cards，主線保留完整 context；正式 compact 時用完整主線 context 一次產生 tail_card 與 overview，驗證後以單一 checkpoint 替換。
>
> 原始要求（REQ，使用者原話）：
> - REQ-1「工作期間背景產生精簡歷史 cards；主線保留完整 context。正式 compact 時，使用完整主線 context，產生最後一張歷史 card 與短整體摘要，再一次替換。」（spec §1）
> - REQ-2「允許舊 cards 再摘要；原始 logs 另存。」（spec 開頭的已確認決策）
> - REQ-3「Need a usable and solid mvp.」（2026-11-14）
>
> 型態：host plugin（新的 compaction provider）＋ `read_history` 工具；無 client UI。
>
> 交付面：GitHub repo `Joker2377/dsh-cards-compaction`。本輪終點是本地 commit。

## 階段 0：host 接點（依 host 0.2.2-rc.1 原始碼查證）

| # | 問題 | 答案 | 依據 |
| --- | --- | --- | --- |
| 1 | compaction provider 接點 | 繼承 `CompactionEngine`（cordis Service `compaction`），實作 `compactIfNeeded`、`compactRegion`、`compactNow`；一個 context 只能有一個 | `@deepseek-ai/dsh-compaction` |
| 2 | 取得主線同一份 request 投影 | `session.requestHeader()`（config、tools）、`session.surface.nodes`＋`deriveEventMessage`、`session.toolHistory()`；`ctx.llm.stream({ purpose: 'compaction' })` | `dsh-compaction-basic` 的 `buildSummarizationInput` |
| 3 | 在模型請求之間攔住下一步 | `agent/pre-step` waterfall；本步新輸入此時尚未寫進 log | `dsh-agent-loop` `preStep()` |
| 4 | writer gate | log 鎖：未配對的 `compaction/start`（晚於最新 `session/end-seed`）代表 busy；所有 compaction backend 共用。`tool-result-pruner`、`image-offload` 不走這把鎖 | `dsh-compaction` README |
| 5 | 原子寫入與恢復 | 沒有整組交易。replace 是單一事件；鎖包住它，崩潰留下可偵測的未配對 start，重啟後由 end-seed 判定為過期 | 同上 |
| 6 | 共用 quota limiter | host 沒有；本外掛自建 process 內 limiter | 搜尋 `dsh-llm`、`dsh-llm-retry` 無對應 API |
| 7 | 原文查閱 | 被替換的事件留在 session log，工具執行時可由 `exec.agent.session` 讀；host 沒有給模型用的查閱工具，所以註冊 `cards_compaction_read_history` | `dsh-tools` exec、`deriveEventMessage` |
| — | 背景 cards 的持久化 | host 規定 repo 外的外掛不得呼叫 `appendPluginRecord`，改用 `ctx.storageDomain`（每個 session 一筆，可遺失） | `dsh-session` README「Write experimental plugin records」、`dsh-storage-domain` |
| — | 前端顯示 | client 以 `uiConversation.events.register` 投影 compaction 生命週期事件，`conversation.chat.node` 依 kind 渲染；`/cards` 指令輸出不進模型 | `dsh-client-ui-conversation`、`dsh-client-ui-goal`、`dsh-commands` README |
| — | 替換內建 backend | dsh-base 類 profile：bundle patch 以 id 停用 host 層 `compaction-basic` 再插入本列；移除外掛就恢復 | `dsh-base/cordis.patch.yml` |
| — | web-app profile（桌面 App） | `dsh-web-app` 已停用 host 層 basic，改在每個 agent preset 的隔離 `compaction` group 掛 basic；bundle patch 進不去 preset 的 `config.plugins`。`agent.ctx` 看不到 preset 的隔離 realm，本外掛在執行期以 `agentPresets.serviceFor(agent, 'compaction')` 判斷，不是自己就不動。要在 preset 啟用，得在 preset 的 compaction group 換列（未驗證） | `dsh-web-app/presets/*.patch.yml`、`dsh-agent-preset-registry` README |

不需要 core patch。桌面 App 的 preset 情境需要使用者在 preset 裡換列，或由 bundle 覆寫整個 preset 定義（尚未決定）。

## AC 現況

驗證方式：U＝單元測試（`test/units.test.mjs`）、E＝假 host 的 engine 測試（`test/engine.test.mjs`）、R＝host 真套件測試（`test/real.test.mjs`，需 `DSH_HOST_NODE_MODULES`）。

| AC | 狀態 | 證據或缺口 |
| --- | --- | --- |
| AC01 prefix 一致、指令在尾端 | 通過（E） | 只比對 messages／tools 投影；沒有錄製真實 adapter 請求 |
| AC02 tool call 輸出 | 通過（U、E） | |
| AC03 第二張卡只記後段 | 部分 | 來源 metadata 精確（E）；內容是否重複記前段需實際模型抽查 |
| AC04 必保留欄位 | 未驗 | 需真模型與品質 fixture |
| AC05 最後請求含完整 cutoff | 通過（E） | |
| AC06 三種情境完整覆蓋 | 通過（E、R） | |
| AC07／AC08 生成期間追加／改寫 | 通過（E） | |
| AC09 平行工具與亂序 | 通過（U、R） | 合法邊界與 host 的 `toolPairingBalancedAfter` 逐點一致 |
| AC10 finalize 期間 stop | 通過（E） | 新訊息排隊由 host 保證（pre-step 時尚未寫入） |
| AC11 遲到 card | 通過（E） | |
| AC12 重複 callback | 通過（E） | 同一 session 並行兩次只提交一次 |
| AC13 故障注入 | 部分 | 生成、提交前失敗都會釋放鎖（E、R）；寫入、flush 中途崩潰沒有測 |
| AC14 多個 compaction owner | 通過（E） | log 鎖；patch 停用 host 層 basic；preset 自有 compaction 時執行期讓出（E；R 用真 cordis 隔離拓樸＋替身 registry）；真 App 未驗 |
| AC15／AC16 配額 | 通過（U、E） | 只限本外掛自己的請求 |
| AC17 單併發無空檔 | 部分（E） | 單併發時背景卡只在 agent 閒置時啟動；沒有長時間測試 |
| AC18 巨大輸入 | 部分 | 門檻把主線輸出、下一步、最後輸出相加（U）；巨大工具輸出交給 host 的 spill-policy |
| AC19 截斷／429／timeout／空摘要 | 通過（U、E） | 429 走 host `dsh-llm-retry` |
| AC20 超預算或沒縮小 | 通過（E） | |
| AC21 十輪以上、兩次 archive | 部分 | 多輪與 archive 各有測試（E）；沒有十輪測試 |
| AC22 續做時查原文 | 部分 | 工具可讀回（E、R）；模型會不會主動查未驗 |
| AC23 cache 全 miss | 通過（設計） | 不依賴 cache 欄位；usage 未知時以估算計入背景預算 |
| AC24／AC25／AC36 品質與成本對照 | 未驗 | 需真模型實測 |
| AC26 archive lineage | 通過（E） | |
| AC27 多次再摘要後讀回原文 | 部分 | digest 穩定（E）；沒有和寫入時的 digest 比對 |
| AC28 跨 session 查閱 | 通過（E） | |
| AC29 原始檔缺失 | 部分 | 越界 seq 明確報錯；磁碟已滿未測 |
| AC30 確定性 assembly | 通過（U） | |
| AC31 timeout 後 slot 隔離 | 通過（U、E） | 前景重試先等隔離期 |
| AC32 背景費用上限 | 通過（E） | |
| AC33 不支援的 host | 通過（U） | `engines.dsh` 限制版本；缺 host 套件時 apply 拒絕載入 |
| AC34 停用、更新 schema | 部分 | 停用時取消背景工作（E）；移除外掛後 checkpoint 仍是一般 user 訊息，但 `read_history` 隨外掛消失 |
| AC35 無限重試 | 通過（E） | 連續失敗兩次後 BLOCKED |
| AC37 重啟 | 通過（E、R） | READY card 存在 host storage-domain（R：真的 json backend 重開後讀回），使用前重驗 |
| AC38 半份結果 | 通過（U、E） | |

## 不做（v1）

- 圖片、音訊、外部附件的完整支援（spec §12）。
- 備援模型路由（spec §18）。
- 完整 context 超出摘要輸入上限時以 cards 代替原文的降級模式（spec §13）。目前 overflow 時只壓縮放得下的前段、保留其餘原文後重送一次（E），沒有以 cards 代替整個輸入。
- 常駐的狀態列（spec §19）。目前以對話中的壓縮列與 `/cards` 指令呈現，未在真實 App 畫面驗證。
- 不連續 READY cards 的採用（只接受連續前綴，spec §9）。

## 尚未驗證

- 真實 App 載入與長對話使用（安裝需另外授權）。
- web-app preset 內以本外掛取代 `compaction-basic`。
- 門檻、預算與背景頻率的效能與成本（spec §13）。
