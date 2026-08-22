// tests/unit/cors.test.ts
//
// CORS policy 迴歸測試。
//
// 重點不只是「允許的來源要能通」，更是「不該通的絕對不能通」——
// 前後綴繞道（http://localhost:5173.evil.com）是最容易寫錯的地方。
//
//   npm test

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ALLOWED_HEADERS,
  ALLOWED_METHODS,
  corsHeadersFor,
  decideCors,
  isOriginAllowed,
} from '@/server/api/cors';

const ALLOWED = 'http://localhost:5173';

// ══════════════════════════════ A：允許的 preflight ════════════════════════

describe('CORS A: 允許來源的 preflight', () => {
  test('OPTIONS 回 204', () => {
    const d = decideCors('OPTIONS', ALLOWED, ALLOWED);
    assert.equal(d.kind, 'preflight');
    assert.equal(d.kind === 'preflight' && d.status, 204);
  });

  test('帶回 Access-Control-Allow-Origin，且是具體來源不是 *', () => {
    const d = decideCors('OPTIONS', ALLOWED, ALLOWED);
    assert.equal(d.headers['Access-Control-Allow-Origin'], ALLOWED);
    assert.notEqual(d.headers['Access-Control-Allow-Origin'], '*');
  });

  test('帶回 Allow-Methods 與 Allow-Headers', () => {
    const d = decideCors('OPTIONS', ALLOWED, ALLOWED);
    assert.equal(d.headers['Access-Control-Allow-Methods'], ALLOWED_METHODS);
    assert.equal(d.headers['Access-Control-Allow-Headers'], ALLOWED_HEADERS);
  });

  test('只宣告實際會用到的 method（POST/OPTIONS），不多宣告', () => {
    assert.equal(ALLOWED_METHODS, 'POST, OPTIONS');
    for (const m of ['GET', 'PUT', 'DELETE', 'PATCH']) {
      assert.ok(!ALLOWED_METHODS.includes(m), `不應宣告 ${m}`);
    }
  });

  test('只宣告 Content-Type，沒有提前開放 Authorization', () => {
    assert.equal(ALLOWED_HEADERS, 'Content-Type');
    assert.ok(!ALLOWED_HEADERS.includes('Authorization'));
  });

  test('帶 Max-Age，讓瀏覽器可以快取 preflight', () => {
    const d = decideCors('OPTIONS', ALLOWED, ALLOWED);
    assert.ok(Number(d.headers['Access-Control-Max-Age']) > 0);
  });
});

// ══════════════════════════════ B：允許的 POST ═════════════════════════════

describe('CORS B: 允許來源的 POST', () => {
  test('不是 preflight，會交給 route handler 處理', () => {
    const d = decideCors('POST', ALLOWED, ALLOWED);
    assert.equal(d.kind, 'pass');
  });

  test('附上 Access-Control-Allow-Origin', () => {
    const d = decideCors('POST', ALLOWED, ALLOWED);
    assert.equal(d.headers['Access-Control-Allow-Origin'], ALLOWED);
  });

  test('附上 Vary: Origin，避免快取把回應發給別的來源', () => {
    const d = decideCors('POST', ALLOWED, ALLOWED);
    assert.equal(d.headers['Vary'], 'Origin');
  });

  test('不設 Allow-Credentials（目前沒有 cookie / session）', () => {
    const d = decideCors('POST', ALLOWED, ALLOWED);
    assert.equal(d.headers['Access-Control-Allow-Credentials'], undefined);
  });
});

// ══════════════════════════════ C：惡意來源 ════════════════════════════════

describe('CORS C: 不允許的來源', () => {
  test('evil.example 的 POST 仍會被處理，但不給 CORS 權限', () => {
    const d = decideCors('POST', 'https://evil.example', ALLOWED);
    assert.equal(d.kind, 'pass', 'CORS 不是認證，不改變 API 語意');
    assert.equal(d.headers['Access-Control-Allow-Origin'], undefined);
  });

  test('evil.example 的 preflight 回 204 但不給任何許可標頭', () => {
    const d = decideCors('OPTIONS', 'https://evil.example', ALLOWED);
    assert.equal(d.kind === 'preflight' && d.status, 204);
    assert.deepEqual(d.headers, {});
  });

  test('任何情況都不會出現 Access-Control-Allow-Origin: *', () => {
    for (const origin of [ALLOWED, 'https://evil.example', null, '', 'null']) {
      for (const method of ['POST', 'OPTIONS']) {
        const d = decideCors(method, origin, ALLOWED);
        assert.notEqual(d.headers['Access-Control-Allow-Origin'], '*');
      }
    }
  });
});

