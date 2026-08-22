// tests/unit/services.test.ts
//
// Service 層純 business logic 的測試。
// 相依項全部用參數注入的假物件取代，完全離線 —— 不碰資料庫、TDX、Gemini。
//
//   npm test

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key-not-used-offline';

import {
  getCandidateParkingsForPlaces,
  getLiveAvailability,
  toCandidateParking,
  type ParkingServiceDeps,
} from '@/server/services/parking.service';
import {
  generateTrip,
  insertParkingNodes,
  planTripWithParking,
  type TripServiceDeps,
} from '@/server/services/trip.service';
import { parseRawInput, type PoiServiceDeps } from '@/server/services/poi.service';
import { UnsafeUrlError } from '@/server/integrations/geocoding';
import { ValidationError } from '@/server/api/validation';
import type { NearbyParking } from '@/server/types/parking';

// ───────────────────────────────────────────────────────────────── fixtures

const parkingRow = (over: Partial<NearbyParking> = {}): NearbyParking => ({
  parking_id: 'KHA00001',
  name: '測試停車場',
  total_spaces: 100,
  available_spaces: 40,
  hourly_rate: '30 元/小時',
  fare_description: '平日計費',
  lat: 22.62,
  lng: 120.28,
  distance_meters: 240,
  ...over,
});

const PLACES = [
  { name: '駁二藝術特區', lat: 22.6201, lng: 120.2818 },
  { name: '高雄流行音樂中心', lat: 22.6133, lng: 120.2925 },
];

/** 假的 tdx integration 回傳值 */
const tdxResult = (map: Record<string, number | null>, upstreamOk = true) => ({
  availabilities: new Map(
    Object.entries(map).map(([id, availableSpaces]) => [
      id,
      { carParkId: id, availableSpaces, totalSpaces: null, serviceStatus: null, dataCollectTime: null },
    ])
  ),
  upstreamOk,
});

// ═════════════════════════════════════════════════════ parking.service

describe('parking.service：DB 快取與即時車位合併', () => {
  test('即時車位有值時覆蓋快取值', () => {
    const c = toCandidateParking(parkingRow({ available_spaces: 40 }), 7);
    assert.equal(c.available_spaces, 7);
  });

  test('即時車位為 null 時 fallback 回快取值', () => {
    const c = toCandidateParking(parkingRow({ available_spaces: 40 }), null);
    assert.equal(c.available_spaces, 40);
  });

  test('完全沒有即時資料（undefined）時 fallback 回快取值', () => {
    const c = toCandidateParking(parkingRow({ available_spaces: 40 }), undefined);
    assert.equal(c.available_spaces, 40);
  });

  test('即時車位為 0 會被採用，不會被誤判成沒有資料', () => {
    const c = toCandidateParking(parkingRow({ available_spaces: 40 }), 0);
    assert.equal(c.available_spaces, 0);
  });

  test('步行時間與顯示字串（240m → 0.24 公里 / 3 分鐘）', () => {
    const c = toCandidateParking(parkingRow({ distance_meters: 240 }), null);
    assert.equal(c.distance_display, '0.24 公里 (步行約 3 分鐘)');
    assert.equal(c.distance_meters, 240);
  });

  test('距離四捨五入，步行分鐘數無條件進位', () => {
    const c = toCandidateParking(parkingRow({ distance_meters: 81.4 }), null);
    assert.equal(c.distance_meters, 81);
    assert.equal(c.distance_display, '0.08 公里 (步行約 2 分鐘)'); // 81.4/80 → 2
  });

  test('total_spaces 為 0 時轉成 null（既有行為）', () => {
    assert.equal(toCandidateParking(parkingRow({ total_spaces: 0 }), null).total_spaces, null);
  });

  test('hourly_rate / fare_description 的 fallback 串接', () => {
    const noRate = toCandidateParking(
      parkingRow({ hourly_rate: null, fare_description: '假日計費' }),
      null
    );
    assert.equal(noRate.hourly_rate, '假日計費');

    const nothing = toCandidateParking(
      parkingRow({ hourly_rate: null, fare_description: null }),
      null
    );
    assert.equal(nothing.hourly_rate, '依現場公告收費');
    assert.equal(nothing.fare_description, '以現場公告營運時段為準');
  });
});

