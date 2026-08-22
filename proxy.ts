// proxy.ts
//
// Next.js 16 的檔案慣例：middleware.ts 已被更名為 proxy.ts
// （見 node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/middleware.md
//  ——「The `middleware.js` file convention has been deprecated in Next.js 16
//     and renamed to `proxy.js`」）。
//
// 這裡是整個 backend 唯一的 CORS 出口：所有 /api/* 的回應都經過這裡，
// route handler 完全不需要各自處理 CORS。
//
// 政策本身（哪個 Origin 獲准、要附哪些標頭）在 server/api/cors.ts，
// 是可離線測試的純函式；這個檔案只負責把決策翻成 NextResponse。

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { decideCors } from '@/server/api/cors';

export function proxy(request: NextRequest) {
  const decision = decideCors(request.method, request.headers.get('origin'));

  // preflight 在這裡就結束，不會進入 route handler，
  // 因此不會觸發任何 Service / DB / Gemini / TDX 呼叫
  if (decision.kind === 'preflight') {
    return new NextResponse(null, {
      status: decision.status,
      headers: decision.headers,
    });
  }

  const response = NextResponse.next();
  for (const [key, value] of Object.entries(decision.headers)) {
    response.headers.set(key, value);
  }
  return response;
}

export const config = {
  // 只套用在 API 上，不碰任何頁面或靜態資源
  matcher: '/api/:path*',
};
