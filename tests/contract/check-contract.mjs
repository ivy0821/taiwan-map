// tests/contract/check-contract.mjs
//
// 重構安全網：對照 api-contract.json 驗證 5 個 endpoint 的 request/response contract。
// 只驗證「形狀」（key 名稱與型別）與「有沒有資料」，不驗證確切的值 ——
// 因為即時車位與 AI 產出每次都會變。
//
// 用法（需先另開終端機執行 `npm run dev`）：
//   npm run contract                      只跑唯讀的 endpoint
//   npm run contract -- --include-writes  連同會寫入資料庫的 endpoint 一起跑
//   npm run contract -- --record          另外把原始回應存到 tests/contract/recorded/
//   npm run contract -- --only <id>       只跑指定的 endpoint
//   npm run contract -- --allow-warn      狀態碼不如預期時只警告，不視為失敗
//
// 環境變數：
//   CONTRACT_BASE_URL   預設 http://localhost:3000
//   CONTRACT_TRIP_ID    insert-parking 要用的既有 trip_id（UUID）
//   CONTRACT_TIMEOUT_MS 單一請求逾時，預設 60000
//
// ⚠ --include-writes 會真的寫入資料庫：
//   trip-generate     會新增一筆 trips + 數筆 trip_nodes
//   trip-insert-parking 會 DELETE 再重新 INSERT 該 trip 的所有節點，
//                     在 C1/C2 修好之前，重複執行會增生停車節點並清掉
//                     stay_duration_minutes / summary。請只對可拋棄的 trip 使用。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const contract = JSON.parse(readFileSync(join(HERE, 'api-contract.json'), 'utf8'));

const args = process.argv.slice(2);
const includeWrites = args.includes('--include-writes');
const record = args.includes('--record');
const allowWarn = args.includes('--allow-warn');
const baseUrl = process.env.CONTRACT_BASE_URL || contract.baseUrl;
const timeoutMs = Number(process.env.CONTRACT_TIMEOUT_MS || 60000);

const validIds = contract.endpoints.map((e) => e.id);

/** 取出 --only 的值，順便擋掉「忘了帶值」與「打錯 id」這兩種會靜靜跑掉 0 個檢查的情況 */
function parseOnly() {
  const i = args.indexOf('--only');
  if (i < 0) return null;

  const value = args[i + 1];
  if (!value || value.startsWith('--')) {
    console.error(`--only 後面必須接 endpoint id，可用的有：\n  ${validIds.join('\n  ')}`);
    process.exit(1);
  }
  if (!validIds.includes(value)) {
    console.error(`--only 指定了不存在的 endpoint id「${value}」，可用的有：\n  ${validIds.join('\n  ')}`);
    process.exit(1);
  }
  return value;
}

const only = parseOnly();

