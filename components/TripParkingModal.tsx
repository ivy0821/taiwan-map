// components/TripParkingModal.tsx
'use client';

import React, { useState, useEffect } from 'react';
import dynamic from 'next/dynamic';
import {
  AlertTriangle,
  Navigation,
  X,
  ArrowRight,
  Car,
  Compass,
  MapPin,
  RefreshCw,
  Clock,
  ShieldCheck,
  Footprints,
  AlertCircle
} from 'lucide-react';

import { confidenceLabel, sourceLabel } from './scheduleLabels';
import { availabilityLabel, availabilityStatus } from './availabilityLabel';

const RelativeMiniMap = dynamic(() => import('./RelativeMiniMap'), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full bg-slate-900 animate-pulse flex items-center justify-center text-xs text-slate-500">
      載入地圖中...
    </div>
  ),
});

function cleanParkingName(name: string): string {
  if (!name) return '停車場';
  return name
    .replace(/倬亭/g, '俥亭')
    .replace(/齊津/g, '旗津')
    .replace(/哨船/g, '哨船頭')
    .replace(/台南/g, '臺南')
    .replace(/台北/g, '臺北')
    .trim();
}

export interface ScheduleNode {
  spot_order: number;
  spot_name: string;
  lat: number;
  lng: number;
  suggested_stay_minutes: number;
  reason: string;

  // ── 後端會提供的欄位（與 server/types/trip.ts 的 ScheduleEntry 一致）──
  /** 從最近候選停車場走到景點的分鐘數；1.5km 內沒有停車場時為 null */
  walk_minutes_to_spot: number | null;
  /** 這個景點的來源（目前只有 'user'：由使用者提供的原始 POI） */
  source: 'user';
  /**
   * 「來源可信度」0~1 —— 指這個 POI 的來源有多可靠，
   * 不是 AI 對推薦內容的信心分數。使用者直接提供 → 1。
   */
  confidence: number;

  // ── 後端目前沒有可靠資料來源，因此為選擇性 ──────────────────────────
  // arrival/departure/parking_arrival 需要「出發時間 + 景點間車程」，
  // open/close 需要景點營業時間資料集，兩者系統目前都沒有。
  // 這些欄位缺值時，下方 UI 會整塊不顯示，而不是印出 undefined。
  arrival_time?: string;
  departure_time?: string;
  open_time?: string;
  close_time?: string;
  parking_arrival_time?: string;
  candidate_parkings: Array<{
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
  }>;
}

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  itineraryFlow: string;
  hasConflicts?: boolean;
  conflictLogs?: string[];
  schedule: ScheduleNode[];
}

