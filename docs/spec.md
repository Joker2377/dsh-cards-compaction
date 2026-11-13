# 背景 Cards Compaction：設計、需求與驗收規格

版本：v0.2 完整實作規格｜2026-11-13

本文件是待實作、待驗證的規格，不代表功能已完成。依本次討論與前輪讀取的 Codex／DeepSeek Harness 原始碼整理。

決策已確認：允許舊 cards 再摘要；原始 logs 另存。本文將此行為列為正式需求，不再保留為待選方案。其他數值為可調整的初始預設，不代表經過效能驗證。

## 1. 已確認的產品行為

**工作期間背景產生精簡歷史 cards；主線保留完整 context。正式 compact 時，使用完整主線 context，產生最後一張歷史 card 與短整體摘要，再一次替換。**

| 階段 | 讀取 | 產出 | 是否改主線 |
| --- | --- | --- | --- |
| 背景產卡 | 原主線 prefix＋尾端指令 | 指定區段的精簡歷史 card | 否 |
| 正式 compact | 截止點的完整主線 context＋尾端指令 | 所有剩餘區段的尾段 card，以及短整體摘要 | 驗證通過後才改 |
| 下一輪工作 | 固定指令＋歷史 cards＋整體摘要 | 正常 agent 行為 | 正常追加 |

「完整」指目前模型可見的主線 context；若已經做過前一輪 compact，它包含前輪 cards 與摘要，不代表把歷來所有原始 log 重新載入。

### 不可改變的要求

- 不把摘要指令換成新的前置 system prompt。
- Compactor 是一次模型生成，不進入 agent／tool 執行循環。
- 前段 cards 是精簡歷史，不必各自寫整體交接。
- 最後摘要讀完整主線，不只讀 cards 或最後尾段。
- 成功切換時，截止點之前沒有未成卡的原始尾段。固定指令與必要模型協定項目除外。

### 本版設計選擇

Cards 使用帶來源標記的文字歷史紀錄；保留工具名稱、命令、短結果，但不偽裝成待執行的 function call。模型可見的 cards 不提升為 system／developer 指令。原始工具事件另存，繼續供 UI、稽核與必要查閱使用。

最後一張「歷史 card」與「整體摘要」是不同欄位，預設同一次生成。兩者都看到完整主線；前者只記錄未覆蓋區段，後者統整整體狀態。

## 2. 資料與範圍

維持四份資料：原始 event log、目前主線 context、背景候選 cards、已提交 checkpoint。

### Card 的最小資料

| 欄位 | 責任 |
| --- | --- |
| session／branch／epoch | 防止不同分支、不同 context 世代混用 |
| ordered source IDs、source digest | 指定實際壓縮的連續來源；由程式建立，不由模型宣稱 |
| request snapshot／route identity | 記錄實際送給 provider 的前綴、model、schema 與隔離身分 |
| body、input/output tokens、usage | 精簡紀錄與實際成本 |
| job ID、attempt ID、status | 排程、重試、去重與恢復 |

Snapshot 必須連同 tool schemas、訊息投影、tool history／歸因與路由資訊一起固定；不能讀了舊 messages，再配上生成期間改變的 live tools。

### 兩個範圍必須分開

- **閱讀範圍**：從主線起點到已完成邊界 B 的完整 prefix。
- **壓縮範圍**：本次尚未覆蓋的 A…B。

第二張卡可讀 A 之前的歷史以理解名稱，但只能記錄其指定區段。不得把之前的事情重新寫成第二張卡發生的事情。範圍標示與工作指令都加在原 prefix 之後；不在舊訊息中插入標籤。

### 覆蓋不變條件

對本輪截止點以前的新增歷史，所有已選 cards 的來源聯集必須等於待壓縮事件集合，且互不重疊、順序一致。這保證「每段有處理」，不等於模型語意一定無遺漏；後者需另外測試。

固定 system／developer 指令不屬於可壓縮區段。前輪已提交 cards 視為既有歷史；前輪整體摘要會被新的整體摘要取代，不一輪一輪累加。

## 3. Card 與最後摘要的內容規則

### 一般 card：精簡歷史

保留工具名稱、可重現命令／關鍵參數、適用工作目錄、結果狀態及短 logs。長輸出縮成重點，保留關鍵錯誤、路徑、數值與可查閱原文的定位。

使用者改變目標、重要限制、已做決定，也要在其發生位置留下必要紀錄；不能因 card 以工具 logs 為主而全部刪掉。無須替每張卡額外推導全局進度或撰寫敘事銜接。

例：

~~~text
[card 03｜source e41…e58]
user: 改為支援離線匯入。
tool: shell；cwd=/repo；command=pytest tests/import
result: exit=1；18 passed、1 failed。
error: test_duplicate_id；預期去重，實際新增兩筆。
change: importer.py 加入 ID 去重；尚未重新測試。
~~~

規則：計畫不寫成完成；測試通過要保留適用版本／執行先後；歷史指令與當前指令要能區分。內容過長的參數或輸出可保留原文引用，但引用必須真的可透過主線既有能力查閱。

### 最後摘要：完整理解、較短輸出

輸入是截止點的完整主線 context；輸出集中於目標、有效限制、重要決策與理由、當前狀態、未解問題、下一步。不要重新逐條抄錄 cards 裡的命令。

摘要不必零重複；必要的關鍵失敗或決策可重述。不能為了縮短，刪掉繼續工作所需的理由。

### 最後一次生成

