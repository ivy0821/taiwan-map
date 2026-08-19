// app/page.tsx
'use client';

import { useState } from 'react';
import FloatingOverlay, { TripNode } from '@/components/FloatingOverlay';

export default function HomePage() {
  const [userPrompt, setUserPrompt] = useState('想要看海、拍照、喝咖啡');
  const [loading, setLoading] = useState(false);
  const [tripData, setTripData] = useState<{ title: string; nodes: TripNode[] } | null>(null);

  const samplePois = [
    { poi_name: "駁二藝術特區", lat: 22.6198, lng: 120.2818 },
    { poi_name: "大港橋", lat: 22.6180, lng: 120.2830 },
    { poi_name: "高雄流行音樂中心", lat: 22.6133, lng: 120.2922 }
  ];

  const handleGenerateFullTrip = async () => {
    setLoading(true);
    try {
      // 1. 生成行程
      const genRes = await fetch('/api/v1/trip/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: 'web_demo_user',
          user_prompt: userPrompt,
          poi_list: samplePois
        })
      });
      const genData = await genRes.json();
      if (!genRes.ok) throw new Error(genData.error || '行程生成失敗');

      // 2. 自動插入停車點
      const parkRes = await fetch(`/api/v1/trip/${genData.trip_id}/insert-parking`, {
        method: 'POST'
      });
      const parkData = await parkRes.json();
      if (!parkRes.ok) throw new Error(parkData.error || '停車點插入失敗');

      // 3. 設定懸浮視窗資料
      setTripData({
        title: genData.title,
        nodes: parkData.nodes
      });
    } catch (err: any) {
      alert(`規劃失敗: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="min-h-screen bg-slate-900 text-slate-100 flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-md bg-slate-800 p-6 rounded-2xl border border-slate-700 shadow-xl space-y-4">
        <h1 className="text-2xl font-bold text-center text-white">台灣在地 MaaS 行程助手</h1>
        <p className="text-xs text-slate-400 text-center">自動規劃遊玩動線與就近停車位</p>

        <div>
          <label className="block text-xs text-slate-400 mb-1">自訂行程偏好：</label>
          <input
            type="text"
            value={userPrompt}
            onChange={(e) => setUserPrompt(e.target.value)}
            className="w-full bg-slate-700 border border-slate-600 rounded-xl px-4 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
          />
        </div>

        <button
          onClick={handleGenerateFullTrip}
          disabled={loading}
          className="w-full bg-blue-600 hover:bg-blue-500 active:scale-95 text-white font-semibold py-3 rounded-xl shadow-lg transition disabled:opacity-50"
        >
          {loading ? 'AI 動線排程與停車位運算中...' : '🚀 一鍵生成完整行程'}
        </button>
      </div>

      {/* 懸浮導航視窗元件 */}
      {tripData && (
        <FloatingOverlay tripTitle={tripData.title} nodes={tripData.nodes} />
      )}
    </main>
  );
}