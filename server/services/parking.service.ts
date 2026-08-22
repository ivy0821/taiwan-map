// server/services/parking.service.ts
//
// 停車場的 use case 層：把 parking.repository（DB 快取）與 tdx integration
// （即時車位）組合起來，並負責 fallback、步行時間、顯示字串等 domain 計算。
//
// repository 不知道 TDX 的存在；TDX integration 不知道 DB 的存在；
// 兩者只在這一層相遇。
//
// 這一層不 import next/server，也不知道任何 HTTP status。

import { findNearbyParking } from '@/server/repositories/parking.repository';
import { getParkingAvailability } from '@/server/integrations/tdx';
import type {
  CandidateParking,
  LiveAvailabilityResult,
  NearbyParking,
} from '@/server/types/parking';
import type { PlaceInput } from '@/server/types/trip';

/** 既有行為的常數，維持不變 */
export const SEARCH_RADIUS_M = 1500;
export const CANDIDATES_PER_PLACE = 3;
/** 步行速度：公尺／分鐘 */
const WALKING_SPEED_M_PER_MIN = 80;

/**
 * 相依項以參數注入，預設指向真實實作。
 * 這是為了讓 service 的 business logic 能離線測試，
 * 不需要引入任何 DI framework 或 mocking library。
 */
export interface ParkingServiceDeps {
  findNearbyParking: typeof findNearbyParking;
  getParkingAvailability: typeof getParkingAvailability;
}

const defaultDeps: ParkingServiceDeps = { findNearbyParking, getParkingAvailability };

// ────────────────────────────────────────────────────────────── domain 計算

/** 把一筆 DB 快取資料與（可能有的）即時車位合併成對外的候選停車場 */
export function toCandidateParking(
  parking: NearbyParking,
  liveAvailableSpaces: number | null | undefined
): CandidateParking {
  // 即時車位有值就覆蓋快取值，沒有就沿用快取（既有 fallback 行為）
  const availableSpaces =
    liveAvailableSpaces !== null && liveAvailableSpaces !== undefined
      ? liveAvailableSpaces
      : parking.available_spaces;

  const distKm = (parking.distance_meters / 1000).toFixed(2);
  const walkingMin = Math.ceil(parking.distance_meters / WALKING_SPEED_M_PER_MIN);

  return {
    parking_id: parking.parking_id,
    name: parking.name,
    lat: Number(parking.lat),
    lng: Number(parking.lng),
    total_spaces: parking.total_spaces || null,
    available_spaces: availableSpaces,
    distance_meters: Math.round(parking.distance_meters),
    distance_display: `${distKm} 公里 (步行約 ${walkingMin} 分鐘)`,
    // 真實資料：若政府端點未提供則如實顯示「現場公告為主」
    hourly_rate: parking.hourly_rate || parking.fare_description || '依現場公告收費',
    fare_description: parking.fare_description || '以現場公告營運時段為準',
  };
}

// ──────────────────────────────────────────────────────────────── use cases

/**
 * 取得多個景點各自的候選停車場，並套上即時車位。
 *
 * TDX 每分鐘只有 5 次額度，所以**所有景點的候選停車場合起來只打一次**
 * （超過 chunk 大小時由 tdx integration 自行分批），
 * 絕對不做「每個景點 N 次」或「每個停車場 1 次」的呼叫。
 *
 * 回傳陣列與傳入的 places 一一對應（index 對齊）。
 */
export async function getCandidateParkingsForPlaces(
  places: readonly PlaceInput[],
  deps: ParkingServiceDeps = defaultDeps
): Promise<CandidateParking[][]> {
  // 1. 每個景點各自查 DB 快取（PostGIS 空間查詢，走本地資料庫）
  const perPlace: NearbyParking[][] = [];
  for (const place of places) {
    perPlace.push(
      await deps.findNearbyParking({
        lat: place.lat,
        lng: place.lng,
        radiusM: SEARCH_RADIUS_M,
        limit: CANDIDATES_PER_PLACE,
      })
    );
  }

  // 2. 所有候選停車場的即時車位，一次查完
  const allIds = perPlace.flatMap((list) => list.map((p) => p.parking_id));
  const live = await getLiveAvailabilityMap(allIds, deps);

  // 3. 合併回各景點
  return perPlace.map((list) => list.map((p) => toCandidateParking(p, live.get(p.parking_id))));
}

/**
 * 找出離某個座標最近、且不在排除清單中的一個停車場。
 * 只查 DB，不碰 TDX —— 呼叫端（trip.service）會在選完所有停車場後一次補上即時車位。
 */
export async function findNearestParkingForPlace(
  params: { lat: number; lng: number; excludeIds?: readonly string[] },
  deps: ParkingServiceDeps = defaultDeps
): Promise<NearbyParking | null> {
  const rows = await deps.findNearbyParking({
    lat: params.lat,
    lng: params.lng,
    radiusM: SEARCH_RADIUS_M,
    limit: 1,
    excludeIds: params.excludeIds,
  });
  return rows[0] ?? null;
}

/** 批次取得即時車位，回傳 Map（查不到的 ID 不會出現在 Map 中） */
export async function getLiveAvailabilityMap(
  parkingIds: readonly string[],
  deps: ParkingServiceDeps = defaultDeps
): Promise<Map<string, number | null>> {
  if (parkingIds.length === 0) return new Map();

  const { availabilities } = await deps.getParkingAvailability(parkingIds);
  const result = new Map<string, number | null>();
  for (const [id, info] of availabilities) {
    result.set(id, info.availableSpaces);
  }
  return result;
}

/**
 * parking/live endpoint 的 use case。
 *
 * 保留 `upstreamOk`，讓 route 能維持既有行為：
 * 上游失敗時回 200 + 空 availabilities 且不附 updated_at。
 * （HTTP status 語意的調整留給 error-handling stage。）
 */
export async function getLiveAvailability(
  parkingIds: unknown,
  deps: ParkingServiceDeps = defaultDeps
): Promise<LiveAvailabilityResult> {
  const { availabilities, upstreamOk } = await deps.getParkingAvailability(parkingIds);

  const result: Record<string, number | null> = {};
  for (const [id, info] of availabilities) {
    result[id] = info.availableSpaces;
  }

  return { availabilities: result, upstreamOk };
}
