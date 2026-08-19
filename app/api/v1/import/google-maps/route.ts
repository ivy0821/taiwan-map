// app/api/v1/import/google-maps/route.ts
import { NextResponse } from 'next/server';
import axios from 'axios';
import pool from '@/lib/db'; // 確保路徑正確

interface ParsedPOI {
  poi_name: string;
  lat: number;
  lng: number;
  matched: boolean;
}

export async function POST(request: Request) {
  try {
    const { raw_input } = await request.json();

    if (!raw_input) {
      return NextResponse.json({ error: "缺少 raw_input 參數" }, { status: 400 });
    }

    const results: ParsedPOI[] = [];

    // 情境 A：輸入為 Google Maps 網址
    if (raw_input.includes('maps.app.goo.gl') || raw_input.includes('google.com/maps')) {
      const coords = await resolveGoogleMapsUrl(raw_input);
      if (coords) {
        results.push({
          poi_name: coords.name,
          lat: coords.lat,
          lng: coords.lng,
          matched: true
        });
      }
    } 
    // 情境 B：輸入為文字景點名稱
    else {
      const geo = await geocodePlaceName(raw_input);
      if (geo) {
        results.push(geo);
      }
    }

    // 將解析結果回傳給前端，前端確認後再進入 AI 規劃階段
    return NextResponse.json({ parsed_pois: results });

  } catch (error) {
    console.error("解析 API 發生錯誤:", error);
    return NextResponse.json({ error: "伺服器內部錯誤" }, { status: 500 });
  }
}

// 解析重定向與 URL 經緯度
async function resolveGoogleMapsUrl(url: string) {
  try {
    // 取得 Google Maps 短網址重定向後的完整網址
    const response = await axios.get(url);
    const finalUrl = response.request.res.responseUrl || url;

    // 用正則表達式尋找網址中的 @經度,緯度
    const match = finalUrl.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (match) {
      return {
        lat: parseFloat(match[1]),
        lng: parseFloat(match[2]),
        name: "Google Maps 匯入地點" // 實務上可透過 Google Places API 取得真實名稱
      };
    }
  } catch (error) {
    console.error("解析 Google Maps 網址失敗:", error);
  }
  return null;
}

// 透過 OpenStreetMap 取得經緯度 (免費，無需 API Key)
async function geocodePlaceName(placeName: string): Promise<ParsedPOI | null> {
  try {
    const res = await axios.get(`https://nominatim.openstreetmap.org/search`, {
      params: { q: placeName, format: 'json', limit: 1 },
      headers: { 'User-Agent': 'TripParkingApp/1.0' } // OSM 規定必須提供 User-Agent
    });
    
    if (res.data && res.data.length > 0) {
      return {
        poi_name: placeName,
        lat: parseFloat(res.data[0].lat),
        lng: parseFloat(res.data[0].lon),
        matched: true
      };
    }
  } catch (err) {
    console.error(`Geocoding 失敗: ${placeName}`, err);
  }
  return null;
}