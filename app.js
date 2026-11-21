/* Светофоры Костромы — карта, маршруты с учётом светофоров, тайминги.
   Данные карты © участники OpenStreetMap (ODbL). */
'use strict';

// ======================= КОНСТАНТЫ ==================================
const BBOX = [57.69, 40.78, 57.85, 41.13];             // юг, запад, север, восток
const LAT0 = 57.765, LON0 = 40.95;
const KX = 111320 * Math.cos(LAT0 * Math.PI / 180), KY = 110540;
const toXY = (lat, lon) => [(lon - LON0) * KX, (lat - LAT0) * KY];
const toLL = (x, y) => [y / KY + LAT0, x / KX + LON0];
const DATA_VERSION = 3;
const LS_TIMINGS = 'kostroma_timings_v1';

const CAR_SPEED = { motorway: 90, trunk: 70, primary: 60, secondary: 50, tertiary: 45, unclassified: 40,
  residential: 30, living_street: 15, service: 15, motorway_link: 50, trunk_link: 45, primary_link: 40,
  secondary_link: 35, tertiary_link: 30 };
const WALK_OK = new Set([...Object.keys(CAR_SPEED), 'pedestrian', 'footway', 'path', 'steps', 'cycleway', 'track']);
const ROAD_CLASS = { motorway: 1, trunk: 1, primary: 1, motorway_link: 1, trunk_link: 1, primary_link: 1,
  secondary: 2, secondary_link: 2, tertiary: 3, tertiary_link: 3, unclassified: 4, residential: 4, living_street: 4,
  service: 5, pedestrian: 6, footway: 6, path: 6, steps: 6, cycleway: 6, track: 6 };
const DEFAULT_WAIT = { X: 15, P: 8 };      // ожидание без таймингов, с

// ======================= СОСТОЯНИЕ ==================================
const S = {
  data: null,            // {ways:[{id,t,n,g}], water:[[ring]], signals:Set}
  roads: [],             // для отрисовки: [{c, name, pts:[[x,y]...]}]
  water: [],             // полигоны: [[ [x,y]... ] ...]
  rivers: [],            // линии рек
  labels: [],
  graph: null,
  lights: LIGHTS_BASE.map((l, i) => ({ id: i, x: l[0], y: l[1], kind: l[2], n: l[3], name: l[4],
    streets: l[4] ? l[4].split(' / ') : [] })),
  timings: {},
  view: { cx: 0, cy: 0, s: 0.07 },
  me: null, follow: false,
  route: null, pickMode: null, A: null, B: null,
  mode: 'car', opt: 'fast', depart: 0,
  selected: null,
};
try { S.timings = JSON.parse(localStorage.getItem(LS_TIMINGS) || '{}') || {}; } catch (e) { S.timings = {}; }

// ======================= УТИЛИТЫ ====================================
const $ = id => document.getElementById(id);
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const fmtT = ms => { const d = new Date(ms); return [d.getHours(), d.getMinutes(), d.getSeconds()].map(v => String(v).padStart(2, '0')).join(':'); };
const fmtDur = s => s < 60 ? Math.round(s) + ' с' : (s < 3600 ? Math.floor(s / 60) + ' мин ' + String(Math.round(s % 60)).padStart(2, '0') + ' с' : Math.floor(s / 3600) + ' ч ' + Math.round((s % 3600) / 60) + ' мин');
const fmtDist = m => m < 1000 ? Math.round(m) + ' м' : (m / 1000).toFixed(m < 10000 ? 2 : 1) + ' км';
let toastT = null;
function toast(t, ms = 2800) { const m = $('msg'); m.textContent = t; m.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => m.classList.remove('show'), ms); }

// ======================= ХРАНИЛИЩЕ (IndexedDB) ======================
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('kostroma-map', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function kvGet(k) { try { const db = await idb(); return await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => r(q.result); q.onerror = () => r(null); }); } catch (e) { return null; } }
async function kvSet(k, v) { try { const db = await idb(); await new Promise(r => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = r; t.onerror = r; }); } catch (e) {} }

