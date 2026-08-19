'use client';

import React, { useState } from 'react';

export interface TripNode {
  node_id: string;
  sequence_order: number;
  node_type: 'DESTINATION' | 'PARKING';
  poi_name: string;
  stay_duration_minutes: number;
  lat: number;
  lng: number;
  summary?: string;
}

interface FloatingOverlayProps {
  tripTitle: string;
  nodes: TripNode[];
}

export default function FloatingOverlay({ tripTitle, nodes }: FloatingOverlayProps) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isMinimized, setIsMinimized] = useState(false);

  if (!nodes || nodes.length === 0) return null;

  const currentNode = nodes[currentIndex];
  const isLastNode = currentIndex === nodes.length - 1;

  // 開啟 Google Maps 外部導航（以名稱優先查詢，避免反向地理編碼帶出無關商家）
  const handleOpenGoogleMaps = () => {
    // 去除前綴的停車場圖示符號，提取純地名
    const cleanPoiName = currentNode.poi_name.replace(/^🅿️\s*/, '').trim();
    const destinationQuery = encodeURIComponent(cleanPoiName);
    const url = `https://www.google.com/maps/dir/?api=1&destination=${destinationQuery}&destination_place_id=&travelmode=driving`;
    window.open(url, '_blank');
  };

  const handleNextStep = () => {
    if (!isLastNode) {
      setCurrentIndex((prev) => prev + 1);
    }
  };

  return (
    <div className="fixed bottom-6 right-6 z-50 w-96 max-w-[calc(100vw-3rem)] rounded-2xl bg-white/95 p-5 shadow-2xl backdrop-blur-md border border-slate-200 transition-all duration-300">
      {/* 頂部標題列 */}
      <div className="flex items-center justify-between border-b pb-3">
        <div>
          <span className="text-xs font-semibold uppercase tracking-wider text-blue-600">
            {currentNode.node_type === 'PARKING' ? '🅿️ 停車導引' : '🎯 景點導覽'}
          </span>
          <h2 className="text-base font-bold text-slate-800 line-clamp-1">{tripTitle}</h2>
        </div>
        <button
          onClick={() => setIsMinimized(!isMinimized)}
          className="rounded-full p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
        >
          {isMinimized ? '🔼' : '🔽'}
        </button>
      </div>

      {/* 展開內容 */}
      {!isMinimized && (
        <div className="mt-4 space-y-4">
          {/* 當前站點資訊 */}
          <div className="rounded-xl bg-slate-50 p-4 border border-slate-100">
            <div className="flex items-center justify-between text-xs text-slate-500 mb-1">
              <span>第 {currentNode.sequence_order} 站 / 共 {nodes.length} 站</span>
              <span>預計停留 {currentNode.stay_duration_minutes} 分鐘</span>
            </div>
            <h3 className="text-lg font-bold text-slate-900">{currentNode.poi_name}</h3>
            {currentNode.summary && (
              <p className="mt-2 text-sm text-slate-600 line-clamp-3 leading-relaxed">
                {currentNode.summary}
              </p>
            )}
          </div>

          {/* 操作按鈕群 */}
          <div className="flex gap-2">
            <button
              onClick={handleOpenGoogleMaps}
              className="flex-1 rounded-xl bg-blue-600 py-3 text-center text-sm font-semibold text-white shadow-md hover:bg-blue-700 transition active:scale-95"
            >
              📍 開啟導航
            </button>
            <button
              onClick={handleNextStep}
              disabled={isLastNode}
              className={`flex-1 rounded-xl py-3 text-center text-sm font-semibold transition ${
                isLastNode
                  ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
                  : 'bg-emerald-600 text-white shadow-md hover:bg-emerald-700 active:scale-95'
              }`}
            >
              {isLastNode ? '抵達終點 🎉' : '下一站 ➡️'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}