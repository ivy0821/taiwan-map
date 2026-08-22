// tests/unit/ssrf.test.ts
//
// C6 SSRF 迴歸測試。
//
// 全部離線：轉址鏈用假的 fetch 模擬，
// 【不會】對真實的 private / metadata 位址發出任何請求。
//
//   npm test

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  UnsafeUrlError,
  assertSafeGoogleMapsUrl,
  extractCoordinatesFromUrl,
  geocodePlaceName,
  looksLikeUrl,
  resolveGoogleMapsUrl,
} from '@/server/integrations/geocoding';

/** 建立一個回傳指定轉址鏈的假 fetch，並記錄實際被請求的每個 URL */
function fakeFetch(script: Record<string, { status: number; location?: string }>) {
  const requested: string[] = [];
  const fn = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requested.push(url);
    const step = script[url] ?? { status: 200 };
    const headers = new Headers();
    if (step.location) headers.set('location', step.location);
    return new Response(null, { status: step.status, headers });
  }) as typeof fetch;
  return { fetch: fn, requested };
}

const MAPS_URL =
  'https://www.google.com/maps/place/x/@22.6,120.2,17z/data=!3m1!4b1!4m6!3m5!8m2!3d22.6201!4d120.2818';

// ═══════════════════════════════════════════════ URL 安全驗證（單元）

describe('SSRF: assertSafeGoogleMapsUrl 允許的網址', () => {
  const allowed = [
    'https://www.google.com/maps/place/x',
    'https://google.com/maps',
    'https://maps.google.com/?q=1,2',
    'https://maps.app.goo.gl/abc123',
    'https://www.google.com:443/maps', // 明寫預設埠
    'https://www.google.com./maps', // 結尾的 DNS root 點
    'https://WWW.GOOGLE.COM/maps', // 大小寫
  ];
  for (const url of allowed) {
    test(`PASS ${url}`, () => {
      assert.ok(assertSafeGoogleMapsUrl(url) instanceof URL);
    });
  }
});

describe('SSRF: assertSafeGoogleMapsUrl 必須拒絕的網址', () => {
  const blocked: [string, string][] = [
    // ── 這一條就是原始的 C6 攻擊字串 ──
    ['雲端 metadata（字串含 google.com/maps）', 'http://169.254.169.254/latest/meta-data/#google.com/maps'],
    ['loopback', 'http://127.0.0.1/google.com/maps'],
    ['loopback https', 'https://127.0.0.1/maps'],
    ['私有網段', 'https://10.0.0.1/maps'],
    ['私有網段 172', 'https://172.16.0.1/maps'],
    ['私有網段 192', 'https://192.168.1.1/maps'],
    ['IPv6 loopback', 'https://[::1]/maps'],
    ['IPv6 mapped', 'https://[0:0:0:0:0:ffff:127.0.0.1]/maps'],
    ['十進位 IP（正規化後為 127.0.0.1）', 'http://2130706433/'],
    ['十六進位 IP', 'http://0x7f000001/'],
    ['localhost', 'https://localhost/maps'],
    ['.local 主機', 'https://printer.local/maps'],
    ['路徑裡含 google.com/maps 的他站', 'https://evil.com/google.com/maps'],
    ['前綴混淆', 'https://google.com.evil.com/maps'],
    ['後綴混淆', 'https://evilgoogle.com/maps'],
    ['子網域混淆', 'https://www.google.com.evil.com/maps'],
    ['userinfo 混淆', 'https://www.google.com@evil.com/maps'],
    ['file 協定', 'file:///etc/passwd'],
    ['ftp 協定', 'ftp://google.com/maps'],
    ['javascript 協定', 'javascript:alert(1)'],
    ['data 協定', 'data:text/html,<h1>x</h1>'],
    ['明文 http', 'http://www.google.com/maps'],
    ['非預設埠', 'https://www.google.com:8080/maps'],
    ['不是網址', '駁二藝術特區'],
    ['未允許的 goo.gl 子網域', 'https://goo.gl/maps/abc'],
    ['未允許的 Google 子網域', 'https://accounts.google.com/maps'],
  ];

  for (const [label, url] of blocked) {
    test(`BLOCK ${label}`, () => {
      assert.throws(
        () => assertSafeGoogleMapsUrl(url),
        (error: unknown) => error instanceof UnsafeUrlError,
        `${label} 應該被拒絕: ${url}`
      );
    });
  }
});

// ═══════════════════════════════════════════════ 不會發出任何請求

describe('SSRF: 被拒絕的網址不得產生任何 outbound request', () => {
  const payloads = [
    'http://169.254.169.254/latest/meta-data/#google.com/maps',
    'http://127.0.0.1/google.com/maps',
    'https://evil.com/google.com/maps',
    'file:///etc/passwd',
  ];

  for (const payload of payloads) {
    test(`零請求：${payload.slice(0, 48)}`, async () => {
      const { fetch: fakeFn, requested } = fakeFetch({});
      await assert.rejects(
        () => resolveGoogleMapsUrl(payload, { fetch: fakeFn }),
        (error: unknown) => error instanceof UnsafeUrlError
      );
      assert.deepEqual(requested, [], '不可以對被拒絕的網址發出請求');
    });
  }
});

