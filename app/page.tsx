// app/page.tsx
'use client';

import React, { useState } from 'react';
import TripParkingModal from '@/components/TripParkingModal';

export default function Home() {
  const [modalOpen, setModalOpen] = useState(false);
  const [planResult, setPlanResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  // 模擬 Google Maps 匯入的景點標籤
  const savedGooglePlaces = [
    { name: '駁二藝術特區', lat: 22.6201, lng: 120.2818 },
    { name: '高雄流行音樂中心', lat: 22.6133, lng: 120.2925 },
    { name: '旗津天后宮', lat: 22.6137, lng: 120.2678 }
  ];

  const handleStartAIPlan = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/v1/trip/ai-plan-with-parking', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ places: savedGooglePlaces }),
      });
      const data = await res.json();
      if (res.ok) {
        setPlanResult(data);
        setModalOpen(true);
      }
    } catch (e) {
      alert('規劃失敗');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-10">
      <button
        onClick={handleStartAIPlan}
        disabled={loading}
        className="px-6 py-3 bg-indigo-600 text-white font-bold rounded-xl shadow-lg hover:bg-indigo-500 transition"
      >
        {loading ? 'AI 正在排定順序與周邊停車場...' : '匯入 Google 儲存景點並規劃行程'}
      </button>

      {planResult && (
        <TripParkingModal
          isOpen={modalOpen}
          onClose={() => setModalOpen(false)}
          itineraryFlow={planResult.itinerary_flow}
          schedule={planResult.schedule}
        />
      )}
    </div>
  );
}