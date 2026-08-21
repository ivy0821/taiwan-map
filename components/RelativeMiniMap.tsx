// components/RelativeMiniMap.tsx
'use client';

import React, { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

interface RelativeMiniMapProps {
  spotName: string;
  spotLat: number;
  spotLng: number;
  parkingName: string;
  parkingLat: number;
  parkingLng: number;
}

export default function RelativeMiniMap({
  spotName,
  spotLat,
  spotLng,
  parkingName,
  parkingLat,
  parkingLng,
}: RelativeMiniMapProps) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);

  useEffect(() => {
    if (!mapContainerRef.current) return;

    // 若地圖實例已存在則銷毀重建，避免切換站點時重複綁定
    if (mapInstanceRef.current) {
      mapInstanceRef.current.remove();
      mapInstanceRef.current = null;
    }

    // 建立地圖實例
    const map = L.map(mapContainerRef.current, {
      zoomControl: false,
      attributionControl: false,
      dragging: true,
      scrollWheelZoom: false,
    });

    // 載入 OpenStreetMap 圖資
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
    }).addTo(map);

    // 🔴 紅色 Pin 圖示（景點）
    const spotIcon = L.divIcon({
      className: 'custom-pin-spot',
      html: `
        <div style="
          background-color: #ef4444;
          width: 28px;
          height: 28px;
          border-radius: 50% 50% 50% 0;
          transform: rotate(-45deg);
          border: 2px solid #ffffff;
          box-shadow: 0 2px 6px rgba(0,0,0,0.4);
          display: flex;
          align-items: center;
          justify-content: center;
        ">
          <div style="
            width: 10px;
            height: 10px;
            background-color: #ffffff;
            border-radius: 50%;
            transform: rotate(45deg);
          "></div>
        </div>
      `,
      iconSize: [28, 28],
      iconAnchor: [14, 28],
    });

    // 🔵 藍色 Pin 圖示（停車場）
    const parkingIcon = L.divIcon({
      className: 'custom-pin-parking',
      html: `
        <div style="
          background-color: #3b82f6;
          width: 28px;
          height: 28px;
          border-radius: 50% 50% 50% 0;
          transform: rotate(-45deg);
          border: 2px solid #ffffff;
          box-shadow: 0 2px 6px rgba(0,0,0,0.4);
          display: flex;
          align-items: center;
          justify-content: center;
        ">
          <span style="
            color: #ffffff;
            font-weight: 800;
            font-size: 13px;
            transform: rotate(45deg);
            line-height: 1;
          ">P</span>
        </div>
      `,
      iconSize: [28, 28],
      iconAnchor: [14, 28],
    });

    // 加入景點標記
    const spotMarker = L.marker([spotLat, spotLng], { icon: spotIcon })
      .addTo(map)
      .bindTooltip(`📍 ${spotName}`, { permanent: false, direction: 'top' });

    // 加入停車場標記
    const parkingMarker = L.marker([parkingLat, parkingLng], { icon: parkingIcon })
      .addTo(map)
      .bindTooltip(`🅿️ ${parkingName}`, { permanent: false, direction: 'top' });

    // 繪製兩點之間的導引虛線
    const latlngs: L.LatLngExpression[] = [
      [spotLat, spotLng],
      [parkingLat, parkingLng],
    ];
    L.polyline(latlngs, {
      color: '#6366f1',
      weight: 3,
      dashArray: '6, 6',
      opacity: 0.8,
    }).addTo(map);

    // 自動縮放讓兩個點同時完整顯示於視野中
    const bounds = L.latLngBounds([
      [spotLat, spotLng],
      [parkingLat, parkingLng],
    ]);
    map.fitBounds(bounds, { padding: [35, 35] });

    mapInstanceRef.current = map;

    return () => {
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
      }
    };
  }, [spotLat, spotLng, parkingLat, parkingLng, spotName, parkingName]);

  return <div ref={mapContainerRef} className="w-full h-full" />;
}