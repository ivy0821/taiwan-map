// tests/unit/error-handling.test.ts
//
// H3 迴歸測試：確認任何內部錯誤都不會穿透到 HTTP response。
//
// 這些測試直接呼叫真正的 route handler，因此驗證的是實際會跑到 production 的程式碼路徑。
//
// 注意 module mock 的用法：route 一旦被 import，它對 service 的綁定就固定了，
// 之後再呼叫 mock.module() 也不會重新綁定。所以這裡在檔案最上方【只 mock 一次】，
// 並讓 mock 轉呼叫一個可替換的行為變數；每個測試只要換掉那個變數即可。
//
//   npm test   （已帶 --experimental-test-module-mocks）

import { test, describe, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key-not-used-offline';

// ── 可替換的行為 ─────────────────────────────────────────────────────────
type Behavior = () => Promise<unknown>;

const notConfigured: Behavior = async () => {
  throw new Error('behavior not configured');
};

let tripBehavior: Behavior = notConfigured;
let parkingBehavior: Behavior = notConfigured;
let poiBehavior: Behavior = notConfigured;

mock.module('@/server/services/trip.service', {
  namedExports: {
    generateTrip: () => tripBehavior(),
    planTripWithParking: () => tripBehavior(),
    insertParkingNodes: () => tripBehavior(),
  },
});
mock.module('@/server/services/parking.service', {
  namedExports: {
    getLiveAvailability: () => parkingBehavior(),
  },
});
mock.module('@/server/services/poi.service', {
  namedExports: {
    parseRawInput: () => poiBehavior(),
  },
});

const throwing = (error: unknown): Behavior => async () => {
  throw error;
};

// ── 模擬的內部錯誤，內容刻意包含各種絕對不能外洩的東西 ──────────────────
const DB_ERROR = new Error('relation "trip_nodes" does not exist at 10.0.0.5');
const GEMINI_ERROR = new Error('Gemini API key invalid: secret-example');
const TDX_ERROR = new Error('TDX Authorization Bearer abc123');

/** 出現在 response 裡就代表外洩的字串 */
const FORBIDDEN = [
  'trip_nodes',
  '10.0.0.5',
  'relation',
  'secret-example',
  'Gemini API key invalid',
  'abc123',
  'Bearer',
  'does not exist',
  'at Object',
  '.ts:',
  'node_modules',
  'C:\\',
  '/server/',
];

/** 攔截 console.error，確認「server 有拿到完整錯誤」而 client 沒有 */
let captured: string[] = [];
const originalError = console.error;

beforeEach(() => {
  captured = [];
  console.error = (...args: unknown[]) => {
    captured.push(args.map((a) => String(a)).join(' '));
  };
});
afterEach(() => {
  console.error = originalError;
  tripBehavior = notConfigured;
  parkingBehavior = notConfigured;
  poiBehavior = notConfigured;
});

function assertSafeBody(body: unknown, label: string) {
  const json = JSON.stringify(body);

  for (const needle of FORBIDDEN) {
    assert.ok(!json.includes(needle), `${label}: response 不該包含 "${needle}"，實際為 ${json}`);
  }
  assert.ok(
    !Object.prototype.hasOwnProperty.call(body as object, 'details'),
    `${label}: response 不該有 details 欄位，實際為 ${json}`
  );
  const err = (body as { error?: unknown }).error;
  assert.equal(typeof err, 'string', `${label}: error 應為字串，實際為 ${json}`);
  assert.ok((err as string).length > 0, `${label}: error 不可為空字串`);
}

const jsonRequest = (body: unknown) =>
  new Request('http://localhost/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const VALID_PLACE = { name: '駁二藝術特區', lat: 22.6201, lng: 120.2818 };
const VALID_POI = { poi_name: '駁二藝術特區', lat: 22.6201, lng: 120.2818 };
const VALID_UUID = '35ec1d51-7f86-4487-833e-3977f5948694';

// route handlers 必須在 mock 註冊「之後」才載入。
// mock.module() 在檔案最上方同步執行，而這個 loader 只會在 test 內被 await，
// 所以順序有保證。ESM 的 module cache 會讓重複呼叫拿到同一組模組。
async function routes() {
  return {
    generate: await import('@/app/api/v1/trip/generate/route'),
    aiPlan: await import('@/app/api/v1/trip/ai-plan-with-parking/route'),
    insertParking: await import('@/app/api/v1/trip/[tripId]/insert-parking/route'),
    parkingLive: await import('@/app/api/v1/parking/live/route'),
    googleMaps: await import('@/app/api/v1/import/google-maps/route'),
  };
}

/** 各 endpoint 共用的「非 Error 也要安全」案例 */
const NON_ERROR_THROWS: [string, unknown][] = [
  ['throw 字串', 'unexpected'],
  ['throw 物件', { foo: 'bar' }],
  ['throw null', null],
  ['throw undefined', undefined],
  ['throw 數字', 42],
];

// ══════════════════════════════════════════════════════ trip/generate

describe('H3: trip/generate', () => {
  const cases: [string, unknown][] = [
    ['資料庫錯誤', DB_ERROR],
    ['Gemini 錯誤', GEMINI_ERROR],
    ['TDX 錯誤', TDX_ERROR],
    ...NON_ERROR_THROWS,
  ];

  for (const [label, error] of cases) {
    test(`${label} → 500 且訊息固定`, async () => {
      tripBehavior = throwing(error);
      const res = await (await routes()).generate.POST(jsonRequest({ poi_list: [VALID_POI] }));
      const body = await res.json();

      assert.equal(res.status, 500, label);
      assert.deepEqual(body, { error: '行程生成失敗' }, label);
      assertSafeBody(body, label);
    });
  }

  test('server log 仍收到完整錯誤（可除錯）', async () => {
    tripBehavior = throwing(DB_ERROR);
    await (await routes()).generate.POST(jsonRequest({ poi_list: [VALID_POI] }));

    const logged = captured.join('\n');
    assert.ok(logged.includes('trip/generate'), 'log 應標示 endpoint');
    assert.ok(logged.includes('trip_nodes'), 'log 應保留原始錯誤內容');
    assert.ok(logged.includes('10.0.0.5'), 'log 應保留原始錯誤內容');
  });

  test('非 Error 被 throw 時 log 也不會自己爆掉', async () => {
    tripBehavior = throwing({ weird: true });
    const res = await (await routes()).generate.POST(jsonRequest({ poi_list: [VALID_POI] }));
    assert.equal(res.status, 500);
    assert.ok(captured.join('\n').includes('trip/generate'));
  });
});

// ═════════════════════════════════════════════ ai-plan-with-parking

describe('H3: ai-plan-with-parking', () => {
  const cases: [string, unknown][] = [
    ['Gemini 錯誤', GEMINI_ERROR],
    ['資料庫錯誤', DB_ERROR],
    ['TDX 錯誤', TDX_ERROR],
    ...NON_ERROR_THROWS,
  ];

  for (const [label, error] of cases) {
    test(`${label} → 500 且不含 details`, async () => {
      tripBehavior = throwing(error);
      const res = await (await routes()).aiPlan.POST(jsonRequest({ places: [VALID_PLACE] }));
      const body = await res.json();

      assert.equal(res.status, 500, label);
      assert.deepEqual(body, { error: '規劃失敗' }, label);
      assertSafeBody(body, label);
    });
  }
});

// ═══════════════════════════════════════════════════ insert-parking

describe('H3: insert-parking', () => {
  const context = (tripId: string) => ({ params: Promise.resolve({ tripId }) });

  const cases: [string, unknown][] = [
    ['資料庫錯誤', DB_ERROR],
    ['TDX 錯誤', TDX_ERROR],
    ...NON_ERROR_THROWS,
  ];

  for (const [label, error] of cases) {
    test(`${label} → 500 且不含 details`, async () => {
      tripBehavior = throwing(error);
      const res = await (await routes()).insertParking.POST(jsonRequest({}), context(VALID_UUID));
      const body = await res.json();

      assert.equal(res.status, 500, label);
      assert.deepEqual(body, { error: '伺服器內部錯誤' }, label);
      assertSafeBody(body, label);
    });
  }

  test('domain 404 仍然是 404，不會被錯誤處理吃掉', async () => {
    tripBehavior = async () => null;
    const res = await (await routes()).insertParking.POST(jsonRequest({}), context(VALID_UUID));
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: '找不到對應的行程節點或行程為空' });
  });

  test('無效 UUID 仍然是 400（validation 先於 service）', async () => {
    tripBehavior = throwing(DB_ERROR);
    const res = await (await routes()).insertParking.POST(jsonRequest({}), context('abc'));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: '無效的行程 ID' });
  });
});

