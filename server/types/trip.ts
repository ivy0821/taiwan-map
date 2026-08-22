// server/types/trip.ts
//
// trips / trip_nodes 的資料型別。目前只放 repository 真正需要的。

import type { CandidateParking } from '@/server/types/parking';

/**
 * trip_nodes 的一列（含由 PostGIS 還原出來的經緯度）。
 *
 * 欄位名沿用資料庫的 snake_case —— 既有 route 會直接把這個物件展開進 response，
 * 這個 Stage 的原則是「搬 SQL，不改行為」，所以形狀刻意保持不變。
 *
 * `stay_duration_minutes` / `summary` 只有在查詢時明確要求
 * （`findTripNodes(tripId, { includePlanningFields: true })`）才會出現。
 * 預設不取，是為了完全重現目前 insert-parking 的行為（C2 尚未修正）。
 */
export interface TripNodeRow {
  node_id: string;
  poi_name: string;
  lat: number;
  lng: number;
  node_type: string;
  sequence_order: number;
  stay_duration_minutes?: number | null;
  summary?: string | null;
}

/**
 * 要寫入 trip_nodes 的一筆節點。
 *
 * `stayDurationMinutes` 與 `summary` 有三種語意，缺一不可：
 *   undefined → 完全不寫這個欄位，交給資料庫預設值
 *               （stay_duration_minutes 的 DEFAULT 是 60，不是 NULL）
 *   null      → 明確寫入 NULL（用來保存原本就是 NULL 的資料）
 *   有值      → 照寫
 * 「undefined 等於 NULL」的簡化會直接弄壞 C2 的欄位保存。
 */
export interface NewTripNode {
  tripId: string;
  sequenceOrder: number;
  nodeType: string;
  poiName: string;
  /** 緯度 */
  lat: number;
  /** 經度 */
  lng: number;
  stayDurationMinutes?: number | null;
  summary?: string | null;
}

// ─────────────────────────────────────────── service 層對外的 use case 結果

/**
 * 這個景點（POI）的來源。
 *
 * 目前 ai-plan-with-parking 的景點一律由呼叫端在 request 中提供，
 * 不是 Google Places / Nominatim / TDX 產生的 POI，因此只有 'user' 一種值。
 * 未來真的出現其他來源時再擴充，不預先放沒在用的列舉值。
 */
export type ScheduleSource = 'user';

/**
 * 景點的「來源可信度」（source confidence），值域 0~1。
 *
 * ⚠ 語意務必分清楚：
 *   這是「這個 POI 的來源有多可靠」，
 *   **不是**「Gemini 對這個行程推薦有多少信心」，
 *   也**不是** LLM calibrated confidence。
 *
 * source === 'user' → 1
 *   因為這個景點不是模型猜出來的，而是使用者明確提供的原始 POI，
 *   座標與名稱都原封不動沿用（Stage 3 已保證 AI 無法改寫座標），
 *   所以「來源」這件事本身是最高等級的可靠，沒有任何推測成分。
 */
export type ScheduleConfidence = number;

/** ai-plan-with-parking 的 schedule 一筆（欄位名即既有 API contract） */
export interface ScheduleEntry {
  spot_order: number;
  spot_name: string;
  lat: number;
  lng: number;
  suggested_stay_minutes: number;
  reason: string;
  candidate_parkings: CandidateParking[];

  // ── M9 新增欄位（additive，舊 client 可忽略）────────────────────────────
  /**
   * 從「最近的候選停車場」走到景點的分鐘數。
   * 與 candidate_parkings[0].distance_display 使用同一個計算來源。
   * 該景點 1.5km 內沒有停車場時為 null。
   */
  walk_minutes_to_spot: number | null;
  /** 這個景點（POI）的來源，見 ScheduleSource */
  source: ScheduleSource;
  /** 見 ScheduleConfidence */
  confidence: ScheduleConfidence;
}

export interface TripPlanWithParking {
  itinerary_flow: string;
  schedule: ScheduleEntry[];
}

/** trip/generate 回應中的節點 */
export interface GeneratedTripNode {
  sequence_order: number;
  node_type: 'DESTINATION';
  poi_name: string;
  stay_duration_minutes: number;
  lat: number;
  lng: number;
  summary: string;
}

export interface GeneratedTrip {
  trip_id: string;
  title: string;
  nodes: GeneratedTripNode[];
}

/**
 * insert-parking 回應中的節點。
 * 景點節點與停車場節點欄位不同（M4，本階段不處理），故以選擇性欄位表示聯集。
 */
export interface InsertParkingNode {
  poi_name: string;
  lat: number;
  lng: number;
  node_type: string;
  sequence_order: number;
  node_id?: string;
  trip_id?: string;
  total_spaces?: number | null;
  available_spaces?: number | null;
  distance_meters?: number;
}

export interface InsertParkingResult {
  trip_id: string;
  total_nodes: number;
  nodes: InsertParkingNode[];
}

/** 呼叫端傳入的景點（已通過 route 層驗證） */
export interface PlaceInput {
  name: string;
  lat: number;
  lng: number;
}
