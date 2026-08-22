// tests/unit/time.test.ts
//
// M1 迴歸測試：updated_at 必須永遠是台灣當地時間，
// 不受伺服器 OS / container 時區影響。
//
// 所有斷言都用「固定的 UTC 時間點」當輸入，因此期望值是絕對的：
// 只要 helper 依賴本機時區，在任何非 Asia/Taipei 的機器上都會立刻紅燈。
//
//   npm test

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import { TAIPEI_TIME_ZONE, formatTaipeiClockTime } from '@/server/api/time';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('M1: updated_at 時區', () => {
  test('使用 IANA 時區識別碼，而不是固定位移', () => {
    assert.equal(TAIPEI_TIME_ZONE, 'Asia/Taipei');
  });

  // A. 明確 timestamp
  test('2026-08-22T12:34:56Z → 台灣 20:34:56', () => {
    assert.equal(formatTaipeiClockTime(new Date('2026-08-22T12:34:56Z')), '20:34:56');
  });

  // B. 跨日：UTC 8/22 20:30 → 台灣 8/23 04:30
  test('跨日 2026-08-22T20:30:00Z → 台灣 04:30:00', () => {
    assert.equal(formatTaipeiClockTime(new Date('2026-08-22T20:30:00Z')), '04:30:00');
  });

  test('台灣午夜輸出 00:00:00，不是 24:00:00', () => {
    // zh-TW 若 hourCycle 落到 h24 會輸出 24:00:00，這裡鎖住 h23 行為
    assert.equal(formatTaipeiClockTime(new Date('2026-08-22T16:00:00Z')), '00:00:00');
  });

  test('台灣一日最後一秒 23:59:59', () => {
    assert.equal(formatTaipeiClockTime(new Date('2026-08-22T15:59:59Z')), '23:59:59');
  });

  test('中午 12 點正確（不是 00 或 24）', () => {
    assert.equal(formatTaipeiClockTime(new Date('2026-08-22T04:00:00Z')), '12:00:00');
  });

  test('跨年邊界：UTC 2025-12-31T16:00Z → 台灣 2026 元旦 00:00:00', () => {
    assert.equal(formatTaipeiClockTime(new Date('2025-12-31T16:00:00Z')), '00:00:00');
  });

  // D. response contract：格式仍與前端相容
  test('格式為零補位的 HH:mm:ss 字串', () => {
    for (const iso of [
      '2026-08-22T12:34:56Z',
      '2026-08-22T20:30:00Z',
      '2026-08-22T16:00:00Z',
      '2026-01-05T01:02:03Z',
    ]) {
      const out = formatTaipeiClockTime(new Date(iso));
      assert.equal(typeof out, 'string');
      assert.match(out, /^\d{2}:\d{2}:\d{2}$/, `${iso} 的輸出格式不符：${out}`);
    }
  });

  test('不含 AM/PM 或中文上下午（拿掉 hour12:false 就會出現）', () => {
    const out = formatTaipeiClockTime(new Date('2026-08-22T05:00:00Z'));
    assert.equal(out, '13:00:00');
    assert.ok(!/上午|下午|AM|PM/i.test(out));
  });

  test('不帶參數時使用當下時間，且仍符合格式', () => {
    assert.match(formatTaipeiClockTime(), /^\d{2}:\d{2}:\d{2}$/);
  });
});

// C. 真正的「不依賴伺服器時區」證明
//
// 在子行程中把 TZ 設成非台灣時區再跑同一個 helper。
// 這不需要更動 CI 本身的系統時區。
describe('M1: 不依賴伺服器時區（子行程實測）', () => {
  const runUnder = (tz: string): string => {
    // Windows 上絕對路徑必須是合法的 file:// URL，否則 "C:" 會被當成 protocol
    const helperUrl = pathToFileURL(join(REPO_ROOT, 'server', 'api', 'time.ts')).href;
    const script = `
      import { formatTaipeiClockTime } from ${JSON.stringify(helperUrl)};
      process.stdout.write(formatTaipeiClockTime(new Date('2026-08-22T12:34:56Z')));
    `;
    return execFileSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', script],
      { env: { ...process.env, TZ: tz }, encoding: 'utf8', cwd: REPO_ROOT }
    ).trim();
  };

  for (const tz of ['UTC', 'America/New_York', 'Europe/London', 'Asia/Tokyo']) {
    test(`TZ=${tz} 時仍輸出台灣時間 20:34:56`, () => {
      assert.equal(runUnder(tz), '20:34:56');
    });
  }

  test('對照組：沒有指定時區的舊寫法確實會隨 TZ 改變（證明這個 bug 是真的）', () => {
    const script = `
      process.stdout.write(
        new Date('2026-08-22T12:34:56Z').toLocaleTimeString('zh-TW', { hour12: false })
      );
    `;
    const underUtc = execFileSync(
      process.execPath,
      ['--input-type=module', '--eval', script],
      { env: { ...process.env, TZ: 'UTC' }, encoding: 'utf8' }
    ).trim();

    // 舊寫法在 UTC 環境下會少 8 小時 —— 這正是 M1 的成因
    assert.equal(underUtc, '12:34:56');
    assert.notEqual(underUtc, '20:34:56');
  });
});
