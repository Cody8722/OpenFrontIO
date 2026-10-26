# 電腦國家出手時機(階段 A:間隔抖動)

預設關閉。關閉時與舊行為逐位元相同(5 個基準場景的 hash 鏈不變)。

## 設計

- 舊行為:每個國家只在 `tick % attackRate === attackTick` 的格點上思考,間隔恆為 attackRate 的整數倍。
- 新行為:思考間隔改抽自三角分佈 `[(1-s)R, (1+s)R]`,平均仍為 R(長期思考頻率不變)。第一次思考仍落在舊格點上。
- 建築的三個偏移(`attackTick`、+⌊R/3⌋、+⌊2R/3⌋)維持舊格點,不抖動。
- 抖動用每國獨立的 `timingRandom`(種子 = 國家自己的種子 + 常數),不碰共用的 PRNG。
- `s = 0` 等於舊格點(測試以 hash 鏈與行動計數證明)。

## spread 是每國狀態,不是全域設定

`spread` 與 `triggerRatio`、`reserveRatio` 一樣是**每個國家自己的個性參數**:存在該國的計時狀態裡、跟著該國的快照走,同一場遊戲裡不同國家可以不同(同場混合實驗就是這樣做的)。它不在 `GameConfig`,也沒有全域旋鈕;`setDevNationTiming` 只是「建國時給每個國家的預設值」。

## 快照

`NationExecution` 快照版本 1→2,`migrations[1]` 補 `timing: null`。測試:舊版 1 快照升級、`s = 0` 與 `s = 0.5` 的存讀與連續執行逐刻相同(`tests/NationTimingSnapshot.test.ts`)。

## 開發用啟用方式:網址參數 `?nationTiming=0.5`

只用來在真實單人遊戲裡手動觀察。

| 層 | 做的事 |
|---|---|
| 頁面 `src/client/DevNationTiming.ts` | 讀 `?nationTiming=`;**僅單人局、僅開發環境(`GameEnv.Dev`)、僅 [0,1) 的數字**才算請求 |
| 協定 `InitMessage` | 只加一個選填欄位 `nationTiming?: number` |
| 工作執行緒 `Worker.worker.ts` | `init` 時呼叫 `configureDevNationTiming(gameType, nationTiming)`:僅單人局接受,其餘一律清除 |
| 引擎 `Executor.nationExecutions()` | 建國時把設定交給每個 `NationExecution` |

安全限制與對應測試:

- 多人房間(Public/Private)一律忽略,因為鎖步下各客戶端必須跑完全相同的東西:
  `tests/client/DevNationTiming.test.ts`、`tests/NationTimingDev.test.ts`、`tests/client/WorkerClientNationTiming.test.ts`。
- 預備環境與正式環境不啟用:頁面端判斷環境(沒有請求時甚至不讀環境),測試同上。
- 引擎端對單人局以外的遊戲一律清除,所以即使有人手動送出欄位,多人局也不會生效。

協定改動範圍:`packages/engine-api/src/worker/WorkerMessages.ts` 一個選填欄位;其他送 `init` 的地方(重播處理等)不需改,因為欄位選填。

## 證據

見 `tools/nn-nation/baseline/timing_phaseA.md`(第一輪報告)與 `timing_followup.md`(兵力三法與軍艦劑量反應)。階段 B(事件觸發)與長尾變體尚未實作。

## 診斷日誌:`&nationTimingLog=1`

與 `?nationTiming=` 同樣只限單人局 + 開發環境,可單獨使用(不帶 `nationTiming` 時記錄舊格點的醒來,可拿來對照)。協定再加一個選填欄位 `InitMessage.nationTimingLog?: boolean`。

- 做法:在國家的攻擊政策外包一層「原樣轉手」的裝飾器(`NationTimingLog.ts`),只讀 `ticks()` 與引擎已經給的純值;不查詢遊戲、不抽亂數、不碰 boatRoutes 快取。沒帶參數時完全不建立。
- 輸出(前綴 `[NationTiming]`):開始一行;每次醒來一行(刻、國家名、距上次醒來的間隔、結果:發動攻擊/門檻沒過/抽籤沒過/沒有目標/未進入判斷);每 3000 刻一行統計(自上次統計起的間隔平均、標準差、最小、最大;同刻醒來的最大值與平均值,平均只計有國家醒來的刻)。
- 測試:`tests/NationTimingLog.test.ts`(開關日誌 hash chain 完全一致,舊格點與 spread 0.5 各一;開關限制;輸出格式與統計數字)。
