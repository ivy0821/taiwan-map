// tests/unit/validation.test.ts
//
// server/api/validation.ts 的測試。純函式、完全離線。
//
//   npm test

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ValidationError,
  parseAiPlanWithParkingRequest,
  parseImportGoogleMapsRequest,
  parseInsertParkingParams,
  parseParkingLiveRequest,
  parseTripGenerateRequest,
  readJsonBody,
} from '@/server/api/validation';
import { limits } from '@/server/config';

/** 斷言某個輸入會被擋下來，並且錯誤訊息不含任何 schema 內部細節 */
function expectRejected(fn: () => unknown, label: string) {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof ValidationError, `${label} 應該被擋下來`);
  const message = (thrown as ValidationError).message;
  // 不可外洩 Zod / schema 內部資訊
  for (const leak of ['ZodError', 'invalid_type', 'expected', 'issues', 'zod', 'undefined']) {
    assert.ok(
      !message.toLowerCase().includes(leak.toLowerCase()),
      `${label} 的錯誤訊息不該含 "${leak}"：${message}`
    );
  }
  assert.ok(message.length > 0 && message.length < 80, `${label} 的訊息應該簡潔`);
}

const VALID_PLACE = { name: '駁二藝術特區', lat: 22.6201, lng: 120.2818 };
const VALID_POI = { poi_name: '駁二藝術特區', lat: 22.6201, lng: 120.2818 };

// ══════════════════════════════════════════════ import/google-maps

describe('validation: import/google-maps', () => {
  test('PASS: 一般地名', () => {
    assert.deepEqual(parseImportGoogleMapsRequest({ raw_input: '駁二藝術特區' }), {
      raw_input: '駁二藝術特區',
    });
  });

  test('PASS: Google Maps 網址', () => {
    const url = 'https://www.google.com/maps/place/%E9%A7%81%E4%BA%8C/@22.62,120.28,17z';
    assert.equal(parseImportGoogleMapsRequest({ raw_input: url }).raw_input, url);
  });

  test('PASS: 前後空白會被 trim', () => {
    assert.equal(parseImportGoogleMapsRequest({ raw_input: '  駁二  ' }).raw_input, '駁二');
  });

  const bad: [string, unknown][] = [
    ['缺少 raw_input', {}],
    ['空字串', { raw_input: '' }],
    ['只有空白', { raw_input: '   ' }],
    ['數字', { raw_input: 123 }],
    ['null', { raw_input: null }],
    ['陣列', { raw_input: ['a'] }],
    ['物件', { raw_input: { a: 1 } }],
    ['布林', { raw_input: true }],
    ['body 不是物件', 'raw_input=x'],
    ['body 是 null', null],
    ['body 是陣列', []],
  ];
  for (const [label, input] of bad) {
    test(`FAIL: ${label}`, () => expectRejected(() => parseImportGoogleMapsRequest(input), label));
  }

  test('FAIL: 超過長度上限', () => {
    expectRejected(
      () => parseImportGoogleMapsRequest({ raw_input: 'x'.repeat(limits.maxRawInputLength + 1) }),
      '過長 raw_input'
    );
  });

  test('PASS: 剛好等於長度上限', () => {
    const input = 'x'.repeat(limits.maxRawInputLength);
    assert.equal(parseImportGoogleMapsRequest({ raw_input: input }).raw_input, input);
  });

  test('FAIL: 多送未知欄位（strict）', () => {
    expectRejected(
      () => parseImportGoogleMapsRequest({ raw_input: '駁二', evil: 'x' }),
      '未知欄位'
    );
  });
});

// ══════════════════════════════════════════════════════ parking/live