回傳兩個獨立文字欄位：tail_card、overview。來源範圍在模型外綁定。若沒有新增尾段，tail_card 明確為空；不用製造空白事件。

若仍有背景 job 未完成，先固定哪些已完成 cards 被採用；最後請求涵蓋其餘全部區段。之後才到達的結果不得補進已固定的 assembly。

預設用尾端指令要求格式，不為了 JSON schema 隨意改變 request 前綴；若 adapter 支援不影響 prefix 的結構化輸出，再以實測採用。

## 4. 執行流程

### A. 背景準備

1. 在完整 step／工具配對邊界，找出尚未覆蓋的連續區段。
2. 在短暫 session lock 內擷取不可變 snapshot 與來源資料。
3. 取得 provider 配額後，送出一次摘要請求；主線繼續。
4. 驗證結果及來源是否仍有效，將 card 持久化為 READY。
5. 不插入主線、不替換訊息、不更改主線 token usage。

大型 step 可以超過理想卡片尺寸，但不能切開未配對的 call/result。若沒有適合的邊界，就延後；不能為了 token 數製造不合法歷史。

### B. 正式 compact

1. 在模型請求間取得切換權，暫停新主線推論與該 session 的新背景工作。
2. 等待當前工具呼叫收束，或依 host 支援終止後記錄真實結果；不可虛構完成。長期背景工作可維持執行，但其新事件在截止點後排隊。
3. 固定 cutoff snapshot、採用 cards 清單及未覆蓋範圍。進行中的 card job 可等短期限；否則標成不採用。
4. 用完整 cutoff snapshot 產生 tail_card＋overview。單併發下須先確定舊請求釋放 slot。
5. 驗證覆蓋、內容、最終 token 預算與 snapshot 有效性。
6. 透過 host 的持久化／replacement 機制提交一個 checkpoint；恢復主線，依序加入截止點後的訊息。

成功後：

~~~text
固定指令
＋ 前輪保留的歷史 cards
＋ 本輪背景 cards
＋ 本輪 tail_card（如有）
＋ 新 overview
~~~

截止點後收到的新訊息屬於下一輪，正常追加；這不等於留下截止點前的原始尾段。

### C. 成功提交的必要條件

來源 epoch、來源內容、分支、政策與目標 route 相容；採用集合無缺口；生成完整且只有允許內容；組裝後低於目標預算。任一不符都不得以「部分成功」取代主線。

## 5. 觸發與 provider 排程

### 產卡觸發

以「未覆蓋的新增 log token 數」為主，配合完整 step 邊界。加入最小間隔、最低壓縮收益、背景費用上限，避免每個小工具結果都重送整份 prefix。

最小區段大小可以先以 8k tokens 做實驗起點，並非發布保證值。工作負載短、重複少時，可以完全不產背景卡，最後再一次生成。

### 正式 compact 觸發

門檻必須同時滿足主線請求與最後摘要的輸入／輸出預算。C 是目前完整 request 輸入，已包含 system、tools 與訊息包裝。對輸入輸出共享視窗的 provider，開始下一步前須同時成立：

~~~text
C＋主線輸出預留 ≤ context window

C＋下一步新增內容上限
 ＋最後指令長度＋tail_card 輸出預留＋overview 輸出預留
 ＋token 估算誤差緩衝 ≤ context window
~~~

同時在發送主線請求前與接收工具結果後檢查。實作使用 provider 自身的視窗規則，不假設所有 provider 都用同一計算方式。

「下一步新增上限」必須包含這一步新增的 assistant 訊息、所有工具結果及被接受的外部訊息，不能只算工具 stdout。不符合第二條時，在執行該步前就先 finalize；不可把主線輸出預留與最後摘要輸出預留取最大值，因為前者可能先成為後者的輸入。巨大工具 stdout 可先保存完整原文，再以有明確省略標記的 bounded projection 進入主線；不可事後偷偷改寫已送過的 prefix。超大使用者輸入需先做 admission 檢查。

每次最後請求也必須現算實際未覆蓋尾段與輸出預算；尾段成長過大就先補卡。提交目標同時要求真正縮小，且留下可開始下一步並仍能安全再 compact 的空間。固定指令本身已佔滿視窗時，任何歷史壓縮策略都無法解決。

### 排程規則

| 情況 | 規則 |
| --- | --- |
| 可並行 | 前景優先；每 session 最多一個背景 card request，且須有可用 provider 配額 |
| 單併發 | 主線推論期間不啟動 card；長工具空檔或閒置才啟動 |
| 主線提早恢復 | 已啟動請求不可假定可搶占；等待至完成／期限，或走 provider 已驗證的取消流程 |
| 到正式切換點 | 最後 compaction 提升為前景必要工作；不再啟動背景卡 |
| 429／配額未知 | 有界 backoff，降低背景併發；不能據單次 429 斷言 provider 只有一併發 |

Limiter 依真正配額範圍共享，例如 provider＋帳號，不可每個 session 各自假設有一個免費 slot。另計 TPM／RPM；背景與主線各一個仍可能競爭 token quota。

未受本 plugin 管理的外部流量無法完全協調。單併發且主線連續推論時，允許沒有背景收益；最後短暫阻塞是正確行為。

## 6. Prefix cache 的要求與界線

