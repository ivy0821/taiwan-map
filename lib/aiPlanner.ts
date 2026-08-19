// lib/aiPlanner.ts
import { GoogleGenAI, Type } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });

export interface POIInput {
  poi_name: string;
  lat: number;
  lng: number;
}

export interface PlannedTripResult {
  title: string;
  nodes: {
    sequence_order: number;
    node_type: 'DESTINATION';
    poi_name: string;
    stay_duration_minutes: number;
    lat: number;
    lng: number;
    summary: string;
  }[];
}

export async function planTripWithAI(
  userPrompt: string,
  poiList: POIInput[],
  retries = 2
): Promise<PlannedTripResult> {
  const prompt = `
你是一位專業的高雄在地旅遊規劃師與交通排程專家。
請根據使用者提供的景點清單與旅遊偏好，進行最順暢的「動線排序」、「建議停留時間（分鐘）」並為每個景點寫一句「特色推薦/導覽摘要」。

【使用者偏好】：${userPrompt}
【待排序景點清單】：
${JSON.stringify(poiList, null, 2)}
`;

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: 'gemini-3.5-flash-lite', // 使用輕量高併發模型
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              title: {
                type: Type.STRING,
                description: '這趟行程的吸睛主題名稱',
              },
              nodes: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    sequence_order: { type: Type.INTEGER },
                    node_type: { type: Type.STRING, enum: ['DESTINATION'] },
                    poi_name: { type: Type.STRING },
                    stay_duration_minutes: { type: Type.INTEGER },
                    lat: { type: Type.NUMBER },
                    lng: { type: Type.NUMBER },
                    summary: { type: Type.STRING },
                  },
                  required: [
                    'sequence_order',
                    'node_type',
                    'poi_name',
                    'stay_duration_minutes',
                    'lat',
                    'lng',
                    'summary',
                  ],
                },
              },
            },
            required: ['title', 'nodes'],
          },
        },
      });

      const resultText = response.text;
      if (!resultText) throw new Error('AI 回傳空內容');

      return JSON.parse(resultText) as PlannedTripResult;
    } catch (err: any) {
      console.warn(`第 ${attempt} 次呼叫失敗:`, err?.message);
      if (attempt <= retries) {
        // 等待 1.5 秒後重試
        await new Promise((res) => setTimeout(res, 1500));
      } else {
        throw err;
      }
    }
  }

  throw new Error('AI 規劃失敗，請稍後再試');
}