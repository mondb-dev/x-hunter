'use client';
import { useEffect, useRef } from 'react';

type Marker = { lat: number; lng: number; label?: string };
type Props = { title?: string; center?: [number, number]; zoom?: number; markers?: Marker[]; height?: number };

// Real interactive map via Leaflet loaded from CDN (no npm dep → no build risk).
// Part of the report viz registry; swappable for react-leaflet later.
export default function MapBlock({ title, center, zoom = 3, markers = [], height = 360 }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);

  useEffect(() => {
    let cancelled = false;
    const CSS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    const JS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';

    function ensureCss() {
      if (!document.querySelector(`link[href="${CSS}"]`)) {
        const l = document.createElement('link');
        l.rel = 'stylesheet'; l.href = CSS; document.head.appendChild(l);
      }
    }
    function loadJs(): Promise<any> {
      const w = window as any;
      if (w.L) return Promise.resolve(w.L);
      return new Promise((resolve, reject) => {
        const existing = document.querySelector(`script[src="${JS}"]`) as HTMLScriptElement | null;
        if (existing) { existing.addEventListener('load', () => resolve((window as any).L)); return; }
        const s = document.createElement('script');
        s.src = JS; s.async = true;
        s.onload = () => resolve((window as any).L);
        s.onerror = reject;
        document.head.appendChild(s);
      });
    }

    ensureCss();
    loadJs().then((L) => {
      if (cancelled || !ref.current || mapRef.current) return;
      const pts = markers.filter((m) => Number.isFinite(m.lat) && Number.isFinite(m.lng));
      const c = center || (pts.length ? [pts[0].lat, pts[0].lng] : [20, 0]);
      const map = L.map(ref.current).setView(c, zoom);
      mapRef.current = map;
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap', maxZoom: 19,
      }).addTo(map);
      pts.forEach((m) => {
        const mk = L.marker([m.lat, m.lng]).addTo(map);
        if (m.label) mk.bindPopup(m.label);
      });
      if (pts.length > 1) { try { map.fitBounds(pts.map((m) => [m.lat, m.lng])); } catch {} }
    }).catch(() => {});

    return () => { cancelled = true; if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; } };
  }, [center, zoom, markers]);

  return (
    <figure className="report-block report-map">
      {title ? <figcaption className="report-viz-title">{title}</figcaption> : null}
      <div ref={ref} style={{ height, width: '100%', borderRadius: 10, overflow: 'hidden' }} />
    </figure>
  );
}
