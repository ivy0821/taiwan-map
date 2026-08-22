// server/integrations/geocoding.ts
//
// Google Maps 網址解析與 Nominatim 地名轉座標的唯一進入點。
// 這一層負責「對外請求的安全性」：協定 / host allowlist / 轉址重新驗證 /
// IP literal 阻擋 / 逾時。request body 的型別驗證由 Zod 在 API 邊界完成，
// 這裡不重複。
//
// ── C6 SSRF 修正說明 ────────────────────────────────────────────────────
// 舊版用 `raw_input.includes('google.com/maps')` 判斷是不是 Google Maps 網址，
// 然後直接 axios.get(raw_input) 並自動跟隨轉址。因此
//     http://169.254.169.254/latest/meta-data/#google.com/maps
// 這種輸入的字串裡含有 'google.com/maps'，但實際請求的 host 是雲端 metadata
// 服務，伺服器就會替攻擊者對內網發出請求。
//
// 現在所有對外請求都必須先通過 assertSafeGoogleMapsUrl()：
// 判斷依據一律是 `new URL()` 解析後的 protocol / hostname，
// 而且【每一次轉址的 Location 都會重新驗證一次】。

import { timeouts } from '@/server/config';

/**
 * 允許對外請求的 Google Maps host（精確比對）。
 *
 * 刻意使用精確集合而不是 `.endsWith('.google.com')`：
 * 目前只需要這幾個 host，精確集合不可能被
 * `google.com.evil.com` / `evilgoogle.com` 這類邊界問題繞過。
 *
 * 實測（2026-08-22）真實轉址鏈都落在這個集合內：
 *   maps.google.com/?q=… → 302 maps.google.com → 302 www.google.com → 200
 */
const ALLOWED_HOSTS = new Set([
  'google.com',
  'www.google.com',
  'maps.google.com',
  'maps.app.goo.gl',
]);

/** 轉址最多跟隨幾次 */
const MAX_REDIRECTS = 5;

const NOMINATIM_SEARCH_URL = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'TripParkingApp/1.0';

export interface GeocodedPoint {
  lat: number;
  lng: number;
}

export interface ResolvedGoogleMapsPlace extends GeocodedPoint {
  name: string;
}

/**
 * 網址不安全或不被支援。
 *
 * message 只給 server log 用（含被拒絕的原因），
 * 呼叫端負責轉成給 client 的安全訊息。
 */
export class UnsafeUrlError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'UnsafeUrlError';
  }
}

// ─────────────────────────────────────────────────────────── URL 安全檢查

/**
 * 輸入看起來是不是「一個網址」（而不是地名）。
 *
 * 只認「scheme + //」或少數幾個沒有 authority 的危險 scheme，
 * 這樣 `台北:101` 這種含冒號的地名才不會被誤判成網址。
 */
export function looksLikeUrl(rawInput: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(rawInput) || /^(javascript|data|file|vbscript):/i.test(rawInput);
}

/** 結尾的點是 DNS root 標示法，`www.google.com.` 與 `www.google.com` 是同一台主機 */
function normaliseHostname(hostname: string): string {
  const lower = hostname.toLowerCase();
  return lower.endsWith('.') ? lower.slice(0, -1) : lower;
}

/**
 * 是否為 IP literal。
 *
 * WHATWG URL 會把 `2130706433`、`0x7f000001` 這類寫法正規化成 `127.0.0.1`，
 * 所以這裡只要比對正規化之後的結果即可；IPv6 會保留中括號。
 */
function isIpLiteral(hostname: string): boolean {
  if (hostname.startsWith('[')) return true; // IPv6 literal，例如 [::1]
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}

/**
 * 驗證一個網址是否可以安全地對它發出伺服器端請求。
 *
 * 通過才回傳解析後的 URL；否則丟 UnsafeUrlError。
 * 進入點與每一次轉址都會走這個函式。
 */
export function assertSafeGoogleMapsUrl(candidate: string | URL): URL {
  let url: URL;
  try {
    url = candidate instanceof URL ? candidate : new URL(candidate);
  } catch {
    throw new UnsafeUrlError('無法解析的網址');
  }

  // 1. 只允許 HTTPS：擋掉 file: / ftp: / javascript: / data: 與明文 http:
  if (url.protocol !== 'https:') {
    throw new UnsafeUrlError(`不允許的協定 ${url.protocol}`);
  }

  const hostname = normaliseHostname(url.hostname);
  if (hostname === '') {
    throw new UnsafeUrlError('網址缺少 hostname');
  }

  // 2. 縱深防禦：Google Maps 網址沒有任何理由使用 IP 或本機位址。
  //    （即使沒有這一段，下面的 allowlist 也會擋掉，但明確拒絕能留下更清楚的 log）
  if (isIpLiteral(hostname)) {
    throw new UnsafeUrlError(`不允許直接使用 IP 位址 ${hostname}`);
  }
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new UnsafeUrlError(`不允許本機位址 ${hostname}`);
  }

  // 3. 精確 host allowlist
  if (!ALLOWED_HOSTS.has(hostname)) {
    throw new UnsafeUrlError(`不在允許清單中的 host ${hostname}`);
  }

  // 4. 只允許預設的 HTTPS 埠
  if (url.port !== '' && url.port !== '443') {
    throw new UnsafeUrlError(`不允許的埠號 ${url.port}`);
  }

  return url;
}