- 從主線已完成、provider 有機會持久化的邊界建立請求。
- 保持 model、system、tools 及順序、訊息序列、隔離身分、adapter 投影一致。
- 只追加任務指令，不移動、改寫或重新摘要前方訊息。
- Worker 不啟動工具執行器。若回傳 tool call，即使同時有文字，也拒絕該次結果，不把它當已執行。
- Cache miss 不影響正確性；記錄命中 tokens、費用與延遲，不保證 KV 直接繼承。

若 provider 的 non-tool 選項、reasoning 模式或 structured output 會改變輸入模板，先量測再啟用。不可為求 cache 命中而重送 API 禁止回傳的隱藏欄位。

主線正式換成 cards 後，改寫位置之後通常要重新建立 cache。這是設計成本；背景卡提高生成時的重用機會，不代表切換後仍能重用整份舊 cache。

完整 prefix 每張卡都重送，可能造成累積輸入成本很大。背景命中率高，不足以證明比普通 compact 便宜。

## 7. 競態、取消與持久化

### 狀態

Card：QUEUED → RUNNING → READY；失敗、取消或來源過期進入終止狀態。只有 READY 可被採用。

Session：WORKING → FINALIZING → COMMITTING → WORKING。FINALIZING 失敗可回到未修改的 context；若已無安全容量，停在 BLOCKED。COMMITTING 持久化結果不明時進入 RECOVERING，不能直接重跑替換。

### 驗證方式

背景只要求來源區段仍一致；後方 append 不使其失效。若 host generation 對所有 append 都遞增，不能直接拿它當「歷史被改寫」版本：應另設 replacement epoch 與來源 digest。

最後摘要則綁定完整 cutoff snapshot；產生後若主線已被改寫，不得把舊 overview 當作新狀態提交。正常新訊息先排隊；rollback、branch switch、政策／model 變更會取消本次 finalize 並重新準備。

### 取消與故障

停止操作取消未提交的 finalize，保留原主線及已有效 READY cards。已提交成功之後收到停止，不回滾既有 checkpoint，只停止後續工作。

每次提交使用唯一 checkpoint ID，記錄前一 epoch、cutoff、cards 清單、overview 與 replacement digest。提交在 host writer／mutation gate 內重驗來源；API 等待不持有這把 lock。

不能將 JavaScript 中連續 append 誤認為磁碟交易。DSH 若無整組原子寫入，需使用其可恢復的事件協定與額外 journal／checkpoint 記錄；崩潰後先辨識 replacement 是否已存在，再決定補齊結束事件或重試，防止重複替換。

Flush 失敗不能直接宣告「原主線完全未改」：可能是寫入狀態未知。此時暫停推論，依 durable log 重建與對帳。這是整合前必須驗證的技術關卡。

## 8. 多輪 compact 與 cards 大小

Cards 不可無限累積。預算包含固定指令、所有歷史 cards、最新 overview，以及下一輪工作所需空間。

一般情況沿用前輪 cards，只為新歷史產卡；舊 overview 由新 overview 取代。未完成 jobs、關鍵約束與來源引用必須在新摘要中延續。

當舊 cards 超過配置的歷史預算：

1. 選最舊的連續 cards，產生一張較精簡的 archive card，保留來源 lineage。
2. 此候選同樣不修改主線；最後 overview 仍讀合併前的完整主線 snapshot。
3. 新 checkpoint 使用 archive card＋近期 cards＋新的尾段 card＋overview。
4. 仍無法符合容量就不提交；不能靜默刪掉最舊 cards。

Archive card 是有損再壓縮，不能保證無限輪次後仍保留每一個命令。已確認允許這種再摘要；完整原始 logs 另存，必須能查閱。原文存在不等於模型當下記得一切，因此查閱能力及關鍵狀態延續均納入驗收。

詳細合併演算法、容量分配與原文查閱契約見第 15–17 節。

## 9. 邊界情況與處理

| 情況 | 預期行為 | 尚存限制 |
| --- | --- | --- |
| 背景摘要時主線新增 logs | card 仍有效；新增內容留待下一張 | 無 |
| 背景卡尚未完成就要切換 | 固定 READY 集合，其餘由最後 tail_card 補齊；遲到結果不採用 | 單併發可能要等 slot |
| Cards 間出現缺口或重疊 | 不提交；MVP 只接受連續前綴，從缺口重做 | 多花一次生成 |
| 多工具平行執行、結果亂序 | 以完整配對邊界與實際 surface 順序選範圍 | 不能按完成時間任意排序 |
| 工具執行很久／輸出持續到達 | 保留真實 job 狀態；只在安全邊界切換，晚到事件屬下一輪 | 無安全邊界時須等待或正確中止 |
| 一個工具結果很巨大 | admission 前原文保存＋受限投影，或較早切換 | 壓縮不能解決無界輸入 |
| Finalize 期間新 user 訊息 | 依序排隊，提交後再追加；取消／回滾另行中斷 | 新修正可能讓 overview 部分過時，後續新訊息優先 |
| Rollback／另一個 compact | 來源失效，取消舊候選與 finalize | 必須與其他 writer 共用協定 |
| Model／tools／policy 改變 | 舊卡只作文字候選評估；最後請求重取相容 snapshot、重估大小 | Cache 不保證可沿用 |
| 分支／fork | 只有祖先來源完全相符才能共用文字卡；worker 與提交各自隔離 | 不混用 provider 身分 |
| 空摘要、格式錯誤、max tokens、tool call | 拒絕該輸出，有界重試；主線不被部分替換 | 重試仍計費 |
| 尾段太大，兩欄輸出不夠 | 先補卡，再以完整主線做最後摘要；不切掉尾段 | 正式切換等待增加 |
| 新 context 沒縮小／仍超標 | 不提交，縮小輸出或先合併舊 cards | 必須有重試上限 |
| 卡片提到已過時成功結果 | 保留時間與版本；overview 以最新狀態為準 | 語意錯誤需品質測試 |
| 重啟、重試回覆重複 | READY 卡校驗後可重用；running 標為未完成；checkpoint ID 去重 | 不能保證已取消請求不計費 |
| 圖片、音訊或外部附件 | 不靜默忽略；保留必要描述與可用引用，驗證 adapter 能力 | 無法可靠保存者，不宣稱支援 |
| Provider cache miss | 正常完成；記錄成本、可降低背景頻率 | 不屬正確性失敗 |
| 單併發且沒有工具空檔 | 背景排隊，最後同步 compact | 無法承諾零等待 |
| 完整主線已超出摘要輸入上限 | 保留主線、停止自動切換，回報無法履行完整輸入要求 | 用 cards 取代原文送入最後摘要，屬另一種需明確接受的降級 |
| 注入指令出現在工具 log | 當歷史資料處理；worker 無工具執行權，card 不提升權限 | 不把摘要當新的授權來源 |

