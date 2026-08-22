// tests/unit/m9.test.ts
//
// M9 迴歸測試：補齊 frontend 期待的行程欄位。
//
// 這一組測試的重點不只是「有值」，更重要的是「沒有假造資料」：
// 沒有可靠來源的欄位必須維持不存在，不能被推測值填充。
//
//   npm test

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key-not-used-offline';

import {
  toCandidateParking,
  walkingMinutesFor,
} from '@/server/services/parking.service';
import { planTripWithParking, type TripServiceDeps } from '@/server/services/trip.service';
import { toTripPlan } from '@/server/integrations/gemini';
import { confidenceLabel, sourceLabel } from '@/components/scheduleLabels';
import type { NearbyParking } from '@/server/types/parking';

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

function tripDeps(over: Partial<TripServiceDeps> = {}): TripServiceDeps {
  return {
    planTrip: async (pois) => ({
      title: 't',
      stops: pois.map((poi, i) => ({
        sequenceOrder: i + 1,
        poi,
        stayDurationMinutes: 60,
        summary: `s-${i}`,
      })),
    }),
    withTransaction: (async (fn: (c: unknown) => Promise<unknown>) => fn({} as never)) as never,
    createTrip: async () => 'trip-1',
    findTripNodes: async () => [],
    deleteTripNodes: async () => {},
    insertTripNodes: async (_c, nodes) => nodes.map((_, i) => `n${i}`),
    getCandidateParkingsForPlaces: async (places) => places.map(() => []),
    findNearestParkingForPlace: async () => null,
    getLiveAvailabilityMap: async () => new Map(),
    ...over,
  } as TripServiceDeps;
}

// ══════════════════════════════════════════ walk_minutes_to_spot

describe('M9: walk_minutes_to_spot', () => {
  test('800m 依 80 m/min 換算為 10 分鐘', () => {
    assert.equal(walkingMinutesFor(800), 10);
  });

  test('無條件進位（81m → 2 分鐘）', () => {
    assert.equal(walkingMinutesFor(81), 2);
    assert.equal(walkingMinutesFor(80), 1);
    assert.equal(walkingMinutesFor(1), 1);
  });

  test('0 公尺 → 0 分鐘', () => {
    assert.equal(walkingMinutesFor(0), 0);
  });

  // 這一條是「不能有兩套計算」的迴歸鎖
  test('與 distance_display 內的分鐘數完全一致（不得漂移）', () => {
    for (const d of [1, 80, 81, 240, 799, 800, 1499]) {
      const card = toCandidateParking(parkingRow({ distance_meters: d }), null);
      const minutes = Number(card.distance_display.match(/步行約 (\d+) 分鐘/)![1]);
      assert.equal(minutes, walkingMinutesFor(d), `distance=${d} 時兩處計算不一致`);
    }
  });

  test('schedule 的值取自「最近的」候選停車場', async () => {
    const deps = tripDeps({
      getCandidateParkingsForPlaces: async (places) =>
        places.map(() => [
          toCandidateParking(parkingRow({ parking_id: 'near', distance_meters: 240 }), null),
          toCandidateParking(parkingRow({ parking_id: 'far', distance_meters: 1200 }), null),
        ]),
    });
    const result = await planTripWithParking(PLACES, deps);
    // 240m → 3 分鐘（不是 1200m 的 15 分鐘）
    assert.equal(result.schedule[0].walk_minutes_to_spot, 3);
  });

  test('景點附近沒有停車場時為 null，不是 0 也不是捏造值', async () => {
    const result = await planTripWithParking(PLACES, tripDeps());
    assert.equal(result.schedule[0].walk_minutes_to_spot, null);
  });
});

// ══════════════════════════════════════════ source / confidence
//
// 語意提醒：confidence 是「這個 POI 的來源有多可靠」，
// 【不是】「AI 對這個景點推薦有 100% 信心」。
// 景點由使用者直接提供、座標原封不動沿用，所以來源可信度為最高等級。

describe('M9: source 固定為 user（景點由呼叫端提供，非 API 產生的 POI）', () => {
  test('source === "user"', async () => {
    const result = await planTripWithParking(PLACES, tripDeps());
    assert.ok(result.schedule.every((s) => s.source === 'user'));
  });

  test('後端回傳 machine-readable 值，不是中文字串', async () => {
    const result = await planTripWithParking(PLACES, tripDeps());
    assert.ok(result.schedule.every((s) => s.source === 'user'));
    assert.ok(result.schedule.every((s) => !/[一-鿿]/.test(s.source)));
  });
});

describe('M9: confidence 是「來源可信度」而非 LLM 信心分數', () => {
  test('source 為 user 時 confidence === 1（POI 由使用者明確提供，非模型推測）', async () => {
    const result = await planTripWithParking(PLACES, tripDeps());
    assert.ok(result.schedule.every((s) => s.confidence === 1));
  });

  test('confidence 是 number 且落在 0~1', async () => {
    const result = await planTripWithParking(PLACES, tripDeps());
    for (const s of result.schedule) {
      assert.equal(typeof s.confidence, 'number');
      assert.ok(s.confidence >= 0 && s.confidence <= 1);
    }
  });

  test('模型是否漏掉景點都不影響 confidence —— 它衡量的是來源，不是規劃品質', async () => {
    // 模型只回傳 index 1，index 0 由 toTripPlan 依原始順序補回
    const plan = toTripPlan(
      PLACES,
      { title: 't', stops: [{ poi_index: 1, stay_duration_minutes: 90, summary: 'ok' }] },
      'fallback'
    );
    const result = await planTripWithParking(PLACES, tripDeps({ planTrip: async () => plan }));
    // 兩個景點都來自使用者輸入，因此來源可信度同樣是 1
    assert.ok(result.schedule.every((s) => s.confidence === 1));
    assert.ok(result.schedule.every((s) => s.source === 'user'));
  });
});

