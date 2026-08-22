// app/api/v1/import/google-maps/route.ts
import { NextResponse } from 'next/server';
import { parseRawInput } from '@/server/services/poi.service';
import {
  parseImportGoogleMapsRequest,
  readJsonBody,
  ValidationError,
} from '@/server/api/validation';
import { logServerError } from '@/server/api/errors';

export async function POST(request: Request) {
  try {
    const { raw_input } = parseImportGoogleMapsRequest(await readJsonBody(request));

    // 將解析結果回傳給前端，前端確認後再進入 AI 規劃階段
    const parsedPois = await parseRawInput(raw_input);
    return NextResponse.json({ parsed_pois: parsedPois });
  } catch (error: unknown) {
    if (error instanceof ValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    // 完整錯誤只留在 server log，client 只拿到固定訊息
    logServerError('import/google-maps', error);
    return NextResponse.json({ error: '伺服器內部錯誤' }, { status: 500 });
  }
}
