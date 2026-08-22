// server/types/parking.ts
//
// parking_lots_cache 的資料型別。目前只放 repository 真正需要的，
// 完整 domain model 等 Stage 5 service 層再視需要擴充。

/**
 * 附近停車場查詢的一列結果。
 *
 * 欄位名沿用資料庫 / 既有 route 的 snake_case，這是 DB row 的投影而不是
 * 對外 API 型別 —— 對外欄位由 route 自行組裝，維持既有 response contract。
 *
 * 註：`total_spaces` 與 `available_spaces` 在 schema 上是 nullable int4，
 * 且 `available_spaces` 的預設值是 -1（TDX 用 -1 表示「無即時資料」）。
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
