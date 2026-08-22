// server/integrations/tdx.ts
//
// Next.js backend 對 TDX（運輸資料流通服務）的唯一進入點。
// 這裡集中：OAuth token 取得與快取、TDX base URL、OData 組裝與跳脫、
// 逐批查詢即時車位、HTTP timeout、回應解析。
//
// route.ts 一律只呼叫這裡匯出的函式，不得自行組 URL 或 OData 條件。
//
// ── 實測確認過的 TDX API contract（2026-08-22，高雄市）────────────────────
//  Auth   POST /auth/realms/TDXConnect/protocol/openid-connect/token
//         回應 { access_token, expires_in: 86400, token_type, ... }
//         認證失敗 → HTTP 400 { error, error_description }
//
//  Data   GET  /api/basic/v1/Parking/OffStreet/ParkingAvailability/City/{City}
//         回應 { UpdateTime, UpdateInterval, SrcUpdateTime, SrcUpdateInterval,
//                AuthorityCode, ParkingAvailabilities: [...] }
//         每筆 { CarParkID, CarParkName: { Zh_tw }, TotalSpaces, AvailableSpaces,
//                Availabilities[], ServiceStatus, FullStatus, ChargeStatus,
//                DataCollectTime }
//
//  ⚠ 識別欄位是 CarParkID，【沒有】ParkingID。
//    用 `$filter=ParkingID eq '...'` 會得到
//    HTTP 400「odata語法錯誤: Could not find a property named 'ParkingID'」。
//    舊程式就是踩到這個坑，導致即時車位功能從來沒有生效過。
//
//  查無資料 → HTTP 200 且 ParkingAvailabilities 為空陣列（不是 404）。
//  速率限制 → 每分鐘 5 次；超過回 HTTP 429 { message: "API rate limit exceeded" }
//             並帶 retry-after / ratelimit-* 標頭。
//             正因為額度這麼緊，呼叫端務必「一次查多個 ID」而不是逐筆查。
//  `CarParkID in ('a','b',...)` 可用且比一長串 `or` 短，實測 350 個 ID
//  （編碼後約 4.7KB URL）仍正常。

import { config } from '@/server/config';

const TDX_HOST = 'https://tdx.transportdata.tw';
const TDX_AUTH_URL = `${TDX_HOST}/auth/realms/TDXConnect/protocol/openid-connect/token`;
const TDX_API_BASE = `${TDX_HOST}/api/basic/v1`;

const DEFAULT_CITY = 'Kaohsiung';

const AUTH_TIMEOUT_MS = 10_000;
const QUERY_TIMEOUT_MS = 10_000;

/** token 提前這麼多秒視為過期，避免拿著剛好到期的 token 去打 API */
const TOKEN_EXPIRY_SAFETY_SECONDS = 60;
/** TDX 沒回 expires_in 時的保守預設值 */
const TOKEN_FALLBACK_TTL_SECONDS = 3600;

/** 單次呼叫最多接受幾個 ID；超過的部分會被丟棄並記錄 */
export const MAX_PARKING_IDS = 200;
/** 每個 request 塞幾個 ID。100 個 → 編碼後約 1.4KB，過任何 proxy 都安全 */
const ID_CHUNK_SIZE = 100;
/** 單一 ID 的長度上限，純粹用來擋住異常長的輸入 */
const MAX_ID_LENGTH = 64;

export interface ParkingAvailability {
  carParkId: string;
  /** TDX 回 -1 代表「該場無即時資料」，這裡原樣保留，不自行改寫語意 */
  availableSpaces: number | null;
  totalSpaces: number | null;
  serviceStatus: number | null;
  dataCollectTime: string | null;
}

export interface ParkingAvailabilityResult {
  /** 只包含 TDX 真的有回報的 ID */
  availabilities: Map<string, ParkingAvailability>;
  /**
   * 是否所有批次都成功。false 代表至少一批被上游拒絕（429／5xx／逾時）。
   * parking/live 需要這個旗標才能維持「上游失敗時不附 updated_at」的既有行為。
   */
  upstreamOk: boolean;
}

interface TdxAvailabilityRecord {
  CarParkID?: unknown;
  TotalSpaces?: unknown;
  AvailableSpaces?: unknown;
  ServiceStatus?: unknown;
  DataCollectTime?: unknown;
}

