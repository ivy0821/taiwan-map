// lib/tdxParking.ts
import pool from '@/lib/db';

let tdxTokenCache: { token: string; expiresAt: number } | null = null;

export interface NearestParkingResult {
  parking_id: string;
  name: string;
  total_spaces: number | null;
  available_spaces: number | null;
  fare_description: string | null;
  lat: number;
  lng: number;
  distance_meters: number;
}

// 1. 取得 TDX OAuth Token
export async function getTDXToken(): Promise<string> {
  if (tdxTokenCache && Date.now() < tdxTokenCache.expiresAt) {
    return tdxTokenCache.token;
  }

  const res = await fetch(
    'https://tdx.transportdata.ntu.edu.tw/auth/realms/TDXConnect/protocol/openid-connect/token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: process.env.TDX_CLIENT_ID || '',
        client_secret: process.env.TDX_CLIENT_SECRET || '',
      }),
    }
  );

  const data = await res.json();
  if (!res.ok) throw new Error(`TDX Token 取得失敗: ${JSON.stringify(data)}`);

  tdxTokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };
  return data.access_token;
}

// 2. 依景點經緯度搜尋附近指定半徑內距離最近的停車場（使用 PostGIS 空間索引計算）
export async function findNearestParking(
  lat: number,
  lng: number,
  radiusMeters: number = 1000
): Promise<NearestParkingResult | null> {
  const client = await pool.connect();
  try {
    // 注意：ST_MakePoint 參數必須為 (經度 lng, 緯度 lat)
    const query = `
      SELECT 
        parking_id, 
        name, 
        total_spaces, 
        available_spaces, 
        fare_description,
        ST_Y(location::geometry) AS lat,
        ST_X(location::geometry) AS lng,
        ST_Distance(
          location, 
          ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
        ) AS distance_meters
      FROM parking_lots_cache
      WHERE ST_DWithin(
        location, 
        ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, 
        $3
      )
      ORDER BY distance_meters ASC
      LIMIT 1;
    `;
    const res = await client.query(query, [lng, lat, radiusMeters]);
    return (res.rows[0] as NearestParkingResult) || null;
  } finally {
    client.release();
  }
}