## 10. 功能需求

| ID | MUST 要求 |
| --- | --- |
| R01 | 背景 cards 不修改主線 context；不執行工具、不啟動 subagent 循環 |
| R02 | 閱讀 prefix 與壓縮區段分離；輸入來自一致 snapshot |
| R03 | Cards 保存精簡操作、重要短 logs、必要 user／assistant 事實與來源 |
| R04 | 成功替換對 cutoff 前新增歷史完整覆蓋，無原始尾段、無缺口或重複 |
| R05 | 最後 overview 使用完整 cutoff context，而非只有 cards／尾段 |
| R06 | 正式提交重驗來源與 epoch，保留截止點後輸入順序，支援取消 |
| R07 | 所有模型呼叫遵守共用 provider 配額、timeout、費用與重試上限 |
| R08 | Cache 是最佳努力；可量測，不能作為正確性前提 |
| R09 | 最終 token 預算包含 wrapper、cards、overview、固定指令及後續預留 |
| R10 | 候選與 checkpoint 可持久化、恢復、去重；未知提交狀態先對帳 |
| R11 | 多輪 cards 有總預算；允許舊卡再摘要、保留來源及原始 logs；舊 overview 不累加 |
| R12 | 不滿足完整輸入或安全提交條件時停止切換，保留可恢復狀態 |
| R13 | 原文查閱受 session／branch 權限限制，有大小上限、游標及完整性驗證 |
| R14 | 以確定性 assembly 與冪等提交保證相同候選輸出一致，不依模型排列來源 |
| R15 | 配置、schema、prompt 版本與可觀測資訊完整；不以未知 usage 當零成本 |
| R16 | 啟用、停用及 host 更新須保護既有 checkpoints 與原文查閱能力 |

## 11. 驗收條件（AC）

以下為待執行測試。R01–R16 對應的結構與競態測試必須全部通過；效能改善以實測判定，不能先宣稱。

### A. 請求與內容

| ID | 測試 | 通過標準 |
| --- | --- | --- |
| AC01 | 擷取背景 card request 與相應主線 request | 原 prefix 在 adapter 可觀測投影一致；任務指令只在尾端 |
| AC02 | Mock 回傳 tool call；另回傳文字＋tool call | 工具執行次數皆為 0；兩者皆不能成為 READY card |
| AC03 | 第二張卡讀較長 prefix，只負責後段 | 來源 metadata 精確；內容抽查沒有把前段操作再算成後段 |
| AC04 | 混合工具 logs、user 更正、計畫、失敗與成功 | 必保留欄位正確；沒有計畫變完成、舊測試套到新版本 |
| AC05 | 最後請求錄製檢查 | 包含完整 cutoff snapshot；未以 cards 替換尚存在主線的原文 |
| AC06 | 有尾段、無尾段、未完成背景卡三種情境 | 成功 checkpoint 均完整覆蓋；不存在 cutoff 前原始尾段 |

### B. 競態與生命週期

| ID | 測試 | 通過標準 |
| --- | --- | --- |
| AC07 | 卡片生成時追加主線事件 | 卡片可採用；新事件不遺失、不重複 |
| AC08 | 卡片生成時改寫來源、rollback、切分支 | 舊候選不能覆蓋新歷史 |
| AC09 | 平行工具呼叫與亂序結果 | snapshot 與提交不產生 orphan call/result |
| AC10 | Finalize 期間注入新訊息與 stop | 正常訊息排隊且順序不變；stop 在提交前取消並保留主線 |
| AC11 | 最後請求已開始後收到遲到 card | 固定 cards 清單不變，無雙重覆蓋 |
| AC12 | 重複 callback／重試同一 checkpoint | 最多一個可見 replacement；原始 log 不重寫 |
| AC13 | 在準備、生成、replacement 寫入、flush、end 各點故障注入 | 重啟後能辨別舊／新／未完成狀態；不使用未知半提交 context 推論 |
| AC14 | 手動 compact、內建 auto compact 與 plugin 同時觸發 | 只有一個提交 owner；未協調的第二個 writer 不可進入 |

### C. 配額與容量

