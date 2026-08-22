// components/availabilityLabel.ts
//
// 即時車位數的顯示用對照。純函式、無 React 相依，方便測試。
// 與 components/scheduleLabels.ts 同樣的作法：後端只回 machine-readable 值，
// 中文字串由前端決定。
//
// ── P1-1 的核心規則 ────────────────────────────────────────────────
// 這裡必須明確區分三種狀態，絕對不可以用 truthiness 判斷 ——
// `0` 和 `null` 都是 falsy，`if (!available)` 會把「已滿」誤判成「未知」。
//
//   null  → 未知 / 無有效即時資料      「尚無動態」
//   0     → 已知目前沒有空位（滿了）    「0 格」（紅色）
//   > 0   → 已知的剩餘車位數            「N 格」（綠色）
//
// 後端已在 integration / repository 邊界把 -1 正規化成 null，
// 所以正常情況不會收到負數；這裡仍防禦性地把任何負數當成未知，
// 避免舊的快取回應或未來的迴歸讓畫面出現「-1 格」。

/** 車位數的三種顯示狀態 */
export type AvailabilityStatus = 'unknown' | 'full' | 'available';

/**
 * 判斷車位數屬於哪一種顯示狀態。
 *
 * 注意 `full` 只代表「即時剩餘為 0」，這是資料本身的意思，
 * 不牽涉 TDX 的 FullStatus 欄位（目前系統沒有使用該欄位）。
 */
export function availabilityStatus(
  availableSpaces: number | null | undefined
): AvailabilityStatus {
  if (typeof availableSpaces !== 'number' || !Number.isFinite(availableSpaces)) return 'unknown';
  // 防禦：正常情況後端不會再送出負數（-1 已在後端轉成 null）
  if (availableSpaces < 0) return 'unknown';
  return availableSpaces === 0 ? 'full' : 'available';
}

/**
 * 即時車位數的畫面文字。
 *
 * 未知時回「尚無動態」（沿用既有文案），不會印出 undefined、null 或負數。
 */
export function availabilityLabel(availableSpaces: number | null | undefined): string {
  return availabilityStatus(availableSpaces) === 'unknown'
    ? '尚無動態'
    : `${availableSpaces} 格`;
}