export default function TripParkingModal({
  isOpen,
  onClose,
  hasConflicts = false,
  conflictLogs = [],
  schedule,
}: ModalProps) {
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

  const handleGoogleNav = (name: string, lat: number, lng: number) => {
    const cleaned = cleanParkingName(name);
    if (cleaned && !cleaned.includes('路邊') && cleaned !== '停車場') {
      const query = encodeURIComponent(`${cleaned} 高雄`);
      window.open(`https://www.google.com/maps/dir/?api=1&destination=${query}&travelmode=driving`, '_blank');
    } else {
      window.open(`https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`, '_blank');
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-3 md:p-6 overflow-y-auto">
      <div className="bg-slate-900 border border-slate-700 w-full max-w-5xl rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[94vh]">
        
        {/* 頂部 Header */}
        <div className="p-4 md:p-5 bg-slate-800/90 border-b border-slate-700 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-indigo-600/20 text-indigo-400 rounded-lg">
              <Compass className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-white flex items-center gap-2">
                可信任 AI 智慧行程與即時停車導覽
                <span className="text-[11px] bg-indigo-500/20 text-indigo-300 px-2 py-0.5 rounded border border-indigo-500/30">
                  觀光署開放資料 + TDX 雙驗證
                </span>
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">自駕完整流動：停車預留 ➔ 步行引導 ➔ 景點時間軸</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 text-slate-400 hover:text-white rounded-lg hover:bg-slate-700 transition">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 衝突警示橫幅（若有時間或營業衝突） */}
        {hasConflicts && conflictLogs.length > 0 && (
          <div className="bg-rose-950/40 border-b border-rose-500/30 px-6 py-2.5 flex items-start gap-2 text-xs text-rose-300">
            <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
            <div className="space-y-0.5">
              <span className="font-bold">行程衝突檢查提示：</span>
              {conflictLogs.map((log, i) => (
                <div key={i} className="text-rose-200/90">• {log}</div>
              ))}
            </div>
          </div>
        )}

        {/* 行程推薦順序 (流水號) */}
        <div className="bg-indigo-950/40 border-b border-indigo-500/20 px-6 py-3 flex items-center gap-3 overflow-x-auto">
          <span className="text-xs font-semibold px-2.5 py-1 rounded bg-indigo-500 text-white shrink-0">
            行程站點
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
          
          {/* 目前站點時間軸與可信度資訊 */}
          <div className="bg-slate-800/80 p-4 rounded-xl border border-slate-700 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-rose-500/20 text-rose-400 font-bold flex items-center justify-center border border-rose-500/30">
                  <MapPin className="w-5 h-5" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-rose-400">站點 #{currentSpot.spot_order}</span>
                    <h3 className="text-lg font-bold text-white">{currentSpot.spot_name}</h3>
                    {confidenceLabel(currentSpot.confidence) && (
                      <span className="text-[11px] px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 flex items-center gap-1">
                        <ShieldCheck className="w-3 h-3" /> 可信度：{confidenceLabel(currentSpot.confidence)}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-400 mt-1">
                    推薦理由：{currentSpot.reason}
                    {sourceLabel(currentSpot.source) && <>（來源：{sourceLabel(currentSpot.source)}）</>}
                  </p>
                </div>
              </div>

              {/* 即時更新按鈕 */}
              <div className="flex items-center gap-3">
                {lastUpdateTime && (
                  <span className="text-[11px] text-slate-400 font-mono">
                    即時車位更新：{lastUpdateTime}
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

            {/* 時間流動：停車 ➔ 步行 ➔ 景點時間軸 */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-2 border-t border-slate-700/60 text-xs">
              {currentSpot.parking_arrival_time && (
                <div className="flex items-center gap-2 text-slate-300 bg-slate-900/40 p-2 rounded-lg">
                  <Car className="w-4 h-4 text-amber-400" />
                  <span>預計抵達停車場：<b className="text-amber-300">{currentSpot.parking_arrival_time}</b></span>
                </div>
              )}
              {currentSpot.walk_minutes_to_spot != null && (
                <div className="flex items-center gap-2 text-slate-300 bg-slate-900/40 p-2 rounded-lg">
                  <Footprints className="w-4 h-4 text-indigo-400" />
                  <span>步行至景點：約 <b className="text-indigo-300">{currentSpot.walk_minutes_to_spot} 分鐘</b></span>
                </div>
              )}
              <div className="flex items-center gap-2 text-slate-300 bg-slate-900/40 p-2 rounded-lg">
                <Clock className="w-4 h-4 text-emerald-400" />
                {currentSpot.arrival_time && currentSpot.departure_time ? (
                  <span>景點參觀時段：<b className="text-emerald-300">{currentSpot.arrival_time} ~ {currentSpot.departure_time}</b> ({currentSpot.suggested_stay_minutes}分)</span>
                ) : (
                  <span>建議停留：<b className="text-emerald-300">{currentSpot.suggested_stay_minutes} 分鐘</b></span>
                )}
              </div>
            </div>
          </div>

          {/* 停車場卡片列表 */}
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

                    <div className="absolute top-2 left-2 right-2 flex justify-between items-center pointer-events-none z-[400]">
                      <span className="bg-slate-900/90 backdrop-blur-md text-rose-400 text-[10px] px-2 py-0.5 rounded border border-rose-500/30 flex items-center gap-1 font-bold">
                        🔴 {currentSpot.spot_name}
                      </span>
                      <span className="bg-slate-900/90 backdrop-blur-md text-blue-400 text-[10px] px-2 py-0.5 rounded border border-blue-500/30 flex items-center gap-1 font-bold">
                        🔵 停車推薦 {pIdx + 1}
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
                      <h4 className="font-bold text-white text-base truncate" title={displayName}>
                        {displayName}
                      </h4>

                      <div className="mt-2 p-2 bg-amber-500/10 border border-amber-500/20 rounded text-[11px] text-amber-200/90 flex items-start gap-1.5 leading-tight">
                        <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
                        <span>資料取自 TDX 即時端點，車況有時差僅供參考。</span>
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
                              availabilityStatus(currentAvailable) === 'full'
                                ? 'text-rose-400'
                                : availabilityStatus(currentAvailable) === 'available'
                                ? 'text-emerald-400'
                                : 'text-slate-400'
                            }`}
                          >
                            {availabilityLabel(currentAvailable)}
                          </div>
                        </div>
                        <div className="border-l border-slate-700">
                          <div className="text-[11px] text-slate-400">總車位數</div>
                          <div className="text-base font-bold text-slate-200">
                            {parking.total_spaces || '-'}
                          </div>
                        </div>
                      </div>

                      {/* 費率 */}
                      <div className="mt-3 text-xs space-y-1.5 text-slate-300">
                        <div className="flex justify-between">
                          <span className="text-slate-400">收費時段:</span>
                          <span className="font-medium text-slate-200 truncate max-w-[170px]">
                            {parking.fare_description}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-slate-400">收費費率:</span>
                          <span className="font-medium text-amber-300 truncate max-w-[170px]">
                            {parking.hourly_rate}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Google 導航按鈕 */}
                    <div className="pt-3 border-t border-slate-700/60">
                      <button
                        onClick={() => handleGoogleNav(displayName, parking.lat, parking.lng)}
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