// server/integrations/gemini.ts
//
// Next.js backend 對 Gemini 的唯一進入點。
// 這裡集中：GoogleGenAI client、model 選擇、structured output schema、
// prompt 組裝、回應解析與驗證、retry policy、timeout、錯誤分類。
//
// route.ts 一律只呼叫這裡匯出的 planTrip()，不得自行 new GoogleGenAI()、
// 定義 model / responseSchema，或解析模型的原始輸出。
//
// ── 設計重點：AI 不是座標的來源 ──────────────────────────────────────────
// responseSchema 裡【完全沒有】lat / lng 欄位，模型連表達座標的能力都沒有。
// 它只回傳 poi_index（對應呼叫端傳進來的原始 POI 陣列索引）、停留時間與說明。
// 座標與名稱一律取自原始輸入，因此模型無論如何都改寫不了地點位置。
//
// ── 實測（2026-08-22）────────────────────────────────────────────────────
// ListModels 確認 gemini-3.5-flash-lite 確實存在（in 1048576 / out 65536），
// 且以本檔的 schema 實測可正常回傳純 JSON（無 markdown fence）。

import { GoogleGenAI, Type } from '@google/genai';
import { config } from '@/server/config';

/**
 * 經 ListModels 與實際呼叫驗證過的 model。
 * 這是行程排序這種輕量結構化任務，flash-lite 等級即足夠。
 * 注意：Gemini 免費方案的每日額度是「每個 model 各自計算」的。
 */
export const GEMINI_MODEL = 'gemini-3.5-flash-lite';

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1_000;

// ────────────────────────────────────────────────────────────────── 錯誤分類

export type GeminiErrorKind =
  /** 額度用盡（RESOURCE_EXHAUSTED / 429）—— 重試沒有意義 */
  | 'quota'
  /** 金鑰無效或權限不足 —— 重試沒有意義 */
  | 'auth'
  /** 請求本身有問題（400 INVALID_ARGUMENT）—— 重試沒有意義 */
  | 'bad_request'
  /** 上游暫時性錯誤（5xx / 網路）—— 可以重試 */
  | 'upstream'
  /** 逾時 —— 可以重試 */
  | 'timeout'
  /** 模型輸出不符 schema 或無法解析 —— 換一次抽樣可能就好，可以重試 */
  | 'invalid_output';

/** 這些訊息會被 route 放進 500 response，因此刻意不含任何上游原文或金鑰 */
const SAFE_MESSAGE: Record<GeminiErrorKind, string> = {
  quota: 'AI 服務額度已用盡，請稍後再試',
  auth: 'AI 服務認證失敗',
  bad_request: 'AI 服務請求無效',
  upstream: 'AI 服務暫時無法使用，請稍後再試',
  timeout: 'AI 服務回應逾時，請稍後再試',
  invalid_output: 'AI 回傳的行程格式不正確',
};

const RETRYABLE: Record<GeminiErrorKind, boolean> = {
  quota: false,
  auth: false,
  bad_request: false,
  upstream: true,
  timeout: true,
  invalid_output: true,
};

export class GeminiError extends Error {
  readonly kind: GeminiErrorKind;
  readonly retryable: boolean;

