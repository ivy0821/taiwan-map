// server/api/cors.ts
//
// 前後端分離後的單一 CORS policy。
//
// 這裡只有純函式，不碰 NextRequest / NextResponse ——
// 真正的 wiring 在專案根目錄的 proxy.ts（Next.js 16 的檔案慣例，
// middleware.ts 在 16 已被更名為 proxy.ts）。
// 這樣切開的好處是這份 policy 可以完全離線做單元測試。
//
// ── 設計決定 ──────────────────────────────────────────────────────
// 1. 允許來源由 FRONTEND_ORIGIN 環境變數提供，不寫死任何網域。
// 2. 一律【不】使用 `Access-Control-Allow-Origin: *`。
//    未設定 FRONTEND_ORIGIN 時的安全預設是「不給任何 CORS 權限」，
//    而不是退回萬用字元。
// 3. 比對用嚴格 `===`，不用 includes / startsWith / endsWith，
//    否則 `http://localhost:5173.evil.com` 這類前後綴攻擊會通過。
// 4. 目前沒有 cookie / session，所以【不】設 Access-Control-Allow-Credentials。
//    等真的做登入再重新設計。
// 5. CORS 是瀏覽器政策，不是 API 認證。因此沒有 Origin 的請求
//    （curl、server-to-server、contract test）一律照常處理，只是不附 CORS 標頭。

import { config } from '@/server/config';

/** 目前 5 個 route 全都只有 POST；preflight 需要 OPTIONS */
export const ALLOWED_METHODS = 'POST, OPTIONS';

/** 前端只送 application/json，沒有 Authorization */
export const ALLOWED_HEADERS = 'Content-Type';

/** preflight 結果可快取的秒數 */
export const MAX_AGE_SECONDS = 600;

/**
 * 讀取允許的來源。
 *
 * 實際的 env 讀取在 server/config.ts（後端環境變數的唯一讀取點）。
 * 沒設定或空字串時回 null（= 不開放任何跨來源存取），
 * 刻意不提供 `*` 這種預設值。
 */
export function getAllowedOrigin(): string | null {
  return config.frontendOrigin;
}

/**
 * 判斷這個 Origin 是否獲准。
 *
 * 嚴格全字比對 —— 這正是擋掉下列繞道的關鍵：
 *   http://localhost:5173.evil.com   （後綴）
 *   http://evil-localhost:5173       （前綴）
 *   https://localhost:5173           （協定不同）
 */
export function isOriginAllowed(
  originHeader: string | null | undefined,
  allowedOrigin: string | null
): boolean {
  if (allowedOrigin === null) return false;
  if (typeof originHeader !== 'string' || originHeader === '') return false;
  return originHeader === allowedOrigin;
}

/** 獲准時要附加的回應標頭 */
export function corsHeadersFor(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': ALLOWED_METHODS,
    'Access-Control-Allow-Headers': ALLOWED_HEADERS,
    // 回應內容會依 Origin 而異，必須讓快取知道，否則可能把某個來源的
    // 回應（含 CORS 標頭）誤發給另一個來源
    Vary: 'Origin',
  };
}

/**
 * CORS 決策結果。
 *
 * preflight → 直接回應，【不】進入 route handler
 *             （所以不會碰到 Service / DB / Gemini / TDX）
 * pass      → 交給原本的 route handler，headers 附加在回應上
 */
export type CorsDecision =
  | { kind: 'preflight'; status: number; headers: Record<string, string> }
  | { kind: 'pass'; headers: Record<string, string> };

/**
 * 單一進入點：依 method 與 Origin 決定要怎麼處理。
 *
 * OPTIONS 一律在這裡短路掉並回 204，不論 Origin 是否獲准 ——
 * 差別只在有沒有附 Access-Control-Allow-Origin。
 * 不獲准時瀏覽器看不到許可標頭，preflight 自然失敗，
 * 這已經足夠，不需要為此改動 API 的 HTTP 語意。
 */
export function decideCors(
  method: string,
  originHeader: string | null | undefined,
  allowedOrigin: string | null = getAllowedOrigin()
): CorsDecision {
  const allowed = isOriginAllowed(originHeader, allowedOrigin);
  const headers = allowed ? corsHeadersFor(originHeader as string) : {};

  if (method === 'OPTIONS') {
    return {
      kind: 'preflight',
      status: 204,
      headers: allowed ? { ...headers, 'Access-Control-Max-Age': String(MAX_AGE_SECONDS) } : {},
    };
  }

  return { kind: 'pass', headers };
}
