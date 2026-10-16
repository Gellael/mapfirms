import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Map as MLMap, Popup, NavigationControl, ScaleControl, setWorkerUrl } from 'maplibre-gl'
import type { StyleSpecification, GeoJSONSource, MapMouseEvent, MapLayerMouseEvent } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import * as turf from '@turf/turf'
import type { Feature, FeatureCollection, Point } from 'geojson'

// Worker MapLibre disajikan Vite sebagai file terpisah (perbaikan "Worker failed to load")
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
setWorkerUrl(workerUrl)

/* ---------------------------------- Basemap --------------------------------- */
const raster = (tiles: string[], attribution: string, maxzoom = 18): StyleSpecification => ({
  version: 8,
  sources: { base: { type: 'raster', tiles, tileSize: 256, attribution, maxzoom } },
  layers: [{ id: 'base', type: 'raster', source: 'base' }],
})
const CARTO_ATTR = '© OpenStreetMap contributors © CARTO'
/* API key CARTO Basemaps: isi VITE_CARTO_KEY di frontend/.env (lihat transformRequest di bawah) */
const CARTO_KEY = (import.meta.env.VITE_CARTO_KEY as string | undefined)?.trim()
const sub = (style: string) => [`https://basemaps.cartocdn.com/rastertiles/${style}/{z}/{x}/{y}.png`]

const DEFAULT_BASEMAP = 'Gelap (Carto)'
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas'

const BASEMAPS: Record<string, string | StyleSpecification> = {
  'Gelap (Carto)': raster(sub('dark_all'), CARTO_ATTR),
  'Malam (NASA City Lights)': raster(
    ['https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_CityLights_2012/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpg'],
    'Imagery © NASA GIBS',
    8
  ),
  'Gelap + label (Esri)': {
    version: 8,
    sources: {
      base: { type: 'raster', tiles: [`${ESRI}/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`], tileSize: 256, maxzoom: 16, attribution: 'Tiles © Esri' },
      ref: { type: 'raster', tiles: [`${ESRI}/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`], tileSize: 256, maxzoom: 16 },
    },
    layers: [
      { id: 'base', type: 'raster', source: 'base' },
      { id: 'ref', type: 'raster', source: 'ref' },
    ],
  },
  'Gelap vektor (Carto)': 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  'Satelit (Esri)': raster(
    ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
    'Tiles © Esri',
    17
  ),
  'Terang (Carto)': raster(sub('light_all'), CARTO_ATTR),
  'Vektor (OpenFreeMap)': 'https://tiles.openfreemap.org/styles/liberty',
}

/* --------------------------- Wilayah Indonesia (cadangan) ---------------------
   Dipakai hanya bila GeoJSON provinsi/kota belum tersedia. Kalau GeoJSON ada,
   batas resmi dari file itulah yang dipakai untuk menyaring & mengelompokkan titik. */
type Region = { id: string; color: string; bounds: [number, number, number, number]; poly: number[][] }
const REGIONS: Region[] = [
  { id: 'Sumatera', color: '#ff7b54', bounds: [94.8, -6.0, 108.4, 6.4],
    poly: [[94.8,6.4],[97.5,5.9],[98.9,4.9],[100.2,4.0],[101.2,2.8],[102.3,1.9],[103.2,1.1],[104.8,0.7],[108.4,-0.8],[108.4,-3.7],[106.5,-4.8],[106.0,-5.95],[94.8,-6.0]] },
  { id: 'Jawa', color: '#ffd166', bounds: [105.0, -9.0, 114.42, -5.5],
    poly: [[105.0,-6.1],[106.0,-5.95],[106.2,-5.5],[114.42,-5.5],[114.42,-9.0],[105.0,-8.5]] },
  { id: 'Kalimantan', color: '#ef476f', bounds: [108.8, -4.2, 118.3, 4.5],
    poly: [[108.8,-3.9],[108.8,2.2],[109.7,2.2],[109.9,1.6],[110.3,1.15],[111.0,1.1],[112.0,1.2],[113.0,1.3],[113.9,1.6],[114.7,2.3],[115.5,3.9],[116.6,4.5],[118.0,4.5],[118.3,2.0],[118.2,0.0],[117.4,-1.0],[116.6,-2.0],[116.3,-4.2],[110.0,-4.0]] },
  { id: 'Sulawesi', color: '#06d6a0', bounds: [118.8, -7.4, 127.0, 4.7],
    poly: [[118.8,-7.4],[118.8,-2.0],[119.0,0.0],[120.0,1.8],[125.0,1.8],[125.0,4.7],[127.0,4.7],[127.0,2.2],[125.0,0.0],[125.0,-2.5],[124.5,-5.0],[124.0,-7.4]] },
  { id: 'Bali & Nusa Tenggara', color: '#4cc9f0', bounds: [114.42, -11.2, 124.9, -7.4],
    poly: [[114.42,-7.4],[124.9,-7.4],[124.9,-11.2],[114.42,-11.2]] },
  { id: 'Papua', color: '#b388ff', bounds: [130.0, -9.5, 141.0, 1.0],
    poly: [[130.0,1.0],[141.0,1.0],[141.0,-9.5],[136.0,-9.5],[135.4,-5.2],[133.9,-4.4],[131.4,-3.9],[131.4,-1.5],[130.0,-1.5]] },
  { id: 'Maluku', color: '#f78fb3', bounds: [125.0, -8.4, 136.0, 3.0],
    poly: [[125.0,-8.4],[136.0,-8.4],[136.0,3.0],[125.0,3.0]] },
]
const POLYS = REGIONS.map((r) => turf.polygon([[...r.poly, r.poly[0]]]))

function regionOf(lon: number, lat: number): Region | null {
  const pt: [number, number] = [lon, lat]
  for (let i = 0; i < REGIONS.length; i++) {
    const b = REGIONS[i].bounds
    if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) continue
    if (turf.booleanPointInPolygon(pt, POLYS[i])) return REGIONS[i]
  }
  return null
}

/* ------------------------- GeoJSON provinsi & kota/kabupaten ------------------- */
/* Taruh file di frontend/public/geo/provinsi.geojson dan kota.geojson (WGS84),
   atau arahkan lewat VITE_GEO_PROV / VITE_GEO_KOTA di .env. */
type Level = 'prov' | 'kota'
type BBox = [number, number, number, number]
type Geo = { fc: FeatureCollection; names: string[]; parents: string[]; bb: BBox[] }
type GeoSet = { prov: Geo | null; kota: Geo | null }
const GEO_URL: Record<Level, string> = {
  prov: (import.meta.env.VITE_GEO_PROV as string | undefined) || '/geo/Provinsi.json',
  kota: (import.meta.env.VITE_GEO_KOTA as string | undefined) || '/geo/Kabupaten.json',
}
/* cadangan: bila nama properti tidak dikenal, cari otomatis dari pola nama kunci,
   lalu dari properti teks pertama yang bukan kode/ID */
const PROV_RE = /prov|wadmpr|name_1/i
const KOTA_RE = /kab|kota|wadmkk|name_2/i
const autoName = (p: any, re: RegExp) => {
  if (!p) return ''
  for (const k of Object.keys(p)) if (re.test(k) && typeof p[k] === 'string' && p[k].trim()) return p[k].trim()
  return ''
}
const anyText = (p: any) => {
  if (!p) return ''
  for (const k of Object.keys(p)) {
    const v = p[k]
    if (typeof v === 'string' && v.trim() && !/^(id|kode|code|objectid|fid|gid|kd_|kdp|kdk)/i.test(k) && !/^[\d.\s]+$/.test(v)) return v.trim()
  }
  return ''
}
/* nama properti yang umum dipakai berbagai sumber (BIG, BPS, GADM, dll.) */
const PROV_KEYS = ['provinsi', 'Provinsi', 'PROVINSI', 'Propinsi', 'PROPINSI', 'WADMPR', 'NAME_1', 'nama_prov', 'prov', 'PROV']
const KOTA_KEYS = ['kabkot', 'KABKOT', 'kab_kota', 'KAB_KOTA', 'WADMKK', 'NAME_2', 'nama_kab', 'kabupaten', 'KABUPATEN', 'kota', 'KOTA']
const ANY_KEYS = ['name', 'NAME', 'Name', 'nama', 'NAMA']
const pick = (p: any, keys: string[]) => {
  if (!p) return ''
  for (const k of keys) { const v = p[k]; if (v != null && String(v).trim()) return String(v).trim() }
  return ''
}

async function loadGeo(url: string, keys: string[], parentKeys: string[] | null, re: RegExp, parentRe: RegExp | null): Promise<Geo | null> {
  try {
    const r = await fetch(url)
    if (!r.ok) return null
    const j = await r.json()
    const raw: any[] = j.type === 'FeatureCollection' ? j.features : j.type === 'Feature' ? [j] : []
    const feats = raw.filter((f) => f?.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon'))
    if (!feats.length) return null
    const names: string[] = [], parents: string[] = [], bb: BBox[] = []
    const out = feats.map((f, i) => {
      const name = pick(f.properties, keys) || autoName(f.properties, re) || anyText(f.properties) || `Wilayah ${i + 1}`
      const parent = parentKeys ? pick(f.properties, parentKeys) || (parentRe ? autoName(f.properties, parentRe) : '') : ''
      names.push(name); parents.push(parent); bb.push(turf.bbox(f) as BBox)
      // properti asli dibuang supaya ringan; id numerik dipakai untuk feature-state
      return { type: 'Feature', id: i, geometry: f.geometry, properties: { _id: i, _name: name, _parent: parent } }
    })
    return { fc: { type: 'FeatureCollection', features: out } as FeatureCollection, names, parents, bb }
  } catch {
    return null
  }
}

function locate(g: Geo, lon: number, lat: number): number {
  const fs = g.fc.features
  for (let i = 0; i < fs.length; i++) {
    const b = g.bb[i]
    if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) continue
    if (turf.booleanPointInPolygon([lon, lat], fs[i] as any)) return i
  }
  return -1
}

/* ------------------------------------ Util ---------------------------------- */
function level(c: unknown): 0 | 1 | 2 {
  const s = String(c).toLowerCase()
  if (s === 'l' || s === 'low') return 0
  if (s === 'n' || s === 'nominal') return 1
  if (s === 'h' || s === 'high') return 2
  const n = Number(s)
  if (!Number.isNaN(n)) return n >= 80 ? 2 : n >= 30 ? 1 : 0
  return 1
}
const LEVEL_NAME = ['Rendah', 'Sedang', 'Tinggi']
const nf = new Intl.NumberFormat('id-ID')
const nf1 = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 1 })