// ═══════════════════════════════════════════════════ 轉址安全

describe('SSRF: 轉址鏈驗證', () => {
  test('允許的 host → 允許的 host，可以繼續跟隨', async () => {
    const start = 'https://maps.app.goo.gl/abc';
    const { fetch: fakeFn, requested } = fakeFetch({
      [start]: { status: 302, location: 'https://maps.google.com/maps?q=1' },
      'https://maps.google.com/maps?q=1': { status: 302, location: MAPS_URL },
      [MAPS_URL]: { status: 200 },
    });

    const result = await resolveGoogleMapsUrl(start, { fetch: fakeFn });
    assert.deepEqual(result, { lat: 22.6201, lng: 120.2818, name: 'Google Maps 匯入地點' });
    assert.equal(requested.length, 3);
  });

  test('轉址到 metadata IP 必須被拒絕，且不得請求該位址', async () => {
    const start = 'https://maps.app.goo.gl/evil';
    const { fetch: fakeFn, requested } = fakeFetch({
      [start]: { status: 302, location: 'http://169.254.169.254/latest/meta-data/' },
    });

    await assert.rejects(
      () => resolveGoogleMapsUrl(start, { fetch: fakeFn }),
      (error: unknown) => error instanceof UnsafeUrlError
    );
    assert.deepEqual(requested, [start], '只能請求第一跳，絕不能跟到 169.254.169.254');
  });

  test('轉址到外部網域必須被拒絕', async () => {
    const start = 'https://maps.app.goo.gl/evil2';
    const { fetch: fakeFn, requested } = fakeFetch({
      [start]: { status: 302, location: 'https://evil.com/steal' },
    });
    await assert.rejects(
      () => resolveGoogleMapsUrl(start, { fetch: fakeFn }),
      (error: unknown) => error instanceof UnsafeUrlError
    );
    assert.deepEqual(requested, [start]);
  });

  test('相對 Location 若跳到別的 host 也要被擋（//169.254.169.254/x）', async () => {
    const start = 'https://maps.app.goo.gl/rel';
    const { fetch: fakeFn, requested } = fakeFetch({
      [start]: { status: 302, location: '//169.254.169.254/x' },
    });
    await assert.rejects(
      () => resolveGoogleMapsUrl(start, { fetch: fakeFn }),
      (error: unknown) => error instanceof UnsafeUrlError
    );
    assert.deepEqual(requested, [start]);
  });

  test('同 host 的相對 Location 可以正常跟隨', async () => {
    const start = 'https://maps.app.goo.gl/rel2';
    const { fetch: fakeFn } = fakeFetch({
      [start]: { status: 302, location: '/maps/place/x/data=!3d22.5!4d120.5' },
      'https://maps.app.goo.gl/maps/place/x/data=!3d22.5!4d120.5': { status: 200 },
    });
    const result = await resolveGoogleMapsUrl(start, { fetch: fakeFn });
    assert.deepEqual(result, { lat: 22.5, lng: 120.5, name: 'Google Maps 匯入地點' });
  });

  test('轉址次數超過上限時安全失敗', async () => {
    const start = 'https://maps.app.goo.gl/loop';
    // 自己指向自己，製造無限轉址
    const { fetch: fakeFn, requested } = fakeFetch({
      [start]: { status: 302, location: start },
    });
    await assert.rejects(
      () => resolveGoogleMapsUrl(start, { fetch: fakeFn }),
      (error: unknown) => error instanceof UnsafeUrlError
    );
    assert.ok(requested.length <= 6, `不可無限跟隨，實際請求 ${requested.length} 次`);
  });

  test('轉址但沒有 Location 標頭 → 視為查無結果，不丟例外', async () => {
    const start = 'https://maps.app.goo.gl/noloc';
    const { fetch: fakeFn } = fakeFetch({ [start]: { status: 302 } });
    assert.equal(await resolveGoogleMapsUrl(start, { fetch: fakeFn }), null);
  });

  test('上游 404 → 查無結果（不是輸入問題）', async () => {
    const start = 'https://maps.app.goo.gl/missing';
    const { fetch: fakeFn } = fakeFetch({ [start]: { status: 404 } });
    assert.equal(await resolveGoogleMapsUrl(start, { fetch: fakeFn }), null);
  });

  test('網路錯誤 → 查無結果，不外洩例外', async () => {
    const failing = (async () => {
      throw new Error('ECONNREFUSED 10.0.0.5:443');
    }) as typeof fetch;
    assert.equal(
      await resolveGoogleMapsUrl('https://maps.app.goo.gl/x', { fetch: failing }),
      null
    );
  });
});

// ═══════════════════════════════════════════════ 座標抽取順序