// ======================= ЗАГРУЗКА ДАННЫХ OSM ========================
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
function overpassQuery() {
  const b = BBOX.join(',');
  return `[out:json][timeout:90];(
way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link|pedestrian|footway|path|steps|cycleway)$"](${b});
way["natural"="water"](${b});way["waterway"~"^(river|riverbank|canal)$"](${b});
relation["natural"="water"](${b});relation["waterway"="riverbank"](${b});
node["highway"="traffic_signals"](${b});node["crossing"="traffic_signals"](${b}););out body geom qt;`;
}
function keepTags(t) {
  if (!t) return {};
  const o = {};
  for (const k of ['highway', 'name', 'oneway', 'junction', 'maxspeed', 'natural', 'waterway', 'water', 'area'])
    if (t[k] != null) o[k] = t[k];
  return o;
}
function normalizeOverpass(j) {
  const ways = [], water = [], signals = new Set();
  for (const e of j.elements) {
    if (e.type === 'node') { signals.add(e.id); continue; }
    if (e.type === 'way' && e.geometry) {
      ways.push({ id: e.id, t: keepTags(e.tags), n: e.nodes, g: e.geometry.map(p => [p.lat, p.lon]) });
    } else if (e.type === 'relation' && e.members) {
      const outers = e.members.filter(m => m.type === 'way' && m.geometry && m.role !== 'inner').map(m => m.geometry.map(p => [p.lat, p.lon]));
      const inners = e.members.filter(m => m.type === 'way' && m.geometry && m.role === 'inner').map(m => m.geometry.map(p => [p.lat, p.lon]));
      water.push({ outer: stitch(outers), inner: stitch(inners) });
    }
  }
  return { v: DATA_VERSION, ways, water, signals: [...signals], at: Date.now() };
}
// соединяем куски колец мультиполигона
function stitch(parts) {
  const rings = [], pool = parts.map(p => p.slice());
  const same = (a, b) => Math.abs(a[0] - b[0]) < 1e-7 && Math.abs(a[1] - b[1]) < 1e-7;
  while (pool.length) {
    let ring = pool.shift();
    let guard = 0;
    while (!same(ring[0], ring[ring.length - 1]) && guard++ < 5000) {
      const end = ring[ring.length - 1];
      let k = pool.findIndex(p => same(p[0], end)), rev = false;
      if (k < 0) { k = pool.findIndex(p => same(p[p.length - 1], end)); rev = true; }
      if (k < 0) break;
      const p = pool.splice(k, 1)[0];
      ring = ring.concat((rev ? p.reverse() : p).slice(1));
    }
    rings.push(ring);
  }
  return rings;
}
async function fetchTimeout(url, opt, ms) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { ...opt, signal: c.signal }); } finally { clearTimeout(t); }
}
async function loadFromOverpass(progress) {
  const body = 'data=' + encodeURIComponent(overpassQuery());
  for (const url of OVERPASS) {
    try {
      progress('Загрузка карты: ' + new URL(url).host + '…');
      const r = await fetchTimeout(url, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, 120000);
      if (!r.ok) continue;
      const j = await r.json();
      if (j.elements && j.elements.length > 1000) return normalizeOverpass(j);
    } catch (e) { /* следующий сервер */ }
  }
  return null;
}
// запасной путь: основной API OSM, плиткой
async function loadFromOsmApi(progress) {
  const tiles = [];
  for (let la = BBOX[0]; la < BBOX[2]; la += 0.025) for (let lo = BBOX[1]; lo < BBOX[3]; lo += 0.04) tiles.push([lo, la, lo + 0.04, la + 0.025]);
  const ways = new Map(), signals = new Set(); let done = 0, failed = 0;
  async function one(t) {
    for (let k = 0; k < 3; k++) {
      try {
        const r = await fetchTimeout('https://api.openstreetmap.org/api/0.6/map.json?bbox=' + t.map(v => v.toFixed(4)).join(','), {}, 60000);
        if (r.status === 400) { const [a, b, c, d] = t, mx = (a + c) / 2, my = (b + d) / 2; for (const s of [[a, b, mx, my], [mx, b, c, my], [a, my, mx, d], [mx, my, c, d]]) await one(s); return; }
        if (!r.ok) throw new Error(r.status);
        const j = await r.json(); const nd = {};
        for (const e of j.elements) if (e.type === 'node') { nd[e.id] = e; if (e.tags && (e.tags.highway === 'traffic_signals' || e.tags.crossing === 'traffic_signals')) signals.add(e.id); }
        for (const e of j.elements) {
          if (e.type !== 'way' || !e.tags || ways.has(e.id)) continue;
          const t2 = e.tags;
          if (!(ROAD_CLASS[t2.highway] || t2.natural === 'water' || /^(river|riverbank|canal)$/.test(t2.waterway || ''))) continue;
          const g = e.nodes.map(n => nd[n]).filter(Boolean);
          if (g.length !== e.nodes.length) continue;
          ways.set(e.id, { id: e.id, t: keepTags(t2), n: e.nodes, g: g.map(n => [n.lat, n.lon]) });
        }
        return;
      } catch (e) { if (k === 2) failed++; }
    }
  }
  const q = [...tiles];
  await Promise.all([0, 1, 2].map(async () => { while (q.length) { await one(q.shift()); done++; progress(`Загрузка карты (запасной сервер): ${Math.round(done / tiles.length * 100)}%`); } }));
  if (ways.size < 1000) return null;
  return { v: DATA_VERSION, ways: [...ways.values()], water: [], signals: [...signals], at: Date.now(), partial: failed > 0 };
}
async function loadData(force) {
  const progress = t => { $('loading').hidden = false; $('loadingText').textContent = t; };
  if (!force) {
    const cached = await kvGet('osm');
    if (cached && cached.v === DATA_VERSION) { useData(cached); return; }
  }
  progress('Загрузка карты Костромы…');
  let d = await loadFromOverpass(progress);
  if (!d) d = await loadFromOsmApi(progress);
  $('loading').hidden = true;
  if (!d) { toast('Не удалось загрузить карту из интернета — показаны только основные улицы', 5000); useFallback(); return; }
  await kvSet('osm', d);
  useData(d);
  toast('Карта загружена и сохранена на устройстве');
}

// ======================= ПОДГОТОВКА ДАННЫХ ==========================
function useFallback() {
  S.roads = [];
  FALLBACK_ROADS.forEach((s, ci) => s.split('|').forEach(w => {
    let x = 0, y = 0;
    const pts = w.split(' ').map(t => { const [a, b] = t.split(','); x += parseInt(a, 36); y += parseInt(b, 36); return [x, y]; });
    S.roads.push({ c: ci + 1, name: '', pts });
  }));
  S.water = []; S.rivers = []; S.labels = []; S.graph = null; S.data = null;
  $('dataInfo').textContent = 'Подробная карта не загружена. Маршруты недоступны.';
  draw();
}
function useData(d) {
  S.data = d;
  const signals = new Set(d.signals);
  S.roads = []; S.water = []; S.rivers = [];
  for (const w of d.ways) {
    const t = w.t, pts = w.g.map(p => toXY(p[0], p[1]));
    if (t.highway && ROAD_CLASS[t.highway]) S.roads.push({ c: ROAD_CLASS[t.highway], name: t.name || '', pts });
    else if (t.natural === 'water' || t.waterway === 'riverbank') { if (pts.length > 3) S.water.push({ outer: [pts], inner: [] }); }
    else if (t.waterway) S.rivers.push({ big: t.waterway === 'river', pts });
  }
  for (const r of d.water || []) S.water.push({ outer: r.outer.map(ring => ring.map(p => toXY(p[0], p[1]))), inner: r.inner.map(ring => ring.map(p => toXY(p[0], p[1]))) });
  S.roads.sort((a, b) => b.c - a.c);
  buildLabels();
  S.graph = buildGraph(d, signals);
  const dt = new Date(d.at);
  $('dataInfo').textContent = `Карта: ${S.roads.length} улиц и дорог, загружена ${dt.toLocaleDateString('ru-RU')}${d.partial ? ' (частично)' : ''}.`;
  buildStreetIndex();
  draw();
}