describe('validation: parking/live', () => {
  test('PASS: 空陣列仍是合法輸入', () => {
    assert.deepEqual(parseParkingLiveRequest({ parkingIds: [] }), { parkingIds: [] });
  });

  test('PASS: 單一 ID', () => {
    assert.deepEqual(parseParkingLiveRequest({ parkingIds: ['KHA00001'] }).parkingIds, [
      'KHA00001',
    ]);
  });

  test('PASS: 多個 ID', () => {
    const ids = ['KHA00001', 'KHA00002', 'KHB00383'];
    assert.deepEqual(parseParkingLiveRequest({ parkingIds: ids }).parkingIds, ids);
  });

  test('PASS: ID 前後空白會被 trim', () => {
    assert.deepEqual(parseParkingLiveRequest({ parkingIds: ['  KHA00001 '] }).parkingIds, [
      'KHA00001',
    ]);
  });

  test('PASS: 剛好等於數量上限', () => {
    const ids = Array.from({ length: limits.maxParkingIds }, (_, i) => `ID${i}`);
    assert.equal(parseParkingLiveRequest({ parkingIds: ids }).parkingIds.length, limits.maxParkingIds);
  });

  const bad: [string, unknown][] = [
    ['缺少 parkingIds', {}],
    ['不是陣列', { parkingIds: 'KHA00001' }],
    ['null', { parkingIds: null }],
    ['陣列含數字', { parkingIds: ['KHA00001', 123] }],
    ['陣列含 null', { parkingIds: [null] }],
    ['陣列含物件', { parkingIds: [{ id: 'x' }] }],
    ['陣列含空字串', { parkingIds: [''] }],
    ['陣列含純空白', { parkingIds: ['   '] }],
    ['多送未知欄位', { parkingIds: [], evil: '...' }],
  ];
  for (const [label, input] of bad) {
    test(`FAIL: ${label}`, () => expectRejected(() => parseParkingLiveRequest(input), label));
  }

  test('FAIL: ID 過長', () => {
    expectRejected(
      () => parseParkingLiveRequest({ parkingIds: ['x'.repeat(limits.maxParkingIdLength + 1)] }),
      '過長 ID'
    );
  });

  test('FAIL: ID 數量超過上限', () => {
    const ids = Array.from({ length: limits.maxParkingIds + 1 }, (_, i) => `ID${i}`);
    expectRejected(() => parseParkingLiveRequest({ parkingIds: ids }), '過多 ID');
  });

  // OData 注入字串本身是合法字串，應該通過 Zod，由 TDX integration 負責跳脫
  test('PASS: 含引號的 ID 交由 integration 跳脫（defense in depth）', () => {
    const payload = "' or CarParkID ne '";
    assert.deepEqual(parseParkingLiveRequest({ parkingIds: [payload] }).parkingIds, [payload]);
  });
});

// ═══════════════════════════════════════════ ai-plan-with-parking

describe('validation: ai-plan-with-parking', () => {
  test('PASS: 單一景點', () => {
    assert.deepEqual(parseAiPlanWithParkingRequest({ places: [VALID_PLACE] }).places, [VALID_PLACE]);
  });

  test('PASS: 多個景點', () => {
    const places = [VALID_PLACE, { name: '旗津天后宮', lat: 22.6137, lng: 120.2678 }];
    assert.equal(parseAiPlanWithParkingRequest({ places }).places.length, 2);
  });

  test('PASS: 邊界座標 (±90 / ±180)', () => {
    const places = [
      { name: '北極', lat: 90, lng: 180 },
      { name: '南極', lat: -90, lng: -180 },
    ];
    assert.equal(parseAiPlanWithParkingRequest({ places }).places.length, 2);
  });

  const bad: [string, unknown][] = [
    ['缺少 places', {}],
    ['places 為空陣列', { places: [] }],
    ['places 不是陣列', { places: VALID_PLACE }],
    ['lat > 90', { places: [{ ...VALID_PLACE, lat: 90.1 }] }],
    ['lat < -90', { places: [{ ...VALID_PLACE, lat: -90.1 }] }],
    ['lng > 180', { places: [{ ...VALID_PLACE, lng: 180.1 }] }],
    ['lng < -180', { places: [{ ...VALID_PLACE, lng: -180.1 }] }],
    ['lat 是 NaN', { places: [{ ...VALID_PLACE, lat: NaN }] }],
    ['lat 是 Infinity', { places: [{ ...VALID_PLACE, lat: Infinity }] }],
    ['lng 是 -Infinity', { places: [{ ...VALID_PLACE, lng: -Infinity }] }],
    ['座標是字串 "22.6"', { places: [{ ...VALID_PLACE, lat: '22.6' }] }],
    ['座標是 null', { places: [{ ...VALID_PLACE, lat: null }] }],
    ['缺少 lat', { places: [{ name: 'x', lng: 120 }] }],
    ['name 為空字串', { places: [{ ...VALID_PLACE, name: '' }] }],
    ['name 為純空白', { places: [{ ...VALID_PLACE, name: '   ' }] }],
    ['name 是數字', { places: [{ ...VALID_PLACE, name: 123 }] }],
    ['place 多送未知欄位', { places: [{ ...VALID_PLACE, evil: 1 }] }],
    ['最外層多送未知欄位', { places: [VALID_PLACE], evil: 1 }],
  ];
  for (const [label, input] of bad) {
    test(`FAIL: ${label}`, () => expectRejected(() => parseAiPlanWithParkingRequest(input), label));
  }

  test('FAIL: 景點數超過上限', () => {
    const places = Array.from({ length: limits.maxPlaces + 1 }, () => VALID_PLACE);
    expectRejected(() => parseAiPlanWithParkingRequest({ places }), '過多景點');
  });

  test('PASS: 剛好等於景點數上限', () => {
    const places = Array.from({ length: limits.maxPlaces }, () => VALID_PLACE);
    assert.equal(parseAiPlanWithParkingRequest({ places }).places.length, limits.maxPlaces);
  });

  test('FAIL: name 超過長度上限', () => {
    expectRejected(
      () =>
        parseAiPlanWithParkingRequest({
          places: [{ ...VALID_PLACE, name: 'x'.repeat(limits.maxPlaceNameLength + 1) }],
        }),
      '過長名稱'
    );
  });
});