describe('座標抽取：!3d/!4d 優先於 @lat,lng', () => {
  test('同時存在時採用 !3d/!4d（地點座標，而非地圖中心）', () => {
    const url =
      'https://www.google.com/maps/place/x/@22.9999,120.9999,17z/data=!4m6!3m5!8m2!3d22.6201!4d120.2818';
    assert.deepEqual(extractCoordinatesFromUrl(url), { lat: 22.6201, lng: 120.2818 });
  });

  test('只有 @lat,lng 時退回使用它', () => {
    const url = 'https://www.google.com/maps/place/x/@22.6201,120.2818,17z';
    assert.deepEqual(extractCoordinatesFromUrl(url), { lat: 22.6201, lng: 120.2818 });
  });

  test('負座標', () => {
    assert.deepEqual(extractCoordinatesFromUrl('https://x/!3d-33.8688!4d151.2093'), {
      lat: -33.8688,
      lng: 151.2093,
    });
  });

  test('整數座標也能解析', () => {
    assert.deepEqual(extractCoordinatesFromUrl('https://x/!3d22!4d120'), { lat: 22, lng: 120 });
  });

  test('沒有座標時回 null', () => {
    assert.equal(extractCoordinatesFromUrl('https://www.google.com/maps'), null);
  });

  test('超出合理範圍的座標視為解析失敗', () => {
    assert.equal(extractCoordinatesFromUrl('https://x/!3d999!4d120'), null);
    assert.equal(extractCoordinatesFromUrl('https://x/!3d22!4d999'), null);
  });
});

// ═══════════════════════════════════════════════ looksLikeUrl 分支

describe('looksLikeUrl：決定走網址還是地名分支', () => {
  const urls = [
    'https://www.google.com/maps/x',
    'http://169.254.169.254/#google.com/maps',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,x',
    'ftp://google.com/maps',
  ];
  for (const u of urls) {
    test(`是網址：${u.slice(0, 40)}`, () => assert.equal(looksLikeUrl(u), true));
  }

  const names = ['駁二藝術特區', '高雄流行音樂中心', '台北:101', 'Taipei 101', 'maps.app.goo.gl/abc'];
  for (const n of names) {
    test(`是地名：${n}`, () => assert.equal(looksLikeUrl(n), false));
  }
});

// ═══════════════════════════════════════════════ Nominatim 安全性

describe('Nominatim：host 固定、輸入只進 query string', () => {
  test('使用者輸入不會影響 host，且以 query parameter 編碼', async () => {
    let requestedUrl = '';
    const fakeFn = (async (input: RequestInfo | URL) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify([{ lat: '22.6', lon: '120.3' }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const result = await geocodePlaceName('駁二藝術特區', { fetch: fakeFn });
    assert.deepEqual(result, { lat: 22.6, lng: 120.3 });

    const parsed = new URL(requestedUrl);
    assert.equal(parsed.protocol, 'https:');
    assert.equal(parsed.hostname, 'nominatim.openstreetmap.org');
    assert.equal(parsed.searchParams.get('q'), '駁二藝術特區');
  });

  test('惡意輸入無法改寫 host 或注入額外參數', async () => {
    let requestedUrl = '';
    const fakeFn = (async (input: RequestInfo | URL) => {
      requestedUrl = String(input);
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    await geocodePlaceName('x&format=xml&evil=1 @169.254.169.254/#', { fetch: fakeFn });

    const parsed = new URL(requestedUrl);
    assert.equal(parsed.hostname, 'nominatim.openstreetmap.org');
    assert.equal(parsed.searchParams.get('format'), 'json', 'format 不可被覆寫');
    assert.equal(parsed.searchParams.get('evil'), null, '不可注入額外參數');
  });

  test('上游非 200 → null', async () => {
    const fakeFn = (async () => new Response('', { status: 503 })) as typeof fetch;
    assert.equal(await geocodePlaceName('x', { fetch: fakeFn }), null);
  });

  test('空結果 → null', async () => {
    const fakeFn = (async () =>
      new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
    assert.equal(await geocodePlaceName('x', { fetch: fakeFn }), null);
  });

  test('網路錯誤 → null，不外洩例外', async () => {
    const fakeFn = (async () => {
      throw new Error('ETIMEDOUT');
    }) as typeof fetch;
    assert.equal(await geocodePlaceName('x', { fetch: fakeFn }), null);
  });
});

// ═══════════════════════════════════════════════ timeout 有被設定

describe('逾時', () => {
  test('Google Maps 請求帶 AbortSignal', async () => {
    let signal: AbortSignal | undefined;
    const fakeFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    await resolveGoogleMapsUrl(MAPS_URL, { fetch: fakeFn });
    assert.ok(signal instanceof AbortSignal, 'Google Maps 請求必須帶 timeout signal');
  });

  test('Nominatim 請求帶 AbortSignal', async () => {
    let signal: AbortSignal | undefined;
    const fakeFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    await geocodePlaceName('x', { fetch: fakeFn });
    assert.ok(signal instanceof AbortSignal, 'Nominatim 請求必須帶 timeout signal');
  });
});