// ══════════════════════════════ D：前後綴繞道 ══════════════════════════════

describe('CORS D: 前綴／後綴／協定繞道一律拒絕', () => {
  const bypasses = [
    'http://localhost:5173.evil.com', // 後綴
    'http://evil-localhost:5173', // 前綴
    'http://localhost:5173.evil.com:5173',
    'https://localhost:5173', // 協定不同
    'http://localhost:51730', // 埠號被延長
    'http://localhost:517', // 埠號被截短
    'http://localhost', // 沒有埠
    'http://LOCALHOST:5173', // 大小寫不同
    'http://localhost:5173/', // 結尾斜線（合法 Origin 不會有）
    'http://localhost:5173 ', // 尾隨空白
    ' http://localhost:5173', // 前導空白
    'http://attacker.com#http://localhost:5173',
    'http://attacker.com?http://localhost:5173',
    'null',
  ];

  for (const origin of bypasses) {
    test(`拒絕 ${JSON.stringify(origin)}`, () => {
      assert.equal(isOriginAllowed(origin, ALLOWED), false);
      assert.equal(
        decideCors('POST', origin, ALLOWED).headers['Access-Control-Allow-Origin'],
        undefined
      );
    });
  }

  test('只有完全相同的字串才通過', () => {
    assert.equal(isOriginAllowed(ALLOWED, ALLOWED), true);
  });
});

// ══════════════════════════════ E：沒有 Origin ═════════════════════════════

describe('CORS E: 沒有 Origin 的請求（curl / server-to-server / contract test）', () => {
  test('POST 照常處理，只是不附 CORS 標頭', () => {
    for (const origin of [null, undefined, '']) {
      const d = decideCors('POST', origin, ALLOWED);
      assert.equal(d.kind, 'pass', 'API 本身不該因為沒有 Origin 就被擋');
      assert.deepEqual(d.headers, {});
    }
  });

  test('CORS 不是 API 認證 —— 沒有 Origin 不代表被拒絕', () => {
    const d = decideCors('POST', null, ALLOWED);
    assert.equal(d.kind, 'pass');
  });
});

// ══════════════════════════════ F：preflight 不碰 business logic ═══════════

describe('CORS F: OPTIONS 不進入 route handler', () => {
  test('不論來源是否獲准，OPTIONS 一律短路成 preflight', () => {
    for (const origin of [ALLOWED, 'https://evil.example', null, '']) {
      const d = decideCors('OPTIONS', origin, ALLOWED);
      assert.equal(
        d.kind,
        'preflight',
        'preflight 必須在 proxy 就結束，不能走到 Gemini / TDX / DB'
      );
    }
  });

  test('preflight 決策是純函式，不需要任何 I/O 就能算出來', () => {
    // 這條測試本身就是證明：整個檔案沒有 import 任何 service / repository /
    // integration，也沒有網路或資料庫存取，preflight 仍能得到完整結果。
    const d = decideCors('OPTIONS', ALLOWED, ALLOWED);
    assert.equal(d.kind === 'preflight' && d.status, 204);
  });
});

// ══════════════════════════════ 未設定 FRONTEND_ORIGIN ════════════════════

describe('CORS: 未設定 FRONTEND_ORIGIN 時的安全預設', () => {
  test('不開放任何來源，且不退回 *', () => {
    const d = decideCors('POST', ALLOWED, null);
    assert.deepEqual(d.headers, {});
    assert.notEqual(d.headers['Access-Control-Allow-Origin'], '*');
  });

  test('preflight 也不給許可', () => {
    const d = decideCors('OPTIONS', ALLOWED, null);
    assert.equal(d.kind === 'preflight' && d.status, 204);
    assert.deepEqual(d.headers, {});
  });

  test('API 本身仍可運作（pass），不會因為缺少設定就全部壞掉', () => {
    assert.equal(decideCors('POST', null, null).kind, 'pass');
  });
});

// ══════════════════════════════ corsHeadersFor ════════════════════════════

describe('corsHeadersFor', () => {
  test('回傳具體來源與四個標頭', () => {
    const h = corsHeadersFor(ALLOWED);
    assert.deepEqual(Object.keys(h).sort(), [
      'Access-Control-Allow-Headers',
      'Access-Control-Allow-Methods',
      'Access-Control-Allow-Origin',
      'Vary',
    ]);
    assert.equal(h['Access-Control-Allow-Origin'], ALLOWED);
  });
});
