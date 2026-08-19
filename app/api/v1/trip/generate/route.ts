// app/api/v1/trip/generate/route.ts
import { NextResponse } from 'next/server';
import pool from '@/lib/db';
import { planTripWithAI, POIInput } from '@/lib/aiPlanner';

export async function POST(request: Request) {
  const client = await pool.connect();
  try {
    const body = await request.json();
    const { prompt, poi_list } = body as { prompt: string; poi_list: POIInput[] };

    if (!poi_list || poi_list.length === 0) {
      return NextResponse.json({ error: '請提供至少一個景點' }, { status: 400 });
    }

    // 1. 呼叫 Gemini 進行動線排序與規劃
    const aiPlan = await planTripWithAI(prompt || '輕鬆高雄一日遊', poi_list);

    await client.query('BEGIN');

    // 2. 建立 Trip 主記錄
    const tripInsertQuery = `
      INSERT INTO trips (title, start_date, end_date)
      VALUES ($1, CURRENT_DATE, CURRENT_DATE)
      RETURNING trip_id;
    `;
    const tripRes = await client.query(tripInsertQuery, [aiPlan.title || '高雄一日遊']);
    const tripId = tripRes.rows[0].trip_id;

    // 3. 逐筆插入 AI 規劃出的各個「不同」景點節點
    for (let i = 0; i < aiPlan.nodes.length; i++) {
      const node = aiPlan.nodes[i];
      const nodeInsertQuery = `
        INSERT INTO trip_nodes (
          trip_id, sequence_order, node_type, poi_name, location, stay_duration_minutes, summary
        ) VALUES (
          $1, $2, 'DESTINATION', $3, ST_SetSRID(ST_MakePoint($4, $5), 4326), $6, $7
        );
      `;
      // 注意：$4 是 lng (經度), $5 是 lat (緯度)
      await client.query(nodeInsertQuery, [
        tripId,
        i + 1,
        node.poi_name,
        node.lng,
        node.lat,
        node.stay_duration_minutes || 60,
        node.summary || '',
      ]);
    }

    await client.query('COMMIT');

    return NextResponse.json({
      trip_id: tripId,
      title: aiPlan.title,
      nodes: aiPlan.nodes,
    });
  } catch (error: any) {
    await client.query('ROLLBACK');
    console.error('行程生成失敗:', error);
    return NextResponse.json({ error: error?.message || '行程生成失敗' }, { status: 500 });
  } finally {
    client.release();
  }
}