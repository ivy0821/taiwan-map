// tests/unit/availability.test.ts
//
// P1-1 迴歸測試：available_spaces 的「未知」語意。
//
// 系統裡有兩種表示法，這個檔案就是在鎖住兩者的邊界：
//   external / persistence  -1   = 無有效即時資料（TDX 回應、DB 欄位 DEFAULT）
//   application / API       null = 未知
//
// 最重要的一條規則：
//   0    = 已知目前沒有空位（滿了）
//   null = 不知道目前有幾個空位
// 這兩者永遠不可以互換，也不可以用 truthiness 判斷（兩個都是 falsy）。
//
//   npm test

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeAvailableSpaces } from '@/server/types/parking';
import { toCandidateParking } from '@/server/services/parking.service';
import { getParkingAvailability } from '@/server/integrations/tdx';
import type { NearbyParking } from '@/server/types/parking';
import { availabilityLabel, availabilityStatus } from '../../components/availabilityLabel';

function parkingRow(overrides: Partial<NearbyParking> = {}): NearbyParking {
  return {
    parking_id: 'KHA00001',
    name: '測試停車場',
    total_spaces: 100,
    available_spaces: 40,
    hourly_rate: '20',
    fare_description: '每小時 20 元',
    lat: 22.6,
    lng: 120.3,
    distance_meters: 800,
    ...overrides,
  };
}

// ══════════════════════════════ A / B / C / D：normalization ══════════════

describe('P1-1 A: 正常車位數原樣保留', () => {
  test('TDX AvailableSpaces = 25 → 25', () => {
    assert.equal(normalizeAvailableSpaces(25), 25);
  });

  test('大數值不受影響', () => {
    assert.equal(normalizeAvailableSpaces(9999), 9999);
  });
});

describe('P1-1 B: 已滿（0）不可被轉成 null', () => {
  test('TDX AvailableSpaces = 0 → 0，不是 null', () => {
    const result = normalizeAvailableSpaces(0);
    assert.equal(result, 0);
    assert.notEqual(result, null);
  });

  test('0 通過 normalize 後仍然是 number 型別', () => {
    assert.equal(typeof normalizeAvailableSpaces(0), 'number');
  });
});

describe('P1-1 C: 未知（-1）轉成 null', () => {
  test('TDX AvailableSpaces = -1 → null', () => {
    assert.equal(normalizeAvailableSpaces(-1), null);
  });

  test('-1 不可以被轉成 0（那會把「不知道」偽裝成「已滿」）', () => {
    assert.notEqual(normalizeAvailableSpaces(-1), 0);
  });

  test('null / undefined 輸入仍是 null', () => {
    assert.equal(normalizeAvailableSpaces(null), null);
    assert.equal(normalizeAvailableSpaces(undefined), null);
  });
});

describe('P1-1 D: 防禦性負數', () => {
  // TDX 文件上的哨兵值只有 -1，但負數本來就不是合法的車位數。
  // 與其把 -2 當成真實數字往下傳，一律視為「沒有有效資料」。
  test('-2 → null（任何負數都當成未知，而不是照傳）', () => {
    assert.equal(normalizeAvailableSpaces(-2), null);
  });

  test('-999 → null', () => {
    assert.equal(normalizeAvailableSpaces(-999), null);
  });

  test('負數一律不 clamp 成 0', () => {
    for (const v of [-1, -2, -999]) {
      assert.notEqual(normalizeAvailableSpaces(v), 0, `${v} 不可以變成 0`);
    }
  });

  test('NaN / Infinity → null', () => {
    assert.equal(normalizeAvailableSpaces(NaN), null);
    assert.equal(normalizeAvailableSpaces(Infinity), null);
    assert.equal(normalizeAvailableSpaces(-Infinity), null);
  });
});

// ══════════════ C（端到端）：真的走一次 TDX 解析路徑 ═══════════════════════
//
// 上面測的是 normalize 函式本身，這裡證明「TDX 回應 → integration 產出」
// 這條真實路徑確實有套用正規化 —— 完全離線，不消耗 TDX 每分鐘 5 次的額度。