/* ------------------- Grid angin & polusi udara (Open-Meteo / CAMS) ------------- */
type WindPt = { lon: number; lat: number; speed: number; dir: number } // dir = arah ASAL angin (derajat)
const GSTEP = 2 // jarak grid (derajat) — dipakai bersama oleh angin dan polusi
const COMPASS = ['Utara', 'Timur Laut', 'Timur', 'Tenggara', 'Selatan', 'Barat Daya', 'Barat', 'Barat Laut']
const compass = (deg: number) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8]
const rng = (a: number, b: number, st: number) => { const o: number[] = []; for (let x = a; x <= b + 1e-9; x += st) o.push(+x.toFixed(2)); return o }
const GLON = rng(94, 142, GSTEP)
const GLAT = rng(-12, 8, GSTEP)
const NX = GLON.length, NY = GLAT.length
const GRID_PTS = GLAT.flatMap((la) => GLON.map((lo) => ({ lo, la })))
const GRID_Q = `latitude=${GRID_PTS.map((p) => p.la).join(',')}&longitude=${GRID_PTS.map((p) => p.lo).join(',')}`

function nearestWind(w: WindPt[], lon: number, lat: number): WindPt | null {
  let best: WindPt | null = null, bd = Infinity
  for (const p of w) { const d = (p.lon - lon) ** 2 + (p.lat - lat) ** 2; if (d < bd) { bd = d; best = p } }
  return best
}

/* interpolasi bilinear dengan smoothstep (tanpa "patahan" di tepi sel) */
const G = { i: 0, fx: 0, fy: 0 }
function gpos(lon: number, lat: number) {
  const gx = Math.min(NX - 1.001, Math.max(0, (lon - GLON[0]) / GSTEP))
  const gy = Math.min(NY - 1.001, Math.max(0, (lat - GLAT[0]) / GSTEP))
  const x0 = Math.floor(gx), y0 = Math.floor(gy)
  const ax = gx - x0, ay = gy - y0
  G.i = y0 * NX + x0
  G.fx = ax * ax * (3 - 2 * ax)
  G.fy = ay * ay * (3 - 2 * ay)
}
const bil = (a: Float32Array) =>
  a[G.i] * (1 - G.fx) * (1 - G.fy) + a[G.i + 1] * G.fx * (1 - G.fy) + a[G.i + NX] * (1 - G.fx) * G.fy + a[G.i + NX + 1] * G.fx * G.fy

type Field = { u: Float32Array; v: Float32Array }
function buildField(w: WindPt[]): Field {
  const u = new Float32Array(w.length), v = new Float32Array(w.length)
  w.forEach((p, i) => { const t = (p.dir * Math.PI) / 180; u[i] = -p.speed * Math.sin(t); v[i] = -p.speed * Math.cos(t) })
  return { u, v }
}
function sampleWind(f: Field, lon: number, lat: number, out: number[]) {
  gpos(lon, lat); out[0] = bil(f.u); out[1] = bil(f.v)
}
function sampleGrid(a: Float32Array, lon: number, lat: number) {
  gpos(lon, lat); return bil(a)
}

/* polusi udara: PM2.5, PM10, debu, AOD (CAMS global via Open-Meteo, ±45 km) */
type AqKey = 'pm25' | 'pm10' | 'dust' | 'aod'
type AqData = Record<AqKey, Float32Array>
const AQ_DEF: Record<AqKey, { label: string; unit: string; stops: number[]; digits: number }> = {
  pm25: { label: 'PM2.5', unit: 'µg/m³', stops: [0, 9, 35.5, 55.5, 125.5, 225.5, 325], digits: 0 },
  pm10: { label: 'PM10', unit: 'µg/m³', stops: [0, 20, 50, 100, 200, 300, 450], digits: 0 },
  dust: { label: 'Debu', unit: 'µg/m³', stops: [0, 10, 30, 60, 120, 200, 400], digits: 0 },
  aod: { label: 'Kabut asap (AOD)', unit: '', stops: [0, 0.1, 0.25, 0.5, 1, 1.5, 2.5], digits: 2 },
}
const AQ_RGBA = [[255, 235, 200, 0], [255, 214, 160, 70], [255, 160, 100, 120], [240, 80, 120, 160], [205, 35, 150, 190], [135, 22, 160, 212], [70, 10, 120, 230]]
function aqColor(key: AqKey, v: number, out: number[]) {
  const s = AQ_DEF[key].stops
  if (!(v > s[0])) { out[3] = 0; return }
  let i = 1
  while (i < s.length - 1 && v > s[i]) i++
  const t = Math.min(1, (v - s[i - 1]) / (s[i] - s[i - 1]))
  const a = AQ_RGBA[i - 1], b = AQ_RGBA[i]
  for (let k = 0; k < 4; k++) out[k] = a[k] + (b[k] - a[k]) * t
}
const AQ_LEGEND = `linear-gradient(90deg, rgba(255,255,255,.08), ${AQ_RGBA.slice(1)
  .map((c, i) => `rgba(${c[0]},${c[1]},${c[2]},${Math.min(1, c[3] / 255 + 0.3)}) ${((i + 1) / 6) * 100}%`)
  .join(', ')})`
const PM_BANDS = [
  { max: 9, t: 'Baik', c: '#4ade80' },
  { max: 35.5, t: 'Sedang', c: '#facc15' },
  { max: 55.5, t: 'Tidak sehat bagi kelompok sensitif', c: '#fb923c' },
  { max: 125.5, t: 'Tidak sehat', c: '#f43f5e' },
  { max: 225.5, t: 'Sangat tidak sehat', c: '#c026d3' },
  { max: Infinity, t: 'Berbahaya', c: '#8b5cf6' },
]
const pmBand = (v: number) => PM_BANDS.find((b) => v <= b.max) ?? PM_BANDS[PM_BANDS.length - 1]

/* warna asap hasil simulasi plume: kerapatan → peach → magenta → ungu tua (mirip Fire Emissions Watch) */
const SMOKE_STOPS = [[0, 255, 200, 170, 0], [0.06, 255, 205, 175, 45], [0.3, 255, 140, 110, 105], [0.7, 240, 70, 140, 150], [1.3, 190, 40, 170, 190], [2.2, 110, 20, 150, 215], [3, 60, 10, 110, 235]]
function buildSmokeLut(): Uint32Array {
  const lut = new Uint32Array(256)
  for (let k = 0; k < 256; k++) {
    const v = Math.pow(k / 255, 2) * 3 // kebalikan dari pemetaan sqrt saat render
    let i = 1
    while (i < SMOKE_STOPS.length - 1 && v > SMOKE_STOPS[i][0]) i++
    const a = SMOKE_STOPS[i - 1], b = SMOKE_STOPS[i]
    const t = Math.min(1, Math.max(0, (v - a[0]) / (b[0] - a[0])))
    const c = [1, 2, 3, 4].map((j) => Math.round(a[j] + (b[j] - a[j]) * t))
    lut[k] = ((c[3] << 24) | (c[2] << 16) | (c[1] << 8) | c[0]) >>> 0 // ABGR (little-endian)
  }
  return lut
}
const SMOKE_LUT = buildSmokeLut()
const smokeKernels: Float32Array[] = [0, 1, 2, 3, 4, 5, 6].map((r) => {
  if (r === 0) return new Float32Array([1])
  const n = 2 * r + 1, k = new Float32Array(n * n), sg = 0.55 * r + 0.3
  let s = 0
  for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) { const w = Math.exp(-(x * x + y * y) / (2 * sg * sg)); k[(y + r) * n + x + r] = w; s += w }
  for (let i = 0; i < k.length; i++) k[i] /= s
  return k
})

const LV_COLOR = ['#ffcc80', '#ff8a65', '#ef5350']
/* aliran angin: biru dingin → hijau → kuning → oranye/merah menurut kecepatan (km/j) */
const WIND_STEPS = [6, 12, 20, 30, 45]
const WIND_COLORS = ['rgba(120,190,255,0.55)', 'rgba(120,225,235,0.62)', 'rgba(160,245,190,0.68)', 'rgba(240,240,150,0.74)', 'rgba(255,190,120,0.8)', 'rgba(255,120,120,0.88)']

function toWib(date: string, time: string): string {
  const t = String(time ?? '').padStart(4, '0')
  const d = new Date(`${date}T${t.slice(0, 2)}:${t.slice(2)}:00Z`)
  if (isNaN(d.getTime())) return `${date} ${t} UTC`
  return (
    d.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' WIB'
  )
}

function popupHtml(p: any, w: WindPt | null, pm: number | null): string {
  const dn = p.daynight === 'D' ? 'Siang' : p.daynight === 'N' ? 'Malam' : '-'
  return `<div class="pop"><b>🔥 Titik panas</b>
    <div class="pop-row"><span>Wilayah</span><b>${p._place || p._region}</b></div>
    <div class="pop-row"><span>Waktu</span><b>${toWib(p.acq_date, p.acq_time)}</b></div>
    <div class="pop-row"><span>Satelit</span><b>${p.satellite}</b></div>
    <div class="pop-row"><span>Keyakinan</span><b>${LEVEL_NAME[level(p.confidence)]}</b></div>
    <div class="pop-row"><span>FRP</span><b>${p.frp} MW</b></div>
    <div class="pop-row"><span>Pengamatan</span><b>${dn}</b></div>
    ${pm != null ? `<div class="pop-row"><span>PM2.5 (CAMS)</span><b>${Math.round(pm)} µg/m³</b></div>` : ''}
    ${w ? `<div class="pop-row"><span>Arah asap</span><b>${Math.round(w.speed)} km/j → ${compass(w.dir + 180)}</b></div>` : ''}</div>`
}

type Fires = FeatureCollection<Point, Record<string, any>>
const EMPTY: Fires = { type: 'FeatureCollection', features: [] }
const EMPTY_FC: FeatureCollection = { type: 'FeatureCollection', features: [] }
const INDONESIA: [number, number, number, number] = [94.5, -11.5, 141.5, 6.5]