// ════════════════════════════════════════════════════ trip/generate

describe('validation: trip/generate', () => {
  test('PASS: prompt + poi_list', () => {
    const parsed = parseTripGenerateRequest({
      prompt: '輕鬆高雄一日遊',
      poi_list: [VALID_POI],
    });
    assert.equal(parsed.prompt, '輕鬆高雄一日遊');
    assert.equal(parsed.poi_list.length, 1);
  });

  test('PASS: 省略 prompt（既有合法請求，交由 Gemini 用預設偏好）', () => {
    const parsed = parseTripGenerateRequest({ poi_list: [VALID_POI] });
    assert.equal(parsed.prompt, undefined);
  });

  test('PASS: 邊界座標', () => {
    const parsed = parseTripGenerateRequest({
      poi_list: [{ poi_name: 'x', lat: -90, lng: 180 }],
    });
    assert.equal(parsed.poi_list[0].lat, -90);
  });

  const bad: [string, unknown][] = [
    ['缺少 poi_list', { prompt: 'x' }],
    ['poi_list 為空陣列', { poi_list: [] }],
    ['poi_list 不是陣列', { poi_list: VALID_POI }],
    ['prompt 是空字串', { prompt: '', poi_list: [VALID_POI] }],
    ['prompt 是純空白', { prompt: '   ', poi_list: [VALID_POI] }],
    ['prompt 是數字', { prompt: 123, poi_list: [VALID_POI] }],
    ['poi_name 為空', { poi_list: [{ ...VALID_POI, poi_name: '' }] }],
    ['lat > 90', { poi_list: [{ ...VALID_POI, lat: 91 }] }],
    ['lng < -180', { poi_list: [{ ...VALID_POI, lng: -181 }] }],
    ['座標是字串', { poi_list: [{ ...VALID_POI, lat: '22.6' }] }],
    ['NaN 座標', { poi_list: [{ ...VALID_POI, lng: NaN }] }],
    ['使用了 name 而非 poi_name', { poi_list: [VALID_PLACE] }],
    ['多送未知欄位', { poi_list: [VALID_POI], evil: 1 }],
  ];
  for (const [label, input] of bad) {
    test(`FAIL: ${label}`, () => expectRejected(() => parseTripGenerateRequest(input), label));
  }

  test('FAIL: prompt 超過長度上限', () => {
    expectRejected(
      () =>
        parseTripGenerateRequest({
          prompt: 'x'.repeat(limits.maxPromptLength + 1),
          poi_list: [VALID_POI],
        }),
      '過長 prompt'
    );
  });

  test('FAIL: poi_list 超過數量上限', () => {
    const poi_list = Array.from({ length: limits.maxPlaces + 1 }, () => VALID_POI);
    expectRejected(() => parseTripGenerateRequest({ poi_list }), '過多 POI');
  });
});

// ═══════════════════════════════════════════ insert-parking params

describe('validation: insert-parking tripId', () => {
  test('PASS: 合法 UUID', () => {
    const id = '35ec1d51-7f86-4487-833e-3977f5948694';
    assert.equal(parseInsertParkingParams(id), id);
  });

  const bad: [string, unknown][] = [
    ['abc', 'abc'],
    ['空字串', ''],
    ['格式不完整的 UUID', '35ec1d51-7f86-4487-833e-3977f594869'],
    ['多一段的 UUID', '35ec1d51-7f86-4487-833e-3977f5948694-extra'],
    ['數字', 123],
    ['null', null],
    ['undefined', undefined],
    ['SQL 注入字串', "' OR 1=1 --"],
    ['路徑穿越字串', '../../etc/passwd'],
  ];
  for (const [label, input] of bad) {
    test(`FAIL: ${label}`, () => expectRejected(() => parseInsertParkingParams(input), label));
  }
});

// ══════════════════════════════════════════════════ malformed JSON

describe('validation: readJsonBody', () => {
  const makeRequest = (body: string) =>
    new Request('http://localhost/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

  test('PASS: 合法 JSON', async () => {
    assert.deepEqual(await readJsonBody(makeRequest('{"a":1}')), { a: 1 });
  });

  test('FAIL: 壞掉的 JSON 丟 ValidationError（→ 400，不是 500）', async () => {
    await assert.rejects(
      () => readJsonBody(makeRequest('{bad json')),
      (error: unknown) => error instanceof ValidationError
    );
  });

  test('FAIL: 空 body', async () => {
    await assert.rejects(
      () => readJsonBody(makeRequest('')),
      (error: unknown) => error instanceof ValidationError
    );
  });

  test('錯誤訊息不外洩 parser 內部細節', async () => {
    try {
      await readJsonBody(makeRequest('{bad json'));
      assert.fail('should have thrown');
    } catch (error) {
      const message = (error as Error).message;
      assert.ok(!message.includes('JSON.parse'));
      assert.ok(!message.toLowerCase().includes('unexpected token'));
    }
  });
});
