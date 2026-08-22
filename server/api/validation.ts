// server/api/validation.ts
//
// 5 個 endpoint 的 request 驗證，集中在這一個檔案。
// Route 只負責讀 body / params 後呼叫這裡的 parse function，
// Service 之後可以假設拿到的是已驗證資料。
//
// 設計原則：
//  1. 物件一律 .strict()：多送欄位會回 400，讓 caller 拼錯欄位名時立刻發現。
//     （已確認前端兩個呼叫點只送約定欄位，不會被這條規則打到。）
//  2. 座標一律 strict number，不接受 "22.6" 這種字串。
//     （已確認 app/page.tsx 送的是 number。）
//  3. 這一層只做輸入型別與資源上限，不做安全性語意 ——
//     Google Maps 網址的 SSRF 防護屬 geocoding integration、
//     OData 跳脫屬 TDX integration，兩者都不會因為有了 Zod 而移除。

import { z } from 'zod';
import { limits } from '@/server/config';

/**
 * 輸入驗證失敗。message 是「可以給 client 看」的訊息，
 * 詳細的 issue 只寫進 server log，不外流。
 */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

// ───────────────────────────────────────────────────────────── 共用的欄位規則

/** 緯度：有限數字且落在合法範圍 */
const latitude = z.number().finite().min(-90).max(90);
/** 經度：有限數字且落在合法範圍 */
const longitude = z.number().finite().min(-180).max(180);

const placeName = z.string().trim().min(1).max(limits.maxPlaceNameLength);

const parkingId = z.string().trim().min(1).max(limits.maxParkingIdLength);

// ─────────────────────────────────────────────────────────────────── schemas

const importGoogleMapsSchema = z.strictObject({
  raw_input: z.string().trim().min(1).max(limits.maxRawInputLength),
});

const parkingLiveSchema = z.strictObject({
  // 空陣列是合法輸入 —— 既有 endpoint 以此代表「沒有要查的停車場」並直接回空結果
  parkingIds: z.array(parkingId).max(limits.maxParkingIds),
});

const aiPlanWithParkingSchema = z.strictObject({
  places: z
    .array(z.strictObject({ name: placeName, lat: latitude, lng: longitude }))
    .min(1)
    .max(limits.maxPlaces),
});

const tripGenerateSchema = z.strictObject({
  // prompt 維持選擇性：省略時 gemini integration 本來就有預設偏好，
  // 目前這是合法且會成功的請求，不因為加了驗證而變成 400。
  // 但若有給，就必須是非空字串。
  prompt: z.string().trim().min(1).max(limits.maxPromptLength).optional(),
  poi_list: z
    .array(z.strictObject({ poi_name: placeName, lat: latitude, lng: longitude }))
    .min(1)
    .max(limits.maxPlaces),
});

// trips.trip_id 在資料庫中確認是 uuid 型別（31 筆資料全為 v4 UUID），
// 因此格式錯誤可以在進 Service 前就擋掉，不必等 PostgreSQL 報錯。
const tripIdSchema = z.uuid();

export type ImportGoogleMapsRequest = z.infer<typeof importGoogleMapsSchema>;
export type ParkingLiveRequest = z.infer<typeof parkingLiveSchema>;
export type AiPlanWithParkingRequest = z.infer<typeof aiPlanWithParkingSchema>;
export type TripGenerateRequest = z.infer<typeof tripGenerateSchema>;

// ──────────────────────────────────────────────────────────────── parse 工具

function parseWith<T>(schema: z.ZodType<T>, data: unknown, context: string, publicMessage: string): T {
  const result = schema.safeParse(data);
  if (result.success) return result.data;

  // 只有 server log 看得到細節；client 只拿到上面那句話
  console.warn(
    `[validation] ${context} 驗證失敗:`,
    result.error.issues.map((issue) => ({
      path: issue.path.join('.') || '(root)',
      code: issue.code,
    }))
  );
  throw new ValidationError(publicMessage);
}

/**
 * 讀取並解析 JSON body。
 * body 不是合法 JSON 時丟 ValidationError（400），而不是讓它變成 500。
 */
export async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ValidationError('請求內容不是合法的 JSON');
  }
}

// ─────────────────────────────────────────────────────── 各 endpoint 的入口
//
// publicMessage 沿用各 endpoint 原本的 400 訊息，維持相容性。

export function parseImportGoogleMapsRequest(data: unknown): ImportGoogleMapsRequest {
  return parseWith(importGoogleMapsSchema, data, 'import/google-maps', '缺少 raw_input 參數');
}

export function parseParkingLiveRequest(data: unknown): ParkingLiveRequest {
  return parseWith(parkingLiveSchema, data, 'parking/live', '停車場 ID 格式錯誤');
}

export function parseAiPlanWithParkingRequest(data: unknown): AiPlanWithParkingRequest {
  return parseWith(
    aiPlanWithParkingSchema,
    data,
    'trip/ai-plan-with-parking',
    '請提供儲存的景點清單'
  );
}

export function parseTripGenerateRequest(data: unknown): TripGenerateRequest {
  return parseWith(tripGenerateSchema, data, 'trip/generate', '請提供至少一個景點');
}

export function parseInsertParkingParams(tripId: unknown): string {
  return parseWith(tripIdSchema, tripId, 'trip/insert-parking params', '無效的行程 ID');
}
