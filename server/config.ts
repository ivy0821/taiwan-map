// server/config.ts
// 後端環境變數的唯一讀取點。
// 用 getter 延遲讀取，讓 `next build` 在缺少環境變數時仍能完成，
// 只有真正使用到該設定時才會拋錯。

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`缺少必要的環境變數: ${name}`);
  }
  return value;
}

export const config = {
  get databaseUrl(): string {
    return requireEnv('DATABASE_URL');
  },

  get tdxClientId(): string {
    return requireEnv('TDX_CLIENT_ID');
  },

  get tdxClientSecret(): string {
    return requireEnv('TDX_CLIENT_SECRET');
  },

  get geminiApiKey(): string {
    return requireEnv('GEMINI_API_KEY');
  },
};

/**
 * API 輸入的資源上限。
 *
 * 這些值只用來擋住明顯的濫用與資源浪費，不是產品規則。
 * 放在這裡是為了讓「一次請求最多能造成多少下游成本」有單一可查的地方。
 */
export const limits = {
  /**
   * raw_input 長度上限。Google Maps 地點網址含 !3d/!4d 資料段時可達 1KB 以上，
   * 2048 足以容納實務上的長網址，同時擋掉 MB 等級的 payload。
   */
  maxRawInputLength: 2048,

  /** 景點名稱長度。台灣 POI 名稱普遍在 10 字以內，100 已非常寬鬆；此值也會進 Gemini prompt。 */
  maxPlaceNameLength: 100,

  /** 使用者偏好敘述。會直接進 Gemini prompt，限制長度可同時控制 token 成本與 prompt 注入面積。 */
  maxPromptLength: 500,

  /**
   * 單次行程的景點數上限。一日自駕行程 30 個點已遠超實際需求，
   * 且 30 個景點 × 3 個候選停車場 = 90 個 ID，正好落在 TDX 單批 100 個以內，
   * 因此仍只需要一次 TDX 請求。
   */
  maxPlaces: 30,

  /**
   * 單次可查詢的停車場 ID 數量。刻意與 TDX integration 內部的上限相同：
   * 兩層各自把關（Zod 擋在入口、integration 擋住任何非 HTTP 呼叫端）。
   */
  maxParkingIds: 200,

  /** 單一停車場 ID 長度，與 TDX integration 的限制一致（TDX 實際 ID 如 KHA00001 僅 8 碼）。 */
  maxParkingIdLength: 64,
} as const;

/**
 * 對外請求的逾時設定。
 *
 * 目前只集中 geocoding —— TDX 與 Gemini integration 各自已有逾時設定，
 * 這個 Stage 不動它們。
 */
export const timeouts = {
  /**
   * Google Maps 轉址解析與 Nominatim 查詢的逾時。
   * Google 的轉址通常 1 秒內完成，Nominatim 在尖峰時較慢；
   * 8 秒足以涵蓋正常情況，又不會讓使用者的請求被上游拖住太久。
   */
  geocodingMs: 8_000,
} as const;