| ID | 測試 | 通過標準 |
| --- | --- | --- |
| AC15 | 全域 mock provider 容量 1，多 session | 任意時刻有效請求數不超過 1；取消未確認時不提早歸還 slot |
| AC16 | 容量 2 且主線持續工作 | card 可與主線重疊；背景不壟斷前景配額 |
| AC17 | 無工具空檔的單併發 workload | 能完成最終同步切換，無死鎖；不得宣稱背景無等待 |
| AC18 | 主線輸出達上限、平行巨大工具結果及超大外部輸入 | 同時預留新增內容與最後摘要輸出；projection／admission 生效；不偷偷修改既有 prefix |
| AC19 | 輸出截斷、429、timeout、空摘要 | 有界重試；無部分 checkpoint；背景失敗不污染主線 usage |
| AC20 | 最終組裝超過預算或沒有縮小 | 拒絕提交；補卡／合併後重估；達上限則明確停住 |

### D. 多輪、品質與收益

| ID | 測試 | 通過標準 |
| --- | --- | --- |
| AC21 | 至少 10 輪 compact，並觸發兩次以上 archive merge | 舊 overview 不累加；cards 容量受限；lineage、未完成事項與有效限制可追溯 |
| AC22 | 需要查看被省略 log 的續做任務 | 主線能透過實際可用能力找回正確原文，不依賴虛構 handle |
| AC23 | Cache 全 miss、無 cached-token 欄位 | 功能仍正確；指標標記未知／miss，不捏造命中率 |
| AC24 | 摘要前後相同任務對照 | curated fixture 的關鍵目標、限制、最新錯誤及下一步皆保留；人工檢查無狀態反轉 |
| AC25 | 與一般同步 compact 做相同 workload 對照 | 公開總 input/output 成本、主線額外等待 P50/P95、切換後首請求延遲、品質結果；不只報 cache hit |

品質 fixture 至少包含：撤回舊指令、失敗後修復但未重測、兩個同名檔案、跨卡依賴、長期背景 job、分支回滾。自動欄位檢查只能覆蓋部分語意，不能證明所有摘要都正確。

### E. 長期使用、可恢復性與產品邊界

| ID | 測試 | 通過標準 |
| --- | --- | --- |
| AC26 | 合併兩張以上舊卡，含前輪 archive card | 新卡 lineage 等於被替換來源聯集；無重複葉節點，其他 cards 不變 |
| AC27 | 查回經多次再摘要的原始命令與 logs | 原文 bytes／digest 與保存時一致；搜尋可從最終 card 定位 |
| AC28 | 查閱別的 session／不在分支上的事件 | 無授權則拒絕；不能猜 handle 讀到其他資料 |
| AC29 | 原始檔缺失、損壞或磁碟已滿 | 不發布宣稱可回查的新 card；已存在引用回報具體不可用狀態；不自動 GC logs |
| AC30 | 相同 snapshot 與候選 bundle 重放 assembly | 產生相同訊息順序、文字與 replacement digest；只有一次可見提交 |
| AC31 | 單併發 timeout 後 provider 未確認終止 | 不立即重送第二個請求；slot 進入隔離／等待，依已知終止條件恢復 |
| AC32 | 達背景費用上限、無 usage 或 cancelled usage 不明 | 背景可停用、前景不被誤判免費；成本報告明列未知項 |
| AC33 | 開啟兩個 compaction owner、缺少 writer gate 或不支援 host 版本 | 啟用失敗或保留原 backend；不能默默以不安全模式執行 |
| AC34 | 停用 plugin、更新 schema、恢復舊 checkpoint | 文字 context 仍可讀；reader／相容讀取模式保留；未知版本拒絕覆寫 |
| AC35 | 固定指令太大、尾段含不可再縮小的重要內容、卡片只剩一張 | 有限次嘗試後停住；無反覆立即 compact 的無限迴圈 |
| AC36 | 任務中有被撤回指令、未完成工作、過時測試與跨卡依賴，經兩次 archive merge | overview 保留有效狀態及更正；不因舊卡權重較大恢復已撤回指令 |
| AC37 | 模型請求、checkpoint、logs 保存各階段故障與 restart | 已接受新輸入不丟失；取消不偽造完成；READY candidates 重用前再驗來源 |
| AC38 | Finalize 的一個欄位有效、另一欄位截斷或格式不合 | 不套用半份結果；有界重試／補卡後仍維持完整主線輸入 |

## 12. 實作順序與技術關卡

| 階段 | 產出 | 完成條件 |
| --- | --- | --- |
| 0：固定版本與確認接點 | Pin DSH commit；確認 snapshot、LLM request、writer gate、replacement、持久化與 limiter 接口 | 能證明 plugin 能控制完整切換；缺少 host 能力則明列 core patch |
| 1：先做同步正確版 | 最後一次輸出 tail_card＋overview；覆蓋檢查、token 預算與安全提交 | AC02、04–06、09、12–14、18–20 |
| 2：加入背景候選 | Snapshot／card store、來源校驗、背景 READY 採用 | AC01、03、07–08、10–11 |
| 3：加入配額與恢復 | 全域 limiter、取消、故障注入與重啟對帳 | AC13–17、19、23、30–33、37–38 |
| 4：多輪與實測 | Archive cards、原文查閱、品質與成本測試 | AC21–29、34–36；據實測調門檻 |

第一版支援文字與工具紀錄；含圖片／音訊的 session 在驗證前不得宣稱完整支援。讀 source 不足以證明 plugin API 都已暴露，尤其 provider limiter 與 durable transaction 需階段 0 查證。

