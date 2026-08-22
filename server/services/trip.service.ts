// server/services/trip.service.ts
//
// 行程相關的三個 use case：
//   planTripWithParking  → POST /api/v1/trip/ai-plan-with-parking
//   generateTrip         → POST /api/v1/trip/generate
//   insertParkingNodes   → POST /api/v1/trip/{tripId}/insert-parking
//
// 這一層負責編排 Gemini、parking service、trip repository 與交易，
// 不 import next/server、不知道 HTTP status、不寫 SQL。

import { planTrip } from '@/server/integrations/gemini';
import { withTransaction } from '@/server/db/transaction';
import {
  createTrip,
  deleteTripNodes,
  findTripNodes,
  insertTripNodes,
} from '@/server/repositories/trip.repository';
import {
  findNearestParkingForPlace,
  getCandidateParkingsForPlaces,
  getLiveAvailabilityMap,
  walkingMinutesFor,
} from '@/server/services/parking.service';
import type {
  GeneratedTrip,
  GeneratedTripNode,
  InsertParkingNode,
  InsertParkingResult,
  PlaceInput,
  ScheduleConfidence,
  ScheduleSource,
  TripNodeRow,
  TripPlanWithParking,
} from '@/server/types/trip';

/** 相依項以參數注入，預設指向真實實作，讓 business logic 能離線測試 */
export interface TripServiceDeps {
  planTrip: typeof planTrip;
  withTransaction: typeof withTransaction;
  createTrip: typeof createTrip;
  findTripNodes: typeof findTripNodes;
  deleteTripNodes: typeof deleteTripNodes;
  insertTripNodes: typeof insertTripNodes;
  getCandidateParkingsForPlaces: typeof getCandidateParkingsForPlaces;
  findNearestParkingForPlace: typeof findNearestParkingForPlace;
  getLiveAvailabilityMap: typeof getLiveAvailabilityMap;
}

const defaultDeps: TripServiceDeps = {
  planTrip,
  withTransaction,
  createTrip,
  findTripNodes,
  deleteTripNodes,
  insertTripNodes,
  getCandidateParkingsForPlaces,
  findNearestParkingForPlace,
  getLiveAvailabilityMap,
};

// ───────────────────────────────── A. AI 行程規劃 + 停車候選（唯讀）

/**
 * 由 Gemini 排定景點順序，再為每個景點附上候選停車場。
 *
 * 座標永遠來自傳入的 places（gemini integration 只回 index），
 * 候選停車場的即時車位由 parking service 一次批次取得。
 */
export async function planTripWithParking(
  places: readonly PlaceInput[],
  deps: TripServiceDeps = defaultDeps
): Promise<TripPlanWithParking> {
  const plan = await deps.planTrip(places);

  const orderedPlaces: PlaceInput[] = plan.stops.map((stop) => ({
    name: stop.poi.name,
    lat: stop.poi.lat,
    lng: stop.poi.lng,
  }));

  const candidatesPerPlace = await deps.getCandidateParkingsForPlaces(orderedPlaces);

  return {
    itinerary_flow: plan.stops
      .map((stop) => `${stop.sequenceOrder}. ${stop.poi.name}`)
      .join(' ➔ '),
    schedule: plan.stops.map((stop, index) => {
      const candidates = candidatesPerPlace[index] ?? [];
      // 候選停車場依距離遞增排序，第一個就是最近的那個
      const nearest = candidates[0];

      return {
        spot_order: stop.sequenceOrder,
        spot_name: stop.poi.name,
        lat: stop.poi.lat,
        lng: stop.poi.lng,
        suggested_stay_minutes: stop.stayDurationMinutes,
        reason: stop.summary,
        candidate_parkings: candidates,

        // M9：由最近停車場的距離換算，與 distance_display 共用同一個計算函式
        walk_minutes_to_spot: nearest ? walkingMinutesFor(nearest.distance_meters) : null,

        // 這個景點是呼叫端在 request 裡直接提供的原始 POI
        source: 'user' as ScheduleSource,
        // 「來源」可信度 = 1：POI 由使用者明確提供，不是模型猜出來的。
        // 這【不是】AI 對推薦內容的信心分數。
        confidence: 1 as ScheduleConfidence,
      };
    }),
  };
}

