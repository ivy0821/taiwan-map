// app/api/v1/parking/live/route.ts
import { NextResponse } from 'next/server';

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

export async function POST(req: Request) {
  try {
    const { parkingIds } = await req.json(); // 傳入 ['CarParkID_1', 'CarParkID_2']

    if (!Array.isArray(parkingIds) || parkingIds.length === 0) {
      return NextResponse.json({ availabilities: {} });
    }

    const token = await getTDXToken();

    // 建立 OData filter：ParkingID eq 'A' or ParkingID eq 'B'
    const filterQuery = parkingIds.map((id) => `ParkingID eq '${id}'`).join(' or ');
    const url = `https://tdx.transportdata.tw/api/basic/v1/Parking/OffStreet/ParkingAvailability/City/Kaohsiung?$filter=${encodeURIComponent(
      filterQuery
    )}&$format=JSON`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store', // 確保每次都不走快取
    });

    if (!res.ok) {
      return NextResponse.json({ availabilities: {} });
    }

    const data = await res.json();
    const list = data.ParkingAvailabilities || (Array.isArray(data) ? data : []);

    const availabilitiesMap: Record<string, number | null> = {};
    for (const item of list) {
      const id = item.ParkingID || item.CarParkID;
      if (id) {
        availabilitiesMap[id] = item.AvailableSpaces ?? null;
      }
    }

    return NextResponse.json({
      availabilities: availabilitiesMap,
      updated_at: new Date().toLocaleTimeString('zh-TW', { hour12: false }),
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message, availabilities: {} }, { status: 500 });
  }
}