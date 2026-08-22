// server/repositories/parking.repository.ts
//
// parking_lots_cache 的所有資料庫存取。
// 這一層只碰 SQL / PostGIS 與 row 對應，不呼叫 TDX、不算步行時間、
// 不組顯示字串、不知道 HTTP 的存在 —— 那些是 Stage 5 service 層的事。

import type { PoolClient } from 'pg';
import { getPool } from '@/server/db/pool';
import type { FindNearbyParkingParams, NearbyParking } from '@/server/types/parking';

/** 表名是模組內常數，永遠不接受 runtime 輸入 */
const PARKING_TABLE = 'parking_lots_cache';

/**
 * 附近停車場查詢 —— 收斂自原本散落的三份幾乎相同的 PostGIS 查詢：
 *   app/api/v1/trip/[tripId]/insert-parking/route.ts（半徑 1500 / LIMIT 1 / 有排除）
 *   app/api/v1/trip/ai-plan-with-parking/route.ts  （半徑 1500 / LIMIT 3）
 *   lib/tdxParking.ts                              （半徑參數化 / LIMIT 1，死碼）
 *
 * SELECT 欄位取三者的聯集，半徑與筆數改為參數，呼叫端只是傳不同參數。
 *
 * 座標順序：ST_MakePoint 一律是 (經度 lng, 緯度 lat)。
 * 這裡把 lng 綁 $1、lat 綁 $2，函式簽名則用具名參數，避免呼叫端傳反。
 *
 * `location` 欄位在 schema 上是 geometry(Point,4326)，
 * 與 geography 參數比較時 PostgreSQL 會隱式轉成 geography，
 * 所以 ST_DWithin / ST_Distance 的單位是公尺。此行為與重構前完全相同。
 */
export async function findNearbyParking(
  params: FindNearbyParkingParams,
  client?: PoolClient
): Promise<NearbyParking[]> {
  const { lat, lng, radiusM, limit, excludeIds = [] } = params;

  // 排除清單用陣列參數傳入，不做任何 SQL 字串拼接。
  // 空陣列時 `<> ALL('{}')` 對每一列都成立，等同於「不排除」。
  const sql = `
    SELECT
      parking_id,
      name,
      total_spaces,
      available_spaces,
      hourly_rate,
      fare_description,
      ST_Y(location::geometry) AS lat,
      ST_X(location::geometry) AS lng,
      ST_Distance(location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) AS distance_meters
    FROM ${PARKING_TABLE}
    WHERE ST_DWithin(
            location,
            ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
            $3
          )
      AND parking_id <> ALL($4::text[])
    ORDER BY distance_meters ASC
    LIMIT $5;
  `;

  const executor = client ?? getPool();
  const { rows } = await executor.query<NearbyParking>(sql, [
    lng, // $1 經度
    lat, // $2 緯度
    radiusM,
    excludeIds,
    limit,
  ]);

  return rows;
}
