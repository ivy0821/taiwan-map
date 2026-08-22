// app/api/v1/trip/ai-plan-with-parking/route.ts
import { NextResponse } from 'next/server';
import { planTripWithParking } from '@/server/services/trip.service';
import {
  parseAiPlanWithParkingRequest,
  readJsonBody,
  ValidationError,
} from '@/server/api/validation';
import { logServerError } from '@/server/api/errors';

export async function POST(req: Request) {
  try {
    const { places } = parseAiPlanWithParkingRequest(await readJsonBody(req));

    const plan = await planTripWithParking(places);

    return NextResponse.json({ success: true, ...plan });
  } catch (error: unknown) {
    if (error instanceof ValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    logServerError('trip/ai-plan-with-parking', error);
    return NextResponse.json({ error: '規劃失敗' }, { status: 500 });
  }
}
