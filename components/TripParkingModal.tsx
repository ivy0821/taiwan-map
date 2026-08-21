// components/TripParkingModal.tsx
'use client';

import React, { useState, useEffect } from 'react';
import dynamic from 'next/dynamic';
import { AlertTriangle, Navigation, X, ArrowRight, Car, Compass, MapPin, RefreshCw, ExternalLink } from 'lucide-react';

const RelativeMiniMap = dynamic(() => import('./RelativeMiniMap'), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full bg-slate-900 animate-pulse flex items-center justify-center text-xs text-slate-500">
      載入地圖中...
    </div>
  ),
});

// 錯別字清洗
function cleanParkingName(name: string): string {
  if (!name) return '停車場';
  return name
    .replace(/倬亭/g, '俥亭')
    .replace(/齊津/g, '旗津')
    .replace(/哨船/g, '哨船頭')
    .replace(/台南/g, '臺南')
    .replace(/台北/g, '臺北')
    .replace(/台中/g, '臺中')
    .replace(/台東/g, '臺東')
    .trim();
}

interface ParkingItem {
  parking_id: string;
  name: string;
  lat: number;
  lng: number;
  total_spaces: number;
  available_spaces: number | null;
  distance_meters: number;
  distance_display: string;
  hourly_rate: string;
  fare_description: string;
}

interface ScheduleItem {
  spot_order: number;
  spot_name: string;
  lat: number;
  lng: number;
  suggested_stay_minutes: number;
  reason: string;
  candidate_parkings: ParkingItem[];
}

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  itineraryFlow: string;
  schedule: ScheduleItem[];
}