// ======================= ГРАФ ДОРОГ =================================
function parseSpeed(t) {
  const m = String(t.maxspeed || '').match(/\d+/);
  if (m) return Math.min(+m[0], 110);
  if (/urban/i.test(t.maxspeed || '')) return 60;
  return CAR_SPEED[t.highway] || 30;
}
function buildGraph(d) {
  const node = new Map();     // osm id -> index
  const X = [], Y = [];
  const adj = [];             // index -> [[to, len, speedCar(km/h)|0, walkOk, wayName]]
  const idx = (id, lat, lon) => { let i = node.get(id); if (i == null) { i = X.length; node.set(id, i); const p = toXY(lat, lon); X.push(p[0]); Y.push(p[1]); adj.push([]); } return i; };
  for (const w of d.ways) {
    const t = w.t; if (!t.highway || !w.n || w.n.length < 2) continue;
    const car = !!CAR_SPEED[t.highway], walk = WALK_OK.has(t.highway);
    if (!car && !walk) continue;
    const sp = car ? parseSpeed(t) : 0;
    let ow = 0;
    if (car) { if (['yes', 'true', '1'].includes(t.oneway) || t.junction === 'roundabout' || t.highway === 'motorway') ow = 1; if (t.oneway === '-1') ow = -1; }
    const name = t.name || '';
    for (let k = 0; k < w.n.length - 1; k++) {
      const a = idx(w.n[k], w.g[k][0], w.g[k][1]), b = idx(w.n[k + 1], w.g[k + 1][0], w.g[k + 1][1]);
      const len = Math.hypot(X[a] - X[b], Y[a] - Y[b]);
      adj[a].push([b, len, ow === -1 ? 0 : sp, walk, name]);
      adj[b].push([a, len, ow === 1 ? 0 : sp, walk, name]);
    }
  }
  // узлы внутри светофорных объектов
  const cl = new Int32Array(X.length).fill(-1);
  const R = 40;
  for (let i = 0; i < X.length; i++) {
    for (const L of S.lights) { const r = L.kind === 'X' ? R : 22; if (Math.abs(L.x - X[i]) < r && Math.abs(L.y - Y[i]) < r && Math.hypot(L.x - X[i], L.y - Y[i]) < r) { cl[i] = L.id; break; } }
  }
  // сетка для поиска ближайшего узла
  const G = 100, grid = new Map();
  for (let i = 0; i < X.length; i++) { if (!adj[i].length) continue; const k = Math.floor(X[i] / G) + ',' + Math.floor(Y[i] / G); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); }
  return { X, Y, adj, cl, grid, G };
}
function nearestNode(x, y, mode) {
  const g = S.graph; if (!g) return -1;
  let best = -1, bd = 1e18;
  for (let r = 0; r < 6 && best < 0; r++) {
    const gx = Math.floor(x / g.G), gy = Math.floor(y / g.G);
    for (let i = gx - r; i <= gx + r; i++) for (let j = gy - r; j <= gy + r; j++) {
      const list = g.grid.get(i + ',' + j); if (!list) continue;
      for (const n of list) {
        if (!g.adj[n].some(e => mode === 'car' ? e[2] > 0 : e[3])) continue;
        const d = (g.X[n] - x) ** 2 + (g.Y[n] - y) ** 2; if (d < bd) { bd = d; best = n; }
      }
    }
  }
  return best;
}

// ======================= СВЕТОФОРЫ: ЛОГИКА ==========================
function phase(T, now) {
  if (!T || !(T.g > 0) || !(T.r >= 0) || T.a == null) return null;
  const y = T.y || 0, cyc = T.g + y + T.r; if (cyc <= 0) return null;
  let c = ((now - T.a) / 1000) % cyc; if (c < 0) c += cyc;
  if (c < T.g) return { s: 'G', left: T.g - c, cyc, c };
  if (c < T.g + y) return { s: 'Y', left: T.g + y - c, cyc, c };
  return { s: 'R', left: cyc - c, cyc, c };
}
// ожидание при подъезде в момент tMs по улице streetName
function waitAt(L, tMs, streetName) {
  const T = S.timings[L.id];
  const ph = phase(T, tMs);
  if (!ph) return { wait: DEFAULT_WAIT[L.kind] || 12, known: false, s: null };
  const main = (T.main || L.streets[0] || '');
  const cross = L.kind === 'X' && streetName && main && streetName !== main;
  if (!cross) {
    if (ph.s === 'G') return { wait: 0, known: true, s: 'G' };
    if (ph.s === 'Y') return { wait: ph.left + T.r, known: true, s: 'Y' };
    return { wait: ph.left, known: true, s: 'R' };
  }
  // поперечное направление: зелёный, пока у главного красный
  if (ph.s === 'R') return { wait: 0, known: true, s: 'G' };
  if (ph.s === 'Y') return { wait: ph.left, known: true, s: 'R' };
  return { wait: ph.left + (T.y || 0), known: true, s: 'R' };
}

// ======================= МАРШРУТ ====================================
class Heap { constructor() { this.a = []; } push(k, v) { const a = this.a; a.push([k, v]); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
  pop() { const a = this.a; const top = a[0], last = a.pop(); if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && a[l][0] < a[m][0]) m = l; if (r < a.length && a[r][0] < a[m][0]) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } } return top; } get size() { return this.a.length; } }

function route(fromXY, toXY_, mode, opt, departMs) {
  const g = S.graph; if (!g) return null;
  const s = nearestNode(fromXY[0], fromXY[1], mode), t = nearestNode(toXY_[0], toXY_[1], mode);
  if (s < 0 || t < 0) return null;
  const n = g.X.length;
  const cost = new Float64Array(n).fill(Infinity), tim = new Float64Array(n).fill(Infinity), dist = new Float64Array(n);
  const prev = new Int32Array(n).fill(-1), prevName = new Array(n);
  cost[s] = 0; tim[s] = 0;
  const h = new Heap(); h.push(0, s);
  const walkV = 5 / 3.6;
  const maxV = 90 / 3.6;
  const heur = i => { const d = Math.hypot(g.X[i] - g.X[t], g.Y[i] - g.Y[t]); return opt === 'short' ? d : d / (mode === 'car' ? maxV : walkV); };
  while (h.size) {
    const [, u] = h.pop();
    if (u === t) break;
    const cu = cost[u];
    for (const e of g.adj[u]) {
      const v = e[0], len = e[1];
      if (mode === 'car' ? e[2] <= 0 : !e[3]) continue;
      const vel = mode === 'car' ? e[2] / 3.6 : walkV;
      let dt = len / vel;
      const cv = g.cl[v], cuL = g.cl[u];
      if (cv >= 0 && cv !== cuL) {
        const L = S.lights[cv];
        if (mode === 'car' || L.kind !== 'X' || true) dt += waitAt(L, departMs + (tim[u] + len / vel) * 1000, e[4]).wait;
      }
      const nt = tim[u] + dt;
      const nc = opt === 'short' ? cu + len : nt;
      if (nc < cost[v] - 1e-9) {
        cost[v] = nc; tim[v] = nt; dist[v] = dist[u] + len; prev[v] = u; prevName[v] = e[4];
        h.push(nc + heur(v), v);
      }
    }
  }
  if (!isFinite(cost[t])) return null;
  const path = []; for (let v = t; v >= 0; v = prev[v]) path.push(v);
  path.reverse();
  // разбор по светофорам: заново проходим путь по времени
  const lights = []; let tt = 0;
  for (let i = 1; i < path.length; i++) {
    const u = path[i - 1], v = path[i];
    const e = g.adj[u].find(x => x[0] === v);
    const vel = mode === 'car' ? (e[2] || 30) / 3.6 : walkV;
    tt += e[1] / vel;
    const cv = g.cl[v];
    if (cv >= 0 && cv !== g.cl[u]) {
      const w = waitAt(S.lights[cv], departMs + tt * 1000, e[4]);
      lights.push({ id: cv, eta: tt, ...w, street: e[4] });
      tt += w.wait;
    }
  }
  return { pts: path.map(i => [g.X[i], g.Y[i]]), time: tt, dist: dist[t], lights };
}

