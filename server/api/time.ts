// server/api/time.ts
//
// API response 用的時間格式化。目前只有 parking/live 的 updated_at 用到。
//
// ── M1 修正說明 ──────────────────────────────────────────────────────────
// 舊寫法是 `new Date().toLocaleTimeString('zh-TW', { hour12: false })`，
// 沒有指定時區，因此輸出取決於 **執行環境的 OS / container 時區**。
// 本機開發（Asia/Taipei）看起來正常，但部署到 UTC 環境（Vercel 等）
// 就會少 8 小時。
//
// 修法是明確指定 IANA 時區 'Asia/Taipei'，
// 不使用 `Date.now() + 8 * 60 * 60 * 1000` 這種手動加減 ——
// 手動位移只是把錯誤換個地方，語意也不清楚。

/** 台灣時區。用 IANA 識別碼而不是固定位移。 */
export const TAIPEI_TIME_ZONE = 'Asia/Taipei';

/**
 * 把時間點格式化成台灣當地時間的 `HH:mm:ss`。
 *
 * 格式與修正前完全相同（零補位、24 小時制），前端是直接原樣顯示的字串。
 *
 * 註：`hour12: false` 必須保留 —— 實測 zh-TW 在拿掉它之後會變成
 * 12 小時制（例如「上午12:00:00」），那會破壞前端顯示。
 * 加上它之後 hourCycle 解析為 h23，午夜正確輸出 `00:00:00` 而不是 `24:00:00`。
 *
 * @param date 預設為現在；傳入固定時間點即可做不依賴本機時區的測試
 */
export function formatTaipeiClockTime(date: Date = new Date()): string {
  return date.toLocaleTimeString('zh-TW', {
    hour12: false,
    timeZone: TAIPEI_TIME_ZONE,
  });
}