export default function TripParkingModal({ isOpen, onClose, schedule }: ModalProps) {
  const [activeSpotIndex, setActiveSpotIndex] = useState(0);
  const [liveSpaces, setLiveSpaces] = useState<Record<string, number | null>>({});
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastUpdateTime, setLastUpdateTime] = useState<string>('');

  const currentSpot = schedule[activeSpotIndex] || schedule[0];

  const fetchRealtimeSpaces = async () => {
    if (!currentSpot || currentSpot.candidate_parkings.length === 0) return;

    setIsRefreshing(true);
    try {
      const pIds = currentSpot.candidate_parkings.map((p) => p.parking_id);
      const res = await fetch('/api/v1/parking/live', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parkingIds: pIds }),
      });

      const data = await res.json();
      if (data.availabilities) {
        setLiveSpaces((prev) => ({ ...prev, ...data.availabilities }));
        setLastUpdateTime(data.updated_at || new Date().toLocaleTimeString('zh-TW', { hour12: false }));
      }
    } catch (e) {
      console.warn('即時車位更新失敗');
    } finally {
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchRealtimeSpaces();
    }
  }, [isOpen, activeSpotIndex]);

  if (!isOpen) return null;

  // 🎯 核心修復：智慧 Google Maps 導航
  // 優先使用「清洗後的精準地標名稱」，避免水岸座標吸附到對岸錯誤道路
  const handleSmartGoogleNav = (name: string, lat: number, lng: number) => {
    const cleaned = cleanParkingName(name);

    // 若名稱具體（非泛稱），使用名稱搜尋導航，Google 會直接對位到真實停車場出入口
    if (cleaned && !cleaned.includes('路邊') && cleaned !== '停車場') {
      const query = encodeURIComponent(`${cleaned} 高雄`);
      window.open(
        `https://www.google.com/maps/dir/?api=1&destination=${query}&travelmode=driving`,
        '_blank'
      );
    } else {
      // 泛稱或路邊車格則使用精準經緯度
      window.open(
        `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`,
        '_blank'
      );
    }
  };

  // 額外提供：直接在地圖上查看 Google 地標（非導航模式）
  const handleViewOnGoogleMaps = (name: string, lat: number, lng: number) => {
    const cleaned = cleanParkingName(name);
    const query = encodeURIComponent(`${cleaned} 高雄`);
    window.open(`https://www.google.com/maps/search/?api=1&query=${query}`, '_blank');
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4 md:p-6 overflow-y-auto">
      <div className="bg-slate-900 border border-slate-700 w-full max-w-5xl rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[92vh]">
        
        {/* 頂部 Header */}
        <div className="p-4 md:p-5 bg-slate-800/90 border-b border-slate-700 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-indigo-600/20 text-indigo-400 rounded-lg">
              <Compass className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-white">智慧行程與停車相對位置導覽</h2>
              <p className="text-xs text-slate-400 mt-0.5">即時車位狀態與景點周邊停車點</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-white rounded-lg hover:bg-slate-700 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 推薦路線順序 */}
        <div className="bg-indigo-950/40 border-b border-indigo-500/20 px-6 py-3 flex items-center gap-3 overflow-x-auto">
          <span className="text-xs font-semibold px-2.5 py-1 rounded bg-indigo-500 text-white shrink-0">
            推薦順序
          </span>
          <div className="flex items-center gap-2 text-sm text-indigo-200 font-medium whitespace-nowrap">
            {schedule.map((spot, idx) => (
              <React.Fragment key={spot.spot_order}>
                <button
                  onClick={() => setActiveSpotIndex(idx)}
                  className={`px-3 py-1 rounded-full text-xs font-bold transition flex items-center gap-1.5 ${
                    activeSpotIndex === idx
                      ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/30 ring-2 ring-indigo-400'
                      : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                  }`}
                >
                  <span className="w-4 h-4 rounded-full bg-slate-900/60 text-[10px] flex items-center justify-center">
                    {spot.spot_order}
                  </span>
                  {spot.spot_name}
                </button>
                {idx < schedule.length - 1 && <ArrowRight className="w-3.5 h-3.5 text-slate-500 shrink-0" />}
              </React.Fragment>
            ))}
          </div>
        </div>

        {/* 內容區塊 */}
        <div className="p-6 overflow-y-auto space-y-6 flex-1 bg-slate-900/50">
          
          {/* 目前站點資訊 */}
          <div className="flex flex-wrap items-center justify-between bg-slate-800/80 p-4 rounded-xl border border-slate-700 gap-3">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-rose-500/20 text-rose-400 font-bold flex items-center justify-center border border-rose-500/30">
                <MapPin className="w-5 h-5" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-rose-400">目前站點 #{currentSpot.spot_order}</span>
                  <h3 className="text-lg font-bold text-white">{currentSpot.spot_name}</h3>
                </div>
                <p className="text-xs text-slate-400 mt-0.5">
                  建議停留：{currentSpot.suggested_stay_minutes} 分鐘 • {currentSpot.reason}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              {lastUpdateTime && (
                <span className="text-[11px] text-slate-400 font-mono">
                  即時更新：{lastUpdateTime}
                </span>
              )}
              <button
                onClick={fetchRealtimeSpaces}
                disabled={isRefreshing}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-700 hover:bg-slate-600 active:scale-95 text-xs text-slate-200 rounded-lg transition disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin text-indigo-400' : ''}`} />
                {isRefreshing ? '更新中...' : '重新整理車位'}
              </button>
            </div>
          </div>

          {/* 候選停車場卡片列表 */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            {currentSpot.candidate_parkings.map((parking, pIdx) => {
              const displayName = cleanParkingName(parking.name);
              const currentAvailable =
                liveSpaces[parking.parking_id] !== undefined
                  ? liveSpaces[parking.parking_id]
                  : parking.available_spaces;

              return (
                <div
                  key={parking.parking_id}
                  className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden shadow-xl flex flex-col justify-between"
                >
                  {/* 相對位置地圖（雙標記） */}
                  <div className="h-44 bg-slate-950 relative overflow-hidden border-b border-slate-700">
                    <RelativeMiniMap
                      spotName={currentSpot.spot_name}
                      spotLat={currentSpot.lat}
                      spotLng={currentSpot.lng}
                      parkingName={displayName}
                      parkingLat={parking.lat}
                      parkingLng={parking.lng}
                    />

                    {/* 圖例標籤 */}
                    <div className="absolute top-2 left-2 right-2 flex justify-between items-center pointer-events-none z-[400]">
                      <span className="bg-slate-900/90 backdrop-blur-md text-rose-400 text-[10px] px-2 py-0.5 rounded border border-rose-500/30 flex items-center gap-1 font-bold">
                        🔴 {currentSpot.spot_name}
                      </span>
                      <span className="bg-slate-900/90 backdrop-blur-md text-blue-400 text-[10px] px-2 py-0.5 rounded border border-blue-500/30 flex items-center gap-1 font-bold">
                        🔵 推薦 {pIdx + 1}
                      </span>
                    </div>

                    <div className="absolute bottom-2 left-2 bg-slate-900/90 backdrop-blur-md text-white text-[11px] px-2.5 py-1 rounded border border-slate-700 flex items-center gap-1.5 font-medium z-[400]">
                      <Car className="w-3.5 h-3.5 text-amber-400" />
                      <span>相距 {parking.distance_display}</span>
                    </div>
                  </div>

                  {/* 卡片本體資訊 */}
                  <div className="p-4 space-y-3 flex-1 flex flex-col justify-between">
                    <div>
                      <div className="flex items-center justify-between gap-1">
                        <h4 className="font-bold text-white text-base truncate" title={displayName}>
                          {displayName}
                        </h4>
                        <button
                          onClick={() => handleViewOnGoogleMaps(displayName, parking.lat, parking.lng)}
                          title="在 Google Maps 查看地標"
                          className="text-slate-400 hover:text-indigo-400 transition shrink-0 p-1"
                        >
                          <ExternalLink className="w-4 h-4" />
                        </button>
                      </div>

                      {/* 車位資訊 */}
                      <div className="grid grid-cols-2 gap-2 mt-3 text-center py-2 bg-slate-900/60 rounded-lg border border-slate-700/60">
                        <div>
                          <div className="text-[11px] text-slate-400 flex items-center justify-center gap-1">
                            即時剩餘
                            <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                          </div>
                          <div
                            className={`text-base font-bold ${
                              currentAvailable === 0
                                ? 'text-rose-400'
                                : currentAvailable !== null
                                ? 'text-emerald-400'
                                : 'text-slate-400'
                            }`}
                          >
                            {currentAvailable !== null ? `${currentAvailable} 格` : '尚無動態'}
                          </div>
                        </div>
                        <div className="border-l border-slate-700">
                          <div className="text-[11px] text-slate-400">總車位數</div>
                          <div className="text-base font-bold text-slate-200">
                            {parking.total_spaces || '-'}
                          </div>
                        </div>
                      </div>

                      {/* 費率與時段 */}
                      <div className="mt-3 text-xs space-y-1.5 text-slate-300">
                        <div className="flex justify-between">
                          <span className="text-slate-400">收費說明:</span>
                          <span className="font-medium text-slate-200">{parking.fare_description}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-slate-400">收費費率:</span>
                          <span className="font-medium text-amber-300 truncate max-w-[170px]">
                            {parking.hourly_rate}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Google 導航專用按鈕 */}
                    <div className="pt-3 border-t border-slate-700/60">
                      <button
                        onClick={() => handleSmartGoogleNav(displayName, parking.lat, parking.lng)}
                        className="w-full py-2.5 px-4 bg-amber-800/80 hover:bg-amber-700 active:scale-95 text-amber-100 text-sm font-semibold rounded-lg flex items-center justify-center gap-2 transition shadow-md"
                      >
                        <Navigation className="w-4 h-4 text-amber-300" />
                        Google 導航到此停車場
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* 底部切換 */}
        <div className="p-4 bg-slate-800/90 border-t border-slate-700 flex justify-between items-center">
          <button
            disabled={activeSpotIndex === 0}
            onClick={() => setActiveSpotIndex((prev) => Math.max(0, prev - 1))}
            className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-xs font-semibold text-white rounded-lg disabled:opacity-40 transition"
          >
            ← 上一個景點
          </button>
          <span className="text-xs text-slate-400 font-medium">
            第 {activeSpotIndex + 1} / {schedule.length} 站：{currentSpot.spot_name}
          </span>
          <button
            disabled={activeSpotIndex === schedule.length - 1}
            onClick={() => setActiveSpotIndex((prev) => Math.min(schedule.length - 1, prev + 1))}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white rounded-lg disabled:opacity-40 transition"
          >
            下一個景點 →
          </button>
        </div>

      </div>
    </div>
  );
}