describe('parking.service：批次查詢不做 N+1', () => {
  test('多個景點的候選停車場只呼叫一次 TDX', async () => {
    let tdxCalls = 0;
    let tdxIdsSeen: string[] = [];

    const deps: ParkingServiceDeps = {
      findNearbyParking: async ({ lat }) =>
        lat === PLACES[0].lat
          ? [parkingRow({ parking_id: 'A1' }), parkingRow({ parking_id: 'A2' })]
          : [parkingRow({ parking_id: 'B1' })],
      getParkingAvailability: async (ids) => {
        tdxCalls++;
        tdxIdsSeen = ids as string[];
        return tdxResult({ A1: 5, A2: 6, B1: 7 });
      },
    };

    const result = await getCandidateParkingsForPlaces(PLACES, deps);

    assert.equal(tdxCalls, 1, `TDX 應該只被呼叫 1 次，實際 ${tdxCalls} 次`);
    assert.deepEqual(tdxIdsSeen, ['A1', 'A2', 'B1']);
    assert.equal(result.length, 2);
    assert.deepEqual(result[0].map((c) => c.parking_id), ['A1', 'A2']);
    assert.deepEqual(result[1].map((c) => c.parking_id), ['B1']);
    // 即時車位正確對應回各自的停車場
    assert.equal(result[0][0].available_spaces, 5);
    assert.equal(result[1][0].available_spaces, 7);
  });

  test('沒有任何候選停車場時完全不呼叫 TDX', async () => {
    let tdxCalls = 0;
    const deps: ParkingServiceDeps = {
      findNearbyParking: async () => [],
      getParkingAvailability: async () => {
        tdxCalls++;
        return tdxResult({});
      },
    };
    const result = await getCandidateParkingsForPlaces(PLACES, deps);
    assert.equal(tdxCalls, 0);
    assert.deepEqual(result, [[], []]);
  });

  test('getLiveAvailability 會把 upstreamOk 透傳出去', async () => {
    const deps: ParkingServiceDeps = {
      findNearbyParking: async () => [],
      getParkingAvailability: async () => tdxResult({ A1: 3 }, false),
    };
    const r = await getLiveAvailability(['A1'], deps);
    assert.equal(r.upstreamOk, false);
    assert.deepEqual(r.availabilities, { A1: 3 });
  });
});

// ═════════════════════════════════════════════════════════ trip.service

/** 產生一組可用的假相依項，測試只覆寫需要的部分 */
function tripDeps(over: Partial<TripServiceDeps> = {}): TripServiceDeps {
  return {
    planTrip: async (pois) => ({
      title: '假行程',
      stops: pois.map((poi, i) => ({
        sequenceOrder: i + 1,
        poi,
        stayDurationMinutes: 60 + i,
        summary: `summary-${i}`,
      })),
    }),
    withTransaction: (async (fn: (c: unknown) => Promise<unknown>) => fn({} as never)) as never,
    createTrip: async () => 'trip-uuid-1',
    findTripNodes: async () => [],
    deleteTripNodes: async () => {},
    insertTripNodes: async (_client, nodes) => nodes.map((_, i) => `new-${i}`),
    getCandidateParkingsForPlaces: async (places) => places.map(() => []),
    findNearestParkingForPlace: async () => null,
    getLiveAvailabilityMap: async () => new Map(),
    ...over,
  } as TripServiceDeps;
}

describe('trip.service：planTripWithParking', () => {
  test('AI 排序結果對應回原始 POI，且 schedule 依序編號', async () => {
    const deps = tripDeps({
      // 模型把順序反過來
      planTrip: async (pois) => ({
        title: 't',
        stops: [...pois].reverse().map((poi, i) => ({
          sequenceOrder: i + 1,
          poi,
          stayDurationMinutes: 90,
          summary: `why-${poi.name}`,
        })),
      }),
    });

    const result = await planTripWithParking(PLACES, deps);

    assert.deepEqual(
      result.schedule.map((s) => s.spot_name),
      ['高雄流行音樂中心', '駁二藝術特區']
    );
    assert.deepEqual(result.schedule.map((s) => s.spot_order), [1, 2]);
    assert.equal(result.itinerary_flow, '1. 高雄流行音樂中心 ➔ 2. 駁二藝術特區');
    // 座標必須是原始 POI 的座標
    assert.equal(result.schedule[0].lat, PLACES[1].lat);
    assert.equal(result.schedule[1].lng, PLACES[0].lng);
    assert.equal(result.schedule[0].reason, 'why-高雄流行音樂中心');
    assert.equal(result.schedule[0].suggested_stay_minutes, 90);
  });

  test('候選停車場依 schedule 順序對齊', async () => {
    let placesPassedToParking: readonly { name: string }[] = [];
    const deps = tripDeps({
      getCandidateParkingsForPlaces: async (places) => {
        placesPassedToParking = places;
        return places.map((p) => [
          toCandidateParking(parkingRow({ parking_id: `P-${p.name}` }), null),
        ]);
      },
    });

    const result = await planTripWithParking(PLACES, deps);
    // parking service 收到的是「排序後」的景點
    assert.deepEqual(placesPassedToParking.map((p) => p.name), PLACES.map((p) => p.name));
    assert.equal(result.schedule[0].candidate_parkings[0].parking_id, `P-${PLACES[0].name}`);
    assert.equal(result.schedule[1].candidate_parkings[0].parking_id, `P-${PLACES[1].name}`);
  });
});

