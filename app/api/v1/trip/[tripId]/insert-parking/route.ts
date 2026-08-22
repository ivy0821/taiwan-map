// app/api/v1/trip/[tripId]/insert-parking/route.ts
import { NextResponse } from 'next/server';
import { insertParkingNodes } from '@/server/services/trip.service';
import { parseInsertParkingParams, ValidationError } from '@/server/api/validation';
import { logServerError } from '@/server/api/errors';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ tripId: string }> }
) {
  try {
    // 這個 endpoint 的 body 一直都是 {} 且從未被讀取，因此不解析 body，
    // 只驗證路徑參數（trips.trip_id 是 uuid）。
    const tripId = parseInsertParkingParams((await params).tripId);

    const result = await insertParkingNodes(tripId);

    if (result === null) {
      return NextResponse.json(
        { error: '找不到對應的行程節點或行程為空' },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true, ...result }, { status: 200 });
  } catch (error: unknown) {
    if (error instanceof ValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    logServerError('trip/insert-parking', error);
    return NextResponse.json({ error: '伺服器內部錯誤' }, { status: 500 });
  }
}
