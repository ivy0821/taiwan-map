import { NextResponse } from 'next/server';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const PARKING_TABLE = 'parking_lots_cache';

// 1. 取得 TDX Token
async function getTDXToken() {
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.TDX_CLIENT_ID || '',
    client_secret: process.env.TDX_CLIENT_SECRET || '',
  });

  const res = await fetch('https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });

  if (!res.ok) throw new Error('無法取得 TDX Token');
  const data = await res.json();
  return data.access_token;
}

// 2. 取得即時車位
async function getLiveParkingAvailability(parkingId: string, token: string) {
  try {
    const url = `https://tdx.transportdata.tw/api/basic/v1/Parking/OffStreet/ParkingAvailability/City/Kaohsiung?$filter=ParkingID eq '${parkingId}'&$format=JSON`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (!res.ok) return null;
    const data = await res.json();
    const list = data.ParkingAvailabilities || data;

    if (list && list.length > 0) {
      return {
        availableSpaces: list[0].AvailableSpaces ?? null,
        serviceStatus: list[0].ServiceStatus ?? 1
      };
    }
  } catch (err: any) {
    console.warn(`查詢停車場 ${parkingId} 即時車位失敗:`, err.message);
  }
  return null;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ tripId: string }> | { tripId: string } }
) {
  const resolvedParams = await params;
  const tripId = resolvedParams.tripId;
  const client = await pool.connect();

  try {
    // A. 讀取現有行程節點
    const nodesQuery = `
      SELECT 
        node_id, 
        poi_name, 
        ST_Y(location::geometry) as lat, 
        ST_X(location::geometry) as lng, 
        node_type, 
        sequence_order
      FROM trip_nodes
      WHERE trip_id = $1
      ORDER BY sequence_order ASC;
    `;
    const { rows: currentNodes } = await client.query(nodesQuery, [tripId]);

    if (currentNodes.length === 0) {
      return NextResponse.json(
        { error: '找不到對應的行程節點或行程為空' },
        { status: 404 }
      );
    }

    let tdxToken = null;
    try {
      tdxToken = await getTDXToken();
    } catch (e: any) {
      console.warn('TDX Token 取得失敗，略過即時車位:', e.message);
    }

    const usedParkingIds = new Set<string>();
    const updatedNodes: any[] = [];
    let currentSequence = 1;

    // B. 走訪景點比對 PostGIS 停車場
    for (const node of currentNodes) {
      // 若該節點本身已經是 PARKING 則保留
      if (node.node_type === 'PARKING') {
        updatedNodes.push({ ...node, sequence_order: currentSequence++ });
        continue;
      }

      const usedIdsArray = Array.from(usedParkingIds);
      
      const postgisQuery = `
        SELECT 
          parking_id, 
          name, 
          total_spaces, 
          available_spaces,
          ST_Y(location::geometry) as lat, 
          ST_X(location::geometry) as lng,
          ST_Distance(location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) as distance_meters
        FROM ${PARKING_TABLE}
        WHERE ST_DWithin(
          location, 
          ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, 
          1500
        )
        ${usedIdsArray.length > 0 ? `AND parking_id NOT IN (${usedIdsArray.map((_, i) => `$${i + 3}`).join(',')})` : ''}
        ORDER BY distance_meters ASC
        LIMIT 1;
      `;

      const queryParams = [Number(node.lng), Number(node.lat), ...usedIdsArray];
      const { rows: matchedParkings } = await client.query(postgisQuery, queryParams);

      if (matchedParkings.length > 0) {
        const parking = matchedParkings[0];
        usedParkingIds.add(parking.parking_id);

        let liveInfo = null;
        if (tdxToken) {
          liveInfo = await getLiveParkingAvailability(parking.parking_id, tdxToken);
        }

        // 插入大寫 'PARKING' 節點
        updatedNodes.push({
          trip_id: tripId,
          poi_name: parking.name,
          lat: parking.lat,
          lng: parking.lng,
          node_type: 'PARKING',
          sequence_order: currentSequence++,
          total_spaces: parking.total_spaces,
          available_spaces: liveInfo?.availableSpaces ?? parking.available_spaces ?? null,
          distance_meters: Math.round(parking.distance_meters)
        });
      }

      // 插入原景點節點 (強制標記為大寫 'DESTINATION')
      updatedNodes.push({
        ...node,
        node_type: 'DESTINATION',
        sequence_order: currentSequence++
      });
    }

    // C. 寫入資料庫
    await client.query('BEGIN');
    await client.query('DELETE FROM trip_nodes WHERE trip_id = $1;', [tripId]);

    for (const n of updatedNodes) {
      await client.query(`
        INSERT INTO trip_nodes (trip_id, poi_name, location, node_type, sequence_order)
        VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326), $5, $6);
      `, [
        tripId,
        n.poi_name,
        n.lng,
        n.lat,
        n.node_type,
        n.sequence_order
      ]);
    }

    await client.query('COMMIT');

    return NextResponse.json({
      success: true,
      trip_id: tripId,
      total_nodes: updatedNodes.length,
      nodes: updatedNodes
    }, { status: 200 });

  } catch (error: any) {
    await client.query('ROLLBACK');
    console.error('插入停車場發生錯誤:', error);
    return NextResponse.json(
      { error: '伺服器內部錯誤', details: error.message },
      { status: 500 }
    );
  } finally {
    client.release();
  }
}