describe('P1-1 C(端到端): TDX 回應經過 integration 後不再有 -1', () => {
  const fakeTdxResponse = async (records: unknown[]) => {
    const originalFetch = globalThis.fetch;
    const originalEnv = {
      id: process.env.TDX_CLIENT_ID,
      secret: process.env.TDX_CLIENT_SECRET,
    };
    process.env.TDX_CLIENT_ID = 'test-id';
    process.env.TDX_CLIENT_SECRET = 'test-secret';

    // token 快取掛在 globalThis，測試前後都清掉避免污染其他測試
    const g = globalThis as Record<string, unknown>;
    const savedToken = g.__tdxToken;
    delete g.__tdxToken;
    delete g.__tdxTokenInflight;

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('openid-connect/token')) {
        return new Response(JSON.stringify({ access_token: 'fake-token', expires_in: 3600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ParkingAvailabilities: records }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      return await getParkingAvailability(['P_UNKNOWN', 'P_FULL', 'P_OPEN']);
    } finally {
      globalThis.fetch = originalFetch;
      process.env.TDX_CLIENT_ID = originalEnv.id;
      process.env.TDX_CLIENT_SECRET = originalEnv.secret;
      delete g.__tdxTokenInflight;
      if (savedToken === undefined) delete g.__tdxToken;
      else g.__tdxToken = savedToken;
    }
  };

  test('AvailableSpaces 為 -1 / 0 / 25 時，分別得到 null / 0 / 25', async () => {
    const { availabilities, upstreamOk } = await fakeTdxResponse([
      { CarParkID: 'P_UNKNOWN', AvailableSpaces: -1, TotalSpaces: 50 },
      { CarParkID: 'P_FULL', AvailableSpaces: 0, TotalSpaces: 50 },
      { CarParkID: 'P_OPEN', AvailableSpaces: 25, TotalSpaces: 50 },
    ]);

    assert.equal(upstreamOk, true);
    assert.equal(availabilities.get('P_UNKNOWN')!.availableSpaces, null, '-1 必須變成 null');
    assert.equal(availabilities.get('P_FULL')!.availableSpaces, 0, '0 必須保留為 0');
    assert.equal(availabilities.get('P_OPEN')!.availableSpaces, 25);
  });

  test('integration 產出的所有 availableSpaces 都不是負數', async () => {
    const { availabilities } = await fakeTdxResponse([
      { CarParkID: 'P_UNKNOWN', AvailableSpaces: -1 },
      { CarParkID: 'P_FULL', AvailableSpaces: -2 },
      { CarParkID: 'P_OPEN', AvailableSpaces: 7 },
    ]);

    for (const [id, info] of availabilities) {
      const v = info.availableSpaces;
      assert.ok(v === null || v >= 0, `${id} 仍是負數：${v}`);
    }
  });
});

// ══════════════════════════════ F：truthiness 防呆 ═════════════════════════

describe('P1-1 F: 0 與 null 必須被分開處理', () => {
  test('0 !== null（若哪天有人用 truthiness 就會壞在這裡）', () => {
    assert.notEqual(normalizeAvailableSpaces(0), normalizeAvailableSpaces(-1));
    assert.equal(normalizeAvailableSpaces(0), 0);
    assert.equal(normalizeAvailableSpaces(-1), null);
  });

  test('0 和 null 都是 falsy —— 這正是不能用 if (!v) 的原因', () => {
    const full = normalizeAvailableSpaces(0); // 已知沒有空位
    const unknown = normalizeAvailableSpaces(-1); // 不知道有幾個空位

    // truthiness 完全分不出這兩者 —— 用 if (!v) 就會把「已滿」誤判成「未知」
    assert.ok(!full);
    assert.ok(!unknown);

    // 但它們的產品語意完全不同，明確比較就分得出來
    assert.notEqual(full, unknown);
    assert.notEqual(availabilityStatus(full), availabilityStatus(unknown));
    assert.equal(availabilityStatus(full), 'full');
    assert.equal(availabilityStatus(unknown), 'unknown');
  });

  test('service 合併時 0 不會被快取值蓋掉', () => {
    // 即時回報 0（已滿），快取是 40 —— 必須採用 0
    const c = toCandidateParking(parkingRow({ available_spaces: 40 }), 0);
    assert.equal(c.available_spaces, 0);
  });

  test('即時未知（null）時沿用快取值', () => {
    const c = toCandidateParking(parkingRow({ available_spaces: 40 }), null);
    assert.equal(c.available_spaces, 40);
  });

  test('即時未知且快取也未知 → null，不是 -1', () => {
    const c = toCandidateParking(parkingRow({ available_spaces: null }), null);
    assert.equal(c.available_spaces, null);
  });

  test('快取為 0（已滿）且即時未回報 → 保留 0', () => {
    const c = toCandidateParking(parkingRow({ available_spaces: 0 }), undefined);
    assert.equal(c.available_spaces, 0);
  });
});

// ══════════════════════════════ E：frontend rendering ═════════════════════

describe('P1-1 E: 前端顯示', () => {
  test('null → 「尚無動態」，不顯示 null/undefined', () => {
    assert.equal(availabilityLabel(null), '尚無動態');
    assert.equal(availabilityStatus(null), 'unknown');
  });

  test('undefined → 「尚無動態」', () => {
    assert.equal(availabilityLabel(undefined), '尚無動態');
  });

  test('0 → 「0 格」且狀態為 full（已滿），不是 unknown', () => {
    assert.equal(availabilityLabel(0), '0 格');
    assert.equal(availabilityStatus(0), 'full');
  });

  test('15 → 「15 格」且狀態為 available', () => {
    assert.equal(availabilityLabel(15), '15 格');
    assert.equal(availabilityStatus(15), 'available');
  });

  test('永遠不會顯示「-1 格」（即使後端迴歸送出 -1）', () => {
    assert.equal(availabilityLabel(-1), '尚無動態');
    assert.equal(availabilityStatus(-1), 'unknown');
  });

  test('任何輸入都不會讓畫面出現 undefined / null / 負號', () => {
    for (const v of [null, undefined, -1, -2, 0, 3, 250]) {
      const label = availabilityLabel(v);
      assert.ok(!label.includes('undefined'), `${v} → ${label}`);
      assert.ok(!label.includes('null'), `${v} → ${label}`);
      assert.ok(!label.includes('-'), `${v} → ${label}`);
    }
  });
});

// ══════════════════════════════ G：API contract 值域 ══════════════════════

describe('P1-1 G: API 值域為 Record<string, number | null>', () => {
  // 模擬 getLiveAvailability 組出來的 response 物件
  const buildResponse = (raw: Record<string, number | null>): Record<string, number | null> => {
    const out: Record<string, number | null> = {};
    for (const [id, v] of Object.entries(raw)) out[id] = normalizeAvailableSpaces(v);
    return out;
  };

  test('混合輸入後，值域只有 null 或 >= 0 的 number', () => {
    const response = buildResponse({ A: -1, B: 0, C: 25, D: null, E: -2 });

    assert.deepEqual(response, { A: null, B: 0, C: 25, D: null, E: null });

    for (const [id, v] of Object.entries(response)) {
      assert.ok(v === null || (typeof v === 'number' && v >= 0), `${id} 的值不合法：${v}`);
    }
  });

  test('response 中不存在任何負數', () => {
    const response = buildResponse({ A: -1, B: -2, C: 5 });
    const negatives = Object.values(response).filter((v) => typeof v === 'number' && v < 0);
    assert.deepEqual(negatives, []);
  });

  test('未知值用 null，不使用 "unknown" 字串、-1 或 undefined', () => {
    const response = buildResponse({ A: -1 });
    assert.equal(response.A, null);
    assert.notEqual(response.A as unknown, 'unknown');
    assert.notEqual(response.A as unknown, -1);
    assert.ok('A' in response, 'key 必須保留，不可以整個省略成 undefined');
  });

  test('JSON 序列化後未知值是 null（key 不會消失）', () => {
    const json = JSON.stringify({ availabilities: buildResponse({ A: -1, B: 3 }) });
    assert.equal(json, '{"availabilities":{"A":null,"B":3}}');
  });
});
