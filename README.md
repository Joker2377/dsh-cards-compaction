# dsh-cards-compaction

[![test](https://github.com/Joker2377/dsh-cards-compaction/actions/workflows/test.yml/badge.svg)](https://github.com/Joker2377/dsh-cards-compaction/actions/workflows/test.yml)

*Background history-card compaction for DeepSeek Harness: cards are prepared while you work, and one verified checkpoint replaces the history when context runs low.*

> [!NOTE]
> DeepSeek Harness bundle. Installs into a profile; it does not run on its own.

> [!WARNING]
> MVP。已用 host 0.2.2-rc.1 的真套件（Session、cordis、dsh-compaction）跑過整合測試，**尚未在真實 App 的長對話中使用過**。規格見 [docs/spec.md](docs/spec.md)，範圍與進度見 [docs/scope.md](docs/scope.md)。

## 功能

- 工作期間，在背景把較舊的歷史整理成精簡的 history cards（工具、命令、結果、決策），不改動模型正在用的 context。
- context 接近上限時，在兩次模型請求之間讀一次完整 context，補上最後一張 card 與一份整體 overview，驗證全部覆蓋且真的變小後，才一次替換。
- 多輪 compact 沿用舊 cards；cards 超過預算時把最舊的幾張合併成 archive card；舊 overview 被取代，不會累加。
- 原始紀錄留在 session log。模型可用 `cards_compaction_read_history` 以 card id 讀回原文（分頁、搜尋、digest）。
- `/compact` 照常可用，改由本外掛執行。

## 安裝

在 DSH 裡貼：

```text
https://github.com/Joker2377/dsh-cards-compaction
```

> [!IMPORTANT]
> 貼倉庫**首頁**網址。`https://github.com/Joker2377/dsh-cards-compaction/tree/main` 這類頁面網址會被拒絕。

或用 CLI：`plugin_manager install_bundle`，spec 用 `github:Joker2377/dsh-cards-compaction`。

安裝會停用 host 層的內建 `compaction-basic`（一個 agent 只能有一個 compaction owner）；移除本外掛後內建 backend 自動恢復。

> [!IMPORTANT]
> **DSH 桌面 App（`dsh-web-app` profile）**：compaction 不在 host 層，而是每個 agent preset 各自在隔離的 `compaction` group 裡掛 `compaction-basic`。本外掛的 patch 碰不到 preset 裡的列，所以只裝外掛的話，preset agent 仍由 `compaction-basic` 壓縮。本外掛每次 hook 都向 preset registry（`agentPresets.serviceFor`，host 自己也這樣查）確認這個 agent 用的 compaction；不是自己就保持不動，log 會出現 `another compaction service owns this agent`。這個判斷在真 cordis 的隔離拓樸上測過，但 preset registry 用的是替身，尚未在 App 裡實測。
>
> 要只在某個 preset 啟用：先安裝本外掛，再把該 preset `compaction` group 裡的 `compaction-basic` 列換成本外掛（`command-compact`、`tool-result-pruner` 保留）。其他 preset 不受影響。preset 覆寫會取代整份子列表，所以建議另外新增一個 preset，不要直接改內建的。
>
> ```yaml
> - id: compaction
>   name: cordis:group
>   group: true
>   isolate:
>     compaction: true
>     toolResultPruner: true
>   config:
>     - id: cards-compaction
>       name: dsh-cards-compaction
>     - id: command-compact
>       name: '@deepseek-ai/dsh-command-compact'
>     # tool-result-pruner 照原 preset
> ```
>
> preset 裡那份與 root 那份共用同一個 `cards_compaction_read_history` 工具。沒裝本外掛就引用這一列，該 preset 會沒有 compaction。這條路**尚未在 App 裡驗證**。

設定值錯誤（鍵名打錯、型別不對）時本外掛拒絕載入；在 dsh-base 類 profile 裡內建 backend 也已被停用，此時沒有任何 compaction，log 會有載入錯誤。修正設定或移除本外掛即可恢復。

## 使用

### 最常見的一條路

裝好、重載 App 後照常工作。不需要任何操作：

1. 歷史累積到 `cardMinSourceTokens`（預設 8000）後，背景產生 card；聊天裡不會出現訊息。
2. 請求到達 context 視窗的 65%（或更早的安全上限）時，下一步開始前自動切換成 checkpoint。
3. 想立刻壓縮就輸入 `/compact`。

### 設定

在 profile 的 `cordis.patch.yml` 覆寫 `cards-compaction` 列的 `config`；鍵名打錯會讓外掛拒絕載入，不會靜默用預設。

```yaml
- id: cards-compaction
  name: dsh-cards-compaction
  config:
    providerConcurrency: 2      # provider 允許的併發；不確定就維持 1
    finalizeSoftRatio: 0.65
    postCompactTargetRatio: 0.4
    background: true            # false：只在切換時一次產生
```

完整鍵與預設值見 [lib/config.js](lib/config.js) 的 `DEFAULTS`（對應 spec §17）。

## 疑難排解

| 症狀 | 原因 | 做法 |
| --- | --- | --- |
| log 出現 `auto finalize disabled for <provider>/<model>` | 該模型沒有 contextWindow，或視窗放不下輸出預留 | 在 adapter 設 `contextWindow`，或調小 `nextStepReserveTokens`、`finalMaxOutputTokens` |
| log 出現 `BLOCKED` | 連續兩次切換失敗（模型錯誤、輸出格式錯、checkpoint 沒有變小或超出目標） | 看前面的 `finalize failed` 原因；`/compact` 成功後自動解除 |
| 對話仍然撞到 context 上限 | 單步新增內容超過 `nextStepReserveTokens`，或 BLOCKED | 調大 `nextStepReserveTokens`；本外掛不在 overflow 時以 cards 代替完整輸入（spec §13） |
| log 出現 `another compaction service owns this agent` | agent preset 自己掛了 `compaction-basic` | 見「安裝」的 preset 說明 |
| 外掛載入失敗、也沒有任何 compaction | 設定值錯誤，或不在 DSH 內執行 | 修正 `cards-compaction` 列的 `config`，或移除外掛 |
| `/compact` 回 busy | 有 turn 正在進行，或另一個 compaction 鎖未釋放 | 等 turn 結束再試 |
| 模型說找不到 card | card id 不屬於這個 session | 用 checkpoint 裡列出的 id，或直接給 seq 範圍 `12-40` |

## 運作原理

- **背景產卡**：在 tool-pairing 平衡的邊界選出未覆蓋的區段，送出「原主線 prefix＋尾端指令」，請求前綴和主線逐項相同。輸出含 tool call、截斷或空白一律拒絕。結果驗證來源 digest 沒變才存成 READY，寫成 `plugin:dsh-cards-compaction/card` plugin record，重啟後可重用（使用前重驗）。
- **正式切換**：在 `agent/pre-step`（新輸入尚未進 log）以 host 的 `compaction/start`／`end` log 鎖包住整個交易：採用連續的 READY cards，尾段過大先補卡，最後一次請求讀完整 context 產生 `<tail_card>` 與 `<overview>`。覆蓋、lineage、checkpoint 確實變小、符合 `postCompactTargetRatio` 都通過，surface 也沒有被改動，才以一個 `user/message` replace 提交。任何失敗都保留原主線，並以帶錯誤的 `compaction/end` 釋放鎖。
- **配額**：同一 process 內各 session 共用每個 provider 的 limiter。前景優先，背景只用空閒 slot。`providerConcurrency: 1`（預設）時背景卡只在 agent 閒置時啟動；使用者在背景卡進行中送出新訊息，下一步會等它結束（最多 `backgroundAttemptTimeoutMs`）。逾時放棄的請求在隔離期後才歸還 slot，前景重試也先等隔離期。
- **擁有權**：每次 hook 先問 `agentPresets.serviceFor(agent, 'compaction')`（`agent.ctx` 看不到 preset 的隔離 realm），沒有 preset compaction 才看 `agent.ctx`；不是本 engine 就不做任何事。agent 結束（`agent/disposed`）時中止該 session 的背景卡。
- **checkpoint 文字**是確定性的：同樣的 cards 與 overview 產生同樣的文字，並能解析回 cards，下一輪靠它沿用舊 cards。

## 開發

```bash
node scripts/check.mjs
npm test              # DSH 桌面沙箱內用 npm run test:sandbox
```

測試只用 `node:` builtins 與 `lib/`，不需要 `npm install`。`test/real.test.mjs` 對 host 真套件跑整合測試；沒設環境變數時印 `SKIP`。要跑它，把 App 的 `app.asar` 裡的 `dsh/node_modules` 解到任一目錄，再：

```bash
DSH_HOST_NODE_MODULES=<那個 node_modules 目錄> npm test
```

## 已知限制

- 尚未在真實 App 的長對話中使用過；預設門檻沒有經過效能或成本實測（spec §13）。
- 背景產卡會重送整份 prefix；provider cache 沒命中時，總成本可能高於內建 compaction。
- provider 配額只在本 process 內協調；外部流量與其他 App 實例看不到。
- context overflow 不處理：已經放不下完整 context 時保留原狀，讓 host 錯誤成立。
- `tool-result-pruner`、`image-offload` 仍可能改寫 surface；本外掛以 digest 偵測並丟棄過期的 card，不協調它們的寫入。
- 圖片與音訊沒有特別處理；`read_history` 對圖片只顯示 `[image]`。
- 只採用從 checkpoint 之後連續的 READY cards；中間有缺口時，缺口之後由最後一次請求補齊。
- devkit doctor 的 patch 讀取器不認得以 id 定位的停用列，會對 `cordis.patch.yml` 發一則 `patch/unreadable` 警告；這一列的寫法與 profile 自己的 patch 相同。

## 授權

MIT，見 [LICENSE](LICENSE)。
