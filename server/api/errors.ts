// server/api/errors.ts
//
// 錯誤處理的最小共用工具。刻意保持極小：
// 這裡【不】提供 error class 階層、ApiError framework、global middleware、
// Result<T,E>、error code registry 或 apiHandler wrapper。
//
// 唯一的規則：
//   這個檔案匯出的東西只能用在 server-side log / 內部檢查，
//   永遠不可以把回傳值直接放進 HTTP response。
//   Client 只會拿到 route 裡寫死的固定安全訊息。

/** 這些環境變數的「值」若出現在錯誤訊息裡，一律遮蔽後才寫進 log */
const SECRET_ENV_KEYS = [
  'GEMINI_API_KEY',
  'TDX_CLIENT_SECRET',
  'TDX_CLIENT_ID',
  'DATABASE_URL',
] as const;

/**
 * 遮蔽已知機密。
 *
 * 上游函式庫偶爾會把憑證塞進錯誤訊息（例如連線字串、Authorization 標頭），
 * 這一層確保它們不會落到 server log 裡。
 */
function redactSecrets(text: string): string {
  let output = text;

  for (const key of SECRET_ENV_KEYS) {
    const value = process.env[key];
    // 太短的值可能是佔位字串，全域取代反而會把 log 弄得難讀
    if (value && value.length >= 8) {
      output = output.split(value).join(`[redacted:${key}]`);
    }
  }

  // 即使 token 不是來自環境變數也一併遮蔽
  output = output.replace(/Bearer\s+[\w.~+/-]+=*/gi, 'Bearer [redacted]');

  return output;
}

/**
 * 從任何被 throw 出來的東西取出可讀訊息。
 *
 * 「任何」是字面上的意思：JS 允許 throw 字串、物件、null。
 * 不能假設 `.message` 存在，否則錯誤處理本身會再丟一次錯。
 *
 * ⚠ 回傳值只給 log 用，不可回給 client。
 */
export function getErrorMessage(error: unknown): string {
  try {
    if (error instanceof Error) return redactSecrets(error.message);
    if (typeof error === 'string') return redactSecrets(error);
    if (error === null) return 'null';
    if (error === undefined) return 'undefined';

    const serialised = JSON.stringify(error);
    return redactSecrets(serialised ?? Object.prototype.toString.call(error));
  } catch {
    // 循環參照、Object.create(null)、會 throw 的 toString 等等
    return '無法序列化的錯誤';
  }
}

/**
 * 統一的 server-side 錯誤記錄。
 *
 * 只記錄 endpoint 與錯誤本身（含 stack），不記錄 request body ——
 * prompt / raw_input 可能含使用者內容，不應該無條件進 log。
 */
export function logServerError(context: string, error: unknown): void {
  console.error(`[${context}] ${getErrorMessage(error)}`);

  if (error instanceof Error && error.stack) {
    console.error(redactSecrets(error.stack));
  }
}