// ══════════════════════════════════════════ frontend 中文對照

describe('M9: frontend 中文 mapping', () => {
  test('source: user → 使用者輸入', () => {
    assert.equal(sourceLabel('user'), '使用者輸入');
  });

  test('未知 source → null（UI 整塊不顯示，不印原始代碼）', () => {
    assert.equal(sourceLabel('google_maps'), null);
    assert.equal(sourceLabel(''), null);
    assert.equal(sourceLabel(undefined), null);
  });

  test('confidence: 1 → 高、0.8 → 中、0.5 → 低', () => {
    assert.equal(confidenceLabel(1), '高');
    assert.equal(confidenceLabel(0.8), '中');
    assert.equal(confidenceLabel(0.5), '低');
  });

  test('confidence 邊界值', () => {
    assert.equal(confidenceLabel(0.9), '高');
    assert.equal(confidenceLabel(0.89), '中');
    assert.equal(confidenceLabel(0.7), '中');
    assert.equal(confidenceLabel(0.69), '低');
    assert.equal(confidenceLabel(0), '低');
  });

  test('confidence 缺值 / 非數字 → null（不顯示 undefined）', () => {
    assert.equal(confidenceLabel(undefined), null);
    assert.equal(confidenceLabel(null), null);
    assert.equal(confidenceLabel(NaN), null);
  });

  test('UI 不會直接顯示原始值 user / 1 / undefined', async () => {
    const result = await planTripWithParking(PLACES, tripDeps());
    const spot = result.schedule[0];

    const sourceText = sourceLabel(spot.source);
    const confidenceText = confidenceLabel(spot.confidence);

    assert.equal(sourceText, '使用者輸入');
    assert.equal(confidenceText, '高');
    // 畫面文字不得等於後端原始值，也不得是 undefined
    assert.notEqual(sourceText, 'user');
    assert.notEqual(confidenceText, '1');
    assert.notEqual(confidenceText, String(spot.confidence));
    for (const t of [sourceText, confidenceText]) {
      assert.ok(t && t !== 'undefined');
    }
  });
});

// ══════════════════════════ 沒有可靠來源的欄位「絕不」被捏造

describe('M9: 無 authoritative datasource 的欄位不得出現假資料', () => {
  const UNSUPPORTED = [
    'arrival_time',
    'departure_time',
    'parking_arrival_time',
    'open_time',
    'close_time',
  ];

  test('schedule item 完全不含這些欄位（而不是塞入推測值）', async () => {
    const deps = tripDeps({
      getCandidateParkingsForPlaces: async (places) =>
        places.map(() => [toCandidateParking(parkingRow(), null)]),
    });
    const result = await planTripWithParking(PLACES, deps);

    for (const entry of result.schedule) {
      const asRecord = entry as unknown as Record<string, unknown>;
      for (const field of UNSUPPORTED) {
        assert.ok(
          !(field in entry),
          `${field} 沒有可靠資料來源，不應該出現在回應中（實際值：${JSON.stringify(
            asRecord[field]
          )}）`
        );
      }
    }
  });

  test('回應中不含任何看起來像時刻的字串（避免偷偷造時間）', async () => {
    const deps = tripDeps({
      getCandidateParkingsForPlaces: async (places) =>
        places.map(() => [toCandidateParking(parkingRow(), null)]),
    });
    const result = await planTripWithParking(PLACES, deps);
    // 只檢查 schedule item 自身的純量欄位，不含 candidate_parkings 的費率文字
    for (const entry of result.schedule) {
      const scalars = Object.entries(entry)
        .filter(([k]) => k !== 'candidate_parkings')
        .map(([, v]) => v);
      for (const v of scalars) {
        if (typeof v === 'string') {
          assert.ok(!/^\d{1,2}:\d{2}$/.test(v), `不應出現 HH:mm 形式的捏造時刻: ${v}`);
        }
      }
    }
  });
});

// ══════════════════════════════════════════ contract：additive

describe('M9: schedule item contract 為 additive', () => {
  test('既有欄位全部保留，且新增剛好三個欄位', async () => {
    const deps = tripDeps({
      getCandidateParkingsForPlaces: async (places) =>
        places.map(() => [toCandidateParking(parkingRow(), null)]),
    });
    const result = await planTripWithParking(PLACES, deps);

    const EXISTING = [
      'spot_order', 'spot_name', 'lat', 'lng',
      'suggested_stay_minutes', 'reason', 'candidate_parkings',
    ];
    const ADDED = ['walk_minutes_to_spot', 'source', 'confidence'];

    for (const entry of result.schedule) {
      for (const k of EXISTING) assert.ok(k in entry, `既有欄位 ${k} 不可消失`);
      for (const k of ADDED) assert.ok(k in entry, `新增欄位 ${k} 應存在`);
      assert.deepEqual(
        Object.keys(entry).sort(),
        [...EXISTING, ...ADDED].sort(),
        '不應有預期外的欄位'
      );
    }
  });

  test('candidate_parkings 形狀未被更動', async () => {
    const deps = tripDeps({
      getCandidateParkingsForPlaces: async (places) =>
        places.map(() => [toCandidateParking(parkingRow(), null)]),
    });
    const result = await planTripWithParking(PLACES, deps);
    assert.deepEqual(
      Object.keys(result.schedule[0].candidate_parkings[0]).sort(),
      ['available_spaces', 'distance_display', 'distance_meters', 'fare_description',
        'hourly_rate', 'lat', 'lng', 'name', 'parking_id', 'total_spaces']
    );
  });
});