// ======================= ОТРИСОВКА ==================================
const cv = $('cv'), ctx = cv.getContext('2d');
let W = 0, H = 0, DPR = 1;
function resize() { const r = cv.getBoundingClientRect(); DPR = window.devicePixelRatio || 1; W = r.width; H = r.height; cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR); draw(); }
const sx = x => (x - S.view.cx) * S.view.s + W / 2;
const sy = y => H / 2 - (y - S.view.cy) * S.view.s;
const wx = px => (px - W / 2) / S.view.s + S.view.cx;
const wy = py => S.view.cy - (py - H / 2) / S.view.s;
function fitAll() {
  const xs = S.lights.map(l => l.x), ys = S.lights.map(l => l.y);
  const minx = Math.min(...xs), maxx = Math.max(...xs), miny = Math.min(...ys), maxy = Math.max(...ys);
  S.view.cx = (minx + maxx) / 2; S.view.cy = (miny + maxy) / 2;
  S.view.s = Math.min(W / (maxx - minx + 1500), H / (maxy - miny + 1500));
}
function pathPts(pts) { ctx.moveTo(sx(pts[0][0]), sy(pts[0][1])); for (let i = 1; i < pts.length; i++) ctx.lineTo(sx(pts[i][0]), sy(pts[i][1])); }
function visible(pts) { // грубая отсечка по рамке
  const x0 = wx(-50), x1 = wx(W + 50), y1 = wy(-50), y0 = wy(H + 50);
  for (let i = 0; i < pts.length; i += Math.max(1, pts.length >> 3)) { const p = pts[i]; if (p[0] > x0 && p[0] < x1 && p[1] > y0 && p[1] < y1) return true; }
  const p = pts[pts.length - 1]; return p[0] > x0 && p[0] < x1 && p[1] > y0 && p[1] < y1;
}
let drawQueued = false;
function draw() { if (!drawQueued) { drawQueued = true; requestAnimationFrame(() => { drawQueued = false; render(); }); } }
function render() {
  if (!W) return;
  const s = S.view.s;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.fillStyle = css('--land'); ctx.fillRect(0, 0, W, H);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  // вода
  ctx.fillStyle = css('--water');
  for (const w of S.water) {
    ctx.beginPath();
    for (const r of w.outer) if (r.length > 2) { pathPts(r); ctx.closePath(); }
    for (const r of w.inner) if (r.length > 2) { pathPts(r); ctx.closePath(); }
    ctx.fill('evenodd');
  }
  ctx.strokeStyle = css('--water');
  for (const r of S.rivers) { ctx.lineWidth = r.big ? Math.max(2, 120 * s) : Math.max(1, 8 * s); ctx.beginPath(); pathPts(r.pts); ctx.stroke(); }
  // дороги
  const k = Math.max(0.35, Math.min(3, s / 0.12));
  const W_ = { 1: [10, 7], 2: [8.5, 5.5], 3: [7, 4.5], 4: [5, 3], 5: [3.2, 1.8], 6: [0, 1.2] };
  const C_ = { 1: '--r1', 2: '--r2', 3: '--r3', 4: '--r4', 5: '--r4', 6: '--path' };
  const minClass = s < 0.05 ? 3 : s < 0.11 ? 4 : s < 0.3 ? 5 : 6;
  for (let pass = 0; pass < 2; pass++) {
    for (const c of [6, 5, 4, 3, 2, 1]) {
      if (c > minClass) continue;
      if (pass === 0 && c === 6) continue;
      ctx.strokeStyle = pass === 0 ? css('--case') : css(C_[c]);
      ctx.lineWidth = Math.max(c <= 3 ? 1.2 : 0.6, (pass === 0 ? W_[c][0] : W_[c][1]) * k);
      if (c === 6) ctx.setLineDash([3, 3]); else ctx.setLineDash([]);
      ctx.beginPath();
      for (const r of S.roads) if (r.c === c && visible(r.pts)) pathPts(r.pts);
      ctx.stroke();
    }
  }
  ctx.setLineDash([]);
  // маршрут
  if (S.route) {
    ctx.strokeStyle = css('--routecase'); ctx.lineWidth = 9; ctx.beginPath(); pathPts(S.route.pts); ctx.stroke();
    ctx.strokeStyle = css('--route'); ctx.lineWidth = 5.5; ctx.beginPath(); pathPts(S.route.pts); ctx.stroke();
  }
  // подписи улиц
  if (s > 0.25) drawLabels();
  // светофоры
  const now = Date.now(), showNum = s > 0.2;
  for (const L of S.lights) {
    const x = sx(L.x), y = sy(L.y); if (x < -20 || y < -20 || x > W + 20 || y > H + 20) continue;
    const ph = phase(S.timings[L.id], now);
    const r = (L.kind === 'X' ? 6.5 : 4.5) * Math.max(0.85, Math.min(1.7, k));
    if (L.id === S.selected) { ctx.beginPath(); ctx.arc(x, y, r + 6, 0, 7); ctx.fillStyle = css('--accent'); ctx.globalAlpha = .25; ctx.fill(); ctx.globalAlpha = 1; }
    ctx.beginPath(); ctx.arc(x, y, r, 0, 7);
    if (ph) { ctx.fillStyle = css(ph.s === 'G' ? '--g' : ph.s === 'Y' ? '--y' : '--r'); ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = css('--panel'); ctx.stroke(); }
    else { ctx.fillStyle = css('--panel'); ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = css('--none'); ctx.stroke(); }
    if (showNum) {
      ctx.font = '600 11px system-ui,sans-serif'; ctx.textBaseline = 'middle';
      ctx.lineWidth = 3; ctx.strokeStyle = css('--land'); ctx.strokeText(String(L.id + 1), x + r + 4, y); ctx.fillStyle = css('--ink'); ctx.fillText(String(L.id + 1), x + r + 4, y);
      if (ph && s > 0.4) { ctx.font = '11px system-ui,sans-serif'; ctx.strokeText(Math.ceil(ph.left) + ' с', x + r + 4, y + 13); ctx.fillStyle = css('--muted'); ctx.fillText(Math.ceil(ph.left) + ' с', x + r + 4, y + 13); }
    }
  }
  // точки A/B
  for (const [P, lab, col] of [[S.A, 'A', '--g'], [S.B, 'B', '--r']]) {
    if (!P) continue; const x = sx(P[0]), y = sy(P[1]);
    ctx.beginPath(); ctx.arc(x, y - 14, 10, 0, 7); ctx.fillStyle = css(col); ctx.fill();
    ctx.beginPath(); ctx.moveTo(x - 5, y - 6); ctx.lineTo(x, y); ctx.lineTo(x + 5, y - 6); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = '700 11px system-ui,sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(lab, x, y - 14); ctx.textAlign = 'start';
  }
  // моё место
  if (S.me) {
    const x = sx(S.me.x), y = sy(S.me.y);
    ctx.beginPath(); ctx.arc(x, y, Math.max(8, S.me.acc * s), 0, 7); ctx.fillStyle = css('--accent'); ctx.globalAlpha = .15; ctx.fill(); ctx.globalAlpha = 1;
    ctx.beginPath(); ctx.arc(x, y, 7, 0, 7); ctx.fillStyle = css('--accent'); ctx.fill(); ctx.lineWidth = 2.5; ctx.strokeStyle = '#fff'; ctx.stroke();
  }
  // масштабная линейка
  const target = 100 / s, pow = Math.pow(10, Math.floor(Math.log10(target)));
  const len = [1, 2, 5, 10].map(m => m * pow).find(v => v >= target * 0.6) || pow;
  ctx.fillStyle = css('--ink'); ctx.fillRect(12, H - 18, len * s, 3);
  ctx.font = '11px system-ui,sans-serif'; ctx.textBaseline = 'alphabetic'; ctx.fillText(fmtDist(len), 12, H - 24);
}
function buildLabels() {
  const byName = new Map();
  for (const r of S.roads) {
    if (!r.name || r.c > 4) continue;
    let best = null, bl = 0;
    for (let i = 0; i < r.pts.length - 1; i++) { const l = Math.hypot(r.pts[i + 1][0] - r.pts[i][0], r.pts[i + 1][1] - r.pts[i][1]); if (l > bl) { bl = l; best = i; } }
    if (bl < 60) continue;
    const a = r.pts[best], b = r.pts[best + 1];
    (byName.get(r.name) || byName.set(r.name, []).get(r.name)).push({ x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2, ang: Math.atan2(b[1] - a[1], b[0] - a[0]), len: bl, c: r.c });
  }
  S.labels = [];
  for (const [name, arr] of byName) { arr.sort((p, q) => q.len - p.len); for (const p of arr.slice(0, 6)) S.labels.push({ name: name.replace('улица', 'ул.').replace('проспект', 'пр.'), ...p }); }
  S.labels.sort((p, q) => p.c - q.c || q.len - p.len);
}
function drawLabels() {
  const used = [];
  ctx.font = '11.5px system-ui,sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const L of S.labels) {
    if (L.len * S.view.s < 70) continue;
    const x = sx(L.x), y = sy(L.y); if (x < 0 || y < 0 || x > W || y > H) continue;
    if (used.some(u => Math.abs(u[0] - x) < 90 && Math.abs(u[1] - y) < 22)) continue;
    used.push([x, y]);
    let a = -L.ang; if (a > Math.PI / 2) a -= Math.PI; if (a < -Math.PI / 2) a += Math.PI;
    ctx.save(); ctx.translate(x, y); ctx.rotate(a);
    ctx.lineWidth = 3; ctx.strokeStyle = css('--land'); ctx.strokeText(L.name, 0, 0); ctx.fillStyle = css('--muted'); ctx.fillText(L.name, 0, 0);
    ctx.restore();
  }
  ctx.textAlign = 'start';
}