describe('trip.service：generateTrip', () => {
  test('在單一交易內建立 trip 與節點，並回傳既有 contract', async () => {
    const calls: string[] = [];
    let insertedCount = 0;

    const deps = tripDeps({
      withTransaction: (async (fn: (c: unknown) => Promise<unknown>) => {
        calls.push('begin');
        const r = await fn({} as never);
        calls.push('commit');
        return r;
      }) as never,
      createTrip: async () => {
        calls.push('createTrip');
        return 'trip-uuid-1';
      },
      insertTripNodes: async (_client, nodes) => {
        calls.push('insertTripNodes');
        insertedCount = nodes.length;
        // generate 這條路徑一向帶入停留時間與摘要
        assert.ok(nodes.every((n) => n.stayDurationMinutes !== undefined));
        assert.ok(nodes.every((n) => n.summary !== undefined));
        return nodes.map((_, i) => `gen-${i}`);
      },
    });

    const trip = await generateTrip({ preference: '輕鬆', pois: PLACES }, deps);

    assert.deepEqual(calls, ['begin', 'createTrip', 'insertTripNodes', 'commit']);
    assert.equal(insertedCount, 2);
    assert.equal(trip.trip_id, 'trip-uuid-1');
    assert.equal(trip.title, '假行程');
    assert.deepEqual(trip.nodes.map((n) => n.sequence_order), [1, 2]);
    assert.ok(trip.nodes.every((n) => n.node_type === 'DESTINATION'));
    // 座標來自原始輸入
    assert.equal(trip.nodes[0].lat, PLACES[0].lat);
  });

  test('Gemini 失敗時不會開啟交易', async () => {
    let transactionStarted = false;
    const deps = tripDeps({
      planTrip: async () => {
        throw new Error('gemini-down');
      },
      withTransaction: (async () => {
        transactionStarted = true;
      }) as never,
    });

    await assert.rejects(() => generateTrip({ pois: PLACES }, deps), /gemini-down/);
    assert.equal(transactionStarted, false);
  });
});

// ── 一個最小的記憶體假資料庫，用來忠實模擬 trip_nodes 的寫入語意 ────────
// 重點：stay_duration_minutes 省略時走 DEFAULT 60、明確給 null 時存 NULL，
// 這正是 C2 依賴的區分。withTransaction 會在 callback 丟例外時還原快照。

interface FakeRow {
  node_id: string;
  poi_name: string;
  lat: number;
  lng: number;
  node_type: string;
  sequence_order: number;
  stay_duration_minutes: number | null;
  summary: string | null;
}