// ───────────────────────────────────────────── B. 產生行程並寫入資料庫

/**
 * 由 Gemini 規劃行程，並在單一交易內建立 trip 與所有 trip_nodes。
 *
 * Gemini 呼叫刻意放在交易之外，避免等待模型回應時佔住連線池。
 */
export async function generateTrip(
  input: { preference?: string; pois: readonly PlaceInput[] },
  deps: TripServiceDeps = defaultDeps
): Promise<GeneratedTrip> {
  const plan = await deps.planTrip(input.pois, {
    preference: input.preference,
    fallbackTitle: '高雄一日遊',
  });

  const nodes: GeneratedTripNode[] = plan.stops.map((stop) => ({
    sequence_order: stop.sequenceOrder,
    node_type: 'DESTINATION',
    poi_name: stop.poi.name,
    stay_duration_minutes: stop.stayDurationMinutes,
    lat: stop.poi.lat,
    lng: stop.poi.lng,
    summary: stop.summary,
  }));

  const tripId = await deps.withTransaction(async (client) => {
    const newTripId = await deps.createTrip(client, plan.title);
    await deps.insertTripNodes(
      client,
      nodes.map((node) => ({
        tripId: newTripId,
        sequenceOrder: node.sequence_order,
        nodeType: node.node_type,
        poiName: node.poi_name,
        lat: node.lat,
        lng: node.lng,
        stayDurationMinutes: node.stay_duration_minutes,
        summary: node.summary,
      }))
    );
    return newTripId;
  });

  return { trip_id: tripId, title: plan.title, nodes };
}

// ─────────────────────────────────────── C. 為既有行程插入停車場節點

/** 要寫回資料庫、但【不】出現在 response 中的欄位（C2 的保存對象） */
interface PreservedNodeFields {
  stayDurationMinutes?: number | null;
  summary?: string | null;
}

/** response 節點 + 它對應要寫回的欄位 */
interface PlannedNode {
  response: InsertParkingNode;
  preserved: PreservedNodeFields;
}

function toResponseNode(node: TripNodeRow): InsertParkingNode {
  return {
    node_id: node.node_id,
    poi_name: node.poi_name,
    lat: node.lat,
    lng: node.lng,
    node_type: node.node_type,
    sequence_order: node.sequence_order,
  };
}

/**
 * 為既有行程的每個景點前面插入一個最近的停車場節點，並重寫 trip_nodes。
 *
 * 找不到任何節點時回傳 null，由 route 決定要回什麼 HTTP status。
 *
 * ── C1（idempotent）──────────────────────────────────────────────
 * PARKING 節點是「由 DESTINATION 推導出來的衍生資料」，不是使用者資料。
 * 因此每次執行都先用 node_type 過濾掉既有的 PARKING 節點，只以真正的景點
 * 為基礎重新推導一次完整序列。既有 PARKING 節點不會被誤當成景點再配一次
 * 停車場，也不會被原樣保留而與新推導的節點並存 —— 這正是原本會不斷增生的原因。
 *
 * ── C2（欄位保存）────────────────────────────────────────────────
 * 讀取時一併取回 stay_duration_minutes / summary，寫回時原值奉還：
 * 原本有值就寫回該值，原本是 NULL 就明確寫回 NULL。
 * 新產生的 PARKING 節點則兩個欄位都不傳，維持既有產品行為（走 DB 預設）。
 */
