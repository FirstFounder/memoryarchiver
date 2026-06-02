import { useEffect, useState } from 'react';
import { MapContainer, TileLayer, Polyline, Marker, useMap } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import {
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';

function speedColor(kph) {
  const t = Math.min(kph ?? 0, 60) / 60;
  const r = Math.round(255 * t);
  const g = Math.round(255 * (1 - t));
  return `rgb(${r},${g},0)`;
}

function windArrowIcon(deg) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"
    viewBox="-10 -10 20 20"
    style="transform:rotate(${deg}deg);display:block;">
    <line x1="0" y1="8" x2="0" y2="-6" stroke="#60a5fa" stroke-width="2.5" stroke-linecap="round"/>
    <polygon points="0,-10 -4,-4 4,-4" fill="#60a5fa"/>
  </svg>`;
  return L.divIcon({ html: svg, className: '', iconSize: [20, 20], iconAnchor: [10, 10] });
}

function FitBounds({ bounds }) {
  const map = useMap();
  useEffect(() => {
    if (bounds) map.fitBounds(bounds, { padding: [30, 30] });
  }, [map, bounds]);
  return null;
}

function formatHMM(min) {
  if (min == null) return '—';
  const h = Math.floor(min / 60);
  const m = String(Math.round(min % 60)).padStart(2, '0');
  return `${h}:${m}`;
}

function formatMSS(sec) {
  const m = Math.floor(sec / 60);
  const s = String(Math.round(sec % 60)).padStart(2, '0');
  return `${m}:${s}`;
}

function StatRow({ label, value }) {
  if (value == null) return null;
  return (
    <div className="flex justify-between gap-2 text-xs py-0.5">
      <span className="text-slate-500">{label}</span>
      <span className="text-slate-200 text-right">{value}</span>
    </div>
  );
}

export default function RideTelemetryDetail({ legData, sessionLeg, onClose }) {
  const { session, legNum, trip, durationMin, legStartedAt } = sessionLeg;
  const [mapReady, setMapReady] = useState(false);

  useEffect(() => {
    setMapReady(true);
  }, []);

  const pings = legData?.pings ?? [];
  const stats = legData?.stats ?? null;
  const hasPings = pings.length >= 2;

  const legStartSoc = session[`leg_${legNum}_start_soc_pct`] ?? null;
  const legEndSoc = session[`leg_${legNum}_end_soc_pct`] ?? null;
  const legWhPerMile = session[`leg_${legNum}_wh_per_mile`] ?? null;

  const bounds = hasPings
    ? pings.reduce(
        (b, p) => [
          [Math.min(b[0][0], p.lat), Math.min(b[0][1], p.lon)],
          [Math.max(b[1][0], p.lat), Math.max(b[1][1], p.lon)],
        ],
        [[pings[0].lat, pings[0].lon], [pings[0].lat, pings[0].lon]],
      )
    : null;

  const startIcon = L.divIcon({
    html: '<div style="width:10px;height:10px;border-radius:50%;background:#22c55e;border:2px solid white"></div>',
    className: '',
    iconSize: [10, 10],
    iconAnchor: [5, 5],
  });
  const endIcon = L.divIcon({
    html: '<div style="width:10px;height:10px;border-radius:50%;background:#ef4444;border:2px solid white"></div>',
    className: '',
    iconSize: [10, 10],
    iconAnchor: [5, 5],
  });

  const windPings = hasPings
    ? pings.filter(p => p.motion === 'automotive' && p.wind_dir_deg != null)
    : [];
  const windMarkers = windPings.length >= 3
    ? (windPings.length < 6 ? windPings : windPings.filter((_, i) => i % 6 === 0))
    : [];

  const weatherData = hasPings
    ? pings
        .filter(p => p.temp_f != null)
        .map(p => ({
          elapsed: p.tst - pings[0].tst,
          temp_f: p.temp_f,
          wind_mph: p.wind_speed_mph,
        }))
    : [];

  const tripName = trip?.description ?? `Trip #${session[`leg_${legNum}_trip_id`]}`;
  const dateStr = legStartedAt
    ? new Date(legStartedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : null;

  return (
    <div className="rounded-2xl border border-slate-700 bg-slate-900 overflow-hidden mb-1">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-700">
        <div className="flex items-center gap-3 min-w-0">
          <span className="font-semibold text-slate-100 truncate">{tripName}</span>
          <span className="text-xs text-slate-500 whitespace-nowrap">
            {[dateStr, durationMin != null && formatHMM(durationMin), stats && `${stats.ping_count} pings`]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="flex-shrink-0 rounded-lg p-1 text-slate-400 hover:text-slate-200 hover:bg-slate-700 transition-colors"
          title="Close"
        >
          ✕
        </button>
      </div>

      {/* Body */}
      <div className="flex flex-col">
        <div className="flex gap-0" style={{ minHeight: '280px' }}>
          {/* Map — 60% */}
          <div className="flex-none" style={{ width: '60%' }}>
            {hasPings && mapReady ? (
              <MapContainer
                center={[pings[0].lat, pings[0].lon]}
                zoom={13}
                style={{ height: '280px', width: '100%', background: '#1e293b' }}
                zoomControl={true}
                attributionControl={true}
              >
                <TileLayer
                  url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                  attribution='© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                />
                {bounds && <FitBounds bounds={bounds} />}
                {pings.slice(0, -1).map((p, i) => (
                  <Polyline
                    key={i}
                    positions={[[p.lat, p.lon], [pings[i + 1].lat, pings[i + 1].lon]]}
                    color={speedColor(p.vel)}
                    weight={4}
                    opacity={0.85}
                  />
                ))}
                <Marker position={[pings[0].lat, pings[0].lon]} icon={startIcon} />
                <Marker position={[pings[pings.length - 1].lat, pings[pings.length - 1].lon]} icon={endIcon} />
                {windMarkers.map((p, i) => (
                  <Marker
                    key={i}
                    position={[p.lat, p.lon]}
                    icon={windArrowIcon(p.wind_dir_deg)}
                    interactive={false}
                  />
                ))}
              </MapContainer>
            ) : (
              <div className="flex items-center justify-center h-full text-slate-500 text-sm" style={{ height: '280px' }}>
                {legData === null
                  ? 'No route data recorded for this ride'
                  : pings.length === 0
                    ? 'No route data recorded for this ride'
                    : 'Loading map…'}
              </div>
            )}
          </div>

          {/* Stats panel — 40% */}
          <div className="flex-1 px-4 py-3 overflow-y-auto border-l border-slate-700" style={{ maxHeight: '280px' }}>
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">Stats</p>

            {stats && (
              <>
                {stats.max_vel_kph != null && (
                  <StatRow
                    label="Max Speed"
                    value={`${stats.max_vel_kph.toFixed(0)} km/h · ${(stats.max_vel_kph * 0.621371).toFixed(0)} mph`}
                  />
                )}
                {stats.avg_vel_kph != null && (
                  <StatRow
                    label="Avg Speed"
                    value={`${stats.avg_vel_kph.toFixed(0)} km/h · ${(stats.avg_vel_kph * 0.621371).toFixed(0)} mph`}
                  />
                )}
                {stats.distance_km != null && (
                  <StatRow
                    label="Distance"
                    value={`${stats.distance_km.toFixed(2)} km · ${(stats.distance_km * 0.621371).toFixed(2)} mi`}
                  />
                )}
                {stats.elevation_gain_m != null && (
                  <StatRow label="Elevation Gain" value={`${Math.round(stats.elevation_gain_m)} m`} />
                )}
                {stats.elevation_loss_m != null && (
                  <StatRow label="Elevation Loss" value={`${Math.round(stats.elevation_loss_m)} m`} />
                )}
                <StatRow label="Ping Count" value={stats.ping_count} />
                {stats.avg_temp_f != null && (
                  <StatRow label="Avg Temp" value={`${stats.avg_temp_f.toFixed(1)} °F`} />
                )}
                {stats.avg_wind_mph != null && (
                  <StatRow label="Avg Wind" value={`${stats.avg_wind_mph.toFixed(1)} mph`} />
                )}
              </>
            )}

            <div className="mt-2 border-t border-slate-700 pt-2">
              {durationMin != null && (
                <StatRow label="Duration" value={formatHMM(durationMin)} />
              )}
              {legStartSoc != null && legEndSoc != null && (
                <StatRow label="SOC" value={`${legStartSoc}% → ${legEndSoc}%`} />
              )}
              {legWhPerMile != null && (
                <StatRow
                  label="Wh/mi"
                  value={legWhPerMile < 100 ? legWhPerMile.toFixed(1) : Math.round(legWhPerMile)}
                />
              )}
            </div>

            {!hasPings && legData !== null && (
              <p className="mt-3 text-xs text-slate-500">No route data recorded for this ride</p>
            )}
          </div>
        </div>

        {/* Weather chart */}
        {weatherData.length > 1 && (
          <div className="border-t border-slate-700 px-2 py-2" style={{ height: '160px' }}>
            <ResponsiveContainer width="100%" height={140}>
              <ComposedChart data={weatherData} margin={{ top: 4, right: 24, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis
                  dataKey="elapsed"
                  tickFormatter={formatMSS}
                  tick={{ fill: '#64748b', fontSize: 10 }}
                  axisLine={{ stroke: '#334155' }}
                  tickLine={false}
                />
                <YAxis
                  yAxisId="temp"
                  tick={{ fill: '#60a5fa', fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  width={36}
                />
                <YAxis
                  yAxisId="wind"
                  orientation="right"
                  tick={{ fill: '#2dd4bf', fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  width={36}
                />
                <Tooltip
                  contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8, fontSize: 11 }}
                  labelStyle={{ color: '#94a3b8' }}
                  labelFormatter={(v) => `T+${formatMSS(v)}`}
                  formatter={(value, name) => [
                    name === 'Temp (°F)' ? `${value?.toFixed(1)} °F` : `${value?.toFixed(1)} mph`,
                    name,
                  ]}
                />
                <Line
                  yAxisId="temp"
                  type="monotone"
                  dataKey="temp_f"
                  stroke="#60a5fa"
                  dot={false}
                  strokeWidth={1.5}
                  name="Temp (°F)"
                />
                <Line
                  yAxisId="wind"
                  type="monotone"
                  dataKey="wind_mph"
                  stroke="#2dd4bf"
                  dot={false}
                  strokeWidth={1.5}
                  name="Wind (mph)"
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </div>
  );
}