function makeFakeTripDb(initial: Omit<FakeRow, 'node_id'>[]) {
  let origin = 0;
  let rows: FakeRow[] = initial.map((r) => ({ ...r, node_id: `orig-${origin++}` }));
  let nextId = 0;

  const fakeDeps = (over: Partial<TripServiceDeps> = {}): TripServiceDeps =>
    tripDeps({
      findTripNodes: async (_tripId, options) =>
        rows
          .slice()
          .sort((a, b) => a.sequence_order - b.sequence_order)
          .map((r) => {
            const base = {
              node_id: r.node_id,
              poi_name: r.poi_name,
              lat: r.lat,
              lng: r.lng,
              node_type: r.node_type,
              sequence_order: r.sequence_order,
            };
            return options?.includePlanningFields
              ? { ...base, stay_duration_minutes: r.stay_duration_minutes, summary: r.summary }
              : base;
          }),
      withTransaction: (async (fn: (c: unknown) => Promise<unknown>) => {
        const snapshot = rows.map((r) => ({ ...r }));
        try {
          return await fn({} as never);
        } catch (error) {
          rows = snapshot; // ROLLBACK
          throw error;
        }
      }) as never,
      deleteTripNodes: async () => {
        rows = [];
      },
      insertTripNodes: async (_client, nodes) =>
        nodes.map((n) => {
          const id = `new-${nextId++}`;
          rows.push({
            node_id: id,
            poi_name: n.poiName,
            lat: n.lat,
            lng: n.lng,
            node_type: n.nodeType,
            sequence_order: n.sequenceOrder,
            // 模擬真實 schema：省略 → DEFAULT 60；明確 null → NULL
            stay_duration_minutes:
              n.stayDurationMinutes === undefined ? 60 : n.stayDurationMinutes,
            summary: n.summary === undefined ? null : n.summary,
          });
          return id;
        }),
      ...over,
    });

  return { rows: () => rows, deps: fakeDeps };
}

/** 可預期的停車場挑選：依 lat 決定偏好，並尊重 excludeIds */
const deterministicParking = async ({
  lat,
  excludeIds,
}: {
  lat: number;
  lng: number;
  excludeIds?: readonly string[];
}) => {
  const preferred = lat < 22.615 ? 'P1' : 'P2';
  const pool = ['P1', 'P2', 'P3'].filter((id) => !(excludeIds ?? []).includes(id));
  const chosen = pool.includes(preferred) ? preferred : pool[0];
  return chosen ? parkingRow({ parking_id: chosen, name: `停車場${chosen}` }) : null;
};

/** 只比較「結構」，不比較會隨即時車位變動的值 */
const structureOf = (r: { nodes: { sequence_order: number; node_type: string; poi_name: string }[] } | null) =>
  r!.nodes.map((n) => `${n.sequence_order}:${n.node_type}:${n.poi_name}`);

const D = (
  name: string,
  lat: number,
  seq: number,
  stay: number | null = 60,
  summary: string | null = null
): Omit<FakeRow, 'node_id'> => ({
  poi_name: name,
  lat,
  lng: 120.28,
  node_type: 'DESTINATION',
  sequence_order: seq,
  stay_duration_minutes: stay,
  summary,
});