type Acc = { n: number; frp: number; high: number; max: number; dates: Record<string, number> }
type VisKey = 'heat' | 'radius' | 'wind' | 'smoke' | 'aq' | 'points' | 'choro' | 'borders'
const VIS0: Record<VisKey, boolean> = { heat: true, radius: true, wind: true, smoke: true, aq: true, points: true, choro: true, borders: true }
const LAYER_LIST: [VisKey, string][] = [
  ['points', 'Titik api'], ['heat', 'Heatmap panas'], ['radius', 'Radius panas'],
  ['smoke', 'Plume asap'], ['aq', 'Polusi udara (CAMS)'], ['wind', 'Aliran angin'],
  ['borders', 'Batas wilayah'], ['choro', 'Warna per wilayah'],
]

/* ekspresi warna isi poligon: terpilih > hover > choropleth jumlah titik */
const fillExpr = (max: number, choro: boolean) => [
  'case',
  ['boolean', ['feature-state', 'sel'], false], 'rgba(79,195,247,0.20)',
  ['boolean', ['feature-state', 'hover'], false], 'rgba(255,255,255,0.10)',
  choro
    ? ['interpolate', ['linear'], ['to-number', ['feature-state', 'n'], 0], 0, 'rgba(239,83,80,0)', Math.max(max, 1), 'rgba(239,83,80,0.34)']
    : 'rgba(0,0,0,0.01)',
]

