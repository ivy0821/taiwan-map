// server/types/parking.ts
//
// parking_lots_cache 的資料型別。目前只放 repository 真正需要的，
// 完整 domain model 等 Stage 5 service 層再視需要擴充。

// ───────────────────────────────────── 「未知車位數」的表示法邊界（P1-1）
//
// 這個系統裡有兩種 available_spaces 的表示法，兩邊都必須清楚分開：
//
//   external / persistence 表示法   -1  = 「無有效即時資料」
//     · TDX 回應的 AvailableSpaces
//     · parking_lots_cache.available_spaces（欄位 DEFAULT 就是 -1）
//
//   application / API 表示法        null = 「未知 / 無有效即時資料」
//     · service、route、response JSON、frontend 一律只看得到這一種
//
// -1 只允許存在於「進入 application 之前」的那一層：
// integrations/tdx.ts 解析 TDX 回應時，以及 repositories/parking.repository.ts
// 讀出 DB row 時，兩處都會呼叫下面的 normalizeAvailableSpaces() 轉成 null。
// 之後的任何一層再看到 -1 都是 bug。
//
// ⚠ -1 絕對不可以被轉成 0。兩者的產品語意完全不同：
//     0    = 已知目前沒有空位（滿了）
//     null = 不知道目前有幾個空位
//
// DB 欄位本身這一輪【不做】migration，-1 繼續作為 persistence sentinel 保留；
// 若日後要把欄位改成 nullable，另開 migration Stage。

/**
 * 把外部／persistence 的車位數轉成 application 的 canonical 表示法。
 *
 * 回傳 `null` 代表「未知」，回傳 `>= 0` 的數字代表已知的剩餘車位數。
 *
 * 任何負數都視為未知，而不只是 -1：TDX 文件上的哨兵值是 -1，但負數本來就
 * 不是合法的車位數，與其把 -2 這種意料外的值當成真實數字往下傳，
 * 不如一律當成「沒有有效資料」。
 *
 * 注意這裡刻意【不】做 clamp（`Math.max(0, v)` 之類）——
 * 那會把「不知道」偽裝成「已滿」。
 */
export function normalizeAvailableSpaces(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value < 0 ? null : value;
}

/**
 * 附近停車場查詢的一列結果。
 *
 * 欄位名沿用資料庫 / 既有 route 的 snake_case，這是 DB row 的投影而不是
 * 對外 API 型別 —— 對外欄位由 route 自行組裝，維持既有 response contract。
 *
 * 註：`total_spaces` 與 `available_spaces` 在 schema 上是 nullable int4。
 * `available_spaces` 在 DB 裡的 -1（欄位 DEFAULT）已由 repository
 * 以 normalizeAvailableSpaces() 轉成 null，這個型別上的 null 就是「未知」。
 */
export interface NearbyParking {
  parking_id: string;
  name: string;
  total_spaces: number | null;
  available_spaces: number | null;
  hourly_rate: string | null;
  fare_description: string | null;
  lat: number;
  lng: number;
  distance_meters: number;
}

export interface FindNearbyParkingParams {
  /** 緯度 */
  lat: number;
  /** 經度 */
  lng: number;
  /** 搜尋半徑（公尺） */
  radiusM: number;
  /** 最多回傳幾筆 */
  limit: number;
  /** 要排除的 parking_id（例如同一趟行程已經用過的停車場） */
  excludeIds?: readonly string[];
}

/**
 * 對外回應中的候選停車場（`candidate_parkings` 陣列的一筆）。
 *
 * 欄位名與既有 API contract 完全一致 —— 這個 Stage 沒有另建 DTO 層，
 * 由 parking.service 直接產出可回應的形狀。
 */
export interface CandidateParking {
  parking_id: string;
  name: string;
  lat: number;
  lng: number;
  total_spaces: number | null;
  available_spaces: number | null;
  distance_meters: number;
  distance_display: string;
  hourly_rate: string;
  fare_description: string;
}

/** 查詢即時車位的結果（維持 route 既有的「上游失敗」判斷能力） */
export interface LiveAvailabilityResult {
  availabilities: Record<string, number | null>;
  upstreamOk: boolean;
}