describe('trip.service：insertParkingNodes', () => {
  test('找不到節點時回傳 null（由 route 決定 404）', async () => {
    const result = await insertParkingNodes('missing', tripDeps({ findTripNodes: async () => [] }));
    assert.equal(result, null);
  });

  test('每個景點前插入一個停車場節點，sequence 連續重編', async () => {
    const db = makeFakeTripDb([D('景點1', 22.61, 1), D('景點2', 22.62, 2)]);
    const result = await insertParkingNodes(
      't1',
      db.deps({ findNearestParkingForPlace: deterministicParking })
    );
    assert.deepEqual(
      result!.nodes.map((n) => n.node_type),
      ['PARKING', 'DESTINATION', 'PARKING', 'DESTINATION']
    );
    assert.deepEqual(result!.nodes.map((n) => n.sequence_order), [1, 2, 3, 4]);
    assert.equal(result!.total_nodes, 4);
  });

  test('找不到停車場時只保留景點節點', async () => {
    const db = makeFakeTripDb([D('景點1', 22.61, 1)]);
    const result = await insertParkingNodes(
      't1',
      db.deps({ findNearestParkingForPlace: async () => null })
    );
    assert.deepEqual(result!.nodes.map((n) => n.node_type), ['DESTINATION']);
  });

  test('同一趟行程不會重複指派同一個停車場（excludeIds 有傳下去）', async () => {
    const seen: string[][] = [];
    const db = makeFakeTripDb([D('景點1', 22.61, 1), D('景點2', 22.62, 2)]);
    await insertParkingNodes(
      't1',
      db.deps({
        findNearestParkingForPlace: async (params) => {
          seen.push([...(params.excludeIds ?? [])]);
          return deterministicParking(params);
        },
      })
    );
    assert.deepEqual(seen[0], []);
    assert.deepEqual(seen[1], ['P1']);
  });

  test('即時車位覆蓋快取值，且整趟只查一次 TDX', async () => {
    let liveCalls = 0;
    const db = makeFakeTripDb([D('景點1', 22.61, 1), D('景點2', 22.62, 2)]);
    const result = await insertParkingNodes(
      't1',
      db.deps({
        findNearestParkingForPlace: async (params) => {
          const row = await deterministicParking(params);
          return row ? { ...row, available_spaces: 99 } : null;
        },
        getLiveAvailabilityMap: async () => {
          liveCalls++;
          return new Map([['P1', 3]]);
        },
      })
    );
    assert.equal(liveCalls, 1);
    const parkings = result!.nodes.filter((n) => n.node_type === 'PARKING');
    assert.equal(parkings[0].available_spaces, 3);
    assert.equal(parkings[1].available_spaces, 99);
  });

  test('TDX 失敗不影響整體流程，沿用快取值', async () => {
    const db = makeFakeTripDb([D('景點1', 22.61, 1)]);
    const result = await insertParkingNodes(
      't1',
      db.deps({
        findNearestParkingForPlace: async () => parkingRow({ available_spaces: 42 }),
        getLiveAvailabilityMap: async () => {
          throw new Error('tdx-down');
        },
      })
    );
    assert.equal(result!.nodes.find((n) => n.node_type === 'PARKING')!.available_spaces, 42);
  });

  // ══════════════════════════════ C1 regression：idempotency ══════════════════

  test('C1：重複執行結果穩定，PARKING 節點不會增生', async () => {
    const db = makeFakeTripDb([D('景點1', 22.61, 1), D('景點2', 22.62, 2)]);
    const deps = db.deps({ findNearestParkingForPlace: deterministicParking });

    const first = await insertParkingNodes('t1', deps);
    const second = await insertParkingNodes('t1', deps);
    const third = await insertParkingNodes('t1', deps);

    // 結構完全一致
    assert.deepEqual(structureOf(first), structureOf(second));
    assert.deepEqual(structureOf(second), structureOf(third));

    // 節點總數不變
    assert.equal(first!.total_nodes, 4);
    assert.equal(second!.total_nodes, 4);
    assert.equal(third!.total_nodes, 4);

    // PARKING / DESTINATION 數量都不變
    const count = (r: typeof first, type: string) =>
      r!.nodes.filter((n) => n.node_type === type).length;
    for (const r of [first, second, third]) {
      assert.equal(count(r, 'PARKING'), 2);
      assert.equal(count(r, 'DESTINATION'), 2);
    }

    // 停車場指派身分一致
    assert.deepEqual(
      first!.nodes.filter((n) => n.node_type === 'PARKING').map((n) => n.poi_name),
      third!.nodes.filter((n) => n.node_type === 'PARKING').map((n) => n.poi_name)
    );

    // 資料庫實際內容也一樣穩定
    assert.equal(db.rows().length, 4);
    assert.deepEqual(
      db.rows().map((r) => r.node_type).sort(),
      ['DESTINATION', 'DESTINATION', 'PARKING', 'PARKING']
    );
  });

  test('C1：既有 PARKING 節點被重新推導，不會被當成景點再配一次停車場', async () => {
    // 直接以「已經有停車場」的行程當輸入
    const db = makeFakeTripDb([
      { ...D('停車場P1', 22.61, 1), node_type: 'PARKING' },
      D('景點1', 22.61, 2),
      { ...D('停車場P2', 22.62, 3), node_type: 'PARKING' },
      D('景點2', 22.62, 4),
    ]);
    const result = await insertParkingNodes(
      't1',
      db.deps({ findNearestParkingForPlace: deterministicParking })
    );
    // 仍然是 4 個節點，而不是 6 個
    assert.equal(result!.total_nodes, 4);
    assert.deepEqual(
      result!.nodes.map((n) => n.node_type),
      ['PARKING', 'DESTINATION', 'PARKING', 'DESTINATION']
    );
    assert.deepEqual(result!.nodes.map((n) => n.poi_name), [
      '停車場P1',
      '景點1',
      '停車場P2',
      '景點2',
    ]);
  });

  test('C1：只有 PARKING 節點的行程不做任何寫入（防禦性，不刪光資料）', async () => {
    const db = makeFakeTripDb([{ ...D('孤兒停車場', 22.61, 1), node_type: 'PARKING' }]);
    const before = db.rows().map((r) => ({ ...r }));
    const result = await insertParkingNodes(
      't1',
      db.deps({ findNearestParkingForPlace: deterministicParking })
    );
    assert.equal(result!.total_nodes, 1);
    assert.deepEqual(db.rows(), before);
  });

  // ══════════════════════════════ C2 regression：欄位保存 ═════════════════════

  test('C2：stay_duration_minutes 與 summary 在重寫後仍被保存', async () => {
    const db = makeFakeTripDb([D('景點1', 22.61, 1, 90, 'test-summary')]);
    const deps = db.deps({ findNearestParkingForPlace: deterministicParking });

    await insertParkingNodes('t1', deps);
    const afterFirst = db.rows().find((r) => r.poi_name === '景點1')!;
    assert.equal(afterFirst.stay_duration_minutes, 90);
    assert.equal(afterFirst.summary, 'test-summary');

    // 再跑一次仍然保存
    await insertParkingNodes('t1', deps);
    const afterSecond = db.rows().find((r) => r.poi_name === '景點1')!;
    assert.equal(afterSecond.stay_duration_minutes, 90);
    assert.equal(afterSecond.summary, 'test-summary');

    // 第三次也一樣
    await insertParkingNodes('t1', deps);
    const afterThird = db.rows().find((r) => r.poi_name === '景點1')!;
    assert.equal(afterThird.stay_duration_minutes, 90);
    assert.equal(afterThird.summary, 'test-summary');
  });

  test('C2：原本是 NULL 的欄位保持 NULL，不會被 DB DEFAULT 60 覆蓋', async () => {
    const db = makeFakeTripDb([D('景點1', 22.61, 1, null, null)]);
    await insertParkingNodes(
      't1',
      db.deps({ findNearestParkingForPlace: deterministicParking })
    );
    const row = db.rows().find((r) => r.poi_name === '景點1')!;
    assert.equal(row.stay_duration_minutes, null, 'NULL 不可以變成 60');
    assert.equal(row.summary, null);
  });

  test('C2：新產生的 PARKING 節點沿用 DB 預設（60 / NULL）', async () => {
    const db = makeFakeTripDb([D('景點1', 22.61, 1, 90, 's')]);
    await insertParkingNodes(
      't1',
      db.deps({ findNearestParkingForPlace: deterministicParking })
    );
    const parking = db.rows().find((r) => r.node_type === 'PARKING')!;
    assert.equal(parking.stay_duration_minutes, 60);
    assert.equal(parking.summary, null);
  });

  test('C2：多個景點各自保存自己的欄位，不會互相污染', async () => {
    const db = makeFakeTripDb([
      D('景點1', 22.61, 1, 90, 'summary-1'),
      D('景點2', 22.62, 2, 30, 'summary-2'),
    ]);
    await insertParkingNodes(
      't1',
      db.deps({ findNearestParkingForPlace: deterministicParking })
    );
    const a = db.rows().find((r) => r.poi_name === '景點1')!;
    const b = db.rows().find((r) => r.poi_name === '景點2')!;
    assert.equal(a.stay_duration_minutes, 90);
    assert.equal(a.summary, 'summary-1');
    assert.equal(b.stay_duration_minutes, 30);
    assert.equal(b.summary, 'summary-2');
  });

  test('回傳的 node_id 是實際寫入後的新 id，不是被刪掉的舊 id', async () => {
    const db = makeFakeTripDb([D('景點1', 22.61, 1, 90, 's')]);
    const result = await insertParkingNodes(
      't1',
      db.deps({ findNearestParkingForPlace: deterministicParking })
    );
    const destination = result!.nodes.find((n) => n.node_type === 'DESTINATION')!;
    assert.ok(destination.node_id);
    assert.ok(!destination.node_id!.startsWith('orig-'), '不可以是 DELETE 前的舊 id');
    // 這個 id 真的存在於資料庫裡
    assert.ok(db.rows().some((r) => r.node_id === destination.node_id));
  });

  // ══════════════════════════════ transaction atomicity ══════════════════════

  test('交易中途失敗時不會留下半刪半寫的資料', async () => {
    const db = makeFakeTripDb([D('景點1', 22.61, 1, 90, 's1'), D('景點2', 22.62, 2, 45, 's2')]);
    const before = db.rows().map((r) => ({ ...r }));

    await assert.rejects(
      () =>
        insertParkingNodes(
          't1',
          db.deps({
            findNearestParkingForPlace: deterministicParking,
            insertTripNodes: async () => {
              throw new Error('insert-failed');
            },
          })
        ),
      /insert-failed/
    );

    assert.deepEqual(db.rows(), before, 'ROLLBACK 後必須完全回到原狀');
  });

  test('部分 INSERT 成功後失敗，一樣整批回滾', async () => {
    const db = makeFakeTripDb([D('景點1', 22.61, 1, 90, 's1'), D('景點2', 22.62, 2, 45, 's2')]);
    const before = db.rows().map((r) => ({ ...r }));
    const realDeps = db.deps({ findNearestParkingForPlace: deterministicParking });

    await assert.rejects(
      () =>
        insertParkingNodes(
          't1',
          {
            ...realDeps,
            insertTripNodes: async (client, nodes) => {
              // 先寫入前兩筆，再失敗
              await realDeps.insertTripNodes(client, nodes.slice(0, 2));
              throw new Error('partial-insert-failed');
            },
          }
        ),
      /partial-insert-failed/
    );

    assert.deepEqual(db.rows(), before, '半套寫入必須被回滾');
  });
});

