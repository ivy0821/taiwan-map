// tests/unit/gemini.test.ts
//
// server/integrations/gemini.ts 純邏輯的最小測試。
// 全部離線執行：需要模擬上游時直接替換 globalThis.fetch，不會真的呼叫 Gemini。
//
//   npm test

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key-not-used-offline';

import {
  parsePlanPayload,
  toTripPlan,
  buildPlanPrompt,
  classifyGeminiError,
  GeminiError,
  planTrip,
  type TripPoi,
  type RawTripPlan,
} from '@/server/integrations/gemini';

const POIS: TripPoi[] = [
  { name: '旗津天后宮', lat: 22.6137, lng: 120.2678 },
  { name: '駁二藝術特區', lat: 22.6201, lng: 120.2818 },
  { name: '高雄流行音樂中心', lat: 22.6133, lng: 120.2925 },
];

const raw = (stops: unknown[], title = '高雄一日遊'): RawTripPlan =>
  ({ title, stops } as RawTripPlan);

// ───────────────────────────────────────────────── structured output 解析

describe('parsePlanPayload', () => {
  test('解析合法的 structured output', () => {
    const result = parsePlanPayload(
      JSON.stringify({
        title: '港灣一日遊',
        stops: [{ poi_index: 0, stay_duration_minutes: 90, summary: '參拜天后宮' }],
      })
    );
    assert.equal(result.title, '港灣一日遊');
    assert.equal(result.stops.length, 1);
  });

  test('title 缺失時退成空字串（交給 toTripPlan 套用 fallback）', () => {
    const result = parsePlanPayload(JSON.stringify({ stops: [] }));
    assert.equal(result.title, '');
  });

  const invalid: [string, string | undefined][] = [
    ['undefined', undefined],
    ['空字串', ''],
    ['只有空白', '   '],
    ['不是 JSON 的自由文字', '這是一段模型講的話，不是 JSON'],
    ['JSON 陣列而非物件', '[{"poi_index":0}]'],
    ['缺少 stops', '{"title":"x"}'],
    ['stops 不是陣列', '{"title":"x","stops":{}}'],
    ['null', 'null'],
  ];

  for (const [label, payload] of invalid) {
    test(`${label} → 安全地丟出 invalid_output`, () => {
      assert.throws(
        () => parsePlanPayload(payload),
        (err: unknown) => err instanceof GeminiError && err.kind === 'invalid_output'
      );
    });
  }

  // 這一條就是「不再做 markdown code fence 剝除」的迴歸測試：
  // structured output 不該回傳 ```json，真的收到就必須當成錯誤，而不是硬吞。
  test('帶 markdown code fence 的輸出被視為錯誤，不做剝除', () => {
    const fenced = '```json\n{"title":"x","stops":[]}\n```';
    assert.throws(
      () => parsePlanPayload(fenced),
      (err: unknown) => err instanceof GeminiError && err.kind === 'invalid_output'
    );
  });
});

// ──────────────────────────────────────── index → 原始 POI 對應與座標保護

