// app/api/v1/trip/ai-plan-with-parking/route.ts
import { NextResponse } from 'next/server';
import pg from 'pg';
import { GoogleGenAI } from '@google/genai';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const PARKING_TABLE = 'parking_lots_cache';

// TDX Token 取得
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

  if (!res.ok) return null;
  const data = await res.json();
  return data.access_token;
}

// 查詢 TDX 即時剩餘車位
async function getLiveParkingAvailability(parkingId: string, token: string) {
  try {
    const url = `https://tdx.transportdata.tw/api/basic/v1/Parking/OffStreet/ParkingAvailability/City/Kaohsiung?$filter=ParkingID eq '${parkingId}'&$format=JSON`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const data = await res.json();
    const list = data.ParkingAvailabilities || data;
    if (list && list.length > 0) {
      return list[0].AvailableSpaces ?? null;
    }
  } catch (err: any) {
    console.warn(`查詢即時車位失敗: ${parkingId}`);
  }
  return null;
}

export async function POST(req: Request) {
  const client = await pool.connect();
  try {
    const { places } = await req.json(); // 輸入使用者儲存的地點陣列 [{ name, lat, lng }]

    if (!places || places.length === 0) {
      return NextResponse.json({ error: '請提供儲存的景點清單' }, { status: 400 });
    }

    // 1. 呼叫 Gemini AI 將景點排定最順暢的順序與建議停留時間
    const prompt = `
    你是一位專業的台灣旅遊行程規劃專家。
    請根據以下景點清單（包含座標），以順路、節省車程、不繞路為原則，排定最合理的自駕行程順序。

    【語言與名稱嚴格規範】：
    1. 全文輸出必須完全使用「繁體中文（台灣慣用語）」，嚴格禁止出現任何簡體字。
    2. 景點名稱（name）必須 100% 保持傳入清單中的繁體原名，請勿擅自翻譯或轉換成簡體。

    景點清單:
    ${JSON.stringify(places, null, 2)}

    請直接回傳純 JSON 陣列格式，不要包含 Markdown 語法標記或任何額外解說文字：
    [
      {
        "order": 1,
        "name": "駁二藝術特區",
        "lat": 22.6201,
        "lng": 120.2818,
        "suggested_stay_minutes": 90,
        "reason": "作為行程起點，適合上午悠閒參觀"
      }
    ]
    `;

    const aiRes = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
    });

    const cleanJson = (aiRes.text || '[]').replace(/```json|```/g, '').trim();
    const orderedItinerary = JSON.parse(cleanJson);

    // 2. 準備 TDX Token
    let tdxToken: string | null = null;
    try {
      tdxToken = await getTDXToken();
    } catch (e) {}

    // 3. 為每個景點找尋周邊 1.5km 內 2~3 個候選停車場
    const fullSchedule = [];

    for (const spot of orderedItinerary) {
      const postgisQuery = `
        SELECT 
          parking_id, 
          name, 
          total_spaces, 
          available_spaces,
          hourly_rate,
          fare_description,
          ST_Y(location::geometry) as lat, 
          ST_X(location::geometry) as lng,
          ST_Distance(location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) as distance_meters
        FROM ${PARKING_TABLE}
        WHERE ST_DWithin(
          location, 
          ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, 
          1500
        )
        ORDER BY distance_meters ASC
        LIMIT 3;
      `;

      const { rows: nearbyParkings } = await client.query(postgisQuery, [
        Number(spot.lng),
        Number(spot.lat),
      ]);

      const parkingsWithLive = await Promise.all(
        nearbyParkings.map(async (p: any) => {
          let liveAvailable = p.available_spaces;
          if (tdxToken) {
            const live = await getLiveParkingAvailability(p.parking_id, tdxToken);
            if (live !== null) liveAvailable = live;
          }

          const distKm = (p.distance_meters / 1000).toFixed(2);
          const walkingMin = Math.ceil(p.distance_meters / 80);

          return {
            parking_id: p.parking_id,
            name: p.name,
            lat: Number(p.lat),
            lng: Number(p.lng),
            total_spaces: p.total_spaces || null,
            available_spaces: liveAvailable,
            distance_meters: Math.round(p.distance_meters),
            distance_display: `${distKm} 公里 (步行約 ${walkingMin} 分鐘)`,
            // 真實資料：若政府端點未提供則如實顯示「現場公告為主」
            hourly_rate: p.hourly_rate || p.fare_description || '依現場公告收費',
            fare_description: p.fare_description || '以現場公告營運時段為準',
          };
        })
      );

      fullSchedule.push({
        spot_order: spot.order,
        spot_name: spot.name,
        lat: spot.lat,
        lng: spot.lng,
        suggested_stay_minutes: spot.suggested_stay_minutes,
        reason: spot.reason,
        candidate_parkings: parkingsWithLive,
      });
    }

    return NextResponse.json({
      success: true,
      itinerary_flow: orderedItinerary.map((s: any) => `${s.order}. ${s.name}`).join(' ➔ '),
      schedule: fullSchedule,
    });
  } catch (error: any) {
    console.error('AI 行程與停車規劃失敗:', error);
    return NextResponse.json({ error: '規劃失敗', details: error.message }, { status: 500 });
  } finally {
    client.release();
  }
}