// ═════════════════════════════════════════════════════════ poi.service

describe('poi.service', () => {
  const deps = (over: Partial<PoiServiceDeps> = {}): PoiServiceDeps => ({
    looksLikeUrl: (s: string) => s.startsWith('http://') || s.startsWith('https://'),
    resolveGoogleMapsUrl: async () => ({ lat: 22.1, lng: 120.1, name: 'Google Maps 匯入地點' }),
    geocodePlaceName: async () => ({ lat: 22.2, lng: 120.2 }),
    ...over,
  });

  test('Google Maps 網址走 URL 解析分支', async () => {
    let geocodeCalled = false;
    const result = await parseRawInput(
      'https://www.google.com/maps/place/xxx',
      deps({ geocodePlaceName: async () => { geocodeCalled = true; return null; } })
    );
    assert.equal(geocodeCalled, false);
    assert.deepEqual(result, [
      { poi_name: 'Google Maps 匯入地點', lat: 22.1, lng: 120.1, matched: true },
    ]);
  });

  test('短網址也走 URL 分支', async () => {
    const result = await parseRawInput('https://maps.app.goo.gl/abc', deps());
    assert.equal(result[0].poi_name, 'Google Maps 匯入地點');
  });

  test('純地名走 geocoding 分支，並以原輸入作為名稱', async () => {
    let resolveCalled = false;
    const result = await parseRawInput(
      '駁二藝術特區',
      deps({ resolveGoogleMapsUrl: async () => { resolveCalled = true; return null; } })
    );
    assert.equal(resolveCalled, false);
    assert.deepEqual(result, [
      { poi_name: '駁二藝術特區', lat: 22.2, lng: 120.2, matched: true },
    ]);
  });

  test('URL 解析失敗回空陣列（既有行為：仍算成功）', async () => {
    const result = await parseRawInput(
      'https://www.google.com/maps/place/xxx',
      deps({ resolveGoogleMapsUrl: async () => null })
    );
    assert.deepEqual(result, []);
  });

  test('地名查無結果回空陣列', async () => {
    const result = await parseRawInput('不存在的地方', deps({ geocodePlaceName: async () => null }));
    assert.deepEqual(result, []);
  });

  test('不安全的網址轉成 ValidationError（→ 400），且訊息安全', async () => {
    const unsafe = deps({
      resolveGoogleMapsUrl: async () => {
        throw new UnsafeUrlError('不在允許清單中的 host 169.254.169.254');
      },
    });
    await assert.rejects(
      () => parseRawInput('http://169.254.169.254/#google.com/maps', unsafe),
      (error: unknown) => {
        assert.ok(error instanceof ValidationError);
        assert.equal((error as Error).message, '不支援的 Google Maps 網址');
        // 拒絕原因不可外洩
        assert.ok(!(error as Error).message.includes('169.254'));
        return true;
      }
    );
  });

  test('非 UnsafeUrlError 的錯誤原樣往外拋（交給 route 的 500 處理）', async () => {
    const boom = deps({
      resolveGoogleMapsUrl: async () => {
        throw new Error('socket hang up');
      },
    });
    await assert.rejects(
      () => parseRawInput('https://www.google.com/maps/x', boom),
      /socket hang up/
    );
  });
});
