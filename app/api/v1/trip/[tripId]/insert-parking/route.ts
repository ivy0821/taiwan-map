// app/api/v1/trip/[tripId]/insert-parking/route.ts
import { NextResponse } from 'next/server';
import pool from '@/lib/db';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ tripId: string }> }
) {
  const { tripId } = await params;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. 撈出原有的 DESTINATION 景點節點
    const getNodesQuery = `
      SELECT node_id, sequence_order, poi_name, stay_duration_minutes, summary,
             ST_Y(location::geometry) as lat, ST_X(location::geometry) as lng
      FROM trip_nodes
      WHERE trip_id = $1 AND node_type = 'DESTINATION'
      ORDER BY sequence_order ASC;
    `;
    const { rows: destNodes } = await client.query(getNodesQuery, [tripId]);

    if (destNodes.length === 0) {
      return NextResponse.json({ error: '找不到該行程的景點節點' }, { status: 404 });
    }

    // 2. 清除該行程所有舊節點，準備重新編號插入
    await client.query(`DELETE FROM trip_nodes WHERE trip_id = $1`, [tripId]);

    let currentOrder = 1;
    const usedParkingIds: string[] = [];

    for (const dest of destNodes) {
      // 3. 搜尋附近尚未被選用的最近停車場
      let parkingQuery = `
        SELECT 
          parking_id, 
          name, 
          ST_Y(location::geometry) as lat, 
          ST_X(location::geometry) as lng,
          ST_Distance(
            location, 
            ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
          ) AS distance_meters
        FROM parking_lots_cache
        WHERE ST_DWithin(
          location, 
          ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, 
          1500
        )
      `;

      const queryParams: any[] = [dest.lng, dest.lat];

      if (usedParkingIds.length > 0) {
        const placeholders = usedParkingIds.map((_, i) => `$${i + 3}`).join(',');
        parkingQuery += ` AND parking_id NOT IN (${placeholders})`;
        queryParams.push(...usedParkingIds);
      }

      parkingQuery += ` ORDER BY distance_meters ASC LIMIT 1;`;

      const parkingRes = await client.query(parkingQuery, queryParams);
      const parking = parkingRes.rows[0];

      // 若有找到停車場，先插入停車場節點
      if (parking) {
        usedParkingIds.push(parking.parking_id);

        await client.query(
          `INSERT INTO trip_nodes (
            trip_id, sequence_order, node_type, poi_name, location, stay_duration_minutes, summary
          ) VALUES (
            $1, $2, 'PARKING', $3, ST_SetSRID(ST_MakePoint($4, $5), 4326), 10, '建議停放此處步行前往景點'
          )`,
          [tripId, currentOrder++, `🅿️ ${parking.name}`, parking.lng, parking.lat]
        );
      }

      // 插入景點節點
      await client.query(
        `INSERT INTO trip_nodes (
          trip_id, sequence_order, node_type, poi_name, location, stay_duration_minutes, summary
        ) VALUES (
          $1, $2, 'DESTINATION', $3, ST_SetSRID(ST_MakePoint($4, $5), 4326), $6, $7
        )`,
        [tripId, currentOrder++, dest.poi_name, dest.lng, dest.lat, dest.stay_duration_minutes, dest.summary || '']
      );
    }

    await client.query('COMMIT');

    // 4. 撈出完整重新排序後的節點清單
    const finalResult = await client.query(`
      SELECT node_id, sequence_order, node_type, poi_name, stay_duration_minutes, summary,
             ST_Y(location::geometry) as lat, ST_X(location::geometry) as lng
      FROM trip_nodes
      WHERE trip_id = $1
      ORDER BY sequence_order ASC;
    `, [tripId]);

    return NextResponse.json({
      trip_id: tripId,
      nodes: finalResult.rows
    });
  } catch (error: any) {
    await client.query('ROLLBACK');
    console.error('插入停車點失敗:', error);
    return NextResponse.json({ error: error?.message || '插入停車點失敗' }, { status: 500 });
  } finally {
    client.release();
  }
}