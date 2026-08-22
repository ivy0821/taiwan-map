// components/scheduleLabels.ts
//
// 行程節點的顯示用中文對照。純函式、無 React 相依，方便測試。
//
// 這裡只負責「把後端的 machine-readable 值翻成畫面文字」，
// 後端仍然回傳 machine-readable 值（'user' / 1），不回中文字串。

/** 後端 ScheduleSource 的中文顯示 */
const SOURCE_LABELS: Record<string, string> = {
  user: '使用者輸入',
};

/**
 * 景點來源的中文標籤。
 * 未知來源時回傳 null，呼叫端應該整塊不顯示，而不是印出原始代碼。
 */
export function sourceLabel(source: string | undefined | null): string | null {
  if (!source) return null;
  return SOURCE_LABELS[source] ?? null;
}

/**
 * 「來源可信度」的中文等級。
 *
 * ⚠ 語意：這是「這個 POI 的來源有多可靠」，
 *    不是「AI 對這個推薦有多少信心」。
 *    使用者直接提供的景點 → 1 → 「高」。
 */
export function confidenceLabel(confidence: number | undefined | null): string | null {
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return null;
  if (confidence >= 0.9) return '高';
  if (confidence >= 0.7) return '中';
  return '低';
}