describe('toTripPlan：POI 對應與座標權威性', () => {
  test('依模型順序重排，座標與名稱取自原始 POI', () => {
    const plan = toTripPlan(
      POIS,
      raw([
        { poi_index: 1, stay_duration_minutes: 120, summary: '文創園區' },
        { poi_index: 2, stay_duration_minutes: 90, summary: '海港建築' },
        { poi_index: 0, stay_duration_minutes: 60, summary: '搭渡輪' },
      ]),
      'fallback'
    );

    assert.deepEqual(
      plan.stops.map((s) => s.poi.name),
      ['駁二藝術特區', '高雄流行音樂中心', '旗津天后宮']
    );
    assert.deepEqual(
      plan.stops.map((s) => s.sequenceOrder),
      [1, 2, 3]
    );
    // 座標必須逐一等於原始輸入
    for (const stop of plan.stops) {
      const original = POIS.find((p) => p.name === stop.poi.name)!;
      assert.equal(stop.poi.lat, original.lat);
      assert.equal(stop.poi.lng, original.lng);
    }
  });

  test('模型即使夾帶 lat/lng 也完全不被採用', () => {
    const plan = toTripPlan(
      POIS,
      raw([
        {
          poi_index: 0,
          stay_duration_minutes: 60,
          summary: '被竄改的座標',
          // 模型偷塞的假座標（schema 裡根本沒有這些欄位）
          lat: 0,
          lng: 0,
          name: '台北101',
        },
      ]),
      'fallback'
    );

    assert.equal(plan.stops[0].poi.lat, 22.6137);
    assert.equal(plan.stops[0].poi.lng, 120.2678);
    assert.equal(plan.stops[0].poi.name, '旗津天后宮');
    // 回傳物件上不該出現模型塞進來的任何額外鍵
    assert.deepEqual(Object.keys(plan.stops[0].poi).sort(), ['lat', 'lng', 'name']);
  });

  test('模型自己編的順序號碼不被採用，一律重新編號', () => {
    const plan = toTripPlan(
      POIS,
      raw([
        { poi_index: 2, stay_duration_minutes: 60, summary: 'c', sequence_order: 99 },
        { poi_index: 0, stay_duration_minutes: 60, summary: 'a', sequence_order: 7 },
        { poi_index: 1, stay_duration_minutes: 60, summary: 'b', sequence_order: -3 },
      ]),
      'fallback'
    );
    assert.deepEqual(
      plan.stops.map((s) => s.sequenceOrder),
      [1, 2, 3]
    );
  });

  test('超出範圍 / 非整數 / 負數的 index 一律丟棄', () => {
    const plan = toTripPlan(
      POIS,
      raw([
        { poi_index: 99, stay_duration_minutes: 60, summary: '越界' },
        { poi_index: -1, stay_duration_minutes: 60, summary: '負數' },
        { poi_index: 1.5, stay_duration_minutes: 60, summary: '小數' },
        { poi_index: '0', stay_duration_minutes: 60, summary: '字串' },
        { poi_index: 1, stay_duration_minutes: 60, summary: '唯一合法的' },
      ]),
      'fallback'
    );
    // 合法的排前面，其餘 POI 依原始順序補回，且不會少景點
    assert.equal(plan.stops.length, POIS.length);
    assert.equal(plan.stops[0].poi.name, '駁二藝術特區');
    assert.deepEqual(
      plan.stops.map((s) => s.poi.name).sort(),
      POIS.map((p) => p.name).sort()
    );
  });

  test('重複的 index 只取第一次', () => {
    const plan = toTripPlan(
      POIS,
      raw([
        { poi_index: 0, stay_duration_minutes: 60, summary: '第一次' },
        { poi_index: 0, stay_duration_minutes: 999, summary: '重複' },
      ]),
      'fallback'
    );
    assert.equal(plan.stops.length, POIS.length);
    assert.equal(plan.stops[0].summary, '第一次');
    assert.equal(plan.stops[0].stayDurationMinutes, 60);
    assert.equal(new Set(plan.stops.map((s) => s.poi.name)).size, POIS.length);
  });

  test('模型漏掉的景點依原始順序補回', () => {
    const plan = toTripPlan(
      POIS,
      raw([{ poi_index: 2, stay_duration_minutes: 60, summary: '只給了一個' }]),
      'fallback'
    );
    assert.deepEqual(
      plan.stops.map((s) => s.poi.name),
      ['高雄流行音樂中心', '旗津天后宮', '駁二藝術特區']
    );
  });

  test('少欄位時套用安全預設值，不會產生 NaN / undefined', () => {
    const plan = toTripPlan(
      POIS,
      raw([
        { poi_index: 0 },
        { poi_index: 1, stay_duration_minutes: 'abc', summary: 123 },
        { poi_index: 2, stay_duration_minutes: -5, summary: null },
      ]),
      'fallback'
    );
    for (const stop of plan.stops) {
      assert.equal(typeof stop.stayDurationMinutes, 'number');
      assert.ok(Number.isFinite(stop.stayDurationMinutes) && stop.stayDurationMinutes > 0);
      assert.equal(typeof stop.summary, 'string');
    }
  });

  test('完全沒有可用的 stop → 安全失敗（丟 invalid_output 讓 retry 再抽一次）', () => {
    assert.throws(
      () => toTripPlan(POIS, raw([{ poi_index: 99 }, { poi_index: -1 }]), 'fallback'),
      (err: unknown) => err instanceof GeminiError && err.kind === 'invalid_output'
    );
  });

  test('title 為空時採用 fallback', () => {
    const plan = toTripPlan(POIS, raw([{ poi_index: 0 }], '  '), '高雄一日遊');
    assert.equal(plan.title, '高雄一日遊');
  });
});

describe('buildPlanPrompt', () => {
  test('只給模型 index 與名稱，不給座標', () => {
    const prompt = buildPlanPrompt(POIS, '輕鬆一日遊');
    assert.ok(prompt.includes('index 0: 旗津天后宮'));
    assert.ok(prompt.includes('index 2: 高雄流行音樂中心'));
    assert.ok(prompt.includes('輕鬆一日遊'));
    // 座標不得出現在 prompt 中
    assert.ok(!prompt.includes('22.6137'));
    assert.ok(!prompt.includes('120.2678'));
  });
});

// ─────────────────────────────────────────────────────────── 錯誤分類與 retry