// ════════════════════════════════════════════════════════ parking/live

describe('H3: parking/live', () => {
  const cases: [string, unknown][] = [
    ['TDX 錯誤', TDX_ERROR],
    ['資料庫錯誤', DB_ERROR],
    ...NON_ERROR_THROWS,
  ];

  for (const [label, error] of cases) {
    test(`${label} → 500 且保持既有 shape`, async () => {
      parkingBehavior = throwing(error);
      const res = await (await routes()).parkingLive.POST(jsonRequest({ parkingIds: ['KHA00001'] }));
      const body = await res.json();

      assert.equal(res.status, 500, label);
      assert.deepEqual(body, { error: '取得即時車位失敗', availabilities: {} }, label);
      assertSafeBody(body, label);
    });
  }

  test('M2 未變：TDX 上游失敗仍回 200 + 空 availabilities', async () => {
    parkingBehavior = async () => ({ availabilities: {}, upstreamOk: false });
    const res = await (await routes()).parkingLive.POST(jsonRequest({ parkingIds: ['KHA00001'] }));
    assert.equal(res.status, 200, '上游失敗的 fallback 不可被改成 500');
    assert.deepEqual(await res.json(), { availabilities: {} });
  });

  test('成功路徑仍附 updated_at', async () => {
    parkingBehavior = async () => ({ availabilities: { KHA00001: 5 }, upstreamOk: true });
    const res = await (await routes()).parkingLive.POST(jsonRequest({ parkingIds: ['KHA00001'] }));
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(body.availabilities, { KHA00001: 5 });
    assert.equal(typeof body.updated_at, 'string');
  });
});

