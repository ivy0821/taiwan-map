// app/api/v1/parking/live/route.ts
import { NextResponse } from 'next/server';
import { getLiveAvailability } from '@/server/services/parking.service';
import {
  parseParkingLiveRequest,
  readJsonBody,
  ValidationError,
} from '@/server/api/validation';
import { logServerError } from '@/server/api/errors';

export async function POST(req: Request) {
  try {
    const { parkingIds } = parseParkingLiveRequest(await readJsonBody(req));

    // 空陣列是合法輸入，直接回空結果，不打 TDX（既有行為）
    if (parkingIds.length === 0) {
      return NextResponse.json({ availabilities: {} });
    }

    const { availabilities, upstreamOk } = await getLiveAvailability(parkingIds);

    if (!upstreamOk) {
      // 維持既有行為：上游失敗仍回 200 + 空資料，且不附 updated_at
      // （M2：上游失敗回 200 是 Stage 2 明確定義的 fallback，本階段刻意不動）
      return NextResponse.json({ availabilities: {} });
    }

    return NextResponse.json({
      availabilities,
      updated_at: new Date().toLocaleTimeString('zh-TW', { hour12: false }),
    });
  } catch (error: unknown) {
    if (error instanceof ValidationError) {
      return NextResponse.json({ error: error.message, availabilities: {} }, { status: 400 });
    }
    // 注意：TDX 上游失敗有自己的 fallback（200 + 空資料，見上方 upstreamOk），
    // 走到這裡的是真正非預期的錯誤。
    logServerError('parking/live', error);
    return NextResponse.json(
      { error: '取得即時車位失敗', availabilities: {} },
      { status: 500 }
    );
  }
}