// ======================= ВЗАИМОДЕЙСТВИЕ С КАРТОЙ ====================
const ptrs = new Map(); let drag = null, moved = false, pinch = null;
cv.addEventListener('pointerdown', e => {
  cv.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (ptrs.size === 1) { drag = { x: e.clientX, y: e.clientY, cx: S.view.cx, cy: S.view.cy }; moved = false; }
  else if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), s: S.view.s, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 }; drag = null; moved = true; }
});
cv.addEventListener('pointermove', e => {
  if (!ptrs.has(e.pointerId)) return;
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch && ptrs.size === 2) {
    const [a, b] = [...ptrs.values()], r = cv.getBoundingClientRect();
    const mx = pinch.mx - r.left, my = pinch.my - r.top, X = wx(mx), Y = wy(my);
    S.view.s = Math.max(0.02, Math.min(4, pinch.s * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d));
    S.view.cx = X - (mx - W / 2) / S.view.s; S.view.cy = Y + (my - H / 2) / S.view.s; draw(); return;
  }
  if (drag) { const dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.abs(dx) + Math.abs(dy) > 4) { moved = true; S.follow = false; }
    if (moved) { S.view.cx = drag.cx - dx / S.view.s; S.view.cy = drag.cy + dy / S.view.s; draw(); } }
});
function endPtr(e) {
  if (!ptrs.has(e.pointerId)) return;
  ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch = null;
  if (drag && !moved && ptrs.size === 0) { const r = cv.getBoundingClientRect(); onTap(e.clientX - r.left, e.clientY - r.top); }
  if (ptrs.size === 0) drag = null;
}
cv.addEventListener('pointerup', endPtr); cv.addEventListener('pointercancel', endPtr);
cv.addEventListener('wheel', e => {
  e.preventDefault(); const r = cv.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top, X = wx(mx), Y = wy(my);
  S.view.s = Math.max(0.02, Math.min(4, S.view.s * Math.exp(-e.deltaY * 0.0015)));
  S.view.cx = X - (mx - W / 2) / S.view.s; S.view.cy = Y + (my - H / 2) / S.view.s; draw();
}, { passive: false });
function zoomBy(f) { S.view.s = Math.max(0.02, Math.min(4, S.view.s * f)); draw(); }
function onTap(px, py) {
  if (S.pickMode) {
    const p = [wx(px), wy(py)];
    S[S.pickMode] = p; S.pickMode = null; $('mapwrap').classList.remove('picking');
    updateRouteUI(); computeRoute(); return;
  }
  let best = null, bd = 1e9;
  for (const L of S.lights) { const d = Math.hypot(sx(L.x) - px, sy(L.y) - py); if (d < bd) { bd = d; best = L; } }
  if (best && bd < 20) { selectLight(best.id, false); showTab('lights'); }
}