/* ------------------------------------ App ----------------------------------- */
export default function App() {
  const el = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MLMap | null>(null)
  const firesRef = useRef<Fires>(EMPTY)
  const radiusPoly = useRef<FeatureCollection>(EMPTY_FC)
  const center = useRef<[number, number] | null>(null)
  const radiusRef = useRef(25)
  const lastBasemap = useRef(DEFAULT_BASEMAP)
  const lastErr = useRef('')
  const windRef = useRef<WindPt[]>([])
  const aqRef = useRef<AqData | null>(null)
  const visRef = useRef<Record<VisKey, boolean>>(VIS0)
  const geoRef = useRef<GeoSet>({ prov: null, kota: null })
  const levelRef = useRef<Level>('prov')
  const modeRef = useRef<'area' | 'radius'>('area')
  const selRef = useRef<{ level: Level; idx: number } | null>(null)
  const prevSel = useRef<{ level: Level; idx: number } | null>(null)
  const countsRef = useRef<{ prov: Map<number, number>; kota: Map<number, number>; maxProv: number; maxKota: number }>({
    prov: new Map(), kota: new Map(), maxProv: 1, maxKota: 1,
  })
  const gainRef = useRef(1)

  const [basemap, setBasemap] = useState(DEFAULT_BASEMAP)
  const [source, setSource] = useState('VIIRS_SNPP_NRT')
  const [days, setDays] = useState(1)
  const [minLevel, setMinLevel] = useState(0)
  const [radiusKm, setRadiusKm] = useState(25)
  const [raw, setRaw] = useState<Fires>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [updatedAt, setUpdatedAt] = useState('')
  const [local, setLocal] = useState<{ n: number; frp: number; high: number } | null>(null)
  const [error, setError] = useState('')
  const [mapWarn, setMapWarn] = useState(CARTO_KEY ? '' : 'VITE_CARTO_KEY belum diisi di .env: peta Carto tampil dengan watermark.')
  const [dbg, setDbg] = useState('')
  const [wind, setWind] = useState<WindPt[]>([])
  const [windErr, setWindErr] = useState('')
  const [aq, setAq] = useState<AqData | null>(null)
  const [aqErr, setAqErr] = useState('')
  const [aqVar, setAqVar] = useState<AqKey>('pm25')
  const [vis, setVis] = useState<Record<VisKey, boolean>>(VIS0)
  const [smokeGain, setSmokeGain] = useState(1)
  const [geo, setGeo] = useState<GeoSet>({ prov: null, kota: null })
  const [geoState, setGeoState] = useState<'loading' | 'ok' | 'none'>('loading')
  const [lvl, setLvl] = useState<Level>('prov')
  const [mode, setMode] = useState<'area' | 'radius'>('area')
  const [sel, setSel] = useState<{ level: Level; idx: number } | null>(null)
  const [hoverName, setHoverName] = useState('')
  const cvsRef = useRef<HTMLCanvasElement>(null)
  const smokeRef = useRef<HTMLCanvasElement>(null)
  const aqCvRef = useRef<HTMLCanvasElement>(null)
  const showDbg = useMemo(() => new URLSearchParams(location.search).has('debug'), [])

  const windAvg = useMemo(() => {
    if (!wind.length) return null
    let x = 0, y = 0
    for (const p of wind) { const t = ((p.dir + 180) * Math.PI) / 180; x += p.speed * Math.sin(t); y += p.speed * Math.cos(t) }
    return { speed: Math.round(Math.hypot(x, y) / wind.length), dir: ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360 }
  }, [wind])

  /* data: hanya titik di wilayah Indonesia (pakai GeoJSON provinsi bila ada) + tingkat keyakinan */
  const indo = useMemo<Fires>(() => {
    const feats: Feature<Point, Record<string, any>>[] = []
    for (const f of raw.features) {
      const [lon, lat] = f.geometry.coordinates
      let pi = -1, ki = -1, island = '', region = ''
      if (geo.prov) {
        pi = locate(geo.prov, lon, lat)
        if (pi < 0) continue
        region = geo.prov.names[pi]
      } else {
        const r = regionOf(lon, lat)
        if (!r) continue
        island = r.id; region = r.id
      }
      if (geo.kota) ki = locate(geo.kota, lon, lat)
      const place = ki >= 0 && geo.kota ? `${geo.kota.names[ki]}, ${region}` : region
      feats.push({ ...f, properties: { ...f.properties, _region: region, _island: island, _place: place, _pi: pi, _ki: ki, _lvl: level(f.properties.confidence) } })
    }
    return { type: 'FeatureCollection', features: feats }
  }, [raw, geo])

  const filtered = useMemo<Fires>(
    () => ({ type: 'FeatureCollection', features: indo.features.filter((f) => f.properties._lvl >= minLevel) }),
    [indo, minLevel]
  )

  const stats = useMemo(() => {
    const byIsland: Record<string, { n: number; frp: number }> = {}
    REGIONS.forEach((r) => (byIsland[r.id] = { n: 0, frp: 0 }))
    const byProv = new Map<number, Acc>(), byKota = new Map<number, Acc>()
    const kotaOfProv = new Map<number, Map<number, number>>()
    const bump = (m: Map<number, Acc>, k: number, v: number, hi: boolean, d: string) => {
      let a = m.get(k)
      if (!a) { a = { n: 0, frp: 0, high: 0, max: 0, dates: {} }; m.set(k, a) }
      a.n++; a.frp += v; if (hi) a.high++; if (v > a.max) a.max = v
      a.dates[d] = (a.dates[d] || 0) + 1
    }
    const byDate: Record<string, number> = {}
    let frp = 0, maxFrp = 0, high = 0, latest = ''
    const lv = [0, 0, 0]
    let latestParts = { d: '', t: '' }
    for (const f of filtered.features) {
      const p = f.properties
      const v = Number(p.frp) || 0
      frp += v
      if (v > maxFrp) maxFrp = v
      if (p._lvl === 2) high++
      lv[p._lvl]++
      if (p._island && byIsland[p._island]) { byIsland[p._island].n++; byIsland[p._island].frp += v }
      if (p._pi >= 0) bump(byProv, p._pi, v, p._lvl === 2, p.acq_date)
      if (p._ki >= 0) bump(byKota, p._ki, v, p._lvl === 2, p.acq_date)
      if (p._pi >= 0 && p._ki >= 0) {
        let m = kotaOfProv.get(p._pi)
        if (!m) { m = new Map(); kotaOfProv.set(p._pi, m) }
        m.set(p._ki, (m.get(p._ki) || 0) + 1)
      }
      byDate[p.acq_date] = (byDate[p.acq_date] || 0) + 1
      const key = `${p.acq_date}${String(p.acq_time).padStart(4, '0')}`
      if (key > latest) { latest = key; latestParts = { d: p.acq_date, t: p.acq_time } }
    }
    const provCount = new Map<number, number>(), kotaCount = new Map<number, number>()
    byProv.forEach((a, k) => provCount.set(k, a.n))
    byKota.forEach((a, k) => kotaCount.set(k, a.n))
    const maxProv = Math.max(1, ...provCount.values()), maxKota = Math.max(1, ...kotaCount.values())
    const dates = Object.keys(byDate).sort().slice(-5)
    const maxDate = Math.max(1, ...dates.map((d) => byDate[d]))
    return {
      total: filtered.features.length, lv, frp: Math.round(frp), maxFrp: Math.round(maxFrp), high,
      byIsland, byProv, byKota, kotaOfProv, provCount, kotaCount, maxProv, maxKota, dates, byDate, maxDate,
      latest: latest ? toWib(latestParts.d, latestParts.t) : '-',
    }
  }, [filtered])

  /* statistik polusi udara CAMS di titik-titik api */
  const aqStats = useMemo(() => {
    if (!aq) return null
    let max = 0
    for (let i = 0; i < aq.pm25.length; i++) if (aq.pm25[i] > max) max = aq.pm25[i]
    const fs = filtered.features
    let sum = 0, n = 0
    const step = Math.max(1, Math.floor(fs.length / 1500))
    for (let i = 0; i < fs.length; i += step) {
      const [lon, lat] = fs[i].geometry.coordinates
      sum += sampleGrid(aq.pm25, lon, lat); n++
    }
    return { avg: n ? sum / n : null, max }
  }, [aq, filtered])

  const applyVis = useCallback((map: MLMap) => {
    const v = visRef.current, l = levelRef.current
    const set = (ids: string[], on: boolean) => ids.forEach((id) => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none'))
    set(['fires-heat'], v.heat); set(['fires-radius', 'fires-glow'], v.radius); set(['fires-pt'], v.points)
    set(['prov-fill'], l === 'prov'); set(['kota-fill'], l === 'kota')
    set(['prov-line'], v.borders); set(['kota-line'], v.borders && l === 'kota')
  }, [])

  /* hitung ulang warna choropleth + status terpilih (dipanggil setelah style/data berubah) */
  const applyGeoState = useCallback((map: MLMap) => {
    const c = countsRef.current
    ;(['prov', 'kota'] as const).forEach((l) => {
      const g = geoRef.current[l]
      if (!g || !map.getSource(l)) return
      const m = c[l]
      for (let i = 0; i < g.names.length; i++) map.setFeatureState({ source: l, id: i }, { n: m.get(i) ?? 0 })
      if (map.getLayer(`${l}-fill`)) map.setPaintProperty(`${l}-fill`, 'fill-color', fillExpr(l === 'prov' ? c.maxProv : c.maxKota, visRef.current.choro) as any)
      const s = selRef.current
      if (s && s.level === l) map.setFeatureState({ source: l, id: s.idx }, { sel: true })
    })
  }, [])

  /* pasang source + layer; dipanggil setiap style baru selesai dimuat (peta datar, gaya gelap) */
  const ensureLayers = useCallback((map: MLMap) => {
    if (map.getSource('fires')) return
    /* batas wilayah (di bawah titik api) */
    ;(['prov', 'kota'] as const).forEach((l) => {
      map.addSource(l, { type: 'geojson', data: geoRef.current[l]?.fc ?? EMPTY_FC })
      map.addLayer({ id: `${l}-fill`, type: 'fill', source: l, paint: { 'fill-color': fillExpr(1, true) as any } })
      map.addLayer({
        id: `${l}-line`, type: 'line', source: l,
        paint: {
          'line-color': ['case', ['boolean', ['feature-state', 'sel'], false], '#4fc3f7', 'rgba(255,255,255,0.26)'] as any,
          'line-width': ['case', ['boolean', ['feature-state', 'sel'], false], 2.4, l === 'prov' ? 0.9 : 0.55] as any,
        },
      })
    })
    map.addSource('fires', { type: 'geojson', data: firesRef.current })
    map.addSource('radius', { type: 'geojson', data: radiusPoly.current })
    const fireColor = ['step', ['get', 'frp'], '#ffcc80', 5, '#ff8a65', 20, '#ef5350', 50, '#d81b60']

    /* heatmap panas: karmin → oranye → kuning → putih, lebih lembut dan lebar */
    map.addLayer({
      id: 'fires-heat', type: 'heatmap', source: 'fires',
      paint: {
        'heatmap-weight': ['interpolate', ['linear'], ['to-number', ['get', 'frp'], 0], 0, 0.25, 20, 0.6, 80, 1],
        'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 3, 0.8, 8, 2],
        'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 3, 16, 6, 38, 9, 62, 12, 86],
        'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'],
          0, 'rgba(120,10,60,0)', 0.15, 'rgba(190,24,93,0.28)', 0.35, 'rgba(239,68,68,0.55)',
          0.6, 'rgba(251,146,60,0.78)', 0.82, 'rgba(253,224,71,0.9)', 1, 'rgba(255,251,235,0.97)'] as any,
        'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 6, 0.95, 10, 0.5, 13, 0.25],
      },
    })
    /* radius panas: skala meter nyata, ~0,4 km + 0,25 km x akar(FRP) */
    const meters = ['+', 400, ['*', 250, ['sqrt', ['max', ['to-number', ['get', 'frp'], 0], 0]]]]
    map.addLayer({
      id: 'fires-radius', type: 'circle', source: 'fires', minzoom: 5,
      paint: {
        'circle-radius': ['interpolate', ['exponential', 2], ['zoom'],
          0, ['/', meters, 78271.5], 22, ['*', ['/', meters, 78271.5], 4194304]] as any,
        'circle-pitch-alignment': 'map',
        'circle-color': fireColor as any, 'circle-opacity': 0.12,
        'circle-stroke-color': fireColor as any, 'circle-stroke-width': 1, 'circle-stroke-opacity': 0.5,
      },
    })
    /* pendar di sekitar titik api */
    map.addLayer({
      id: 'fires-glow', type: 'circle', source: 'fires', minzoom: 4,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 3, 8, 9, 12, 18],
        'circle-color': fireColor as any, 'circle-blur': 1, 'circle-opacity': 0.35,
      },
    })
    map.addLayer({
      id: 'fires-pt', type: 'circle', source: 'fires',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 1.2, 6, 2.4, 10, 5, 14, 9],
        'circle-color': fireColor as any,
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 6, 0, 9, 0.8],
        'circle-stroke-color': 'rgba(255,255,255,0.7)',
        'circle-opacity': 0.9,
      },
    })
    map.addLayer({ id: 'radius-fill', type: 'fill', source: 'radius', paint: { 'fill-color': '#4fc3f7', 'fill-opacity': 0.14 } })
    map.addLayer({ id: 'radius-line', type: 'line', source: 'radius', paint: { 'line-color': '#4fc3f7', 'line-width': 2, 'line-dasharray': [2, 2] } })
    applyVis(map)
    applyGeoState(map)
  }, [applyVis, applyGeoState])

  /* analisis Turf: radius dari titik klik */
  const analyze = useCallback(() => {
    const map = mapRef.current
    if (!map) return
    const src = map.getSource('radius') as GeoJSONSource | undefined
    if (!center.current) {
      radiusPoly.current = EMPTY_FC
      src?.setData(EMPTY_FC)
      setLocal(null)
      return
    }
    const poly = turf.circle(center.current, radiusRef.current, { units: 'kilometers', steps: 64 })
    radiusPoly.current = turf.featureCollection([poly])
    src?.setData(radiusPoly.current)
    const inside = turf.pointsWithinPolygon(firesRef.current, poly)
    let frp = 0, high = 0
    inside.features.forEach((f) => {
      frp += Number(f.properties?.frp) || 0
      if (f.properties?._lvl === 2) high++
    })
    setLocal({ n: inside.features.length, frp: Math.round(frp), high })
  }, [])

  const focus = useCallback((b: [number, number, number, number]) => {
    mapRef.current?.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 40, duration: 1200, maxZoom: 9 })
  }, [])

  /* pilih wilayah (dari daftar/detail) + zoom ke batasnya */
  const selectArea = useCallback((l: Level, i: number) => {
    const g = geoRef.current[l]
    if (!g) return
    setLvl(l); setMode('area'); setSel({ level: l, idx: i })
    const b = g.bb[i]
    mapRef.current?.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 70, duration: 1000, maxZoom: 10 })
  }, [])

  /* indikator debug: apakah layer ada & berapa titik tampak di layar */
  const updateDbg = useCallback(() => {
    const m = mapRef.current
    if (!m) return
    const has = !!m.getLayer('fires-pt')
    let vis = -1
    if (has) {
      try { vis = m.queryRenderedFeatures({ layers: ['fires-pt'] }).length } catch { /* abaikan */ }
    }
    setDbg(
      `layer: ${has ? 'ada' : 'TIDAK ADA'} • titik di sumber: ${firesRef.current.features.length} • ` +
      `terlihat di layar: ${vis} • zoom ${m.getZoom().toFixed(1)} • proyeksi: ${(m as any).getProjection?.()?.type ?? '?'} • ` +
      `error: ${lastErr.current || '-'}`
    )
  }, [])

  const flyToBiggest = useCallback(() => {
    const top = [...filtered.features].sort((a, b) => (b.properties.frp || 0) - (a.properties.frp || 0))[0]
    if (top) mapRef.current?.flyTo({ center: top.geometry.coordinates as [number, number], zoom: 8, duration: 1500 })
  }, [filtered])

  /* init peta */
  useEffect(() => {
    const map = new MLMap({
      container: el.current!,
      style: BASEMAPS[DEFAULT_BASEMAP],
      center: [118, -2],
      zoom: 3.6,
      attributionControl: { compact: false },
      // tambahkan ?key=... ke semua permintaan tile/style/glyph/sprite milik CARTO
      transformRequest: (url: string) =>
        CARTO_KEY && url.includes('basemaps.cartocdn.com') && !/[?&]key=/.test(url)
          ? { url: `${url}${url.includes('?') ? '&' : '?'}key=${encodeURIComponent(CARTO_KEY)}` }
          : { url },
    })
    map.addControl(new NavigationControl({ visualizePitch: true }), 'top-right')
    map.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-right')

    const hoverId: Record<Level, number> = { prov: -1, kota: -1 }
    const safeEnsure = () => {
      hoverId.prov = -1; hoverId.kota = -1
      try { ensureLayers(map) } catch (err) { console.error('ensureLayers gagal:', err); lastErr.current = 'ensureLayers: ' + String(err).slice(0, 100) }
    }
    map.on('style.load', safeEnsure)
    map.on('load', safeEnsure)
    const timer = window.setInterval(() => {
      try { if (!map.getSource('fires')) safeEnsure() } catch (err) { lastErr.current = String(err).slice(0, 100) }
      updateDbg()
    }, 1000)
    ;(window as any).map = map
    map.on('error', (e) => {
      console.error('MapLibre error:', e.error)
      const m = String(e.error?.message ?? '')
      lastErr.current = m.slice(0, 120)
      if (/failed to fetch|networkerror|load failed|ajax/i.test(m)) {
        setMapWarn('Basemap gagal dimuat. Coba pilih basemap lain.')
      }
    })

    map.on('click', 'fires-pt', (e: MapLayerMouseEvent) => {
      const p = e.features?.[0]?.properties
      if (!p) return
      const { lng, lat } = e.lngLat
      const pm = aqRef.current ? sampleGrid(aqRef.current.pm25, lng, lat) : null
      new Popup({ maxWidth: '260px' }).setLngLat(e.lngLat).setHTML(popupHtml(p, nearestWind(windRef.current, lng, lat), pm)).addTo(map)
    })
    map.on('mouseenter', 'fires-pt', () => (map.getCanvas().style.cursor = 'pointer'))
    map.on('mouseleave', 'fires-pt', () => (map.getCanvas().style.cursor = ''))

    /* hover wilayah */
    ;(['prov', 'kota'] as const).forEach((l) => {
      map.on('mousemove', `${l}-fill`, (e: MapLayerMouseEvent) => {
        if (modeRef.current !== 'area') return
        const f = e.features?.[0]
        if (!f) return
        const id = Number(f.properties?._id ?? f.id)
        if (hoverId[l] === id) return
        if (hoverId[l] >= 0) map.setFeatureState({ source: l, id: hoverId[l] }, { hover: false })
        hoverId[l] = id
        map.setFeatureState({ source: l, id }, { hover: true })
        setHoverName(String(f.properties?._name ?? ''))
      })
      map.on('mouseleave', `${l}-fill`, () => {
        if (hoverId[l] >= 0) map.setFeatureState({ source: l, id: hoverId[l] }, { hover: false })
        hoverId[l] = -1
        setHoverName('')
      })
    })

    map.on('click', (e: MapMouseEvent) => {
      if (map.getLayer('fires-pt') && map.queryRenderedFeatures(e.point, { layers: ['fires-pt'] }).length > 0) return
      const l = levelRef.current
      if (modeRef.current === 'area' && geoRef.current[l]) {
        const hit = map.getLayer(`${l}-fill`) ? map.queryRenderedFeatures(e.point, { layers: [`${l}-fill`] })[0] : undefined
        setSel(hit ? { level: l, idx: Number(hit.properties?._id ?? hit.id) } : null)
        return
      }
      center.current = [e.lngLat.lng, e.lngLat.lat]
      analyze()
    })

    mapRef.current = map
    return () => {
      window.clearInterval(timer)
      map.remove()
      mapRef.current = null
    }
  }, [ensureLayers, analyze, updateDbg])

  /* muat GeoJSON provinsi & kota (opsional) */
  useEffect(() => {
    let dead = false
    ;(async () => {
      const [prov, kota] = await Promise.all([
        loadGeo(GEO_URL.prov, [...PROV_KEYS, ...ANY_KEYS], null, PROV_RE, null),
        loadGeo(GEO_URL.kota, [...KOTA_KEYS, ...ANY_KEYS], PROV_KEYS, KOTA_RE, PROV_RE),
      ])
      if (dead) return
      geoRef.current = { prov, kota }
      setGeo({ prov, kota })
      setGeoState(prov || kota ? 'ok' : 'none')
      if (!prov && kota) { levelRef.current = 'kota'; setLvl('kota') }
      if (!prov && !kota) { modeRef.current = 'radius'; setMode('radius') }
    })()
    return () => { dead = true }
  }, [])

  /* dorong data ke peta setiap kali berubah */
  useEffect(() => {
    firesRef.current = filtered
    ;(mapRef.current?.getSource('fires') as GeoJSONSource | undefined)?.setData(filtered)
    analyze()
  }, [filtered, analyze])

  useEffect(() => {
    const m = mapRef.current
    if (!m) return
    ;(['prov', 'kota'] as const).forEach((l) => {
      ;(m.getSource(l) as GeoJSONSource | undefined)?.setData(geo[l]?.fc ?? EMPTY_FC)
    })
    applyGeoState(m)
    applyVis(m)
  }, [geo, applyGeoState, applyVis])

  /* jumlah titik per wilayah → warna choropleth */
  useEffect(() => {
    countsRef.current = { prov: stats.provCount, kota: stats.kotaCount, maxProv: stats.maxProv, maxKota: stats.maxKota }
    const m = mapRef.current
    if (m) applyGeoState(m)
  }, [stats, geo, applyGeoState])

  /* status wilayah terpilih */
  useEffect(() => {
    selRef.current = sel
    const m = mapRef.current
    const p = prevSel.current
    if (m) {
      if (p && m.getSource(p.level)) m.setFeatureState({ source: p.level, id: p.idx }, { sel: false })
      if (sel && m.getSource(sel.level)) m.setFeatureState({ source: sel.level, id: sel.idx }, { sel: true })
    }
    prevSel.current = sel
  }, [sel])

  useEffect(() => {
    levelRef.current = lvl
    const m = mapRef.current
    if (m) applyVis(m)
    setSel((s) => (s && s.level !== lvl ? null : s))
    setHoverName('')
  }, [lvl, applyVis])

  useEffect(() => {
    modeRef.current = mode
    if (mode === 'area') { center.current = null; analyze() } else setSel(null)
  }, [mode, analyze])

  useEffect(() => {
    radiusRef.current = radiusKm
    analyze()
  }, [radiusKm, analyze])

  /* ganti basemap: diff:false supaya style.load pasti terpicu lagi */
  useEffect(() => {
    if (lastBasemap.current === basemap) return
    lastBasemap.current = basemap
    setMapWarn('')
    mapRef.current?.setStyle(BASEMAPS[basemap], { diff: false })
  }, [basemap])

  /* ambil data dari backend Rust */
  useEffect(() => {
    const ctrl = new AbortController()
    setLoading(true)
    setError('')
    fetch(`/api/fires?days=${days}&source=${source}`, { signal: ctrl.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(await r.text())
        return r.json() as Promise<Fires>
      })
      .then((fc) => {
        setRaw(fc)
        setUpdatedAt(new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' }) + ' WIB')
        setLoading(false)
      })
      .catch((e: Error) => {
        if (e.name === 'AbortError') return
        setError(String(e.message || e))
        setLoading(false)
      })
    return () => ctrl.abort()
  }, [days, source])

  useEffect(() => {
    visRef.current = vis
    const m = mapRef.current
    if (m) { applyVis(m); applyGeoState(m) }
  }, [vis, applyVis, applyGeoState])

  useEffect(() => { gainRef.current = smokeGain }, [smokeGain])

  /* ambil angin permukaan (grid 2°) dari Open-Meteo, segarkan tiap 30 menit */
  useEffect(() => {
    let dead = false
    const load = async () => {
      try {
        try {
          const c = JSON.parse(localStorage.getItem('fw-wind2') || 'null')
          if (c && Date.now() - c.t < 20 * 60 * 1000 && c.w.length === NX * NY) {
            if (!dead) { windRef.current = c.w; setWind(c.w); setWindErr('') }
            return
          }
        } catch { /* abaikan */ }
        const url = `https://api.open-meteo.com/v1/forecast?${GRID_Q}&current=wind_speed_10m,wind_direction_10m&wind_speed_unit=kmh`
        const r = await fetch(url)
        if (!r.ok) throw new Error('HTTP ' + r.status)
        const j = await r.json()
        const arr = Array.isArray(j) ? j : [j]
        if (arr.length !== NX * NY) throw new Error('grid tidak lengkap')
        const w: WindPt[] = arr.map((d: any, i: number) => ({ lon: GRID_PTS[i].lo, lat: GRID_PTS[i].la, speed: d.current.wind_speed_10m ?? 0, dir: d.current.wind_direction_10m ?? 0 }))
        if (dead) return
        windRef.current = w
        try { localStorage.setItem('fw-wind2', JSON.stringify({ t: Date.now(), w })) } catch { /* abaikan */ }
        setWind(w); setWindErr('')
      } catch { if (!dead) setWindErr('Data angin gagal dimuat') }
    }
    load()
    const t = window.setInterval(load, 30 * 60 * 1000)
    return () => { dead = true; window.clearInterval(t) }
  }, [])

  /* polusi udara CAMS global (PM2.5, PM10, debu, AOD) lewat Open-Meteo Air Quality, segarkan tiap 30 menit */
  useEffect(() => {
    let dead = false
    const toAq = (rows: any[]): AqData => {
      const o: AqData = { pm25: new Float32Array(rows.length), pm10: new Float32Array(rows.length), dust: new Float32Array(rows.length), aod: new Float32Array(rows.length) }
      rows.forEach((c, i) => { o.pm25[i] = c.pm2_5 ?? 0; o.pm10[i] = c.pm10 ?? 0; o.dust[i] = c.dust ?? 0; o.aod[i] = c.aerosol_optical_depth ?? 0 })
      return o
    }
    const load = async () => {
      try {
        try {
          const c = JSON.parse(localStorage.getItem('fw-aq2') || 'null')
          if (c && Date.now() - c.t < 20 * 60 * 1000 && c.rows.length === NX * NY) {
            const d = toAq(c.rows)
            if (!dead) { aqRef.current = d; setAq(d); setAqErr('') }
            return
          }
        } catch { /* abaikan */ }
        const url = `https://air-quality-api.open-meteo.com/v1/air-quality?${GRID_Q}&current=pm2_5,pm10,dust,aerosol_optical_depth&domains=cams_global`
        const r = await fetch(url)
        if (!r.ok) throw new Error('HTTP ' + r.status)
        const j = await r.json()
        const arr = Array.isArray(j) ? j : [j]
        if (arr.length !== NX * NY) throw new Error('grid tidak lengkap')
        const rows = arr.map((d: any) => d.current ?? {})
        if (dead) return
        const d = toAq(rows)
        aqRef.current = d
        try { localStorage.setItem('fw-aq2', JSON.stringify({ t: Date.now(), rows })) } catch { /* abaikan */ }
        setAq(d); setAqErr('')
      } catch { if (!dead) setAqErr('Data polusi udara gagal dimuat') }
    }
    load()
    const t = window.setInterval(load, 30 * 60 * 1000)
    return () => { dead = true; window.clearInterval(t) }
  }, [])

  /* lapisan polusi udara: medan CAMS diinterpolasi halus ke seluruh layar */
  useEffect(() => {
    const map = mapRef.current, cv = aqCvRef.current
    if (!map || !cv) return
    const ctx = cv.getContext('2d')!
    const clear = () => ctx.clearRect(0, 0, cv.width, cv.height)
    if (!vis.aq || !aq) { clear(); return }
    const arr = aq[aqVar]
    const CELL = 6
    const col = [0, 0, 0, 0]
    let raf = 0
    const draw = () => {
      raf = 0
      const r = cv.getBoundingClientRect()
      const w = Math.max(1, Math.ceil(r.width / CELL)), h = Math.max(1, Math.ceil(r.height / CELL))
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h }
      const img = ctx.createImageData(w, h), d = img.data
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const ll = map.unproject([x * CELL + CELL / 2, y * CELL + CELL / 2])
          const lon = ll.lng, lat = ll.lat
          const ex = Math.min(lon - GLON[0], GLON[NX - 1] - lon), ey = Math.min(lat - GLAT[0], GLAT[NY - 1] - lat)
          if (ex < 0 || ey < 0) continue
          const edge = Math.min(1, Math.min(ex, ey) / 3)
          gpos(lon, lat)
          aqColor(aqVar, bil(arr), col)
          const o = (y * w + x) * 4
          d[o] = col[0]; d[o + 1] = col[1]; d[o + 2] = col[2]; d[o + 3] = col[3] * edge
        }
      }
      ctx.putImageData(img, 0, 0)
    }
    const sched = () => { if (!raf) raf = requestAnimationFrame(draw) }
    draw()
    map.on('move', sched)
    map.on('resize', sched)
    return () => { if (raf) cancelAnimationFrame(raf); map.off('move', sched); map.off('resize', sched); clear() }
  }, [aq, aqVar, vis.aq])

  /* aliran angin: garis halus berwarna menurut kecepatan, ekor memudar, kepala bercahaya sebagai penunjuk arah.
     Integrasi RK2, tidak bergantung refresh rate layar */
  useEffect(() => {
    const map = mapRef.current, cv = cvsRef.current
    if (!map || !cv) return
    const ctx = cv.getContext('2d')!
    const clear = () => { ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, cv.width, cv.height); ctx.restore() }
    if (!vis.wind || wind.length !== NX * NY) { clear(); return }
    const field = buildField(wind)
    const dpr = window.devicePixelRatio || 1
    type P = { lon: number; lat: number; age: number; max: number; px: number; py: number }
    let W = 0, H = 0, ps: P[] = []
    const spawn = (p: P) => {
      const b = map.getBounds()
      const w = Math.max(b.getWest(), 93), e = Math.min(b.getEast(), 143), so = Math.max(b.getSouth(), -13), n = Math.min(b.getNorth(), 9)
      const ok = e > w && n > so
      p.lon = ok ? w + Math.random() * (e - w) : 118
      p.lat = ok ? so + Math.random() * (n - so) : -2
      p.age = 0; p.max = 110 + Math.floor(Math.random() * 130); p.px = NaN; p.py = NaN
    }
    const setup = () => {
      const r = cv.getBoundingClientRect()
      W = r.width; H = r.height
      cv.width = W * dpr; cv.height = H * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const n = Math.min(4200, Math.round((W * H) / 520))
      ps = Array.from({ length: n }, () => { const p = { lon: 0, lat: 0, age: 0, max: 0, px: NaN, py: NaN }; spawn(p); p.age = Math.floor(Math.random() * p.max); return p })
    }
    setup()
    const onMove = () => { clear(); ps.forEach((p) => { p.px = NaN; p.py = NaN }) }
    map.on('move', onMove)
    map.on('resize', setup)

    const tmp = [0, 0]
    const SPEED = 0.17 // piksel per frame untuk tiap km/j
    let raf = 0, last = performance.now(), clock = 0
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      const dt = Math.min((now - last) / 16.67, 3)
      last = now; clock += dt
      ctx.globalCompositeOperation = 'destination-out'
      ctx.fillStyle = `rgba(0,0,0,${1 - Math.pow(1 - 0.06, dt)})`
      ctx.fillRect(0, 0, W, H)
      ctx.globalCompositeOperation = 'lighter'
      const ppd = (512 * Math.pow(2, map.getZoom())) / 360
      const k = SPEED * dt
      const seg: number[][] = [[], [], [], [], [], []]
      const heads: number[] = []
      for (const p of ps) {
        p.age += dt
        if (p.age > p.max) { spawn(p); continue }
        // RK2 (titik tengah) + embusan halus supaya aliran terasa hidup
        const g = 1 + 0.12 * Math.sin(p.lon * 1.7 + p.lat * 1.3 + clock * 0.012)
        const cl = Math.cos((p.lat * Math.PI) / 180)
        sampleWind(field, p.lon, p.lat, tmp)
        const u1 = tmp[0] * g, v1 = tmp[1] * g
        sampleWind(field, p.lon + (u1 * k * 0.5) / ppd, p.lat + (v1 * k * 0.5 * cl) / ppd, tmp)
        const u2 = tmp[0] * g, v2 = tmp[1] * g
        p.lon += (u2 * k) / ppd
        p.lat += (v2 * k * cl) / ppd
        const sp = Math.hypot(u2, v2)
        const s = map.project([p.lon, p.lat])
        if (s.x < 0 || s.y < 0 || s.x > W || s.y > H) { spawn(p); continue }
        if (!Number.isNaN(p.px)) {
          let b = 0
          while (b < 5 && sp > WIND_STEPS[b]) b++
          seg[b].push(p.px, p.py, s.x, s.y)
          if (sp > 4) heads.push(s.x, s.y)
        }
        p.px = s.x; p.py = s.y
      }
      ctx.lineCap = 'round'
      for (let b = 0; b < 6; b++) {
        if (!seg[b].length) continue
        ctx.lineWidth = 0.9 + b * 0.16
        ctx.strokeStyle = WIND_COLORS[b]; ctx.beginPath()
        for (let i = 0; i < seg[b].length; i += 4) { ctx.moveTo(seg[b][i], seg[b][i + 1]); ctx.lineTo(seg[b][i + 2], seg[b][i + 3]) }
        ctx.stroke()
      }
      ctx.fillStyle = 'rgba(255,255,255,0.8)'
      for (let i = 0; i < heads.length; i += 2) ctx.fillRect(heads[i] - 0.8, heads[i + 1] - 0.8, 1.6, 1.6)
      ctx.globalCompositeOperation = 'source-over'
    }
    raf = requestAnimationFrame(frame)
    return () => { cancelAnimationFrame(raf); map.off('move', onMove); map.off('resize', setup); clear() }
  }, [wind, vis.wind])

  /* sebaran asap & debu: partikel keluar dari titik panas (lebih banyak di FRP besar), terbawa angin,
     melebar karena turbulensi. Semua partikel dijumlahkan menjadi peta kerapatan beresolusi rendah lalu
     diwarnai (peach → magenta → ungu), sehingga tampil sebagai kabut kontinu, bukan titik-titik. */
  useEffect(() => {
    const map = mapRef.current, cv = smokeRef.current
    if (!map || !cv) return
    const ctx = cv.getContext('2d')!
    const clear = () => { ctx.clearRect(0, 0, cv.width, cv.height) }
    const fires = filtered.features
    if (!vis.smoke || wind.length !== NX * NY || !fires.length) { clear(); return }
    const field = buildField(wind)
    const cum = new Float64Array(fires.length)
    let tot = 0
    fires.forEach((f, i) => { tot += Math.sqrt(Math.max(Number(f.properties.frp) || 1, 1)); cum[i] = tot })
    const pick = () => {
      const r = Math.random() * tot
      let lo = 0, hi = cum.length - 1
      while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < r) lo = m + 1; else hi = m }
      return fires[lo].geometry.coordinates
    }
    type S = { lon: number; lat: number; age: number; life: number }
    const spawn = (p: S) => {
      const [lo, la] = pick()
      p.lon = lo + (Math.random() - 0.5) * 0.02; p.lat = la + (Math.random() - 0.5) * 0.02
      p.age = 0; p.life = 200 + Math.random() * 240
    }
    const SC = 4 // piksel layar per sel kerapatan
    let gw = 0, gh = 0
    let dens = new Float32Array(1)
    let img: ImageData | null = null
    let u32 = new Uint32Array(1)
    const ps: S[] = Array.from({ length: Math.min(9000, Math.max(2000, fires.length * 3)) }, () => {
      const p = { lon: 0, lat: 0, age: 0, life: 0 }; spawn(p); p.age = Math.random() * p.life; return p
    })
    const setup = () => {
      const r = cv.getBoundingClientRect()
      gw = Math.max(1, Math.ceil(r.width / SC)); gh = Math.max(1, Math.ceil(r.height / SC))
      cv.width = gw; cv.height = gh
      dens = new Float32Array(gw * gh)
      img = ctx.createImageData(gw, gh)
      u32 = new Uint32Array(img.data.buffer)
    }
    setup()
    map.on('resize', setup)

    const tmp = [0, 0]
    let raf = 0, last = performance.now(), clock = 0
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      if (!img) return
      const dt = Math.min((now - last) / 16.67, 3)
      last = now; clock += dt
      const z = map.getZoom()
      const ppd = (512 * Math.pow(2, z)) / 360
      const speed = 0.16 * Math.min(1, 0.3 + (z - 3) * 0.18) // plume tidak terlalu panjang saat zoom jauh
      const zs = Math.min(2.4, Math.max(0.8, 0.6 + (z - 3) * 0.18))
      dens.fill(0)
      for (const p of ps) {
        p.age += dt
        if (p.age >= p.life) { spawn(p); continue }
        const t = p.age / p.life
        sampleWind(field, p.lon, p.lat, tmp)
        const g = 1 + 0.12 * Math.sin(p.lon * 1.7 + p.lat * 1.3 + clock * 0.012)
        const turb = 0.1 + 0.6 * t // makin tua makin menyebar
        const jx = (Math.random() - 0.5) * turb, jy = (Math.random() - 0.5) * turb
        const cl = Math.cos((p.lat * Math.PI) / 180)
        p.lon += ((tmp[0] * g * speed + jx) * dt) / ppd
        p.lat += ((tmp[1] * g * speed + jy) * dt * cl) / ppd
        const s = map.project([p.lon, p.lat])
        const cx = s.x / SC, cy = s.y / SC
        if (cx < -7 || cy < -7 || cx > gw + 7 || cy > gh + 7) continue
        const rPx = (1.2 + 5.5 * Math.pow(t, 0.8)) * zs
        const r = Math.min(6, Math.max(1, Math.round((rPx / SC) * 1.5)))
        const mass = 0.9 * Math.pow(1 - t, 1.25) * Math.min(1, p.age / 8)
        const ker = smokeKernels[r], n = 2 * r + 1
        const ix = Math.round(cx), iy = Math.round(cy)
        for (let yy = -r; yy <= r; yy++) {
          const gy = iy + yy
          if (gy < 0 || gy >= gh) continue
          for (let xx = -r; xx <= r; xx++) {
            const gx = ix + xx
            if (gx < 0 || gx >= gw) continue
            dens[gy * gw + gx] += ker[(yy + r) * n + xx + r] * mass
          }
        }
      }
      const gain = gainRef.current
      for (let i = 0; i < dens.length; i++) {
        const v = dens[i] * gain
        if (v < 0.01) { u32[i] = 0; continue }
        let k = (Math.sqrt(v / 3) * 255) | 0
        if (k > 255) k = 255
        u32[i] = SMOKE_LUT[k]
      }
      ctx.putImageData(img, 0, 0)
    }
    raf = requestAnimationFrame(frame)
    return () => { cancelAnimationFrame(raf); map.off('resize', setup); clear() }
  }, [wind, vis.smoke, filtered])

  const smoke = useMemo(() => {
    if (wind.length !== NX * NY || !filtered.features.length) return null
    const f = buildField(wind), t = [0, 0]
    let x = 0, y = 0, ws = 0
    for (const ft of filtered.features) {
      const [lon, lat] = ft.geometry.coordinates
      sampleWind(f, lon, lat, t)
      const w = Math.sqrt(Math.max(Number(ft.properties.frp) || 1, 1))
      x += t[0] * w; y += t[1] * w; ws += w
    }
    return { speed: Math.round(Math.hypot(x, y) / ws), dir: ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360 }
  }, [filtered, wind])

  /* detail wilayah terpilih */
  const detail = useMemo(() => {
    if (!sel) return null
    const g = geo[sel.level]
    if (!g || sel.idx >= g.names.length) return null
    const acc: Acc = (sel.level === 'prov' ? stats.byProv : stats.byKota).get(sel.idx) ?? { n: 0, frp: 0, high: 0, max: 0, dates: {} }
    const b = g.bb[sel.idx]
    const cLon = (b[0] + b[2]) / 2, cLat = (b[1] + b[3]) / 2
    let pm25: number | null = null, aod: number | null = null
    if (aq) {
      const key = sel.level === 'prov' ? '_pi' : '_ki'
      let s1 = 0, s2 = 0, n = 0
      for (const f of filtered.features) {
        if (f.properties[key] !== sel.idx) continue
        const [lon, lat] = f.geometry.coordinates
        s1 += sampleGrid(aq.pm25, lon, lat); s2 += sampleGrid(aq.aod, lon, lat); n++
        if (n >= 400) break
      }
      pm25 = n ? s1 / n : sampleGrid(aq.pm25, cLon, cLat)
      aod = n ? s2 / n : sampleGrid(aq.aod, cLon, cLat)
    }
    let w: { speed: number; dir: number } | null = null
    if (wind.length === NX * NY) {
      const t = [0, 0]
      sampleWind(buildField(wind), cLon, cLat, t)
      // vektor (u,v) → kecepatan & arah TUJUAN angin
      w = { speed: Math.round(Math.hypot(t[0], t[1])), dir: ((Math.atan2(t[0], t[1]) * 180) / Math.PI + 360) % 360 }
    }
    const dates = Object.keys(acc.dates).sort().slice(-5)
    let top: { idx: number; name: string; n: number }[] = []
    if (sel.level === 'prov' && geo.kota) {
      const m = stats.kotaOfProv.get(sel.idx)
      if (m) top = [...m.entries()].sort((a, c) => c[1] - a[1]).slice(0, 5).map(([i, n]) => ({ idx: i, name: geo.kota!.names[i], n }))
    }
    return {
      level: sel.level, idx: sel.idx, name: g.names[sel.idx], parent: sel.level === 'kota' ? g.parents[sel.idx] : '',
      acc, pm25, aod, wind: w, dates, dmax: Math.max(1, ...dates.map((d) => acc.dates[d])), top, bbox: b,
    }
  }, [sel, geo, stats, aq, wind, filtered])

  const rangeLabel = useMemo(() => {
    const e = new Date(), st = new Date()
    st.setDate(e.getDate() - (days - 1))
    const f = (d: Date) => d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', timeZone: 'Asia/Jakarta' })
    return days === 1 ? f(e) : `${f(st)} – ${f(e)}`
  }, [days])

  const ring = (() => {
    const C = 2 * Math.PI * 62
    let acc = 0
    return [2, 1, 0].map((l) => {
      const len = stats.total ? (stats.lv[l] / stats.total) * C : 0
      const vis2 = Math.max(len - 2, 0)
      const el = <circle key={l} r="62" cx="80" cy="80" fill="none" stroke={LV_COLOR[l]} strokeWidth="14" strokeLinecap="round"
        strokeDasharray={`${vis2} ${C - vis2}`} strokeDashoffset={-acc} />
      acc += len
      return el
    })
  })()

  /* daftar sebaran: provinsi teratas bila GeoJSON ada, kalau tidak per pulau */
  const rows = geo.prov
    ? [...stats.byProv.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 10).map(([i, a]) => ({
        key: `p${i}`, label: geo.prov!.names[i], n: a.n, color: 'linear-gradient(90deg,#ef5350,#ff8a65)', go: () => selectArea('prov', i),
      }))
    : REGIONS.map((r) => ({ key: r.id, label: r.id, n: stats.byIsland[r.id].n, color: r.color, go: () => focus(r.bounds) }))
  const rowMax = Math.max(1, ...rows.map((r) => r.n))

  const clearRadius = () => {
    center.current = null
    analyze()
  }

  const aqDef = AQ_DEF[aqVar]
  const hasGeo = !!(geo.prov || geo.kota)
  const avgBand = aqStats?.avg != null ? pmBand(aqStats.avg) : null

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <div className="logo">🔥</div>
          <div>
            <h1>FIREWATCH <span>INDONESIA</span></h1>
            <p>Titik panas satelit • asap • polusi udara • angin</p>
          </div>
        </div>
        <div className="top-status">
          <span className={`dot ${loading ? 'busy' : error ? 'bad' : 'ok'}`} />
          {loading ? 'Memuat data…' : error ? 'Gagal memuat data' : `Diperbarui ${updatedAt}`}
        </div>
      </header>
      <div className="crumb">
        <span className="crumb-in" onClick={() => setSel(null)}>Indonesia</span>
        {detail && detail.parent && <><em>›</em><span>{detail.parent}</span></>}
        {detail && <><em>›</em><span className="cur">{detail.name}</span></>}
        <small>Mentah {nf.format(raw.features.length)} → Indonesia {nf.format(indo.features.length)}</small>
      </div>

      <div className="body">
        <main className="mapwrap">
          <div ref={el} className="map" />
          <canvas ref={aqCvRef} className="aqcv" />
          <canvas ref={smokeRef} className="smokecv" />
          <canvas ref={cvsRef} className="windcv" />

          <div className="toolbar">
            <select className="pill" value={basemap} onChange={(e) => setBasemap(e.target.value)} title="Basemap">
              {Object.keys(BASEMAPS).map((k) => <option key={k}>{k}</option>)}
            </select>
            <select className="pill" value={source} onChange={(e) => setSource(e.target.value)} title="Sensor satelit">
              <option value="VIIRS_SNPP_NRT">VIIRS S-NPP (375 m)</option>
              <option value="VIIRS_NOAA20_NRT">VIIRS NOAA-20 (375 m)</option>
              <option value="VIIRS_NOAA21_NRT">VIIRS NOAA-21 (375 m)</option>
              <option value="MODIS_NRT">MODIS (1 km)</option>
            </select>
            {vis.aq && (
              <select className="pill" value={aqVar} onChange={(e) => setAqVar(e.target.value as AqKey)} title="Variabel polusi udara">
                {(Object.keys(AQ_DEF) as AqKey[]).map((k) => <option key={k} value={k}>{AQ_DEF[k].label}</option>)}
              </select>
            )}
            <div className="seg pillseg" title="Tingkat keyakinan">
              {['Semua', 'Sedang+', 'Tinggi'].map((t, i) => (
                <button key={t} className={minLevel === i ? 'on' : ''} onClick={() => setMinLevel(i)}>{t}</button>
              ))}
            </div>
            {hasGeo && (
              <div className="seg pillseg" title="Tingkat wilayah yang bisa diklik">
                <button className={lvl === 'prov' ? 'on' : ''} disabled={!geo.prov} onClick={() => setLvl('prov')}>Provinsi</button>
                <button className={lvl === 'kota' ? 'on' : ''} disabled={!geo.kota} onClick={() => setLvl('kota')}>Kota/Kab</button>
              </div>
            )}
          </div>

          <div className="leftbar">
            <div className="quick">
              <button className="chip on2" onClick={() => focus(INDONESIA)}>🇮🇩 Fokus Indonesia</button>
              <button className="chip on2" onClick={flyToBiggest}>📍 Api terbesar</button>
            </div>
            <div className="panel layers">
              <div className="panel-h">Lapisan</div>
              {LAYER_LIST.map(([k, t]) => (
                <button key={k} className={vis[k] ? 'sw on' : 'sw'} onClick={() => setVis((v) => ({ ...v, [k]: !v[k] }))}>
                  <i /><span>{t}</span>
                </button>
              ))}
              {vis.smoke && (
                <div className="slider-row">
                  <small>Intensitas asap</small>
                  <input type="range" min={0.4} max={2.5} step={0.1} value={smokeGain} onChange={(e) => setSmokeGain(+e.target.value)} />
                </div>
              )}
            </div>
          </div>

          {mapWarn && <div className="toast">{mapWarn}</div>}
          {loading && <div className="loading">Memuat titik panas…</div>}
          {geoState === 'none' && <div className="toast toast2">GeoJSON wilayah tidak ditemukan di {GEO_URL.prov} / {GEO_URL.kota}. Sementara memakai batas pulau perkiraan.</div>}
          {hoverName && mode === 'area' && <div className="hovertag">{hoverName}</div>}
          {windAvg && vis.wind && (
            <div className="mapchip"><span className="wind-dial sm"><i style={{ transform: `rotate(${windAvg.dir}deg)` }}>↑</i></span>Angin {windAvg.speed} km/j → {compass(windAvg.dir)}</div>
          )}
          {vis.aq && (
            <div className="aqlegend">
              <div className="aql-h"><b>{aqDef.label}</b><span>{aqDef.unit || 'dimensionless'}</span></div>
              <div className="aql-bar" style={{ background: AQ_LEGEND }} />
              <div className="aql-t">
                {[0, 2, 4, 6].map((i) => <span key={i}>{aqDef.stops[i] >= 100 ? Math.round(aqDef.stops[i]) : aqDef.stops[i]}{i === 6 ? '+' : ''}</span>)}
              </div>
            </div>
          )}

          <div className="timeline">
            <div className="tl-left"><small>Rentang waktu</small><b>{rangeLabel}</b></div>
            <div className="tl-slider">
              <input type="range" min={1} max={5} value={days} onChange={(e) => setDays(+e.target.value)} />
              <div className="tl-ticks">{[1, 2, 3, 4, 5].map((d) => <span key={d} className={d <= days ? 'on' : ''}>{d}h</span>)}</div>
            </div>
          </div>
          {showDbg && <div className="dbg">{dbg}</div>}
        </main>

        <aside className="stats">
          <h2 className="st-title">Statistik</h2>
          {error && <div className="err">{error}</div>}

          {detail && (
            <section className="card detail">
              <div className="dt-head">
                <div>
                  <small>{detail.level === 'prov' ? 'Provinsi' : 'Kota / Kabupaten'}{detail.parent ? ` • ${detail.parent}` : ''}</small>
                  <h3>{detail.name}</h3>
                </div>
                <button className="x" onClick={() => setSel(null)} title="Tutup">✕</button>
              </div>
              <div className="kpis">
                <div><small>Titik panas</small><b>{nf.format(detail.acc.n)}</b></div>
                <div><small>Keyakinan tinggi</small><b>{nf.format(detail.acc.high)}</b></div>
                <div><small>Total FRP</small><b>{nf.format(Math.round(detail.acc.frp))}<i> MW</i></b></div>
                <div><small>FRP tertinggi</small><b>{nf.format(Math.round(detail.acc.max))}<i> MW</i></b></div>
              </div>
              {detail.pm25 != null && (
                <div className="aq-line">
                  <i className="aq-dot" style={{ background: pmBand(detail.pm25).c }} />
                  <div>
                    <b>PM2.5 ≈ {nf.format(Math.round(detail.pm25))} µg/m³</b> • {pmBand(detail.pm25).t}
                    <small>AOD {detail.aod != null ? detail.aod.toFixed(2) : '-'} • perkiraan model CAMS di sekitar titik api</small>
                  </div>
                </div>
              )}
              {detail.wind && (
                <div className="wind-card tight">
                  <span className="wind-dial sm"><i style={{ transform: `rotate(${detail.wind.dir}deg)` }}>↑</i></span>
                  <div>Angin {detail.wind.speed} km/j menuju <b>{compass(detail.wind.dir)}</b></div>
                </div>
              )}
              {detail.dates.length > 1 && (
                <div className="mini">
                  {detail.dates.map((d) => (
                    <div key={d} title={`${d}: ${detail.acc.dates[d]} titik`}>
                      <span style={{ height: `${(detail.acc.dates[d] / detail.dmax) * 44 + 3}px` }} />
                      <small>{d.slice(8)}/{d.slice(5, 7)}</small>
                    </div>
                  ))}
                </div>
              )}
              {detail.top.length > 0 && (
                <div className="toplist">
                  <small>Kota/kabupaten teratas</small>
                  {detail.top.map((t) => (
                    <button key={t.idx} onClick={() => selectArea('kota', t.idx)}><span>{t.name}</span><b>{nf.format(t.n)}</b></button>
                  ))}
                </div>
              )}
              <button className="ghost" onClick={() => selectArea(detail.level, detail.idx)}>Zoom ke wilayah</button>
            </section>
          )}

          <section className="card">
            <div className="card-h">Titik panas</div>
            <p className="card-d">Jumlah deteksi satelit di wilayah Indonesia pada rentang waktu terpilih, dipisah per tingkat keyakinan.</p>
            <div className="donut">
              <svg viewBox="0 0 160 160"><g transform="rotate(-90 80 80)"><circle r="62" cx="80" cy="80" fill="none" stroke="#23272f" strokeWidth="14" />{ring}</g></svg>
              <div className="donut-c"><b>{nf.format(stats.total)}</b><small>titik</small></div>
            </div>
            <div className="lv">
              {[2, 1, 0].map((l) => (
                <div key={l}><i style={{ background: LV_COLOR[l] }} /><b>{nf.format(stats.lv[l])}</b><span>Keyakinan {LEVEL_NAME[l].toLowerCase()}</span></div>
              ))}
            </div>
            <div className="duo">
              <div><small>Total FRP</small><b>{nf.format(stats.frp)}<i> MW</i></b></div>
              <div><small>FRP tertinggi</small><b>{nf.format(stats.maxFrp)}<i> MW</i></b></div>
            </div>
          </section>

          <section className="card">
            <div className="card-h">Polusi udara & asap</div>
            <p className="card-d">Medan PM2.5 / PM10 / debu / AOD dari model CAMS (resolusi ±45 km). Kepulan peach → ungu = simulasi sebaran asap dari titik panas yang terbawa angin.</p>
            {aqStats ? (
              <div className="duo">
                <div>
                  <small>PM2.5 di titik api</small>
                  <b style={{ color: avgBand?.c }}>{aqStats.avg != null ? nf.format(Math.round(aqStats.avg)) : '-'}<i> µg/m³</i></b>
                  {avgBand && <small className="band">{avgBand.t}</small>}
                </div>
                <div>
                  <small>PM2.5 tertinggi</small>
                  <b style={{ color: pmBand(aqStats.max).c }}>{nf.format(Math.round(aqStats.max))}<i> µg/m³</i></b>
                  <small className="band">{pmBand(aqStats.max).t}</small>
                </div>
              </div>
            ) : <div className="hint">{aqErr || 'Memuat data polusi udara…'}</div>}
            {smoke && (
              <div className="smoke-line">
                <span className="wind-dial sm"><i style={{ transform: `rotate(${smoke.dir}deg)` }}>↑</i></span>
                <div>Asap dominan menuju <b>{compass(smoke.dir)}</b><small>dibobot FRP • angin di titik panas ±{smoke.speed} km/j</small></div>
              </div>
            )}
          </section>

          <section className="card">
            <div className="card-h">Angin permukaan</div>
            <p className="card-d">Garis berwarna = aliran angin (biru lambat → merah kencang). Titik terang di ujung garis menunjukkan arah.</p>
            {windAvg ? (
              <div className="wind-card">
                <span className="wind-dial"><i style={{ transform: `rotate(${windAvg.dir}deg)` }}>↑</i></span>
                <div><b>{windAvg.speed} km/j</b> menuju {compass(windAvg.dir)}<small>Rata-rata {wind.length} titik grid • Open-Meteo</small></div>
              </div>
            ) : <div className="hint">{windErr || 'Memuat data angin…'}</div>}
            <div className="wind-scale"><i /><div><span>lambat</span><span>sedang</span><span>kencang</span></div></div>
          </section>

          <section className="card">
            <div className="card-h">{geo.prov ? 'Provinsi teratas' : 'Sebaran per wilayah'}</div>
            <p className="card-d">{geo.prov ? 'Klik baris untuk memilih provinsi dan zoom ke batasnya.' : 'Klik baris untuk zoom ke wilayah.'}</p>
            {rows.map((r) => (
              <button key={r.key} className="bar-row" onClick={r.go}>
                <span className="bar-label">{r.label}</span>
                <span className="bar-track"><span className="bar-fill" style={{ width: `${(r.n / rowMax) * 100}%`, background: r.color }} /></span>
                <span className="bar-val">{nf.format(r.n)}</span>
              </button>
            ))}
          </section>

          {stats.dates.length > 1 && (
            <section className="card">
              <div className="card-h">Tren harian</div>
              <div className="spark">
                {stats.dates.map((d) => (
                  <div key={d} className="spark-col" title={`${d}: ${nf.format(stats.byDate[d])} titik`}>
                    <span className="spark-val">{nf.format(stats.byDate[d])}</span>
                    <span className="spark-bar" style={{ height: `${(stats.byDate[d] / stats.maxDate) * 60 + 4}px` }} />
                    <span className="spark-lbl">{d.slice(8)}/{d.slice(5, 7)}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="card">
            <div className="card-h">Analisis</div>
            <p className="card-d">
              {hasGeo ? 'Pilih cara menganalisis: klik wilayah (provinsi / kota-kab) atau hitung titik panas dalam radius dari titik klik.' : 'Klik area kosong di peta untuk menghitung titik panas dalam radius.'}
            </p>
            {hasGeo && (
              <div className="seg block">
                <button className={mode === 'area' ? 'on' : ''} onClick={() => setMode('area')}>Wilayah</button>
                <button className={mode === 'radius' ? 'on' : ''} onClick={() => setMode('radius')}>Radius</button>
              </div>
            )}
            {mode === 'radius' && (
              <>
                <label>Radius: {radiusKm} km</label>
                <input type="range" min={5} max={200} step={5} value={radiusKm} onChange={(e) => setRadiusKm(+e.target.value)} />
                {local && (
                  <div className="result">
                    <div className="stat"><span>Titik dalam radius</span><b>{nf.format(local.n)}</b></div>
                    <div className="stat"><span>Keyakinan tinggi</span><b>{nf.format(local.high)}</b></div>
                    <div className="stat"><span>Total FRP</span><b>{nf.format(local.frp)} MW</b></div>
                    <button className="ghost" onClick={clearRadius}>Hapus radius</button>
                  </div>
                )}
              </>
            )}
            {mode === 'area' && !detail && hasGeo && <div className="hint">Klik sebuah wilayah di peta untuk melihat detailnya.</div>}
          </section>

          <section className="card">
            <div className="card-h">Legenda</div>
            <div className="heat-bar" />
            <div className="heat-lbl"><span>Kepadatan rendah</span><span>tinggi</span></div>
            <div className="legend">
              <span><i style={{ background: '#ffcc80' }} />&lt; 5</span>
              <span><i style={{ background: '#ff8a65' }} />5–20</span>
              <span><i style={{ background: '#ef5350' }} />20–50</span>
              <span><i style={{ background: '#d81b60' }} />&gt; 50 MW</span>
            </div>
            <p className="note">
              FRP (Fire Radiative Power) = besar energi api. Titik panas bukan selalu kebakaran, melainkan anomali panas yang
              terdeteksi satelit. Lingkaran tipis = radius panas (±0,4 km + 0,25 km × √FRP). Plume asap adalah simulasi visual
              dari titik panas dan angin, bukan pengukuran; bukan pengganti peringatan resmi atau stasiun pemantau lokal.
              Waktu dalam WIB. Sumber: NASA FIRMS • Angin & polusi udara: Open-Meteo (data CAMS, Copernicus) • Basemap: Carto / Esri / OpenFreeMap.
            </p>
          </section>
        </aside>
      </div>
    </div>
  )
}