// ───────────────────────────────────────────────────────── OAuth token 與快取

interface TokenCache {
  token: string;
  expiresAt: number;
}

// 跟 db/pool.ts 同樣的理由：dev 的 HMR 會重新執行模組，
// 若把快取放在模組區域變數，每次熱更新都會清掉 token 而重新去換一次。
// TDX 每分鐘只給 5 次額度，重複換 token 是很貴的。
const globalForTdx = globalThis as typeof globalThis & {
  __tdxTokenCache?: TokenCache | null;
  __tdxTokenInflight?: Promise<string> | null;
};

async function requestAccessToken(): Promise<string> {
  const res = await fetch(TDX_AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: config.tdxClientId,
      client_secret: config.tdxClientSecret,
    }),
    signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
  });

  if (!res.ok) {
    // 回應內容可能夾帶憑證相關訊息，只留狀態碼給呼叫端，細節寫進 server log
    console.error(`[tdx] token 取得失敗 HTTP ${res.status}:`, (await res.text()).slice(0, 300));
    throw new Error(`無法取得 TDX Token (HTTP ${res.status})`);
  }

  const data = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
  if (typeof data.access_token !== 'string' || data.access_token === '') {
    throw new Error('TDX Token 回應缺少 access_token');
  }

  const ttlSeconds =
    typeof data.expires_in === 'number' && data.expires_in > 0
      ? data.expires_in
      : TOKEN_FALLBACK_TTL_SECONDS;

  globalForTdx.__tdxTokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + Math.max(ttlSeconds - TOKEN_EXPIRY_SAFETY_SECONDS, 30) * 1000,
  };

  return data.access_token;
}

/**
 * 取得 TDX access token，命中快取時不會發出任何網路請求。
 *
 * 同時間有多個請求進來時共用同一個 in-flight promise，
 * 避免冷啟動瞬間 N 個請求各換一次 token 直接把每分鐘 5 次的額度用光。
 */
export async function getAccessToken(): Promise<string> {
  const cached = globalForTdx.__tdxTokenCache;
  if (cached && Date.now() < cached.expiresAt) {
    return cached.token;
  }

  if (globalForTdx.__tdxTokenInflight) {
    return globalForTdx.__tdxTokenInflight;
  }

  const inflight = requestAccessToken().finally(() => {
    globalForTdx.__tdxTokenInflight = null;
  });
  globalForTdx.__tdxTokenInflight = inflight;
  return inflight;
}

// ─────────────────────────────────────────────────────────── OData 組裝與跳脫

/**
 * 把字串包成安全的 OData 字面值。
 * OData 的跳脫規則就是把單引號寫成兩個單引號，
 * 所以 `KH'A` → `'KH''A'`，被當成資料而不是語法。
 *
 * 實測：未跳脫時傳入 `' or CarParkID ne '` 會讓 filter 變成
 * `CarParkID eq '' or CarParkID ne ''`，TDX 回 200 並吐出全部 710 筆；
 * 跳脫後同樣的輸入只會查無資料。
 */
export function toODataLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function buildCarParkIdFilter(ids: readonly string[]): string {
  return `CarParkID in (${ids.map(toODataLiteral).join(',')})`;
}

// ────────────────────────────────────────────────────────────────── 輸入驗證

/**
 * 過濾出可以安全送去 TDX 的 parking ID。
 *
 * 這一層只負責「不要把垃圾送上游」，不負責回應 HTTP 狀態碼 ——
 * 現階段刻意不丟例外，以免改動 route 既有的狀態碼語意
 * （驗證層與錯誤處理是後面 stage 的事）。
 */