export async function insertParkingNodes(
  tripId: string,
  deps: TripServiceDeps = defaultDeps
): Promise<InsertParkingResult | null> {
  // C2：連同要保存的欄位一起讀出來
  const currentNodes = await deps.findTripNodes(tripId, { includePlanningFields: true });
  if (currentNodes.length === 0) return null;

  // C1：只以真正的景點為基礎重建；既有 PARKING 節點一律捨棄後重新推導
  const destinations = currentNodes.filter((node) => node.node_type !== 'PARKING');

  // 防禦：整趟行程都沒有景點節點時不做任何寫入，避免把資料刪光
  if (destinations.length === 0) {
    return {
      trip_id: tripId,
      total_nodes: currentNodes.length,
      nodes: currentNodes.map(toResponseNode),
    };
  }

  const usedParkingIds = new Set<string>();
  const plannedNodes: PlannedNode[] = [];
  // 記錄哪些節點稍後要套用即時車位，避免在迴圈內逐筆打 TDX
  const parkingNodeRefs: { index: number; parkingId: string }[] = [];
  let currentSequence = 1;

  for (const node of destinations) {
    const parking = await deps.findNearestParkingForPlace({
      lat: Number(node.lat),
      lng: Number(node.lng),
      // 同一趟行程避免重複指派同一個停車場（沿用既有規則）
      excludeIds: Array.from(usedParkingIds),
    });

    if (parking) {
      usedParkingIds.add(parking.parking_id);
      parkingNodeRefs.push({ index: plannedNodes.length, parkingId: parking.parking_id });

      // 插入大寫 'PARKING' 節點（先放快取車位，稍後若有即時資料再覆蓋）
      plannedNodes.push({
        response: {
          trip_id: tripId,
          poi_name: parking.name,
          lat: parking.lat,
          lng: parking.lng,
          node_type: 'PARKING',
          sequence_order: currentSequence++,
          total_spaces: parking.total_spaces,
          available_spaces: parking.available_spaces ?? null,
          distance_meters: Math.round(parking.distance_meters),
        },
        // 停車場節點不帶這兩個欄位 → 走資料庫預設，維持既有產品行為
        preserved: {},
      });
    }

    // 插入原景點節點 (強制標記為大寫 'DESTINATION')
    plannedNodes.push({
      response: {
        node_id: node.node_id,
        poi_name: node.poi_name,
        lat: node.lat,
        lng: node.lng,
        node_type: 'DESTINATION',
        sequence_order: currentSequence++,
      },
      // C2：原值奉還（有值→該值、NULL→NULL）
      preserved: {
        stayDurationMinutes: node.stay_duration_minutes,
        summary: node.summary,
      },
    });
  }

  // 整趟行程的停車場即時車位一次查完（TDX 每分鐘只有 5 次額度）
  // —— 刻意在交易之外完成，不讓外部 HTTP 佔住資料庫連線
  if (parkingNodeRefs.length > 0) {
    try {
      const live = await deps.getLiveAvailabilityMap(
        parkingNodeRefs.map((ref) => ref.parkingId)
      );
      for (const ref of parkingNodeRefs) {
        const availableSpaces = live.get(ref.parkingId);
        if (availableSpaces !== undefined && availableSpaces !== null) {
          plannedNodes[ref.index].response.available_spaces = availableSpaces;
        }
      }
    } catch (error) {
      console.warn('TDX 即時車位取得失敗，沿用快取值:', error);
    }
  }

  // 整批替換：DELETE 與所有 INSERT 在同一個交易內，中途失敗就整批 ROLLBACK
  const newNodeIds = await deps.withTransaction(async (client) => {
    await deps.deleteTripNodes(client, tripId);
    return deps.insertTripNodes(
      client,
      plannedNodes.map((planned) => ({
        tripId,
        sequenceOrder: planned.response.sequence_order,
        nodeType: planned.response.node_type,
        poiName: planned.response.poi_name,
        lat: planned.response.lat,
        lng: planned.response.lng,
        ...planned.preserved,
      }))
    );
  });

  // 讀取階段的 node_id 已隨 DELETE 消失，改用實際寫入後的新 id。
  // 只覆寫原本就有 node_id 的節點，不改變 response 的 key 組成（M4 不在本次範圍）。
  plannedNodes.forEach((planned, index) => {
    if (planned.response.node_id !== undefined) {
      planned.response.node_id = newNodeIds[index];
    }
  });

  const nodes = plannedNodes.map((planned) => planned.response);
  return { trip_id: tripId, total_nodes: nodes.length, nodes };
}
