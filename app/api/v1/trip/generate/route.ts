// app/api/v1/trip/generate/route.ts
import { NextResponse } from 'next/server';
import { generateTrip } from '@/server/services/trip.service';
import {
  parseTripGenerateRequest,
  readJsonBody,
  ValidationError,
} from '@/server/api/validation';
import { logServerError } from '@/server/api/errors';

export async function POST(request: Request) {
  try {
    const { prompt, poi_list } = parseTripGenerateRequest(await readJsonBody(request));

    const trip = await generateTrip({
      preference: prompt,
      pois: poi_list.map((poi) => ({ name: poi.poi_name, lat: poi.lat, lng: poi.lng })),
    });

    return NextResponse.json(trip);
  } catch (error: unknown) {
    if (error instanceof ValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    logServerError('trip/generate', error);
    return NextResponse.json({ error: '行程生成失敗' }, { status: 500 });
  }
}