// ======================= ГЕОЛОКАЦИЯ =================================
let geoWatch = null;
function locate() {
  if (!('geolocation' in navigator)) { toast('Геолокация недоступна в этом браузере'); return; }
  if (S.me) { S.follow = true; S.view.cx = S.me.x; S.view.cy = S.me.y; if (S.view.s < 0.4) S.view.s = 0.6; draw(); }
  if (geoWatch != null) return;
  toast('Определяю местоположение…');
  geoWatch = navigator.geolocation.watchPosition(p => {
    const [x, y] = toXY(p.coords.latitude, p.coords.longitude);
    const first = !S.me; S.me = { x, y, acc: p.coords.accuracy, sp: p.coords.speed };
    if (first || S.follow) { S.follow = true; S.view.cx = x; S.view.cy = y; if (first && S.view.s < 0.4) S.view.s = 0.6; }
    if (first && (Math.abs(x) > 20000 || Math.abs(y) > 20000)) toast('Вы далеко от Костромы — точка за пределами карты', 4000);
    if (first && p.coords.accuracy > 300) toast('Точность ' + Math.round(p.coords.accuracy) + ' м — на ПК местоположение примерное', 4000);
    draw(); updateSpeed();
  }, err => { toast(err.code === 1 ? 'Доступ к геолокации запрещён — разрешите его в настройках браузера' : 'Не удалось определить местоположение'); geoWatch = null; },
  { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
}
function updateSpeed() {
  const el = $('speed');
  if (S.me && S.me.sp != null && S.me.sp > 0.5) { el.hidden = false; el.textContent = Math.round(S.me.sp * 3.6) + ' км/ч'; } else el.hidden = true;
}

// ======================= ПОИСК ======================================
let streetIndex = [];
function buildStreetIndex() {
  const m = new Map();
  for (const r of S.roads) if (r.name && r.c <= 5) { const e = m.get(r.name) || { name: r.name, x0: 1e9, x1: -1e9, y0: 1e9, y1: -1e9, len: 0 };
    for (const p of r.pts) { e.x0 = Math.min(e.x0, p[0]); e.x1 = Math.max(e.x1, p[0]); e.y0 = Math.min(e.y0, p[1]); e.y1 = Math.max(e.y1, p[1]); } m.set(r.name, e); }
  streetIndex = [...m.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}
function doSearch(q) {
  const box = $('results'); box.innerHTML = '';
  q = q.trim().toLowerCase(); if (!q) { box.hidden = true; return; }
  const out = [];
  const num = q.replace(/^#/, '');
  if (/^\d+$/.test(num) && S.lights[+num - 1]) out.push({ t: 'Светофор #' + num, sub: S.lights[+num - 1].name, go: () => { selectLight(+num - 1, true); showTab('lights'); } });
  for (const st of streetIndex) if (st.name.toLowerCase().includes(q)) { out.push({ t: st.name, sub: 'улица', go: () => { S.view.cx = (st.x0 + st.x1) / 2; S.view.cy = (st.y0 + st.y1) / 2; S.view.s = Math.min(1.2, Math.max(0.12, Math.min(W / (st.x1 - st.x0 + 300), H / (st.y1 - st.y0 + 300)))); S.follow = false; draw(); } }); if (out.length > 12) break; }
  for (const L of S.lights) if (L.name.toLowerCase().includes(q) && out.length < 20) out.push({ t: 'Светофор #' + (L.id + 1), sub: L.name, go: () => { selectLight(L.id, true); showTab('lights'); } });
  if (!out.length) out.push({ t: 'Ничего не найдено', sub: S.data ? '' : 'Подробная карта ещё не загружена', go: null });
  for (const o of out) { const d = document.createElement('div'); d.className = 'res'; d.innerHTML = '<b></b><span></span>'; d.querySelector('b').textContent = o.t; d.querySelector('span').textContent = o.sub;
    if (o.go) d.onclick = () => { o.go(); box.hidden = true; $('q').blur(); }; box.appendChild(d); }
  box.hidden = false;
}

// ======================= UI: ВКЛАДКИ ================================
function showTab(name) {
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
  document.querySelectorAll('.pane').forEach(p => p.hidden = p.id !== 'pane-' + name);
  document.body.classList.add('sheet-open');
  if (name === 'lights') renderLightList();
}

// ======================= UI: МАРШРУТ ================================
function updateRouteUI() {
  const nm = P => !P ? 'не выбрано' : (S.me && P === S.meRef ? 'моё местоположение' : toLL(P[0], P[1]).map(v => v.toFixed(5)).join(', '));
  $('aVal').textContent = nm(S.A); $('bVal').textContent = nm(S.B);
  document.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('on', b.dataset.mode === S.mode));
  document.querySelectorAll('[data-opt]').forEach(b => b.classList.toggle('on', b.dataset.opt === S.opt));
}
function pick(which) {
  S.pickMode = which; $('mapwrap').classList.add('picking');
  toast(which === 'A' ? 'Нажмите на карте точку отправления' : 'Нажмите на карте точку назначения');
  if (window.innerWidth < 760) document.body.classList.remove('sheet-open');
}
function computeRoute() {
  const out = $('routeOut');
  if (!S.A || !S.B) { S.route = null; out.innerHTML = ''; draw(); return; }
  if (!S.graph) { out.innerHTML = '<div class="hint">Маршруты появятся, когда загрузится подробная карта (вкладка «Данные»).</div>'; return; }
  const depart = Date.now() + S.depart * 60000;
  const r = route(S.A, S.B, S.mode, S.opt, depart);
  S.route = r;
  if (!r) { out.innerHTML = '<div class="hint">Маршрут не найден. Попробуйте поставить точки ближе к дорогам.</div>'; draw(); return; }
  const alt = route(S.A, S.B, S.mode, S.opt === 'fast' ? 'short' : 'fast', depart);
  const stops = r.lights.filter(l => l.wait > 0.5);
  const known = r.lights.filter(l => l.known).length;
  let html = `<div class="sum"><div><b>${fmtDur(r.time)}</b><span>в пути</span></div><div><b>${fmtDist(r.dist)}</b><span>расстояние</span></div><div><b>${r.lights.length}</b><span>светофоров</span></div><div><b>${fmtDur(r.lights.reduce((a, l) => a + l.wait, 0))}</b><span>ожидание</span></div></div>`;
  html += `<div class="hint">Прибытие ≈ ${fmtT(depart + r.time * 1000)}. Тайминги известны для ${known} из ${r.lights.length} светофоров на пути${known < r.lights.length ? ', для остальных взято среднее ожидание' : ''}.</div>`;
  if (alt) html += `<div class="hint">${S.opt === 'fast' ? 'Самый короткий' : 'Самый быстрый'} вариант: ${fmtDur(alt.time)}, ${fmtDist(alt.dist)}.</div>`;
  if (r.lights.length) {
    html += '<div class="lst">';
    for (const l of r.lights) {
      const L = S.lights[l.id], col = l.s === 'G' ? '--g' : l.s === 'R' || l.s === 'Y' ? '--r' : '--none';
      html += `<div class="li" data-l="${l.id}"><span class="dot on" style="background:var(${col})"></span><span class="nm">#${l.id + 1} ${escapeHtml(L.name || 'Светофор')}</span><span class="tm">${fmtT(depart + l.eta * 1000)}${l.wait > 0.5 ? ' · ждать ' + Math.round(l.wait) + ' с' : l.known ? ' · зелёный' : ''}</span></div>`;
    }
    html += '</div>';
  }
  out.innerHTML = html;
  out.querySelectorAll('[data-l]').forEach(d => d.onclick = () => { selectLight(+d.dataset.l, true); showTab('lights'); });
  draw();
}
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ======================= UI: СВЕТОФОРЫ ==============================
function renderLightList() {
  const q = $('lq').value.trim().toLowerCase(), now = Date.now(), box = $('lightList');
  box.innerHTML = '';
  for (const L of S.lights) {
    const name = L.name || (L.kind === 'P' ? 'Пешеходный переход' : 'Без названия');
    if (q && !(String(L.id + 1) === q.replace('#', '') || name.toLowerCase().includes(q))) continue;
    const ph = phase(S.timings[L.id], now);
    const d = document.createElement('div'); d.className = 'li' + (L.id === S.selected ? ' sel' : ''); d.dataset.i = L.id;
    d.innerHTML = `<span class="num">#${L.id + 1}</span><span class="dot${ph ? ' on' : ''}"${ph ? ` style="background:var(${ph.s === 'G' ? '--g' : ph.s === 'Y' ? '--y' : '--r'})"` : ''}></span><span class="nm"></span><span class="tm">${ph ? Math.ceil(ph.left) + ' с' : ''}</span>`;
    d.querySelector('.nm').textContent = name + (L.kind === 'P' ? ' (пеш.)' : '');
    d.onclick = () => selectLight(L.id, true);
    box.appendChild(d);
  }
  $('lCount').textContent = `${S.lights.length} объектов, с таймингами: ${Object.keys(S.timings).length}`;
}
function parseClock(s) {
  const m = String(s).trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/); if (!m) return null;
  const d = new Date(); d.setHours(+m[1], +m[2], +(m[3] || 0), 0); let t = d.getTime(); if (t > Date.now() + 60000) t -= 86400000; return t;
}
function selectLight(i, center) {
  S.selected = i; const L = S.lights[i], T = S.timings[i] || {};
  if (center) { S.view.cx = L.x; S.view.cy = L.y; if (S.view.s < 0.35) S.view.s = 0.6; S.follow = false; }
  $('editor').hidden = false;
  $('eTitle').textContent = '#' + (i + 1) + '  ' + (L.name || (L.kind === 'P' ? 'Пешеходный переход' : 'Без названия'));
  $('eSub').textContent = (L.kind === 'X' ? 'Перекрёсток' : 'Пешеходный переход') + ' · точек в OSM: ' + L.n;
  $('fG').value = T.g ?? ''; $('fY').value = T.y ?? ''; $('fR').value = T.r ?? ''; $('fA').value = T.a != null ? fmtT(T.a) : '';
  if (!S.meas || S.meas.id !== i) S.meas = { id: i };
  const sel = $('fMain'); sel.innerHTML = '';
  const opts = L.streets.length ? L.streets : ['—'];
  for (const s of opts) { const o = document.createElement('option'); o.value = s; o.textContent = s; sel.appendChild(o); }
  sel.value = T.main || opts[0]; $('mainRow').hidden = L.kind !== 'X' || L.streets.length < 2;
  renderLightList(); tickEditor(); draw();
  const it = $('lightList').querySelector('[data-i="' + i + '"]'); if (it) it.scrollIntoView({ block: 'nearest' });
}
// ---- замер у светофора: 4 кнопки, длительности считаются сами
function mark(k) {
  if (S.selected == null) return;
  const now = Date.now();
  const m = (S.meas && S.meas.id === S.selected) ? S.meas : (S.meas = { id: S.selected });
  const sec = ms => Math.round(ms / 100) / 10;
  const fresh = (t, lim) => t != null && now - t < lim;
  if (k === 'gs') {
    if (fresh(m.rs, 300000)) $('fR').value = sec(now - m.rs);
    m.gs = now; m.ge = null; m.rs = null; $('fA').value = fmtT(now);
  } else if (k === 'ge') {
    if (fresh(m.gs, 300000)) $('fG').value = sec(now - m.gs);
    m.ge = now;
  } else if (k === 'rs') {
    if (fresh(m.ge, 15000)) $('fY').value = sec(now - m.ge);
    else if (m.ge == null && fresh(m.gs, 300000)) { $('fG').value = sec(now - m.gs); $('fY').value = 0; }
    m.rs = now;
  } else if (k === 're') {
    if (fresh(m.rs, 300000)) $('fR').value = sec(now - m.rs);
    m.gs = now; m.ge = null; m.rs = null; $('fA').value = fmtT(now);
  }
  m.last = k; m.t = now;
  try { if (navigator.vibrate) navigator.vibrate(30); } catch (e) {}
  const g = parseFloat($('fG').value), r = parseFloat($('fR').value);
  if (g > 0 && r > 0 && $('fA').value) saveLight(true);
  updMeas();
}
function updMeas() {
  const el = $('eMeas'); if (!el) return;
  const m = S.meas;
  document.querySelectorAll('[data-mk]').forEach(b => b.classList.toggle('last', !!(m && m.id === S.selected && m.last === b.dataset.mk)));
  if (!m || m.id !== S.selected || !m.last) { el.textContent = 'Стоя у светофора, нажимайте кнопку в момент смены сигнала — секунды посчитаются сами. Хватит одного полного круга: начало зелёного → конец зелёного → начало красного → конец красного.'; return; }
  const s = ((Date.now() - m.t) / 1000).toFixed(1);
  const what = { gs: 'идёт зелёный', ge: 'горит жёлтый', rs: 'идёт красный', re: 'снова зелёный' }[m.last];
  const next = { gs: 'Конец зелёного', ge: 'Начало красного', rs: 'Конец красного', re: 'Конец зелёного' }[m.last];
  el.innerHTML = `⏱ ${what}: <b>${s} с</b> · дальше «${next}»`;
}
function tickEditor() {
  if (S.selected == null) return;
  updMeas();
  const ph = phase(S.timings[S.selected], Date.now()), el = $('eLive');
  if (!ph) { el.textContent = 'Нет таймингов — заполните поля и сохраните.'; return; }
  const nm = { G: 'ЗЕЛЁНЫЙ', Y: 'ЖЁЛТЫЙ', R: 'КРАСНЫЙ' }[ph.s];
  el.innerHTML = `Сейчас: <b style="color:var(${ph.s === 'G' ? '--g' : ph.s === 'Y' ? '--y' : '--r'})">${nm}</b>, переключится через <b>${ph.left.toFixed(1)} с</b> · цикл ${ph.cyc} с`;
}
function saveTimings() { try { localStorage.setItem(LS_TIMINGS, JSON.stringify(S.timings)); } catch (e) { toast('Не удалось сохранить на устройстве'); } }
function saveLight(auto) {
  if (S.selected == null) return;
  let g = parseFloat($('fG').value), y = parseFloat($('fY').value || '0'), r = parseFloat($('fR').value), a = parseClock($('fA').value);
  if (S.meas && S.meas.id === S.selected && S.meas.gs && fmtT(S.meas.gs) === $('fA').value.trim()) a = S.meas.gs;
  if (!(g > 0) || isNaN(r) || r < 0) { toast('Укажите зелёный и красный в секундах'); return; }
  if (a == null) { toast('Отметьте начало зелёного кнопкой или впишите время ЧЧ:ММ:СС'); return; }
  S.timings[S.selected] = { g, y: isNaN(y) ? 0 : y, r, a, main: $('fMain').value };
  saveTimings(); renderLightList(); tickEditor(); draw(); toast(auto ? `Замер сохранён: зелёный ${g} с, жёлтый ${isNaN(y) ? 0 : y} с, красный ${r} с` : 'Сохранено на этом устройстве');
  if (S.route) computeRoute();
}
function clearLight() { if (S.selected == null) return; delete S.timings[S.selected]; saveTimings(); selectLight(S.selected, false); if (S.route) computeRoute(); }
function exportTimings() {
  const out = { app: 'kostroma-lights', v: 1, saved: new Date().toISOString(), lights: Object.entries(S.timings).map(([k, T]) => ({ id: +k + 1, name: S.lights[k].name, x: Math.round(S.lights[k].x), y: Math.round(S.lights[k].y), green: T.g, yellow: T.y, red: T.r, green_at: fmtT(T.a), green_at_ms: T.a, main: T.main })) };
  const blob = new Blob([JSON.stringify(out, null, 1)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'светофоры-кострома.json'; document.body.appendChild(a); a.click(); a.remove();
  toast('Файл с таймингами сохранён');
}
function importTimings(file) {
  const fr = new FileReader();
  fr.onload = () => {
    try {
      const j = JSON.parse(fr.result); let n = 0;
      for (const l of j.lights || []) { const i = l.id - 1; if (!S.lights[i]) continue; S.timings[i] = { g: +l.green, y: +l.yellow || 0, r: +l.red, a: l.green_at_ms || parseClock(l.green_at), main: l.main }; n++; }
      saveTimings(); renderLightList(); draw(); toast('Загружено таймингов: ' + n);
    } catch (e) { toast('Файл не похож на файл таймингов'); }
  };
  fr.readAsText(file);
}

// ======================= ИНИЦИАЛИЗАЦИЯ ==============================
function bind() {
  window.addEventListener('resize', resize);
  $('zin').onclick = () => zoomBy(1.6); $('zout').onclick = () => zoomBy(1 / 1.6);
  $('zfit').onclick = () => { fitAll(); S.follow = false; draw(); };
  $('locate').onclick = locate;
  $('q').addEventListener('input', e => doSearch(e.target.value));
  $('q').addEventListener('focus', e => doSearch(e.target.value));
  document.addEventListener('pointerdown', e => { if (!e.target.closest('.searchbox')) $('results').hidden = true; });
  document.querySelectorAll('.tab').forEach(b => b.onclick = () => { if (b.classList.contains('on') && document.body.classList.contains('sheet-open') && window.innerWidth < 760) document.body.classList.remove('sheet-open'); else showTab(b.dataset.tab); });
  $('pickA').onclick = () => pick('A'); $('pickB').onclick = () => pick('B');
  $('meA').onclick = () => { if (!S.me) { locate(); toast('Сначала дождитесь определения местоположения'); return; } S.A = [S.me.x, S.me.y]; S.meRef = S.A; updateRouteUI(); computeRoute(); };
  $('swap').onclick = () => { [S.A, S.B] = [S.B, S.A]; updateRouteUI(); computeRoute(); };
  $('clearRoute').onclick = () => { S.A = S.B = S.route = null; updateRouteUI(); computeRoute(); };
  document.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => { S.mode = b.dataset.mode; updateRouteUI(); computeRoute(); });
  document.querySelectorAll('[data-opt]').forEach(b => b.onclick = () => { S.opt = b.dataset.opt; updateRouteUI(); computeRoute(); });
  $('depart').onchange = e => { S.depart = +e.target.value; computeRoute(); };
  $('lq').addEventListener('input', renderLightList);
  document.querySelectorAll('[data-mk]').forEach(b => b.onclick = () => mark(b.dataset.mk));
  $('bReset').onclick = () => { S.meas = { id: S.selected }; updMeas(); toast('Начат новый замер'); };
  $('bSave').onclick = () => saveLight(false); $('bClear').onclick = clearLight;
  $('bExport').onclick = exportTimings;
  $('bImport').onclick = () => $('fileIn').click();
  $('fileIn').onchange = e => { if (e.target.files[0]) importTimings(e.target.files[0]); e.target.value = ''; };
  $('reload').onclick = () => loadData(true);
  setInterval(() => { if (document.hidden) return; draw(); tickEditor(); if (!$('pane-lights').hidden && document.activeElement !== $('lq')) {
    const now = Date.now(); $('lightList').querySelectorAll('.li').forEach(d => { const ph = phase(S.timings[d.dataset.i], now); if (ph) { const dot = d.querySelector('.dot'); dot.className = 'dot on'; dot.style.background = `var(${ph.s === 'G' ? '--g' : ph.s === 'Y' ? '--y' : '--r'})`; d.querySelector('.tm').textContent = Math.ceil(ph.left) + ' с'; } }); } }, 500);
}
(function init() {
  bind(); resize(); fitAll(); useFallback(); updateRouteUI(); renderLightList();
  loadData(false);
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