// ══════════════════════════════════════════════════ import/google-maps

describe('H3: import/google-maps', () => {
  const cases: [string, unknown][] = [
    ['geocoding 錯誤', new Error('Nominatim request failed at 10.0.0.5')],
    ...NON_ERROR_THROWS,
  ];

  for (const [label, error] of cases) {
    test(`${label} → 500 且訊息固定`, async () => {
      poiBehavior = throwing(error);
      const res = await (await routes()).googleMaps.POST(jsonRequest({ raw_input: '駁二藝術特區' }));
      const body = await res.json();

      assert.equal(res.status, 500, label);
      assert.deepEqual(body, { error: '伺服器內部錯誤' }, label);
      assertSafeBody(body, label);
    });
  }

  test('成功路徑不受影響', async () => {
    poiBehavior = async () => [{ poi_name: 'x', lat: 22, lng: 120, matched: true }];
    const res = await (await routes()).googleMaps.POST(jsonRequest({ raw_input: '駁二藝術特區' }));
    assert.equal(res.status, 200);
    assert.equal((await res.json()).parsed_pois.length, 1);
  });
});

// ══════════════════════════════════ validation 仍為 400（未被蓋掉）

describe('Zod 驗證仍然回 400', () => {
  test('malformed JSON → 400', async () => {
    const res = await (await routes()).googleMaps.POST(
      new Request('http://localhost/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{bad json',
      })
    );
    assert.equal(res.status, 400);
    assert.equal(typeof (await res.json()).error, 'string');
  });

  test('座標超出範圍 → 400', async () => {
    const res = await (await routes()).aiPlan.POST(jsonRequest({ places: [{ name: 'x', lat: 999, lng: 0 }] }));
    assert.equal(res.status, 400);
  });

  test('validation 400 訊息不含 Zod 內部資訊', async () => {
    const res = await (await routes()).generate.POST(jsonRequest({ poi_list: [] }));
    assert.equal(res.status, 400);
    const json = JSON.stringify(await res.json());
    for (const needle of ['ZodError', 'issues', 'invalid_type', 'expected']) {
      assert.ok(!json.includes(needle), `不該包含 ${needle}`);
    }
  });
});