describe('classifyGeminiError', () => {
  const cases: [string, unknown, string, boolean][] = [
    ['429 狀態碼', { status: 429, message: 'too many requests' }, 'quota', false],
    [
      'RESOURCE_EXHAUSTED 訊息',
      { message: '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}' },
      'quota',
      false,
    ],
    ['API_KEY_INVALID', { status: 400, message: 'API_KEY_INVALID' }, 'auth', false],
    ['403 PERMISSION_DENIED', { status: 403, message: 'PERMISSION_DENIED' }, 'auth', false],
    ['401', { status: 401, message: 'unauthenticated' }, 'auth', false],
    ['400 INVALID_ARGUMENT', { status: 400, message: 'INVALID_ARGUMENT' }, 'bad_request', false],
    ['500', { status: 500, message: 'internal' }, 'upstream', true],
    ['503', { status: 503, message: 'unavailable' }, 'upstream', true],
    ['AbortError', { name: 'AbortError', message: 'aborted' }, 'timeout', true],
    ['未知錯誤預設為 upstream', new Error('socket hang up'), 'upstream', true],
  ];

  for (const [label, input, expectedKind, expectedRetryable] of cases) {
    test(`${label} → ${expectedKind} (retryable=${expectedRetryable})`, () => {
      const kind = classifyGeminiError(input);
      assert.equal(kind, expectedKind);
      assert.equal(new GeminiError(kind).retryable, expectedRetryable);
    });
  }

  test('quota 與 auth 一定不可重試', () => {
    assert.equal(new GeminiError('quota').retryable, false);
    assert.equal(new GeminiError('auth').retryable, false);
  });

  test('錯誤訊息不含上游原文或金鑰', () => {
    process.env.GEMINI_API_KEY = 'SUPER_SECRET_KEY_123';
    const err = new GeminiError(classifyGeminiError({ status: 429, message: 'SUPER_SECRET_KEY_123 quota' }));
    assert.ok(!err.message.includes('SUPER_SECRET_KEY_123'));
    assert.ok(!err.message.includes('quota'));
    assert.equal(err.message, 'AI 服務額度已用盡，請稍後再試');
  });
});

// ───────────────────────────── retry policy（用假 fetch，完全不碰真實 Gemini）

describe('planTrip retry policy（離線）', () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;

  const stub = (handler: () => Response) => {
    calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return handler();
    }) as typeof fetch;
  };

  const jsonResponse = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  const okPlan = () =>
    jsonResponse(200, {
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  title: '測試行程',
                  stops: [{ poi_index: 0, stay_duration_minutes: 60, summary: 'ok' }],
                }),
              },
            ],
          },
          finishReason: 'STOP',
        },
      ],
    });

  beforeEach(() => {
    calls = 0;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('quota (429) 只呼叫一次，不重試', async () => {
    stub(() =>
      jsonResponse(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota' } })
    );
    await assert.rejects(
      () => planTrip(POIS),
      (err: unknown) => err instanceof GeminiError && err.kind === 'quota'
    );
    assert.equal(calls, 1, `quota 應該只呼叫 1 次，實際 ${calls} 次`);
  });

  test('auth (403) 只呼叫一次，不重試', async () => {
    stub(() =>
      jsonResponse(403, {
        error: { code: 403, status: 'PERMISSION_DENIED', message: 'API_KEY_INVALID' },
      })
    );
    await assert.rejects(
      () => planTrip(POIS),
      (err: unknown) => err instanceof GeminiError && err.kind === 'auth'
    );
    assert.equal(calls, 1, `auth 應該只呼叫 1 次，實際 ${calls} 次`);
  });

  test('暫時性 5xx 會重試到上限', async () => {
    stub(() => jsonResponse(503, { error: { code: 503, message: 'unavailable' } }));
    await assert.rejects(
      () => planTrip(POIS),
      (err: unknown) => err instanceof GeminiError && err.kind === 'upstream'
    );
    assert.equal(calls, 3, `暫時性錯誤應該重試到 3 次，實際 ${calls} 次`);
  });

  test('先失敗後成功 → 重試後回傳正確結果', async () => {
    let n = 0;
    calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      n++;
      return n === 1 ? jsonResponse(503, { error: { code: 503 } }) : okPlan();
    }) as typeof fetch;

    const plan = await planTrip(POIS);
    assert.equal(calls, 2);
    assert.equal(plan.title, '測試行程');
    assert.equal(plan.stops.length, POIS.length);
    assert.equal(plan.stops[0].poi.lat, POIS[0].lat);
  });

  test('空的 POI 清單不會呼叫 Gemini', async () => {
    stub(okPlan);
    await assert.rejects(
      () => planTrip([]),
      (err: unknown) => err instanceof GeminiError && err.kind === 'bad_request'
    );
    assert.equal(calls, 0);
  });
});
