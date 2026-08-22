// server/repositories/trip.repository.ts
//
// trips / trip_nodes 的所有資料庫存取。
// 這一層只碰 SQL / PostGIS 與 row 對應，不含任何行程規則。
//
// 交易：寫入類函式一律接受呼叫端傳進來的 PoolClient，
// 由 route（Stage 5 之後是 service）用 Stage 1 的 withTransaction 包起來。
// 這裡不自己 BEGIN / COMMIT / ROLLBACK，也不建立第二套 DB helper。

import type { PoolClient } from 'pg';
import { getPool } from '@/server/db/pool';
import type { NewTripNode, TripNodeRow } from '@/server/types/trip';

/**
 * 建立 trip 主記錄，回傳新的 trip_id（uuid）。
 * start_date / end_date 沿用原本明確寫入 CURRENT_DATE 的作法。
 */
export async function createTrip(client: PoolClient, title: string): Promise<string> {
  const { rows } = await client.query<{ trip_id: string }>(
    `INSERT INTO trips (title, start_date, end_date)
     VALUES ($1, CURRENT_DATE, CURRENT_DATE)
     RETURNING trip_id;`,
    [title]
  );
  return rows[0].trip_id;
}

/**
 * 依 sequence_order 讀出某趟行程的所有節點。
 *
 * 預設【不】取 stay_duration_minutes / summary，完全重現目前的行為 ——
 * insert-parking 會把這個物件展開進 response，多取欄位就會改變 API 輸出。
 *
 * Stage 5 要修 C2（重建節點時遺失停留時間與摘要）時，
 * 把 `includePlanningFields: true` 打開即可，repository 這邊已經備好。
 */
export async function findTripNodes(
  tripId: string,
  options: { includePlanningFields?: boolean } = {},
  client?: PoolClient
): Promise<TripNodeRow[]> {
  const planningFields = options.includePlanningFields
    ? ',\n        stay_duration_minutes,\n        summary'
    : '';

  const sql = `
      SELECT
        node_id,
        poi_name,
        ST_Y(location::geometry) AS lat,
        ST_X(location::geometry) AS lng,
        node_type,
        sequence_order${planningFields}
      FROM trip_nodes
      WHERE trip_id = $1
      ORDER BY sequence_order ASC;
    `;

  const executor = client ?? getPool();
  const { rows } = await executor.query<TripNodeRow>(sql, [tripId]);
  return rows;
}

/** 刪掉某趟行程的所有節點（呼叫端負責放在交易內） */
export async function deleteTripNodes(client: PoolClient, tripId: string): Promise<void> {
  await client.query('DELETE FROM trip_nodes WHERE trip_id = $1;', [tripId]);
}

/**
 * 寫入單一節點。
 *
 * 欄位清單是動態組出來的，但候選欄位全部是本模組的固定常數，
 * 不存在任何來自外部輸入的識別字。
 *
 * 欄位的三種語意（C2 依賴這個區分）：
 *   undefined → 不寫這個欄位，交給 DB DEFAULT（stay_duration_minutes 是 60）
 *   null      → 明確寫入 NULL
 *   有值      → 照寫
 *
 * 回傳資料庫實際產生的 node_id。
 */
export async function insertTripNode(client: PoolClient, node: NewTripNode): Promise<string> {
  const columns = ['trip_id', 'sequence_order', 'node_type', 'poi_name', 'location'];
  const values: unknown[] = [node.tripId, node.sequenceOrder, node.nodeType, node.poiName];

  // location 佔用兩個參數：$5 = 經度 lng、$6 = 緯度 lat
  values.push(node.lng, node.lat);
  const placeholders = ['$1', '$2', '$3', '$4', 'ST_SetSRID(ST_MakePoint($5, $6), 4326)'];

  if (node.stayDurationMinutes !== undefined) {
    columns.push('stay_duration_minutes');
    values.push(node.stayDurationMinutes);
    placeholders.push(`$${values.length}`);
  }

  if (node.summary !== undefined) {
    columns.push('summary');
    values.push(node.summary);
    placeholders.push(`$${values.length}`);
  }

  const { rows } = await client.query<{ node_id: string }>(
    `INSERT INTO trip_nodes (${columns.join(', ')})
     VALUES (${placeholders.join(', ')})
     RETURNING node_id;`,
    values
  );
  return rows[0].node_id;
}

/**
 * 依序寫入多筆節點（呼叫端負責放在交易內）。
 * 回傳的 node_id 陣列與傳入順序一一對應。
 */
export async function insertTripNodes(
  client: PoolClient,
  nodes: readonly NewTripNode[]
): Promise<string[]> {
  const ids: string[] = [];
  for (const node of nodes) {
    ids.push(await insertTripNode(client, node));
  }
  return ids;
}
