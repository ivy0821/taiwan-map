// server/services/poi.service.ts
//
// POI 匯入的 use case：判斷輸入是網址還是地名，
// 交給對應的 geocoding 實作，再整理成前端要的 ParsedPOI。
//
// 這一層只做編排，實際的 HTTP 呼叫、網址安全驗證與轉址處理都在
// server/integrations/geocoding.ts。

import {
  UnsafeUrlError,
  geocodePlaceName,
  looksLikeUrl,
  resolveGoogleMapsUrl,
} from '@/server/integrations/geocoding';
import { ValidationError } from '@/server/api/validation';

export interface ParsedPOI {
  poi_name: string;
  lat: number;
  lng: number;
  matched: boolean;
}

export interface PoiServiceDeps {
  looksLikeUrl: typeof looksLikeUrl;
  resolveGoogleMapsUrl: typeof resolveGoogleMapsUrl;
  geocodePlaceName: typeof geocodePlaceName;
}

const defaultDeps: PoiServiceDeps = { looksLikeUrl, resolveGoogleMapsUrl, geocodePlaceName };

/**
 * 把使用者貼上的原始輸入解析成 POI 清單。
 *
 * 解析不到時回傳空陣列（既有行為：仍算成功，不是錯誤）。
 *
 * 但「輸入是一個我們不願意對它發請求的網址」屬於輸入問題而非伺服器問題，
 * 因此轉成 ValidationError，由 route 回 400 並附安全訊息。
 * 被拒絕的真正原因只留在 server log。
 *
 * 註：`matched` 目前永遠是 true（L2，既有行為，本階段不動）。
 */
export async function parseRawInput(
  rawInput: string,
  deps: PoiServiceDeps = defaultDeps
): Promise<ParsedPOI[]> {
  // 情境 A：輸入是一個網址 —— 只有通過 allowlist 的 Google Maps 網址會被請求
  if (deps.looksLikeUrl(rawInput)) {
    let coords;
    try {
      coords = await deps.resolveGoogleMapsUrl(rawInput);
    } catch (error) {
      if (error instanceof UnsafeUrlError) {
        console.warn(`[poi] 拒絕不安全的網址: ${error.message}`);
        throw new ValidationError('不支援的 Google Maps 網址');
      }
      throw error;
    }
    if (!coords) return [];
    return [{ poi_name: coords.name, lat: coords.lat, lng: coords.lng, matched: true }];
  }

  // 情境 B：輸入為文字景點名稱
  const geo = await deps.geocodePlaceName(rawInput);
  if (!geo) return [];
  return [{ poi_name: rawInput, lat: geo.lat, lng: geo.lng, matched: true }];
}