// ────────────────────────────────────────────────────────── 座標抽取

/**
 * 從 Google Maps 網址抽出座標。
 *
 * 優先 `!3d<lat>!4d<lng>`：那是地點本身的座標。
 * 找不到才退回 `@<lat>,<lng>`：那其實是地圖視窗中心，只是近似值（L3）。
 */
export function extractCoordinatesFromUrl(url: string): GeocodedPoint | null {
  const place = url.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  const viewport = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  const match = place ?? viewport;
  if (!match) return null;

  const lat = parseFloat(match[1]);
  const lng = parseFloat(match[2]);

  // 上游給出不可能的座標時當作解析失敗，不要把垃圾往下傳
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

  return { lat, lng };
}

// ──────────────────────────────────────────────────── 安全的轉址跟隨

export interface GeocodingFetchDeps {
  fetch: typeof fetch;
}

const defaultFetchDeps: GeocodingFetchDeps = { fetch: globalThis.fetch };

/**
 * 手動跟隨轉址，每一跳都重新驗證。
 *
 * 用 `redirect: 'manual'` 而不是讓 fetch 自動跟隨 —— 自動跟隨等於把
 * 「要不要對這個 host 發請求」的決定權交給上游的 Location 標頭。
 *
 * 回傳最終網址即可：座標就在網址裡，因此【完全不需要下載回應內容】，
 * 每一跳都直接把 body 取消掉（這也是本函式的回應大小防護）。
 */
async function resolveFinalUrl(
  startUrl: string,
  deps: GeocodingFetchDeps
): Promise<string | null> {
  let current = assertSafeGoogleMapsUrl(startUrl);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let response: Response;
    try {
      response = await deps.fetch(current.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(timeouts.geocodingMs),
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
      });
    } catch (error: unknown) {
      // 網路錯誤／逾時：不是輸入的問題，回 null 讓上層維持「查無結果」語意
      console.warn(
        '[geocoding] Google Maps 請求失敗:',
        error instanceof Error ? error.message : String(error)
      );
      return null;
    }

    // 不需要回應內容，立刻釋放
    response.body?.cancel().catch(() => {});

    const isRedirect = response.status >= 300 && response.status < 400;
    if (!isRedirect) {
      return response.ok ? current.toString() : null;
    }

    const location = response.headers.get('location');
    if (!location) {
      console.warn('[geocoding] 轉址回應沒有 Location 標頭');
      return null;
    }

    // 相對 Location 也可能跳到別的 host（例如 //169.254.169.254/x），
    // 所以先用目前網址解析成絕對網址，再重新跑一次完整驗證。
    current = assertSafeGoogleMapsUrl(new URL(location, current));
  }

  throw new UnsafeUrlError(`轉址超過 ${MAX_REDIRECTS} 次`);
}

/** 解析 Google Maps 網址並取出座標 */
export async function resolveGoogleMapsUrl(
  url: string,
  deps: GeocodingFetchDeps = defaultFetchDeps
): Promise<ResolvedGoogleMapsPlace | null> {
  const finalUrl = await resolveFinalUrl(url, deps);
  if (!finalUrl) return null;

  const point = extractCoordinatesFromUrl(finalUrl);
  if (!point) return null;

  return {
    ...point,
    name: 'Google Maps 匯入地點', // 實務上可透過 Google Places API 取得真實名稱
  };
}

// ───────────────────────────────────────────────────────────── Nominatim

/**
 * 透過 OpenStreetMap 取得經緯度 (免費，無需 API Key)。
 *
 * host 是寫死的常數，使用者輸入只會出現在 query string，
 * 而且是用 URLSearchParams 編碼 —— 不存在讓使用者控制 host 的路徑。
 */
export async function geocodePlaceName(
  placeName: string,
  deps: GeocodingFetchDeps = defaultFetchDeps
): Promise<GeocodedPoint | null> {
  const url = new URL(NOMINATIM_SEARCH_URL);
  url.searchParams.set('q', placeName);
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', '1');

  try {
    const response = await deps.fetch(url.toString(), {
      method: 'GET',
      signal: AbortSignal.timeout(timeouts.geocodingMs),
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, // OSM 規定必須提供 User-Agent
    });

    if (!response.ok) {
      console.warn(`[geocoding] Nominatim 回應 HTTP ${response.status}`);
      return null;
    }

    // 上游回應先當成 unknown，逐層縮小後才讀欄位
    const payload: unknown = await response.json();
    if (!Array.isArray(payload) || payload.length === 0) return null;

    const first: unknown = payload[0];
    if (first === null || typeof first !== 'object') return null;

    // 通過 typeof 檢查後，把欄位讀成 unknown 是安全的
    const { lat: rawLat, lon: rawLon } = first as { lat?: unknown; lon?: unknown };
    const lat = parseFloat(String(rawLat));
    const lng = parseFloat(String(rawLon));
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

    return { lat, lng };
  } catch (error: unknown) {
    console.warn(
      '[geocoding] Nominatim 查詢失敗:',
      error instanceof Error ? error.message : String(error)
    );
    return null;
  }
}