export function normalizeParkingIds(input: unknown): string[] {
  if (!Array.isArray(input)) return [];

  const seen = new Set<string>();
  let droppedInvalid = 0;

  for (const raw of input) {
    if (typeof raw !== 'string') {
      droppedInvalid++;
      continue;
    }
    const id = raw.trim();
    // 空字串會讓 filter 變成 `CarParkID in ('')`，浪費一次寶貴的額度
    if (id === '' || id.length > MAX_ID_LENGTH || /[\u0000-\u001F\u007F]/.test(id)) {
      droppedInvalid++;
      continue;
    }
    seen.add(id);
  }

  if (droppedInvalid > 0) {
    console.warn(`[tdx] 略過 ${droppedInvalid} 個格式不合法的 parking ID`);
  }

  const ids = [...seen];
  if (ids.length > MAX_PARKING_IDS) {
    console.warn(
      `[tdx] 一次收到 ${ids.length} 個 parking ID，超過上限 ${MAX_PARKING_IDS}，只查詢前 ${MAX_PARKING_IDS} 個`
    );
    return ids.slice(0, MAX_PARKING_IDS);
  }
  return ids;
}

// ──────────────────────────────────────────────────────────── 即時車位查詢

function toNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseAvailabilityPayload(payload: unknown): TdxAvailabilityRecord[] {
  if (Array.isArray(payload)) return payload as TdxAvailabilityRecord[];
  if (payload && typeof payload === 'object') {
    const list = (payload as { ParkingAvailabilities?: unknown }).ParkingAvailabilities;
    if (Array.isArray(list)) return list as TdxAvailabilityRecord[];
  }
  return [];
}

async function fetchAvailabilityChunk(
  ids: readonly string[],
  city: string,
  token: string
): Promise<{ records: TdxAvailabilityRecord[]; ok: boolean }> {
  const filter = buildCarParkIdFilter(ids);
  const url =
    `${TDX_API_BASE}/Parking/OffStreet/ParkingAvailability/City/${encodeURIComponent(city)}` +
    `?$filter=${encodeURIComponent(filter)}&$format=JSON`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    cache: 'no-store',
    signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
  });

  if (!res.ok) {
    const retryAfter = res.headers.get('retry-after');
    console.warn(
      `[tdx] 即時車位查詢失敗 HTTP ${res.status}` +
        (retryAfter ? `（retry-after: ${retryAfter}s，每分鐘上限 5 次）` : '') +
        `: ${(await res.text()).slice(0, 200)}`
    );
    return { records: [], ok: false };
  }

  return { records: parseAvailabilityPayload(await res.json()), ok: true };
}

/**
 * 批次查詢即時車位。
 *
 * 回傳的 Map 只包含 TDX 真的有回報的 ID —— 查不到的 ID 不會出現在 Map 裡，
 * 呼叫端可以用「有沒有這個 key」來區分「沒有即時資料」與「即時剩餘 0 位」。
 *
 * 上游失敗（429、5xx、逾時）不會丟例外，而是回傳當下拿得到的部分結果，
 * 以維持 parking/live 既有的「上游掛掉仍回 200 + 空資料」行為。
 * 只有「拿不到 token」會往外丟，這也和既有行為一致。
 */
export async function getParkingAvailability(
  parkingIds: unknown,
  options: { city?: string } = {}
): Promise<ParkingAvailabilityResult> {
  const availabilities = new Map<string, ParkingAvailability>();

  const ids = normalizeParkingIds(parkingIds);
  if (ids.length === 0) return { availabilities, upstreamOk: true };

  const city = options.city ?? DEFAULT_CITY;
  const token = await getAccessToken();
  let upstreamOk = true;

  for (let i = 0; i < ids.length; i += ID_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + ID_CHUNK_SIZE);

    let records: TdxAvailabilityRecord[];
    try {
      const outcome = await fetchAvailabilityChunk(chunk, city, token);
      records = outcome.records;
      if (!outcome.ok) upstreamOk = false;
    } catch (error) {
      // 逾時或網路錯誤：記錄後繼續處理下一批，已取得的結果照樣回傳
      console.warn('[tdx] 即時車位查詢發生例外:', error);
      upstreamOk = false;
      continue;
    }

    for (const record of records) {
      if (typeof record.CarParkID !== 'string' || record.CarParkID === '') continue;
      availabilities.set(record.CarParkID, {
        carParkId: record.CarParkID,
        availableSpaces: toNullableNumber(record.AvailableSpaces),
        totalSpaces: toNullableNumber(record.TotalSpaces),
        serviceStatus: toNullableNumber(record.ServiceStatus),
        dataCollectTime:
          typeof record.DataCollectTime === 'string' ? record.DataCollectTime : null,
      });
    }
  }

  return { availabilities, upstreamOk };
}