/** 驗證 value 是否符合 shape，回傳錯誤訊息陣列 */
function check(value, shape, path = '$') {
  const errors = [];

  if (typeof shape === 'string') {
    const accepted = shape.split('|').map((s) => s.trim());
    if (accepted.includes('any')) return errors;

    const actual =
      value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;

    if (!accepted.includes(actual)) {
      errors.push(`${path}: 期望 ${shape}，實際為 ${actual}`);
    }
    return errors;
  }

  if (Array.isArray(shape)) {
    if (!Array.isArray(value)) {
      errors.push(`${path}: 期望 array，實際為 ${value === null ? 'null' : typeof value}`);
      return errors;
    }
    value.forEach((item, i) => errors.push(...check(item, shape[0], `${path}[${i}]`)));
    return errors;
  }

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${path}: 期望 object，實際為 ${value === null ? 'null' : typeof value}`);
    return errors;
  }

  const declaredKeys = new Set();
  const wildcard = shape['*'];

  for (const [rawKey, keyShape] of Object.entries(shape)) {
    if (rawKey === '*') continue;
    const optional = rawKey.endsWith('?');
    const key = optional ? rawKey.slice(0, -1) : rawKey;
    declaredKeys.add(key);

    if (!(key in value)) {
      if (!optional) errors.push(`${path}.${key}: 缺少必要欄位`);
      continue;
    }
    errors.push(...check(value[key], keyShape, `${path}.${key}`));
  }

  for (const key of Object.keys(value)) {
    if (declaredKeys.has(key)) continue;
    if (wildcard) {
      errors.push(...check(value[key], wildcard, `${path}.${key}`));
    } else {
      errors.push(`${path}.${key}: contract 未宣告的多餘欄位`);
    }
  }

  return errors;
}

/**
 * 解析 "$.schedule[*].candidate_parkings" 這種路徑，回傳所有命中的值。
 * `[*]` 表示展開陣列，後面的欄位會套用到每個元素上。
 */
function resolvePath(value, path) {
  const segments = path.replace(/^\$\.?/, '').split('.');
  let current = [value];

  for (const segment of segments) {
    const match = segment.match(/^([^[]+)(\[\*\])?$/);
    if (!match) return [];
    const [, key, expand] = match;

    const next = [];
    for (const node of current) {
      if (node === null || typeof node !== 'object') continue;
      const child = node[key];
      if (child === undefined) continue;
      if (expand) {
        if (Array.isArray(child)) next.push(...child);
      } else {
        next.push(child);
      }
    }
    current = next;
  }

  return current;
}

function isNonEmpty(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value !== null && typeof value === 'object') return Object.keys(value).length > 0;
  return value !== null && value !== undefined && value !== '';
}

/**
 * 形狀正確但資料全空，代表「上游或查詢壞了」而不是「contract 沒變」。
 * 對每條路徑要求「至少一個命中的值非空」，
 * 所以 `$.schedule[*].candidate_parkings` 只要有一個景點找得到停車場就算過，
 * 不會因為某個景點 1.5km 內真的沒停車場就誤報。
 */
function checkNonEmpty(body, paths) {
  const errors = [];
  for (const path of paths || []) {
    const hits = resolvePath(body, path);
    if (hits.length === 0) {
      errors.push(`${path}: 找不到這個路徑，無法確認是否有資料`);
    } else if (!hits.some(isNonEmpty)) {
      errors.push(`${path}: 形狀正確但完全沒有資料（全部為空）`);
    }
  }
  return errors;
}

function resolveUrlPath(endpoint) {
  if (!endpoint.path.includes('{tripId}')) return endpoint.path;
  const tripId = process.env.CONTRACT_TRIP_ID;
  return tripId ? endpoint.path.replace('{tripId}', encodeURIComponent(tripId)) : null;
}

async function run() {
  console.log(`Base URL: ${baseUrl}`);
  console.log(`寫入型 endpoint: ${includeWrites ? '執行' : '略過（--include-writes 可開啟）'}\n`);

  let passed = 0;
  let failed = 0;
  let warned = 0;
  const skippedWrites = [];
  const skippedOther = [];

  for (const endpoint of contract.endpoints) {
    const label = `${endpoint.method} ${endpoint.path} [${endpoint.id}]`;

    if (only && endpoint.id !== only) continue;

    if (endpoint.writesDatabase && !includeWrites) {
      console.log(`SKIP  ${label} — 會寫入資料庫`);
      skippedWrites.push(endpoint.id);
      continue;
    }

    const path = resolveUrlPath(endpoint);
    if (!path) {
      console.log(`SKIP  ${label} — 需要環境變數 ${endpoint.requiresEnv}`);
      skippedOther.push(`${endpoint.id}（缺少 ${endpoint.requiresEnv}）`);
      continue;
    }

    // 網路錯誤與「回應不是 JSON」是兩種不同的問題，必須分開回報，
    // 否則 dev server 吐 HTML 錯誤頁時會被誤判成連線失敗。
    let res;
    try {
      res = await fetch(baseUrl + path, {
        method: endpoint.method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(endpoint.request),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      console.log(`FAIL  ${label}\n        請求失敗（未收到回應）: ${err.message}`);
      failed++;
      continue;
    }

    const rawBody = await res.text();
    let body;
    try {
      body = JSON.parse(rawBody);
    } catch {
      console.log(
        `FAIL  ${label} — ${res.status}\n        回應不是 JSON: ${rawBody.slice(0, 300)}`
      );
      failed++;
      continue;
    }

    if (record) {
      const dir = join(HERE, 'recorded');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `${endpoint.id}.json`),
        JSON.stringify({ status: res.status, body }, null, 2),
        'utf8'
      );
    }

    const shape = endpoint.responses[String(res.status)];
    if (!shape) {
      console.log(
        `FAIL  ${label} — contract 未宣告的 status ${res.status}: ${JSON.stringify(body).slice(0, 300)}`
      );
      failed++;
      continue;
    }

    const statusExpected = endpoint.expectStatus.includes(res.status);
    const errors = check(body, shape);
    // 只有走在預期的成功狀態碼上時，才有「資料應該非空」這回事
    if (statusExpected) errors.push(...checkNonEmpty(body, endpoint.requireNonEmpty));

    if (errors.length > 0) {
      console.log(`FAIL  ${label} — ${res.status}`);
      errors.forEach((e) => console.log(`        ${e}`));
      failed++;
      continue;
    }

    if (statusExpected) {
      console.log(`PASS  ${label} — ${res.status}`);
      passed++;
      continue;
    }

    // 形狀對、狀態碼不對 —— 例如整個後端壞掉、每個 endpoint 都回自己宣告過的 500。
    // 這種情況預設必須是紅燈，否則安全網會在後端全死時報「通過」。
    const detail = `${res.status} 不在 expectStatus ${JSON.stringify(endpoint.expectStatus)} 內（形狀符合已宣告的 ${res.status} 回應）`;
    if (allowWarn) {
      console.log(`WARN  ${label} — ${detail}`);
      warned++;
    } else {
      console.log(`FAIL  ${label} — ${detail}`);
      failed++;
    }
  }

  const executed = passed + failed + warned;

  console.log(
    `\n通過 ${passed}／失敗 ${failed}${warned ? `／警告 ${warned}` : ''}／略過 ${
      skippedWrites.length + skippedOther.length
    }`
  );

  if (skippedWrites.length > 0) {
    console.log(
      `\n⚠ 下列會寫入資料庫的 endpoint 這次「沒有被驗證」：${skippedWrites.join('、')}\n` +
        `  它們涵蓋 withTransaction 的交易路徑。要一併驗證請執行：\n` +
        `    CONTRACT_TRIP_ID=<可拋棄的 trip_id> npm run contract -- --include-writes\n` +
        `  （PowerShell：$env:CONTRACT_TRIP_ID="<trip_id>"; npm run contract -- --include-writes）`
    );
  }
  if (skippedOther.length > 0) {
    console.log(`\n⚠ 因環境變數缺失而未驗證：${skippedOther.join('、')}`);
  }

  if (executed === 0) {
    console.error('\n沒有實際執行任何檢查 —— 視為失敗。');
    process.exitCode = 1;
    return;
  }

  process.exitCode = failed > 0 ? 1 : 0;
}

run();
