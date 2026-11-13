# 範圍

完整規格：[spec.md](spec.md)（v0.2，2026-11-13）。本檔只放 session 開頭要貼的交代與階段表；需求與 AC 編號沿用 spec，不另編一套。

## 交代

> 本次目標：DSH session 工作期間在背景產生精簡歷史 cards，主線保留完整 context；正式 compact 時用完整主線 context 一次產生 tail_card 與 overview，驗證後以單一 checkpoint 替換。
>
> 原始要求（REQ，使用者原話）：
> - REQ-1「工作期間背景產生精簡歷史 cards；主線保留完整 context。正式 compact 時，使用完整主線 context，產生最後一張歷史 card 與短整體摘要，再一次替換。」（spec §1）
> - REQ-2「允許舊 cards 再摘要；原始 logs 另存。」（spec 開頭的已確認決策）
>
> 型態：host plugin（新的 compaction provider）＋ `read_history` 工具；無 client UI。
>
> 完成條件：spec §10 的 R01–R16 與 §11 的 AC01–AC38；發布門檻見 spec §20。
>
> 交付面：GitHub repo `Joker2377/dsh-cards-compaction`＋release（附 `.tgz`）。

## 階段

| 階段 | 產出 | 完成條件 | 狀態 |
| --- | --- | --- | --- |
| 0 | Pin DSH 版本；逐項實測 snapshot、LLM request 投影、writer gate、replacement、持久化、quota limiter 接點 | 證明 plugin 能控制完整切換；缺的 host 能力列成 core patch | 未開始 |
| 1 | 同步正確版：一次產出 tail_card＋overview、覆蓋檢查、token 預算、安全提交 | AC02、04–06、09、12–14、18–20 | 未開始 |
| 2 | 背景候選：snapshot／card store、來源校驗、採用 READY | AC01、03、07–08、10–11 | 未開始 |
| 3 | 配額與恢復：全域 limiter、取消、故障注入、重啟對帳 | AC13–17、19、23、30–33、37–38 | 未開始 |
| 4 | 多輪與實測：archive cards、原文查閱、品質與成本 | AC21–29、34–36 | 未開始 |

## 階段 0 要回答的問題

每題先寫下各種結果代表什麼、接著做什麼，再跑探針。

1. host 有沒有公開的 compaction provider 接點？註冊方式與 `BasicCompactionEngine` 的關係？
2. 能否取得與主線**同一份** request 投影（system、tools 及順序、messages、route）？
3. 能否在模型請求之間攔住下一步（取得切換權）？
4. 所有 surface writer（內建 auto compact、tool-result pruner、image offload、手動 compact）能否經過同一個 writer gate？
5. replacement 是否有整組原子寫入？沒有的話，崩潰後能否從 durable log 辨認半提交？
6. 有沒有以 provider＋帳號為範圍的共用 quota limiter？
7. host 既有的 session history 查閱能力夠不夠當 `read_history`？夠就不註冊本 plugin 的工具。

## 不做（v1）

- 圖片、音訊、外部附件的完整支援（spec §12：驗證前不宣稱支援）。
- 備援模型路由（spec §18）。
- 完整 context 超出摘要輸入上限時以 cards 代替原文的降級模式（spec §13）。
- 直接 monkey patch agent 內部或只繼承 `BasicCompactionEngine.summarize()`（spec §12）。

## 骨架現況

- `lib/tools.js` 的 `read_history` 只有 schema，執行時丟 `NotImplementedError`。第 7 題答案出來前不要實作。
- `engines.dsh` 下限 `0.2.2-rc.1` 是目前安裝的 host 版本，**尚未在真實 host 載入驗證**。