  constructor(kind: GeminiErrorKind, options?: { cause?: unknown }) {
    super(SAFE_MESSAGE[kind]);
    this.name = 'GeminiError';
    this.kind = kind;
    this.retryable = RETRYABLE[kind];
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/**
 * 把 SDK / 網路丟出來的東西歸類成上面六種。
 * 分類只看狀態碼與錯誤代碼字串，不把原文往外傳。
 */
export function classifyGeminiError(error: unknown): GeminiErrorKind {
  if (error instanceof GeminiError) return error.kind;

  const err = error as { name?: unknown; status?: unknown; code?: unknown; message?: unknown };

  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return 'timeout';

  const status = typeof err?.status === 'number' ? err.status : typeof err?.code === 'number' ? err.code : undefined;
  const text = typeof err?.message === 'string' ? err.message : String(error ?? '');

  if (status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(text)) return 'quota';
  if (
    status === 401 ||
    status === 403 ||
    /API_KEY_INVALID|PERMISSION_DENIED|UNAUTHENTICATED|api key not valid/i.test(text)
  ) {
    return 'auth';
  }
  if (status === 400 || /INVALID_ARGUMENT/i.test(text)) return 'bad_request';
  if (typeof status === 'number' && status >= 500) return 'upstream';
  if (/aborted|timeout/i.test(text)) return 'timeout';

  return 'upstream';
}

/** 記錄用：確保金鑰絕不會出現在 log 裡 */
function redact(value: string): string {
  const key = process.env.GEMINI_API_KEY;
  return key ? value.split(key).join('***') : value;
}

// ────────────────────────────────────────────────────────────────── 領域型別

export interface TripPoi {
  name: string;
  lat: number;
  lng: number;
}

export interface PlannedStop {
  /** 由我們指派的 1-based 順序，不採用模型自己編的號碼 */
  sequenceOrder: number;
  /** 原始 POI，座標與名稱都來自呼叫端輸入 */
  poi: TripPoi;
  stayDurationMinutes: number;
  summary: string;
}

export interface TripPlan {
  title: string;
  stops: PlannedStop[];
}

/**
 * 模型實際被允許回傳的形狀 —— 注意沒有任何座標欄位。
 *
 * 欄位一律宣告為 unknown：JSON 解析出來的內容在 toTripPlan 逐欄檢查之前
 * 都不能假設型別，宣告成 number/string 會讓編譯器對我們說謊。
 */
interface RawStop {
  poi_index?: unknown;
  stay_duration_minutes?: unknown;
  summary?: unknown;
}

export interface RawTripPlan {
  title: string;
  /** 尚未驗證的原始 stop 陣列，每個元素的形狀由 toTripPlan 負責檢查 */
  stops: unknown[];
}

const DEFAULT_STAY_MINUTES = 60;

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    title: {
      type: Type.STRING,
      description: '這趟行程的吸睛主題名稱（繁體中文）',
    },
    stops: {
      type: Type.ARRAY,
      description: '依實際造訪順序排列的景點；陣列順序即為行程順序',
      items: {
        type: Type.OBJECT,
        properties: {
          poi_index: {
            type: Type.INTEGER,
            description: '對應景點清單中的 index，不可自行創造',
          },
          stay_duration_minutes: {
            type: Type.INTEGER,
            description: '建議停留分鐘數',
          },
          summary: {
            type: Type.STRING,
            description: '一句話的特色推薦／導覽摘要（繁體中文）',
          },
        },
        required: ['poi_index', 'stay_duration_minutes', 'summary'],
      },
    },
  },
  required: ['title', 'stops'],
};

// ────────────────────────────────────────────────────────── 純函式（可測試）

/**
 * 解析並驗證模型輸出。
 *
 * 因為用的是 structured output（responseMimeType: application/json + responseSchema），
 * 回來的就是純 JSON —— 這裡刻意【不做】任何 markdown code fence 剝除，
 * 若真的收到帶 ``` 的自由文字，那代表 structured output 失效，應該當成錯誤而不是硬吞。
 */
export function parsePlanPayload(text: string | undefined): RawTripPlan {
  if (!text || text.trim() === '') {
    throw new GeminiError('invalid_output');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new GeminiError('invalid_output', { cause: error });
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new GeminiError('invalid_output');
  }

  const candidate = parsed as { title?: unknown; stops?: unknown };
  if (!Array.isArray(candidate.stops)) {
    throw new GeminiError('invalid_output');
  }

  return {
    title: typeof candidate.title === 'string' ? candidate.title : '',
    // 每個元素的形狀留到 toTripPlan 逐一檢查，這裡不假裝它已經是合法的 stop
    stops: candidate.stops,
  };
}

/**
 * 把模型輸出對應回原始 POI。
 *
 * 這個函式是「AI 不能竄改座標」的保證所在：
 *  - 每個 stop 只透過 poi_index 指向原始陣列，name / lat / lng 一律取自 `pois`
 *  - 索引不合法、重複、或欄位型別錯誤的 stop 會被丟棄
 *  - 模型漏掉的 POI 會依原始順序補在後面，確保不會弄丟景點
 *  - sequenceOrder 由我們重新編號，不採用模型的編號
 *  - 完全沒有任何一條路徑會讀取模型提供的座標（schema 裡根本沒有）
 */