不要只繼承 BasicCompactionEngine.summarize() 就宣稱支援此設計：排程、閱讀範圍、卡片儲存、最後覆蓋與提交策略都不同。優先實作新的 compaction provider，沿用 host 公開契約；避免直接 monkey patch agent 內部。

啟用時只留一個 summary compaction owner。若內建 tool-result pruner 或 image offload 仍能改 surface，必須一併協調來源版本，或在本策略期間停用該變更路徑。

## 13. 尚未證明、不可先承諾

1. 高 prefix 命中是否讓總費用下降：完整 prefix 重送、輸出費用與切換後冷 cache 都需計入。
2. 背景產卡是否改善實際等待：取決於 provider 配額、工具空檔與卡片生成速度。
3. 最後合併生成能否穩定同時產出高品質 tail_card 與 overview：需對比「同一次」與「分兩次」；後者仍每次讀完整主線。
4. DSH 的現有公開 API 能否完整滿足提交與恢復需求：可能需要小型 core 修改，不能先假設純 plugin 足夠。
5. 有損摘要能否保留任務必要細節：可做 fixture 與人工驗收，不能承諾任意歷史零資訊損失。

本版預設：若完整 context 已無法送進最後摘要請求，保留原狀並停住，不偷偷改用 cards 當摘要輸入。若日後要以「繼續執行」優先，那是需要另訂 AC 的降級模式。

產品選擇已確認：舊 cards 可以再次摘要，原始 logs 另存；不要求每條歷史命令永久留在模型 context。所有仍有效的任務限制與未完成事項，需通過語意驗收持續保留。

## 14. 原始碼參考

以下為前輪已讀取的路徑；連結指向可變分支，實作階段必須 pin commit。它們是借用設計的依據，不代表現成具備本規格。

