// scripts/import-kh-parking.mjs
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

const TABLE_NAME = 'parking_lots_cache';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function getTDXToken() {
  const params = new URLSearchParams();
  params.append('grant_type', 'client_credentials');
  params.append('client_id', process.env.TDX_CLIENT_ID);
  params.append('client_secret', process.env.TDX_CLIENT_SECRET);

  const res = await fetch('https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });

  if (!res.ok) throw new Error('無法取得 TDX Token');
  const data = await res.json();
  return data.access_token;
}

async function fetchKaohsiungCarParks(token) {
  const url = 'https://tdx.transportdata.tw/api/basic/v1/Parking/OffStreet/CarPark/City/Kaohsiung?%24format=JSON';
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });

  if (!res.ok) throw new Error(`靜態 API 失敗: ${res.status}`);
  const data = await res.json();
  return data.CarParks || (Array.isArray(data) ? data : []);
}

async function fetchKaohsiungLiveAvailability(token) {
  const url = 'https://tdx.transportdata.tw/api/basic/v1/Parking/OffStreet/ParkingAvailability/City/Kaohsiung?%24format=JSON';
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.ParkingAvailabilities || (Array.isArray(data) ? data : []);
  } catch {
    return [];
  }
}

// 解析 TDX 的真實費率字串
function extractFareDescription(cp) {
  if (cp.FareDescription) return cp.FareDescription;
  if (cp.Description && (cp.Description.includes('元') || cp.Description.includes('計費') || cp.Description.includes('收費'))) {
    return cp.Description;
  }
  if (cp.Fares && Array.isArray(cp.Fares) && cp.Fares.length > 0) {
    const fareStrs = cp.Fares.map(f => {
      const desc = f.FareDescription || '';
      const price = f.Price ? `${f.Price}元` : '';
      return `${desc} ${price}`.trim();
    }).filter(Boolean);
    if (fareStrs.length > 0) return fareStrs.join('；');
  }
  return null;
}

// 解析 TDX 的真實每小時費率
function extractHourlyRate(cp) {
  if (cp.Fares && Array.isArray(cp.Fares)) {
    const hourly = cp.Fares.find(f => f.FareType === 1 || f.FareDescription?.includes('小時'));
    if (hourly?.Price) return `${hourly.Price} 元/小時`;
  }
  const fareDesc = extractFareDescription(cp);
  if (fareDesc) {
    const match = fareDesc.match(/(\d+)\s*元\s*(\/|每|\/半)?\s*(小時|hr|30分)?/i);
    if (match) return match[0];
  }
  return null;
}

// 解析 TDX 的服務時段
function extractServiceTime(cp) {
  if (cp.ServiceTime) return cp.ServiceTime;
  if (cp.ServiceTimeDescription) return cp.ServiceTimeDescription;
  if (cp.OpenTime) return cp.OpenTime;
  return null;
}

async function run() {
  const client = await pool.connect();
  try {
    console.log('1. 取得 TDX Token...');
    const token = await getTDXToken();

    console.log('2. 下載高雄市停車場真實靜態與費率資料...');
    const carParks = await fetchKaohsiungCarParks(token);
    console.log(`取得 ${carParks.length} 筆停車場資料`);

    console.log('3. 下載即時車位...');
    const liveList = await fetchKaohsiungLiveAvailability(token);

    const liveMap = new Map();
    for (const item of liveList) {
      const id = item.ParkingID || item.CarParkID || item.id;
      if (id) {
        liveMap.set(id, item.AvailableSpaces ?? null);
      }
    }

    let count = 0;

    for (const cp of carParks) {
      const id = cp.CarParkID || cp.ParkingID || cp.id;
      const name = cp.CarParkName?.Zh_tw || cp.CarParkName || '停車場';
      const totalSpaces = cp.TotalSubTotalParkingLot || cp.TotalSpaces || 0;

      const lat = cp.CarParkPosition?.PositionLat || cp.lat;
      const lng = cp.CarParkPosition?.PositionLon || cp.lng;

      if (!id || !lat || !lng || isNaN(Number(lat)) || isNaN(Number(lng))) continue;

      const availableSpaces = liveMap.get(id) ?? null;
      const hasDynamicData = availableSpaces !== null;

      // 取得 TDX 真實欄位
      const fareDesc = extractFareDescription(cp);
      const hourlyRate = extractHourlyRate(cp);
      const serviceTime = extractServiceTime(cp);

      const query = `
        INSERT INTO ${TABLE_NAME} (
          parking_id, 
          name, 
          location, 
          total_spaces, 
          available_spaces, 
          hourly_rate,
          fare_description,
          has_dynamic_data, 
          last_updated_at, 
          sync_status
        )
        VALUES (
          $1, 
          $2, 
          ST_SetSRID(ST_MakePoint($3, $4), 4326), 
          $5, 
          $6, 
          $7, 
          $8,
          $9, 
          NOW(), 
          'synced'
        )
        ON CONFLICT (parking_id) DO UPDATE 
        SET name = EXCLUDED.name,
            location = EXCLUDED.location,
            total_spaces = EXCLUDED.total_spaces,
            available_spaces = EXCLUDED.available_spaces,
            hourly_rate = EXCLUDED.hourly_rate,
            fare_description = EXCLUDED.fare_description,
            has_dynamic_data = EXCLUDED.has_dynamic_data,
            last_updated_at = NOW(),
            sync_status = 'synced';
      `;

      await client.query(query, [
        id,
        name,
        Number(lng),
        Number(lat),
        totalSpaces,
        availableSpaces,
        hourlyRate || serviceTime,
        fareDesc,
        hasDynamicData
      ]);

      count++;
    }

    console.log(`✅ 成功匯入 ${count} 筆真實資料（含費率與時段）至 PostGIS！`);
  } catch (err) {
    console.error('❌ 匯入失敗:', err);
  } finally {
    client.release();
    await pool.end();
  }
}

run();