export function toTripPlan(pois: readonly TripPoi[], raw: RawTripPlan, fallbackTitle: string): TripPlan {
  const usedIndexes = new Set<number>();
  const orderedIndexes: number[] = [];
  const details = new Map<number, { stayDurationMinutes: number; summary: string }>();

  for (const entry of raw.stops) {
    if (entry === null || typeof entry !== 'object') continue;

    // 通過 typeof 檢查後，把各欄位讀成 unknown 是安全的；
    // 真正的型別判斷在下面逐欄進行，不做任何未經驗證的斷言。
    const stop = entry as RawStop;

    const index = stop.poi_index;
    if (typeof index !== 'number' || !Number.isInteger(index)) continue;
    if (index < 0 || index >= pois.length) continue;
    if (usedIndexes.has(index)) continue;

    usedIndexes.add(index);
    orderedIndexes.push(index);

    const stay = stop.stay_duration_minutes;
    const summary = stop.summary;
    details.set(index, {
      stayDurationMinutes:
        typeof stay === 'number' && Number.isFinite(stay) && stay > 0
          ? Math.round(stay)
          : DEFAULT_STAY_MINUTES,
      summary: typeof summary === 'string' ? summary : '',
    });
  }

  // 一個有效的 stop 都沒有 → 模型輸出無法使用，交給 retry 再抽一次
  if (orderedIndexes.length === 0 && pois.length > 0) {
    throw new GeminiError('invalid_output');
  }

  // 模型漏掉的 POI 依原始順序補回，行程不會少景點
  for (let i = 0; i < pois.length; i++) {
    if (!usedIndexes.has(i)) {
      orderedIndexes.push(i);
      details.set(i, { stayDurationMinutes: DEFAULT_STAY_MINUTES, summary: '' });
    }
  }

  return {
    title: raw.title.trim() !== '' ? raw.title : fallbackTitle,
    stops: orderedIndexes.map((poiIndex, position) => {
      const detail = details.get(poiIndex)!;
      return {
        sequenceOrder: position + 1,
        poi: pois[poiIndex], // ← 座標唯一來源：呼叫端的原始輸入
        stayDurationMinutes: detail.stayDurationMinutes,
        summary: detail.summary,
      };
    }),
  };
}

export function buildPlanPrompt(pois: readonly TripPoi[], preference: string): string {
  return `你是一位專業的台灣在地旅遊規劃師與交通排程專家。
請依「順路、節省車程、不繞路」為原則，為以下景點排出最合理的自駕造訪順序，
並為每個景點給出建議停留時間與一句話的特色推薦。

【規則】
1. stops 陣列的順序就是實際造訪順序。
2. 每個景點只能出現一次，且清單中的景點必須全部出現。
3. poi_index 必須是下方清單中該景點的 index，不可自行創造或省略。
4. 全文必須使用繁體中文（台灣慣用語），嚴格禁止出現任何簡體字。

【使用者偏好】
${preference}

【景點清單】
${pois.map((poi, index) => `index ${index}: ${poi.name}`).join('\n')}`;
}

// ──────────────────────────────────────────────────────────────── client 與呼叫

// dev 的 HMR 會重新執行模組，把 client 掛在 globalThis 上避免每次熱更新都重建
const globalForGemini = globalThis as typeof globalThis & {
  __geminiClient?: GoogleGenAI;
};

function getClient(): GoogleGenAI {
  if (!globalForGemini.__geminiClient) {
    globalForGemini.__geminiClient = new GoogleGenAI({ apiKey: config.geminiApiKey });
  }
  return globalForGemini.__geminiClient;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function generatePlanOnce(prompt: string): Promise<RawTripPlan> {
  let response;
  try {
    response = await getClient().models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
        abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    });
  } catch (error) {
    const kind = classifyGeminiError(error);
    console.error(
      `[gemini] 呼叫失敗 (${kind}):`,
      redact(error instanceof Error ? error.message : String(error))
    );
    throw new GeminiError(kind, { cause: error });
  }

  return parsePlanPayload(response.text);
}

/**
 * 依使用者偏好為一組 POI 排出行程。
 *
 * 只有「暫時性」的錯誤會重試：上游 5xx／逾時／模型輸出不合格。
 * 額度用盡與認證失敗一定不會重試（重試只是白白再燒一次額度）。
 */
export async function planTrip(
  pois: readonly TripPoi[],
  options: { preference?: string; fallbackTitle?: string } = {}
): Promise<TripPlan> {
  if (pois.length === 0) {
    throw new GeminiError('bad_request');
  }

  const preference = options.preference?.trim() || '輕鬆高雄一日遊';
  const fallbackTitle = options.fallbackTitle ?? '高雄一日遊';
  const prompt = buildPlanPrompt(pois, preference);

  let lastError: GeminiError = new GeminiError('upstream');

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const raw = await generatePlanOnce(prompt);
      return toTripPlan(pois, raw, fallbackTitle);
    } catch (error) {
      const geminiError =
        error instanceof GeminiError
          ? error
          : new GeminiError(classifyGeminiError(error), { cause: error });
      lastError = geminiError;

      if (!geminiError.retryable || attempt === MAX_ATTEMPTS) {
        if (!geminiError.retryable) {
          console.warn(`[gemini] ${geminiError.kind} 不重試，直接放棄`);
        }
        throw geminiError;
      }

      const delay = RETRY_BASE_DELAY_MS * attempt;
      console.warn(
        `[gemini] 第 ${attempt} 次失敗 (${geminiError.kind})，${delay}ms 後重試`
      );
      await sleep(delay);
    }
  }

  throw lastError;
}