- [Codex：背景候選排程](https://github.com/openai/codex/blob/main/codex-rs/core/src/session/async_compaction.rs)：背景門檻、snapshot、candidate、等待與取消。
- [Codex：背景請求組裝](https://github.com/openai/codex/blob/main/codex-rs/core/src/compact_remote_v2_attempt.rs)：固定 prefix 與路由狀態。背景路徑限支援的 remote V2，不能直接當作通用文字 API 實作。
- [Codex：candidate 套用](https://github.com/openai/codex/blob/main/codex-rs/core/src/compact_remote_v2_installation.rs)：相容性與 fallback。
- [Codex：歷史替換](https://github.com/openai/codex/blob/main/codex-rs/core/src/session/mod.rs#L4829)：在 lock 內檢查 prefix 世代，保留 live suffix。
- [DSH：一次摘要](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/compaction/compaction-basic/src/summarizer.ts)：沿用 system／tools／messages，尾端指令，單次 stream，文字投影。
- [DSH：區段與提交](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/compaction/compaction-basic/src/region.ts)：pairing、whole-surface／selected-span 驗證、replacement 事件。
- [DSH：自動觸發](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/compaction/compaction-basic/src/index.ts)：pre-step、overflow、pruner 與 summary provider 接點。

## 15. 舊 cards 再摘要：確定的演算法

### 何時合併

以「預計下一個 checkpoint 的 cards 總 token 數」判斷，不只看現在已存卡片。須加上剩餘尾段的輸出預算與 framing；如果預計超過 cards budget，就先準備 archive candidate。

Archive merge 與新區段產卡共用同一個 session 背景工作槽。接近正式 compact 且尾段積壓時，先補齊新增歷史；正式切換前再處理必要的 archive merge。不得用合併舊卡長期占用新卡工作槽。

### 選取與替換

1. 選最舊的連續 cards，通常至少兩張；優先合併深度相近者，避免每輪都把同一張舊 archive 再壓一次。
2. 近期 cards 優先原樣保留。這是偏好，不是可以突破容量的硬承諾；必要時再壓縮近期 cards，不能直接刪掉。
3. Merge request 使用未改寫的主線 snapshot prefix，尾端指定要合併的 card IDs；一次生成，不執行工具。它不需要載入無限量原始 logs。
4. 新 archive 保存 parent card IDs、原始來源 manifest 及生成版本。程式驗證來源聯集，模型只產生正文。
5. Candidate 準備完成仍不改主線；同一正式 checkpoint 內同時採用 archive、所有新 cards 與 overview。

最後 overview 一律看到合併前完整主線。若要用原始 log 修補特定遺漏，另開明確的重建工作，不能默認 merge worker 已重新讀遍所有原文。

只有一張可縮的 archive 時，允許一次更緊的再摘要；沒有實際縮小就停止。任何 bundle 的縮小重試都有上限，不能「摘要的摘要」無限重跑。

### Lineage 與版本

來源順序來自 snapshot surface 的位置與穩定事件 ID，不使用數字 seq 大小推斷時間順序。DSH replacement 事件可能在新 seq 上代表較早的位置。

原始來源 metadata 保存在旁側 manifest，模型 context 只放短 card handle 與簡短範圍。不能因 lineage 變長而把數千個 IDs 塞回 prompt。

Lineage 使用不可變 manifest／樹狀索引；可追溯到原始事件。最終 assembly 不得同時放入某 archive 及其已被涵蓋的子卡。檢查應能以區段／manifest 完成，避免每輪複製全部歷史 IDs。

## 16. 原始 logs 與查閱契約

### 保存

保存 host 已接受的原始事件與工具結果，沿用既有遮罩／敏感資料政策。已有的 host 截斷無法事後恢復；記錄 source_completeness，不能把不完整來源標成完整。

新的巨大工具結果若由本策略做 bounded projection，必須先將完整可取得的結果持久化，才把省略版本加入主線。若保存失敗，不能繼續以「可查原文」為理由省略內容；須停住或讓 host 的明確錯誤流程接手。

每份原文有穩定 ID、內容 digest、schema/version、擁有 session、分支可達性與完整性標記。不要把會被清理的暫存檔當成永久 archive。

預設不因 compact 或停用 plugin 刪除原始 logs。儲存配額不足時停用新的省略／壓縮寫入並回報，不自動清掉仍被 cards 引用的原文。使用者明確刪除 session／資料時，沿用 host 的刪除與引用政策。

### 模型如何讀回

主線必須有可用的 read-only archive reader；優先接既有 session history 查閱能力，不足才新增工具。以下為需要實作的概念契約，不是已存在的 DSH API：

~~~text
read_history(card_id 或 source_id,
             cursor?,
             query?,
             max_output_tokens)
→ source IDs、內容、完整性、next_cursor、truncated、digest
~~~

- 依目前 session／branch 權限驗證來源，不接受任意磁碟路徑或跨帳號 handle。
- 支援分頁及搜尋；輸出本身也受主線 admission 預算控制，避免查原文再次撐爆 context。
- 內容缺失／損壞需回傳明確錯誤，不能回空字串冒充「沒有內容」。
- Tool schema 在 session 建立時固定；啟用後不要每張卡改工具定義而破壞 prefix。
- Worker 沒有 reader 執行權；只有正常主線能按任務需要查閱。Reader 不改原始紀錄。

Cards 的存在不代表模型一定主動查閱。Prompt 應提示：涉及精確命令、完整錯誤、具體程式碼或過去數值而 card 資訊不足時，查回原文再行動。

## 17. 配置與初始預設

以下是第一輪實驗設定，不是普遍最佳值。由 host adapter 提供實際 token 規則；未知 context 容量或無法估算完整 request 時，不啟用自動模式。

| 設定 | 初始值／規則 | 意義 |
| --- | --- | --- |
| card_min_source_tokens | 8,000 | 達到後，在下一個合法邊界產卡 |
| background_min_interval | 15 秒 | 小規模變更不連續重送 prefix |
| session_background_limit | 1 | 新卡與 archive merge 共用 |
| provider_concurrency | 優先 host quota；未知時 1 | 不自行猜可並行 |
| finalize_soft_ratio | 65% context window | 與第 5 節安全上限取較早者 |
| post_compact_target_ratio | 40% context window | 必須同時符合下一步安全空間 |
| card_text_budget | 約 1,024 tokens | 目標，不是截斷後可直接接受的許可 |
| tail_text_budget | 約 2,048 tokens | 太大的尾段先補卡，不強塞 |
| overview_text_budget | 約 1,536 tokens | 只統整狀態；關鍵內容優先 |
| candidate_wait_at_finalize | 最多 2 秒 | 是等待 READY 的期限，不代表 provider slot 已釋放 |
| background_attempt_timeout | 45 秒 | Client 等待上限；取消後另做 slot 對帳 |
| final_attempt_timeout | 90 秒 | 可配置；不是完成保證 |
| max_attempts_per_request | 2 | 首次＋至多一次一般重試 |
| max_final_bundle_attempts | 2 | 避免因無縮小而無限重建 |
| cache_observation | 開啟 | 真實 usage、TTFT、耗時；缺欄位標未知 |

card／tail／overview 的 text budget 與 provider 的 max_output_tokens 不可直接畫等號。若 provider 的 reasoning 也計入輸出上限，adapter 必須預留其成本並重新計算第 5 節的容量條件；不能因文字很短就假設整個請求便宜。

cards budget = post_compact target − 固定指令／工具包裝 − overview 預留 − card framing。其結果不大於零代表配置不可行。正式組裝後仍用實際 tokenizer／估算器量一次。

背景總費用須可配置硬上限；沒有可靠單價時以 input/output token 預算限制，不能將未知費用當 0。達上限只停止新的背景工作；必要的最後 compact 需有獨立預留，否則明確進入 BLOCKED。

手動 compact 可以在軟門檻前觸發，但仍需有可壓縮來源與正收益。空歷史／只有固定指令則 no-op，不產空 checkpoint。

## 18. 排程與故障的具體決策

### 優先序

Foreground request 與必要 finalize 都是前景工作，依 host 的公平佇列／期限處理；background card 與 archive merge 只使用餘裕。不同 session 不得因單一 session 不斷產卡而飢餓。

單併發的背景啟動至少要求：沒有已排隊前景請求，且 session 正在等待工具／閒置。可用近期工具耗時估計是否值得啟動；估計失準只代表主線可能等待，不能要求本地工具固定延長執行時間。

### 有限等待，不偽裝成已取消

HTTP abort 或 client timeout 只表示本地停止等待，不必然代表 server 已停止推論。只有收到 terminal response、確認的 server cancellation，或 provider 契約保證的終止期限，才釋放這個保守的單併發 slot。

無法確認終止時，slot 標為 UNKNOWN，暫停該 quota scope 的新請求並顯示原因；交由 host 的已驗證恢復策略處理。不能用換 API key 或另一個 session 繞過同一帳號的配額限制。

Late response 只更新終止狀態與可取得的 usage，不直接修改已固定的 assembly。被取消／不採用的請求依然可能計費。

### 失敗矩陣

| 階段 | 失敗後主線 | 下一步 |
| --- | --- | --- |
| 背景請求／候選驗證 | 原狀繼續，前提是仍有容量 | 有界重試或留待最後 tail_card |
| 最後生成，尚未寫 replacement | 原狀保留 | 有餘裕可退出；否則停住／重試，不提交部分欄位 |
| Replacement 寫入前 CAS 不符 | 不覆蓋新狀態 | 重新取得 snapshot；不能把舊 overview 移植到新狀態 |
| Replacement 寫入／flush 結果未知 | 不准繼續推論 | 進入 RECOVERING，讀 durable log 對帳 |
| 成功 checkpoint 已持久化，通知 UI 失敗 | 新 context 保持有效 | 補通知，不再 compact 一次 |

Provider 路由預設與主線相同，不自動改用另一模型。可配置的備援模型屬後續功能；它無法保證沿用原 prefix cache，且須重新驗證輸入容量與摘要品質。

## 19. 元件、整合與可觀測性

### 最小元件

| 元件 | 唯一責任 |
| --- | --- |
| Snapshot／Coverage | 擷取一致輸入，選合法區段，維護涵蓋清單 |
| Compactor | 依 job 類型產生 card／archive／final bundle；不做 commit |
| Store／Reader | 保存候選、原文、lineage；支援有權限的原文查閱 |
| Scheduler | 管理 quota scope、優先序、重試、取消與 timeout |
| Finalizer | 固定 cutoff，確定性組裝、驗證、透過 host 提交 |

這些是邏輯責任，不要求各自一個 plugin 或服務。小型實作可放同一 package，但測試需能替換 model、clock、storage、quota limiter 與 host writer。

### 確定性 assembly

輸入是固定 candidate IDs、來源順序、已版本化 serializer 與 overview。排序不交給模型；framing 不加入隨機時間戳。相同輸入產生相同 replacement digest。

每次生成記錄 prompt version、schema version、serializer version、model route 與來源 snapshot digest。Schema 更新不自動讓舊 checkpoint 變得不可讀；先提供相容 reader，無法轉換就拒絕覆寫。

### DSH 接點與必要 core 支援

採用新的 compaction provider，重用公開的 session／LLM／token meter 契約及 checkpoint 格式。只繼承 summarize 不足以處理兩階段工作。

階段 0 必須逐項實測：能否取出與主線相同的 request 投影、能否攔住下一步、能否序列化所有 surface writers、能否安全恢復半完成 replacement，以及是否有整個 quota scope 共用 limiter。

若缺少這些能力，提出最小 host patch；不以私有 method monkey patch、只靠某個事件先後順序或重複寫 raw events 假裝完成。啟用失敗時保留原 compaction backend，避免 session 變成沒有任何壓縮保護。

### 使用者可見狀態與指標

只需顯示背景產卡、正在切換、重試／等待配額、需要處理四類狀態。正常背景產卡不插入聊天訊息。

記錄 per-job 與 per-session：input/output/cached tokens、未知 usage、排隊時間、生成時間、主線額外等待、candidate 丟棄原因、壓縮比例、archive 深度、原文查閱成功率及 checkpoint 數。

將「總 context token accounting」與「背景呼叫計費」分開。背景 response 的 usage 不可覆蓋主線最新 context usage。

### 停用與更新

停止啟動新 jobs，處理進行中請求的取消／結束，等待確定提交狀態後再切回 host backend。原始 log、已提交文字 cards、overview 與 reader 能力保留；不能因停用摘要器就留下無法解析的引用。

如果 reader 隨 plugin 解除安裝而消失，必須先提供可用的 host reader 或唯讀相容層；否則不能宣稱已完成無損停用。完整刪除資料只走使用者明確要求的 host 刪除流程。

## 20. 發布門檻與需求對照

| 需求 | 主要 AC |
| --- | --- |
| R01–R02：單步、snapshot 與區段 | AC01–03、05、07–09 |
| R03–R05：內容、覆蓋與完整輸入 | AC04–06、20、24、36、38 |
| R06：安全切換與取消 | AC07–14、30、37 |
| R07–R09：配額、cache 與容量 | AC15–20、23、25、31–32、35 |
| R10–R12：持久化、多輪與失敗邊界 | AC12–14、20–22、26–29、35–37 |
| R13–R16：查閱、確定性與相容性 | AC27–34、37 |

發布必須通過所有適用的 MUST AC。初版不支援的模態需有明確拒絕／沿用 host 行為與標示，不能跳過其資料後繼續宣稱成功。

品質測試使用預先標記「必保留事實／禁止錯誤結論」的 fixture，關鍵事實必須全數通過；另以續做任務檢查真實可用性。不可只讓同一摘要模型自行評分。

效能至少比較三組：host 一般同步 compact、本方案同步模式、本方案背景模式。報告總費用、主線等待 P50/P95、切換後首請求、任務正確率與原文查閱次數；固定相同模型、任務與預算並記錄差異。

正確性通過、但背景成本較高或等待未改善時，可以發布為可選模式，不能宣稱預設更好。是否預設啟用背景模式，等實測後決定；不影響這份設計已確定的功能行為。

目前不需要再作產品方向選擇。剩餘需實作時確認的資訊是：目標 DSH commit、provider 的實際 quota／取消契約、token 計算與持久化接點。未知時採保守模式；不得把這些待驗證能力當成已完成。

