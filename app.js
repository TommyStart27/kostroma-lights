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
  timings: {}, ek: '',
  view: { cx: 0, cy: 0, s: 0.07 },
  me: null, follow: false,
  route: null, pickMode: null, A: null, B: null,
  mode: 'car', opt: 'fast', depart: 0,
  selected: null,
};
try { S.mine = JSON.parse(localStorage.getItem(LS_TIMINGS) || '{}') || {}; } catch (e) { S.mine = {}; }
try { const sh = JSON.parse(localStorage.getItem('kostroma_shared_v1') || '{}'); S.shared = sh.t || {}; S.sharedAt = sh.at || 0; } catch (e) { S.shared = {}; }
try { S.tmode = localStorage.getItem('kostroma_tmode') === 'shared' ? 'shared' : 'mine'; } catch (e) { S.tmode = 'mine'; }
S.timings = makeTimingsProxy();   // чтение: «Мои» или «Общие»; запись — всегда в «Мои» (и отправка в общую базу)

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
    if (cached && cached.v === DATA_VERSION) { useData(cached); loadBuildings(false); return; }
  }
  progress('Загрузка карты Костромы…');
  let d = await loadFromOverpass(progress);
  if (!d) d = await loadFromOsmApi(progress);
  $('loading').hidden = true;
  if (!d) { toast('Не удалось загрузить карту из интернета — показаны только основные улицы', 5000); useFallback(); return; }
  await kvSet('osm', d);
  useData(d);
  loadBuildings(true);
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
  const cl = clusterNodes(X, Y);
  // сетка для поиска ближайшего узла
  const G = 100, grid = new Map();
  for (let i = 0; i < X.length; i++) { if (!adj[i].length) continue; const k = Math.floor(X[i] / G) + ',' + Math.floor(Y[i] / G); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); }
  return { X, Y, adj, cl, grid, G };
}
// узлы дорог внутри светофорных объектов (перекрёсток — 40 м, переход — 22 м)
function clusterNodes(X, Y) {
  const cl = new Int32Array(X.length).fill(-1), LL = liveLights();
  for (let i = 0; i < X.length; i++) {
    for (const L of LL) { const r = L.kind === 'X' ? 40 : 22; if (Math.abs(L.x - X[i]) < r && Math.abs(L.y - Y[i]) < r && Math.hypot(L.x - X[i], L.y - Y[i]) < r) { cl[i] = L.id; break; } }
  }
  return cl;
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
// ожидание у светофора L в момент tMs: bin — направление въезда, mov — манёвр (L/S/R), street — улица въезда
function waitAt(L, tMs, bin, mov, street) {
  const rec = recFor(L, bin, mov, street);
  const ph = rec && phase(rec.T, tMs);
  if (!ph) return { wait: DEFAULT_WAIT[L.kind] || 12, known: false, s: null };
  const T = rec.T;
  if (!rec.inv) {
    if (ph.s === 'G') return { wait: 0, known: true, s: 'G' };
    if (ph.s === 'Y') return { wait: ph.left + T.r, known: true, s: 'Y' };
    return { wait: ph.left, known: true, s: 'R' };
  }
  // поперечное направление: зелёный, пока у записанного красный
  if (ph.s === 'R') return { wait: 0, known: true, s: 'G' };
  if (ph.s === 'Y') return { wait: ph.left, known: true, s: 'R' };
  return { wait: ph.left + (T.y || 0), known: true, s: 'R' };
}
const turnOf = (bin, bout) => { const d = angD(bin, bout); return Math.abs(d) <= 35 ? 'S' : d > 0 && d < 150 ? 'R' : 'L'; };

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
      const cuL = g.cl[u];
      if (cuL >= 0 && g.cl[v] !== cuL) {
        let p = u, q = prev[u]; while (q >= 0 && g.cl[q] === cuL) { p = q; q = prev[q]; }
        if (q >= 0) { const bin = bearXY(g.X[q], g.Y[q], g.X[p], g.Y[p]), bout = bearXY(g.X[u], g.Y[u], g.X[v], g.Y[v]);
          dt += waitAt(S.lights[cuL], departMs + tim[u] * 1000, bin, turnOf(bin, bout), prevName[p]).wait; }
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
  const lights = []; let tt = 0, ent = -1, entName = '';
  for (let i = 1; i < path.length; i++) {
    const u = path[i - 1], v = path[i];
    const e = g.adj[u].find(x => x[0] === v);
    const vel = mode === 'car' ? (e[2] || 30) / 3.6 : walkV;
    const cuL = g.cl[u];
    if (cuL >= 0 && g.cl[v] !== cuL && ent >= 1) {
      const q = path[ent - 1], p = path[ent], bin = bearXY(g.X[q], g.Y[q], g.X[p], g.Y[p]), bout = bearXY(g.X[u], g.Y[u], g.X[v], g.Y[v]);
      const mv = turnOf(bin, bout), w = waitAt(S.lights[cuL], departMs + tt * 1000, bin, mv, entName), a = nearApproach(S.lights[cuL], bin, 40);
      lights.push({ id: cuL, eta: tt, ...w, street: entName, key: a ? `${cuL}|${a.k}` : String(cuL), mv });
      tt += w.wait;
    }
    tt += e[1] / vel;
    if (g.cl[v] >= 0 && g.cl[v] !== cuL) { ent = i; entName = e[4]; }
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
// экранные позиции треугольников-подъездов вокруг светофора
function aprScreen(L, x, y, r) {
  return approaches(L).map(a => { const rad = a.b * Math.PI / 180, ux = Math.sin(rad), uy = -Math.cos(rad), dd = r + 12; return { a, ux, uy, cx0: x - ux * dd, cy0: y - uy * dd }; });
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
  drawBuildings(s);
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
  for (const L of liveLights()) {
    const x = sx(L.x), y = sy(L.y); if (x < -20 || y < -20 || x > W + 20 || y > H + 20) continue;
    const ph = phase(anyRec(L), now);
    const r = (L.kind === 'X' ? 6.5 : 4.5) * Math.max(0.85, Math.min(1.7, k));
    if (s > 0.45 && S.graph) for (const q of aprScreen(L, x, y, r)) {   // подъезды: треугольник со стороны, откуда едут машины, цвет — их сигнал
      const { a, cx0, cy0, ux, uy } = q, ep = effPhase(recFor(L, a.b, '', a.name), now), sel = L.id === S.selected && S.ek && S.ek.split('|')[1] === a.k, z = sel ? 8 : 6;
      ctx.beginPath(); ctx.moveTo(cx0 + ux * z, cy0 + uy * z); ctx.lineTo(cx0 - ux * z * .7 - uy * z * .8, cy0 - uy * z * .7 + ux * z * .8); ctx.lineTo(cx0 - ux * z * .7 + uy * z * .8, cy0 - uy * z * .7 - ux * z * .8); ctx.closePath();
      ctx.fillStyle = css(ep ? (ep.s === 'G' ? '--g' : ep.s === 'Y' ? '--y' : '--r') : '--none'); ctx.fill();
      if (sel) { ctx.lineWidth = 1.5; ctx.strokeStyle = css('--accent'); ctx.stroke(); }
    }
    if (L.id === S.selected) { ctx.beginPath(); ctx.arc(x, y, r + 6, 0, 7); ctx.fillStyle = css('--accent'); ctx.globalAlpha = .25; ctx.fill(); ctx.globalAlpha = 1; }
    ctx.beginPath(); ctx.arc(x, y, r, 0, 7);
    if (ph) { ctx.fillStyle = css(ph.s === 'G' ? '--g' : ph.s === 'Y' ? '--y' : '--r'); ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = css('--panel'); ctx.stroke(); }
    else { ctx.fillStyle = css('--panel'); ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = css(L.mine ? '--accent' : '--none'); ctx.stroke(); }
    if (showNum) {
      ctx.font = '600 11px system-ui,sans-serif'; ctx.textBaseline = 'middle';
      ctx.lineWidth = 3; ctx.strokeStyle = css('--land'); ctx.strokeText(String(L.id + 1), x + r + 4, y); ctx.fillStyle = css('--ink'); ctx.fillText(String(L.id + 1), x + r + 4, y);
      if (ph && s > 0.4) { ctx.font = '11px system-ui,sans-serif'; ctx.strokeText(Math.ceil(ph.left) + ' с', x + r + 4, y + 13); ctx.fillStyle = css('--muted'); ctx.fillText(Math.ceil(ph.left) + ' с', x + r + 4, y + 13); }
    }
  }
  if (S.addAt) { const x = sx(S.addAt[0]), y = sy(S.addAt[1]); ctx.beginPath(); ctx.arc(x, y, 9, 0, 7); ctx.setLineDash([4, 3]); ctx.lineWidth = 2.5; ctx.strokeStyle = css('--accent'); ctx.stroke(); ctx.setLineDash([]); }
  drawPin();
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
const ptrs = new Map(); let drag = null, moved = false, pinch = null, lpTimer = 0, lpFired = false;
cv.addEventListener('pointerdown', e => {
  cv.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (ptrs.size === 1) { drag = { x: e.clientX, y: e.clientY, cx: S.view.cx, cy: S.view.cy }; moved = false; lpFired = false;
    clearTimeout(lpTimer); const r = cv.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
    lpTimer = setTimeout(() => { if (drag && !moved && ptrs.size === 1) { lpFired = true; longPress(px, py); } }, 550); }
  else if (ptrs.size === 2) { clearTimeout(lpTimer); const [a, b] = [...ptrs.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), s: S.view.s, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 }; drag = null; moved = true; }
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
  if (drag) { const dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.abs(dx) + Math.abs(dy) > 6) { moved = true; S.follow = false; clearTimeout(lpTimer); }
    if (moved) { S.view.cx = drag.cx - dx / S.view.s; S.view.cy = drag.cy + dy / S.view.s; draw(); } }
});
function endPtr(e) {
  if (!ptrs.has(e.pointerId)) return;
  ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch = null;
  clearTimeout(lpTimer);
  if (drag && !moved && !lpFired && ptrs.size === 0) { const r = cv.getBoundingClientRect(); onTap(e.clientX - r.left, e.clientY - r.top); }
  if (ptrs.size === 0) drag = null;
}
cv.addEventListener('pointerup', endPtr); cv.addEventListener('pointercancel', endPtr);
cv.addEventListener('contextmenu', e => { e.preventDefault(); if (!lpFired) { const r = cv.getBoundingClientRect(); lpFired = true; longPress(e.clientX - r.left, e.clientY - r.top); } });
cv.addEventListener('wheel', e => {
  e.preventDefault(); const r = cv.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top, X = wx(mx), Y = wy(my);
  S.view.s = Math.max(0.02, Math.min(4, S.view.s * Math.exp(-e.deltaY * 0.0015)));
  S.view.cx = X - (mx - W / 2) / S.view.s; S.view.cy = Y + (my - H / 2) / S.view.s; draw();
}, { passive: false });
function zoomBy(f) { S.view.s = Math.max(0.02, Math.min(4, S.view.s * f)); draw(); }
function onTap(px, py) {
  if (S.pickMode) {
    const p = [wx(px), wy(py)];
    S[S.pickMode] = p; S[S.pickMode + 'name'] = null; S.pickMode = null; $('mapwrap').classList.remove('picking');
    updateRouteUI(); computeRoute(); return;
  }
  if (!$('ask').hidden) { hideAsk(); return; }
  if (S.view.s > 0.45 && S.graph) {   // нажали на треугольник-подъезд — сразу этот светофор и это направление
    const k = Math.max(0.85, Math.min(1.7, Math.max(0.35, Math.min(3, S.view.s / 0.12)))); let hit = null, hd = 13;
    for (const L of liveLights()) { const x = sx(L.x), y = sy(L.y); if (Math.abs(x - px) > 60 || Math.abs(y - py) > 60) continue;
      for (const q of aprScreen(L, x, y, (L.kind === 'X' ? 6.5 : 4.5) * k)) { const d = Math.hypot(q.cx0 - px, q.cy0 - py); if (d < hd) { hd = d; hit = [L.id, `${L.id}|${q.a.k}`]; } } }
    if (hit) { selectLight(hit[0], false, hit[1]); showTab('lights'); return; }
  }
  let best = null, bd = 1e9;
  for (const L of liveLights()) { const d = Math.hypot(sx(L.x) - px, sy(L.y) - py); if (d < bd) { bd = d; best = L; } }
  if (best && bd < 20) { selectLight(best.id, false); showTab('lights'); return; }
  if (!tapBuilding(wx(px), wy(py)) && S.pin) hidePin();
}

// ======================= ГЕОЛОКАЦИЯ =================================
let geoWatch = null;
function locate(quiet) {
  if (!('geolocation' in navigator)) { if (!quiet) toast('Геолокация недоступна в этом браузере'); return; }
  if (S.me) { S.follow = true; S.view.cx = S.me.x; S.view.cy = S.me.y; if (S.view.s < 0.4) S.view.s = 0.6; draw(); }
  if (geoWatch != null) return;
  if (!quiet) toast('Определяю местоположение…');
  geoWatch = navigator.geolocation.watchPosition(p => {
    const [x, y] = toXY(p.coords.latitude, p.coords.longitude);
    const first = !S.me; S.me = { x, y, acc: p.coords.accuracy, sp: p.coords.speed };
    try { trackPush(x, y, p.coords.speed, p.timestamp || Date.now()); } catch (e) {}
    if (first || S.follow) { S.follow = true; S.view.cx = x; S.view.cy = y; if (first && S.view.s < 0.4) S.view.s = 0.6; }
    if (first && (Math.abs(x) > 20000 || Math.abs(y) > 20000)) toast('Вы далеко от Костромы — точка за пределами карты', 4000);
    if (first && p.coords.accuracy > 300) toast('Точность ' + Math.round(p.coords.accuracy) + ' м — на ПК местоположение примерное', 4000);
    draw(); updateSpeed();
    if (S.wantMeA && !S.A) { S.wantMeA = false; S.A = [x, y]; S.meRef = S.A; S.Aname = null; updateRouteUI(); computeRoute(); }
  }, err => {
    // запрет доступа — останавливаем слежение; временные сбои (нет спутников, тайм-аут) не прерывают его
    if (err.code === 1) { toast('Доступ к геолокации запрещён — разрешите его в настройках', 4000); navigator.geolocation.clearWatch(geoWatch); geoWatch = null; }
    else if (!S.me && !quiet) toast('Ищу спутники… местоположение появится, как только будет сигнал');
  },
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
  const nAddr = addrSearch(q, out);
  const num = q.replace(/^#/, '');
  if (/^\d+$/.test(num) && S.lights[+num - 1] && !S.lights[+num - 1].off) out.push({ t: 'Светофор #' + num, sub: S.lights[+num - 1].name, go: () => { selectLight(+num - 1, true); showTab('lights'); } });
  for (const st of streetIndex) if (st.name.toLowerCase().includes(q)) { out.push({ t: st.name, sub: 'улица', go: () => { S.view.cx = (st.x0 + st.x1) / 2; S.view.cy = (st.y0 + st.y1) / 2; S.view.s = Math.min(1.2, Math.max(0.12, Math.min(W / (st.x1 - st.x0 + 300), H / (st.y1 - st.y0 + 300)))); S.follow = false; draw(); } }); if (out.length > 12) break; }
  for (const L of liveLights()) if (L.name.toLowerCase().includes(q) && out.length < 20) out.push({ t: 'Светофор #' + (L.id + 1), sub: L.name, go: () => { selectLight(L.id, true); showTab('lights'); } });
  if (!out.length) out.push({ t: 'Не найдено в скачанной карте', sub: S.bld ? 'Попробуйте онлайн-поиск ниже' : 'Дома ещё не загружены — попробуйте онлайн-поиск', go: null });
  out.push({ t: '🔎 Искать онлайн', sub: '«' + q + '» — адреса, организации, остановки', go: () => onlineSearch(q), keep: true });
  for (const o of out) { const d = document.createElement('div'); d.className = 'res'; d.innerHTML = '<b></b><span></span>'; d.querySelector('b').textContent = o.t; d.querySelector('span').textContent = o.sub;
    if (o.go) d.onclick = () => { o.go(); if (!o.keep) { box.hidden = true; $('q').blur(); } }; box.appendChild(d); }
  S.searchFirst = nAddr ? out[0] : null;
  box.hidden = false;
}

// ======================= ДОМА И АДРЕСА ==============================
// Здания и номера домов из OpenStreetMap (кэш на устройстве) + онлайн-поиск через Nominatim
const BLD_VERSION = 2;
// Дома грузятся частями (сетка 4×6 квадратов), чтобы серверы OSM не обрывали большой запрос.
// Сначала центр города, два запроса параллельно к разным серверам. Прогресс сохраняется:
// если приложение закрыли, при следующем запуске загрузка продолжится с того же места.
const BLD_ROWS = 4, BLD_COLS = 6;
function bldPill(t) { const L = $('loading'); if (t) { if (L.hidden || L.dataset.b) { L.dataset.b = '1'; L.hidden = false; $('loadingText').textContent = t; } } else if (L.dataset.b) { L.hidden = true; delete L.dataset.b; } }
async function loadBuildings(force) {
  let d = force ? null : await kvGet('bld');
  if (!d || d.v !== BLD_VERSION) d = { v: BLD_VERSION, p: [], a: [], tiles: [], done: false };
  const N = BLD_ROWS * BLD_COLS;
  if (!d.tiles) { d.tiles = []; for (let i = 0; i < (d.next || 0); i++) d.tiles[i] = 1; }
  if (d.p.length) useBuildings(d);
  if (d.done) return;
  const [la0, lo0, la1, lo1] = BBOX;
  const box = i => { const r = Math.floor(i / BLD_COLS), c = i % BLD_COLS; return [la0 + (la1 - la0) * r / BLD_ROWS, lo0 + (lo1 - lo0) * c / BLD_COLS, la0 + (la1 - la0) * (r + 1) / BLD_ROWS, lo0 + (lo1 - lo0) * (c + 1) / BLD_COLS].map(v => +v.toFixed(5)); };
  const queue = [...Array(N).keys()].filter(i => !d.tiles[i]).sort((i, j) => { const f = k => { const b = box(k); return ((b[0] + b[2]) / 2 - LAT0) ** 2 + (((b[1] + b[3]) / 2 - LON0) * 0.53) ** 2; }; return f(i) - f(j); });
  const pct = () => Math.round(d.tiles.filter(Boolean).length / N * 100);
  const show = () => { const t = `Дома: загрузка ${pct()}% (${d.p.length} зданий)…`; $('bldInfo').textContent = t; bldPill(t); };
  show();
  let fails = 0, saving = Promise.resolve();
  async function worker(srv) {
    while (queue.length) {
      if (fails > OVERPASS.length * 3) return;
      const i = queue.shift(), bb = box(i), b = bb.join(',');
      const q = `[out:json][timeout:120];(way["building"](${b});node["addr:housenumber"](${b}););out tags geom qt;`;
      let j = null;
      try {
        const resp = await fetchTimeout(OVERPASS[srv], { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, 150000);
        if (resp.ok) j = await resp.json();
      } catch (e) { }
      if (!j || !j.elements) { queue.push(i); fails++; srv = (srv + 1) % OVERPASS.length; await new Promise(r => setTimeout(r, 2000)); continue; }
      fails = 0;
      for (const e of j.elements) {
        const t = e.tags || {};
        const st = t['addr:street'] || t['addr:place'] || '', hn = t['addr:housenumber'] || '';
        if (e.type === 'way' && e.geometry && e.geometry.length > 2) {
          const g0 = e.geometry[0];   // здание на границе квадратов берём только в том квадрате, где его первая точка
          if (g0.lat < bb[0] || g0.lat >= bb[2] || g0.lon < bb[1] || g0.lon >= bb[3]) continue;
          const flat = [];
          for (const g of e.geometry) { const xy = toXY(g.lat, g.lon); flat.push(Math.round(xy[0]), Math.round(xy[1])); }
          d.p.push(flat);
          if (hn) { let cx = 0, cy = 0; const n = flat.length / 2; for (let k = 0; k < flat.length; k += 2) { cx += flat[k]; cy += flat[k + 1]; } d.a.push([Math.round(cx / n), Math.round(cy / n), st, hn, t.name || '', d.p.length - 1]); }
        } else if (e.type === 'node' && hn) {
          if (e.lat < bb[0] || e.lat >= bb[2] || e.lon < bb[1] || e.lon >= bb[3]) continue;
          const xy = toXY(e.lat, e.lon); d.a.push([Math.round(xy[0]), Math.round(xy[1]), st, hn, t.name || '', -1]);
        }
      }
      d.tiles[i] = 1; d.done = d.tiles.filter(Boolean).length >= N; d.at = Date.now();
      saving = saving.then(() => kvSet('bld', d));
      useBuildings(d); if (!d.done) show();
    }
  }
  await Promise.all([worker(0), worker(1 % OVERPASS.length)]);
  await saving;
  bldPill(null);
  if (!d.done) $('bldInfo').textContent = `Дома: загружено ${pct()}%, серверы OSM сейчас не отвечают — продолжу при следующем запуске. Онлайн-поиск адресов работает.`;
}
function useBuildings(d) {
  const bb = d.p.map(f => { let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9; for (let i = 0; i < f.length; i += 2) { if (f[i] < x0) x0 = f[i]; if (f[i] > x1) x1 = f[i]; if (f[i + 1] < y0) y0 = f[i + 1]; if (f[i + 1] > y1) y1 = f[i + 1]; } return [x0, y0, x1, y1]; });
  const hnOf = new Array(d.p.length).fill(null);
  for (const a of d.a) if (a[5] >= 0) hnOf[a[5]] = a;
  S.bld = { p: d.p, bb, a: d.a, hnOf };
  if (d.done) $('bldInfo').textContent = `Дома: ${d.p.length} зданий, ${d.a.length} адресов.`;
  draw();
}
function drawBuildings(s) {
  const B = S.bld; if (!B || s < 0.22) return;
  const x0 = wx(-20), x1 = wx(W + 20), y1 = wy(-20), y0 = wy(H + 20);
  ctx.beginPath();
  const vis = [];
  for (let i = 0; i < B.p.length; i++) {
    const b = B.bb[i]; if (b[2] < x0 || b[0] > x1 || b[3] < y0 || b[1] > y1) continue;
    const f = B.p[i]; ctx.moveTo(sx(f[0]), sy(f[1]));
    for (let j = 2; j < f.length; j += 2) ctx.lineTo(sx(f[j]), sy(f[j + 1]));
    ctx.closePath(); vis.push(i);
  }
  ctx.fillStyle = css('--bld'); ctx.fill();
  if (s > 0.6) { ctx.strokeStyle = css('--bldEdge'); ctx.lineWidth = 0.8; ctx.stroke(); }
  if (s > 1.3 && vis.length < 700) {
    ctx.font = '10px system-ui,sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = css('--muted');
    for (const i of vis) { const a = B.hnOf[i]; if (a) ctx.fillText(a[3], sx(a[0]), sy(a[1])); }
    ctx.textAlign = 'start';
  }
}
const normSt = s => String(s).toLowerCase().replace(/ё/g, 'е')
  .replace(/\b(улица|ул|проспект|пр-т|пр|переулок|пер|шоссе|ш|площадь|пл|бульвар|б-р|набережная|наб|проезд|пр-д|тупик|микрорайон|мкр)\b\.?/g, ' ')
  .replace(/[«»"().,]/g, ' ').replace(/\s+/g, ' ').trim();
const normHn = s => String(s).toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, '').replace(/корпус|корп\.?|к\.?/g, 'к').replace(/строение|стр\.?/g, 'с');
function addrLabel(a) { return (a[2] ? a[2] + ', ' : '') + a[3] + (a[4] ? ' · ' + a[4] : ''); }
function addrSearch(q, out) {
  const B = S.bld; if (!B) return 0;
  const m = q.match(/^(.*?)[\s,]+(\d+\s*[а-яa-z]?(?:\s*(?:к|корп|корпус|стр|с)\.?\s*\d+)?(?:\/\d+[а-я]?)?)$/i);
  let n = 0;
  if (m) {
    const st = normSt(m[1]), hn = normHn(m[2]);
    if (!st) return 0;
    const res = [];
    for (const a of B.a) {
      if (!a[2] || !normSt(a[2]).includes(st)) continue;
      const h = normHn(a[3]);
      if (h === hn) res.push([0, a]); else if (h.startsWith(hn)) res.push([1, a]);
    }
    res.sort((x, y) => x[0] - y[0] || x[1][3].localeCompare(y[1][3], 'ru', { numeric: true }));
    for (const [, a] of res.slice(0, 8)) { out.push({ t: addrLabel(a), sub: 'дом', go: () => showPin(a[0], a[1], addrLabel(a)) }); n++; }
  } else if (q.length >= 3) {
    const qq = q.toLowerCase();
    for (const a of B.a) if (a[4] && a[4].toLowerCase().includes(qq)) { out.push({ t: a[4], sub: (a[2] ? a[2] + ', ' : '') + a[3], go: () => showPin(a[0], a[1], addrLabel(a)) }); if (++n >= 6) break; }
  }
  return n;
}
let lastOnline = 0;
async function onlineSearch(q) {
  const box = $('results'); box.hidden = false;
  if (!navigator.onLine) { box.innerHTML = '<div class="res"><b>Нет интернета</b><span>Онлайн-поиск недоступен, работает поиск по скачанным домам</span></div>'; return; }
  const wait = 1100 - (Date.now() - lastOnline); if (wait > 0) await new Promise(r => setTimeout(r, wait));   // правило Nominatim: не чаще 1 запроса в секунду
  lastOnline = Date.now();
  box.innerHTML = '<div class="res"><b>Ищу онлайн…</b></div>';
  try {
    const qs = /кострома/i.test(q) ? q : q + ', Кострома';
    const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8&accept-language=ru&countrycodes=ru&bounded=1&viewbox=40.78,57.85,41.13,57.69&q=' + encodeURIComponent(qs);
    const r = await fetchTimeout(url, { headers: { Accept: 'application/json' } }, 15000);
    const j = await r.json();
    box.innerHTML = '';
    if (!j.length) { box.innerHTML = '<div class="res"><b>Онлайн ничего не найдено</b><span>Попробуйте иначе: «Советская 97», «ТЦ Солнечный»</span></div>'; return; }
    for (const it of j) {
      const parts = it.display_name.split(', ');
      const title = it.name || parts.slice(0, 2).join(', ');
      const sub = parts.slice(it.name ? 1 : 2, 4).join(', ');
      const [x, y] = toXY(+it.lat, +it.lon);
      const d = document.createElement('div'); d.className = 'res'; d.innerHTML = '<b></b><span></span>';
      d.querySelector('b').textContent = title; d.querySelector('span').textContent = sub + ' · онлайн';
      d.onclick = () => { showPin(x, y, title); box.hidden = true; $('q').blur(); };
      box.appendChild(d);
    }
  } catch (e) { box.innerHTML = '<div class="res"><b>Онлайн-поиск не ответил</b><span>Проверьте интернет и попробуйте ещё раз</span></div>'; }
}
function showPin(x, y, label) {
  S.pin = { x, y, label };
  S.view.cx = x; S.view.cy = y; if (S.view.s < 0.6) S.view.s = 0.9; S.follow = false;
  $('pinName').textContent = label; $('pin').hidden = false;
  if (window.innerWidth < 760) document.body.classList.remove('sheet-open');
  draw();
}
function hidePin() { S.pin = null; $('pin').hidden = true; draw(); }
function pinTo(which) {
  const P = S.pin; if (!P) return;
  if (which === 'B') {
    S.B = [P.x, P.y]; S.Bname = P.label;
    if (!S.A && S.me) { S.A = [S.me.x, S.me.y]; S.meRef = S.A; S.Aname = null; }
    if (!S.A) { S.wantMeA = true; locate(); toast('Точка B задана. Определяю ваше местоположение для точки A…'); }
  } else { S.A = [P.x, P.y]; S.Aname = P.label; }
  hidePin(); updateRouteUI(); computeRoute(); showTab('route');
}
function drawPin() {
  const P = S.pin; if (!P) return;
  const x = sx(P.x), y = sy(P.y);
  ctx.beginPath(); ctx.arc(x, y - 16, 9, 0, 7); ctx.fillStyle = css('--accent'); ctx.fill();
  ctx.beginPath(); ctx.moveTo(x - 6, y - 10); ctx.lineTo(x, y); ctx.lineTo(x + 6, y - 10); ctx.fill();
  ctx.beginPath(); ctx.arc(x, y - 16, 3.5, 0, 7); ctx.fillStyle = '#fff'; ctx.fill();
}
function tapBuilding(X, Y) {
  const B = S.bld; if (!B || S.view.s < 0.3) return false;
  for (let i = 0; i < B.p.length; i++) {
    const b = B.bb[i]; if (X < b[0] || X > b[2] || Y < b[1] || Y > b[3]) continue;
    const f = B.p[i]; let inside = false;
    for (let j = 0, k = f.length - 2; j < f.length; k = j, j += 2) {
      const xi = f[j], yi = f[j + 1], xk = f[k], yk = f[k + 1];
      if ((yi > Y) !== (yk > Y) && X < (xk - xi) * (Y - yi) / (yk - yi) + xi) inside = !inside;
    }
    if (!inside) continue;
    let a = B.hnOf[i];
    if (!a) { let bd = 900; for (const c of B.a) { const d = (c[0] - X) ** 2 + (c[1] - Y) ** 2; if (d < bd) { bd = d; a = c; } } }
    showPin((b[0] + b[2]) / 2, (b[1] + b[3]) / 2, a ? addrLabel(a) : 'Здание без адреса');
    return true;
  }
  return false;
}

// ======================= НАПРАВЛЕНИЯ ПОДЪЕЗДА =======================
// У перекрёстка несколько подъездов (обычно 4), у каждого свой сигнал, а иногда ещё и стрелки.
// Ключ тайминга: "id" — весь перекрёсток (как раньше), "id|b180" — подъезд, "id|b180|L" — стрелка налево.
const ARW = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'];
const FROM = ['с юга', 'с юго-запада', 'с запада', 'с северо-запада', 'с севера', 'с северо-востока', 'с востока', 'с юго-востока'];
const MOV = { '': 'Все сигналы', L: '← налево', S: '↑ прямо', R: '→ направо' };
const angD = (a, b) => { let d = (b - a) % 360; if (d > 180) d -= 360; if (d < -180) d += 360; return d; };
const bearXY = (x0, y0, x1, y1) => (Math.atan2(x1 - x0, y1 - y0) * 180 / Math.PI + 360) % 360;
function approaches(L) {
  const g = S.graph; if (!g || !L) return [];
  if (L._ag === g && L._acl === g.cl) return L._ap;
  const raw = [], k0 = Math.floor(L.x / g.G), k1 = Math.floor(L.y / g.G);
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const v of g.grid.get((k0 + i) + ',' + (k1 + j)) || []) {
    if (g.cl[v] !== L.id) continue;
    for (const e of g.adj[v]) {
      const u = e[0]; if (g.cl[u] === L.id) continue;
      const back = g.adj[u].find(x => x[0] === v); if (!back || back[2] <= 0) continue;   // по этому отрезку можно въехать
      raw.push([bearXY(g.X[u], g.Y[u], g.X[v], g.Y[v]), back[4] || '']);
    }
  }
  raw.sort((a, b) => a[0] - b[0]);
  const grp = [];
  for (const [b, nm] of raw) {
    let G = grp.find(q => Math.abs(angD(q.b, b)) < 35);
    if (!G) grp.push(G = { b, n: 0, names: {} });
    G.b = (G.b + angD(G.b, b) / (G.n + 1) + 360) % 360; G.n++; if (nm) G.names[nm] = (G.names[nm] || 0) + 1;
  }
  L._ap = grp.map(q => {
    const name = Object.entries(q.names).sort((a, b) => b[1] - a[1]).map(e => e[0])[0] || '';
    const k = 'b' + (Math.round(q.b / 5) * 5) % 360, o = Math.round(q.b / 45) % 8;
    return { b: q.b, k, name, arrow: ARW[o], from: FROM[o] };
  }).sort((a, b) => a.b - b.b);
  L._ag = g; L._acl = g.cl;
  return L._ap;
}
function nearApproach(L, b, tol) { let best = null, bd = tol; for (const a of approaches(L)) { const d = Math.abs(angD(a.b, b)); if (d < bd) { bd = d; best = a; } } return best; }
const invS = s => s === 'R' ? 'G' : 'R';
// какой тайминг действует для въезда с направлением bin и манёвра mov; inv — сигнал противоположный записанному
function recFor(L, bin, mov, street) {
  const T = S.timings, id = L.id;
  if (bin != null) {
    const a = nearApproach(L, bin, 40);
    if (a) { if (mov && ready(T[`${id}|${a.k}|${mov}`])) return { T: T[`${id}|${a.k}|${mov}`] }; if (ready(T[`${id}|${a.k}`])) return { T: T[`${id}|${a.k}`] }; }
    if (a) return null;   // у этого подъезда своего готового замера нет — не гадаем по соседним подъездам
  }
  const t0 = ready(T[id]); if (!t0) return null;
  const main = t0.main || L.streets[0] || '';
  return { T: t0, inv: L.kind === 'X' && !!street && !!main && street !== main };
}
// есть ли у светофора хоть какой-то тайминг — для цвета кружка на карте и в списке
// «готов» — полный замер; недособранный (оценка, чужой цикл, зеркало без подтверждения) на карте и в маршруте не используется
const ready = T => T && T.g > 0 && !T.part ? T : null;
function anyRec(L) {
  if (ready(S.timings[L.id])) return S.timings[L.id];
  const p = L.id + '|'; for (const k in S.timings) if (k.startsWith(p) && ready(S.timings[k])) return S.timings[k];
  return null;
}
function effPhase(rec, now) { if (!rec) return null; const ph = phase(rec.T, now); if (!ph) return null; return rec.inv ? { ...ph, s: invS(ph.s) } : ph; }
function keyLabel(k) {
  const [id, bk, mv] = String(k).split('|'); if (!bk) return 'весь перекрёсток';
  const L = S.lights[+id], a = approaches(L).find(q => q.k === bk);
  const o = a ? a : { arrow: ARW[Math.round(+bk.slice(1) / 45) % 8], from: FROM[Math.round(+bk.slice(1) / 45) % 8], name: '' };
  return `${o.arrow} ${o.from}${o.name ? ' (' + o.name + ')' : ''}${mv ? ' · ' + MOV[mv] : ''}`;
}
function renderApr() {
  const L = S.lights[S.selected], box = $('eApr'), mb = $('eMov'); if (!L || !box) return;
  const ap = approaches(L), [, bk, mv] = S.ek.split('|');
  $('eSrc').textContent = srcLabel(S.ek);
  box.innerHTML = ''; mb.innerHTML = '';
  const chip = (txt, on, fn, has, title) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'chip' + (on ? ' on' : '') + (has ? ' has' : ''); b.textContent = txt; if (title) b.title = title; b.onclick = fn; return b; };
  box.appendChild(chip('Весь перекрёсток', !bk, () => setEk(String(L.id)), !!S.timings[L.id], 'Один сигнал на всё — если не знаете направление'));
  for (const a of ap) box.appendChild(chip(`${a.arrow} ${a.from}${a.name ? ' · ' + a.name : ''}`, bk === a.k, () => setEk(`${L.id}|${a.k}`), Object.keys(S.timings).some(k => k === `${L.id}|${a.k}` || k.startsWith(`${L.id}|${a.k}|`)), 'Едете ' + a.arrow + ', подъезжаете ' + a.from));
  $('eAprHint').hidden = !ap.length;
  mb.hidden = !bk;
  if (bk) for (const m of ['', 'L', 'S', 'R']) mb.appendChild(chip(MOV[m], (mv || '') === m, () => setEk(`${L.id}|${bk}` + (m ? '|' + m : '')), !!S.timings[`${L.id}|${bk}` + (m ? '|' + m : '')], m ? 'Отдельная секция-стрелка со своим сигналом' : 'Основной сигнал этого подъезда'));
}
function setEk(k) { S.ek = k; loadFields(); }
function loadFields() {
  const L = S.lights[S.selected], T = S.mine[S.ek] || S.timings[S.ek] || {};   // редактор — про ваши замеры
  $('fG').value = T.g != null ? r1(T.g) : ''; $('fY').value = T.y != null ? r1(T.y) : ''; $('fR').value = T.r != null ? r1(T.r) : ''; $('fA').value = T.a != null ? fmtT(T.a) : '';
  const sel = $('fMain'); sel.innerHTML = '';
  const opts = L.streets.length ? L.streets : ['—'];
  for (const s of opts) { const o = document.createElement('option'); o.value = s; o.textContent = s; sel.appendChild(o); }
  sel.value = T.main || opts[0]; $('mainRow').hidden = L.kind !== 'X' || L.streets.length < 2 || S.ek.includes('|');
  renderApr(); tickEditor(); draw();
}
// ---- что впереди: по пути за последние 25–150 м определяем, к какому светофору и с какой стороны подъехали
function trackPush(x, y, sp, t) {
  const tr = S.trk || (S.trk = []);
  const last = tr[tr.length - 1];
  if (last && t - last.t < 400) return;
  if (sp == null || !(sp >= 0)) {   // iPhone отдаёт -1, когда скорость неизвестна — считаем по пути за последние 3 с
    let ref = null; for (let i = tr.length - 1; i >= 0; i--) if (t - tr[i].t >= 3000) { ref = tr[i]; break; }
    ref = ref || tr[0];
    sp = ref ? Math.hypot(x - ref.x, y - ref.y) / Math.max(1, (t - ref.t) / 1000) : 0;
  }
  tr.push({ x, y, t, sp });
  while (tr.length && t - tr[0].t > 120000) tr.shift();
  checkStop();
  try { passCheck(tr[tr.length - 1]); } catch (e) {}
  if (window.gwAuto && gwAuto.on) gwAuto.onTrack(tr[tr.length - 1]);
}
function headingNow() {
  const tr = S.trk; if (!tr || tr.length < 2) return null;
  const c = tr[tr.length - 1];
  for (let i = tr.length - 2; i >= 0; i--) { const d = Math.hypot(tr[i].x - c.x, tr[i].y - c.y); if (d >= 25) return d > 150 ? null : bearXY(tr[i].x, tr[i].y, c.x, c.y); }
  return null;
}
function detectAhead() {
  if (!S.me) return null;
  const hd = headingNow(), c = S.me;
  let best = null, bd = 80;
  for (const L of liveLights()) {
    const d = Math.hypot(L.x - c.x, L.y - c.y); if (d >= bd) continue;
    if (hd != null && d > 14 && Math.abs(angD(hd, bearXY(c.x, c.y, L.x, L.y))) > 50) continue;   // светофор сбоку или позади
    if (hd == null && d > 35) continue;
    bd = d; best = L;
  }
  if (!best) return null;
  const a = hd != null ? nearApproach(best, hd, 50) : null;
  return { L: best, key: a ? `${best.id}|${a.k}` : String(best.id), a, d: bd };
}
// выбор светофора по остановке: если стоим у того же светофора, что и недавно, направление не меняем
// (иначе дрожание GPS переключало подъезды и замер начинался заново)
function pickDet(det) {
  const lk = S.selLock, same = lk && det.L.id === S.selected && Date.now() - lk.t < 15 * 60e3 && S.me && Math.hypot(S.me.x - lk.x, S.me.y - lk.y) < 120;
  if (same) selectLight(det.L.id, false); else selectLight(det.L.id, false, det.key);
  if (S.me) S.selLock = { t: Date.now(), x: S.me.x, y: S.me.y };
  return same;
}
// проехали светофор без остановки: в этот момент для нашего направления горел зелёный (или жёлтый)
function passCheck(p) {
  if (!(p.sp > 4)) return;
  for (const L of liveLights()) {
    if (Math.abs(L.x - p.x) > 20 || Math.abs(L.y - p.y) > 20 || Math.hypot(L.x - p.x, L.y - p.y) > 20) continue;
    S.lastPass = S.lastPass || {}; if (S.lastPass[L.id] && p.t - S.lastPass[L.id] < 120000) continue;
    const hd = headingNow(); if (hd == null) continue;
    S.lastPass[L.id] = p.t;
    const a = nearApproach(L, hd, 45), key = a ? `${L.id}|${a.k}` : String(L.id);
    const m = S.measBy[key] || (S.measBy[key] = { ev: [], obs: [], man: {} }); m.obs = m.obs || [];
    m.obs.push({ c: 'G', t1: Math.round(p.t), t2: Math.round(p.t) }); saveMeas();
  }
}
function checkStop() {
  const tr = S.trk, c = tr[tr.length - 1];
  const st = S.stop || (S.stop = { since: 0, done: false, at: null });
  if (st.at && Math.hypot(c.x - st.at[0], c.y - st.at[1]) > 30) { st.done = false; st.at = null; }   // уехали — следующая остановка новая
  if (c.sp > 1) { st.since = 0; return; }
  if (!st.since) st.since = c.t;
  const wasMoving = tr.some(p => c.t - p.t < 90000 && p.sp > 4);
  if (st.done || !wasMoving || c.t - st.since < 2500) return;
  st.done = true; st.at = [c.x, c.y];
  const det = detectAhead();
  if (window.gwAuto && gwAuto.on && !det) { gwAuto.onStop(null); return; }
  if (!det) return;
  const lbl = '#' + (det.L.id + 1) + ' ' + (det.L.name || 'светофор') + (det.a ? ' · ' + det.a.arrow + ' ' + det.a.from : '');
  if (window.gwAuto && gwAuto.on) { pickDet(det); gwAuto.onStop(det, lbl); return; }
  if (window.gwCamera && gwCamera.isOpen()) { selectLight(det.L.id, false, det.key); gwCamera.retarget(lbl); return; }
  ask('Стоите у ' + lbl + '?', [
    ['📷 Замер камерой', () => { selectLight(det.L.id, true, det.key); showTab('lights'); window.gwCamera && gwCamera.open(true); }, true],
    ['Открыть', () => { selectLight(det.L.id, true, det.key); showTab('lights'); }], ['✕', null]]);
}

// ======================= МОИ СВЕТОФОРЫ ==============================
// Добавленные вручную светофоры и убранные лишние. Хранятся на устройстве и попадают в экспорт.
const LS_MY = 'kostroma_mylights_v1';
const liveLights = () => S.lights.filter(L => !L.off);
function loadMy() {
  let m = { add: [], del: [] };
  try { m = Object.assign(m, JSON.parse(localStorage.getItem(LS_MY) || '{}')); } catch (e) {}
  applyMy(m);
}
function applyMy(m) {
  S.my = { add: m.add || [], del: m.del || [] };
  S.lights.length = LIGHTS_BASE.length;
  for (const L of S.lights) L.off = false;
  for (const a of S.my.add.slice().sort((p, q) => p.id - q.id)) {
    a.id = S.lights.length;      // номера идут подряд после светофоров из OSM
    S.lights.push({ id: a.id, x: a.x, y: a.y, kind: a.kind, n: 0, name: a.name || '', streets: a.name ? a.name.split(' / ') : [], mine: true });
  }
  for (const id of S.my.del) if (S.lights[id] && !S.lights[id].mine) S.lights[id].off = true;
}
function saveMy() {
  try { localStorage.setItem(LS_MY, JSON.stringify(S.my)); } catch (e) { toast('Не удалось сохранить на устройстве'); }
  if (S.graph) S.graph.cl = clusterNodes(S.graph.X, S.graph.Y);
  if (S.route) computeRoute();
  renderLightList(); renderMyInfo(); draw();
}
function streetsNear(x, y) {
  const g = S.graph, names = new Map(); if (!g) return [];
  const k0 = Math.floor(x / g.G), k1 = Math.floor(y / g.G);
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const n of g.grid.get((k0 + i) + ',' + (k1 + j)) || []) {
    const d = Math.hypot(g.X[n] - x, g.Y[n] - y); if (d > 45) continue;
    for (const e of g.adj[n]) if (e[4] && e[2] > 0) names.set(e[4], Math.min(names.get(e[4]) ?? 1e9, d));
  }
  return [...names.entries()].sort((a, b) => a[1] - b[1]).map(e => e[0]).slice(0, 2);
}
function addLight(x, y, kind) {
  const st = streetsNear(x, y);
  const a = { id: S.lights.length, x: Math.round(x), y: Math.round(y), kind, name: st.join(' / ') };
  S.my.add.push(a); applyMy(S.my); saveMy();
  selectLight(a.id, false); showTab('lights');
  toast('Светофор #' + (a.id + 1) + ' добавлен' + (a.name ? ': ' + a.name : ''));
}
function removeLight(i) {
  const L = S.lights[i]; if (!L) return;
  for (const k of Object.keys(S.timings)) if (parseInt(k) === i) delete S.timings[k];
  saveTimings();
  if (L.mine) {
    // убираем добавленный: номера следующих моих светофоров сдвигаются, их тайминги переносим
    const T = {}; for (const [k, v] of Object.entries(S.mine)) { const n = parseInt(k), rest = String(k).slice(String(n).length); if (n < i) T[k] = v; else if (n > i) T[(n - 1) + rest] = v; }
    S.mine = T; saveTimings();
    S.my.add = S.my.add.filter(a => a.id !== i);
  } else if (!S.my.del.includes(i)) S.my.del.push(i);
  applyMy(S.my);
  S.selected = null; $('editor').hidden = true; hideAsk();
  saveMy(); toast('Светофор убран с карты');
}
function restoreRemoved() { const n = S.my.del.length; S.my.del = []; applyMy(S.my); saveMy(); toast('Возвращено светофоров: ' + n); }
function renderMyInfo() {
  const el = $('myInfo'); if (!el) return;
  el.textContent = `Добавлено вами: ${S.my.add.length}, убрано: ${S.my.del.length}.`;
  $('bRestore').hidden = !S.my.del.length;
}
// карточка-вопрос внизу карты
function ask(title, buttons) {
  $('askT').textContent = title; const b = $('askB'); b.innerHTML = '';
  for (const [label, fn, primary] of buttons) { const e = document.createElement('button'); e.textContent = label; if (primary) e.className = 'primary'; e.onclick = () => { hideAsk(); fn && fn(); }; b.appendChild(e); }
  $('ask').hidden = false;
}
function hideAsk() { $('ask').hidden = true; S.addAt = null; draw(); }
function askAdd(x, y, hint) {
  S.addAt = [x, y]; draw();
  const st = streetsNear(x, y);
  ask((hint || 'Добавить светофор здесь?') + (st.length ? ' · ' + st.join(' / ') : ''), [
    ['🚦 Перекрёсток', () => addLight(x, y, 'X'), true], ['🚶 Переход', () => addLight(x, y, 'P')], ['Отмена', null]]);
}
function longPress(px, py) {
  if (S.pickMode) return;
  const X = wx(px), Y = wy(py);
  let best = null, bd = 1e9;
  for (const L of liveLights()) { const d = Math.hypot(sx(L.x) - px, sy(L.y) - py); if (d < bd) { bd = d; best = L; } }
  if (best && bd < 22) { askRemove(best.id); return; }
  if (navigator.vibrate) navigator.vibrate(15);
  askAdd(X, Y);
}
function iAmAtLight() {
  if (!S.me) { locate(false); toast('Жду местоположение — нажмите ещё раз через пару секунд'); return; }
  let best = null, bd = 35;
  for (const L of liveLights()) { const d = Math.hypot(L.x - S.me.x, L.y - S.me.y); if (d < bd) { bd = d; best = L; } }
  if (best) { selectLight(best.id, true); toast('Рядом уже есть светофор #' + (best.id + 1)); return; }
  S.view.cx = S.me.x; S.view.cy = S.me.y; if (S.view.s < 0.6) S.view.s = 0.9;
  if (window.innerWidth < 760) document.body.classList.remove('sheet-open');
  askAdd(S.me.x, S.me.y, 'Добавить светофор в вашей точке?');
}
function askRemove(i) {
  const L = S.lights[i];
  ask(`Убрать светофор #${i + 1}${L.name ? ' (' + L.name + ')' : ''} с карты?` + (L.mine ? '' : ' Его можно будет вернуть во вкладке «Данные».'), [
    ['Убрать', () => removeLight(i), true], ['Отмена', null]]);
}

// ======================= UI: ВКЛАДКИ ================================
// свернуть / развернуть нижнюю панель целиком (видна вся карта)
function setSideHidden(h) {
  document.body.classList.toggle('side-hidden', h);
  $('showSide').hidden = !h;
  try { localStorage.setItem('kostroma_side_hidden', h ? '1' : ''); } catch (e) {}
  requestAnimationFrame(resize);
}
function showTab(name) {
  if (document.body.classList.contains('side-hidden')) setSideHidden(false);
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
  document.querySelectorAll('.pane').forEach(p => p.hidden = p.id !== 'pane-' + name);
  document.body.classList.add('sheet-open');
  if (name === 'lights') renderLightList();
}

// ======================= UI: МАРШРУТ ================================
function updateRouteUI() {
  const nm = (P, n) => !P ? 'не выбрано' : (S.me && P === S.meRef ? 'моё местоположение' : n || toLL(P[0], P[1]).map(v => v.toFixed(5)).join(', '));
  $('aVal').textContent = nm(S.A, S.Aname); $('bVal').textContent = nm(S.B, S.Bname);
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
      html += `<div class="li" data-l="${l.id}" data-k="${l.key}"><span class="dot on" style="background:var(${col})"></span><span class="nm">#${l.id + 1} ${escapeHtml(L.name || 'Светофор')} <small style="color:var(--muted)">${{ L: '←', S: '↑', R: '→' }[l.mv] || ''}</small></span><span class="tm">${fmtT(depart + l.eta * 1000)}${l.wait > 0.5 ? ' · ждать ' + Math.round(l.wait) + ' с' : l.known ? ' · зелёный' : ''}</span></div>`;
    }
    html += '</div>';
  }
  out.innerHTML = html;
  out.querySelectorAll('[data-l]').forEach(d => d.onclick = () => { selectLight(+d.dataset.l, true, d.dataset.k); showTab('lights'); });
  draw();
}
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ======================= UI: СВЕТОФОРЫ ==============================
function renderLightList() {
  const q = $('lq').value.trim().toLowerCase(), now = Date.now(), box = $('lightList');
  box.innerHTML = '';
  for (const L of liveLights()) {
    const name = L.name || (L.kind === 'P' ? 'Пешеходный переход' : 'Без названия');
    if (q && !(String(L.id + 1) === q.replace('#', '') || name.toLowerCase().includes(q))) continue;
    const ph = phase(anyRec(L), now);
    const d = document.createElement('div'); d.className = 'li' + (L.id === S.selected ? ' sel' : ''); d.dataset.i = L.id;
    d.innerHTML = `<span class="num">#${L.id + 1}</span><span class="dot${ph ? ' on' : ''}"${ph ? ` style="background:var(${ph.s === 'G' ? '--g' : ph.s === 'Y' ? '--y' : '--r'})"` : ''}></span><span class="nm"></span><span class="tm">${ph ? Math.ceil(ph.left) + ' с' : ''}</span>`;
    d.querySelector('.nm').textContent = name + (L.kind === 'P' ? ' (пеш.)' : '');
    d.onclick = () => selectLight(L.id, true);
    box.appendChild(d);
  }
  const keys = Object.keys(S.timings), nr = keys.filter(k => ready(S.timings[k])).length;
  $('lCount').textContent = `${liveLights().length} объектов, готовых замеров: ${nr}` + (keys.length > nr ? `, собираются: ${keys.length - nr}` : '') + (S.my && S.my.add.length ? `, ваших: ${S.my.add.length}` : '') + ' · долгое нажатие на карте — добавить';
}
function parseClock(s) {
  const m = String(s).trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/); if (!m) return null;
  const d = new Date(); d.setHours(+m[1], +m[2], +(m[3] || 0), 0); let t = d.getTime(); if (t > Date.now() + 60000) t -= 86400000; return t;
}
function selectLight(i, center, key) {
  const L = S.lights[i];
  if (S.selected !== i || key) S.ek = key || String(i);
  S.selected = i;
  if (center) { S.view.cx = L.x; S.view.cy = L.y; if (S.view.s < 0.35) S.view.s = 0.6; S.follow = false; }
  $('editor').hidden = false;
  $('eTitle').textContent = '#' + (i + 1) + '  ' + (L.name || (L.kind === 'P' ? 'Пешеходный переход' : 'Без названия'));
  $('eSub').textContent = (L.kind === 'X' ? 'Перекрёсток' : 'Пешеходный переход') + (L.mine ? ' · добавлен вами' : ' · точек в OSM: ' + L.n);
  loadFields(); renderLightList();
  const it = $('lightList').querySelector('[data-i="' + i + '"]'); if (it) it.scrollIntoView({ block: 'nearest' });
}
// ---- замер у светофора: события «загорелся зелёный / жёлтый / красный», по ним — цикл и фазы
// Все события хранятся (и переживают перезапуск приложения), а расчёт каждый раз делается заново по всем:
// ошибки, мерцание, пропущенные круги отбрасываются, цикл считается по всем кругам сразу (метод наименьших квадратов).
const avg = a => a.reduce((s, v) => s + v, 0) / a.length;
const med = a => { const b = a.slice().sort((x, y) => x - y), n = b.length; return n % 2 ? b[(n - 1) / 2] : (b[n / 2 - 1] + b[n / 2]) / 2; };
const r1 = v => Math.round(v * 10) / 10;
const LS_MEAS = 'kostroma_meas_v2', YDEF = 3, REACT = 300;          // жёлтый по ГОСТ — 3 с, если его не отметили
S.measBy = {};
try { S.measBy = JSON.parse(localStorage.getItem(LS_MEAS) || '{}') || {}; } catch (e) { S.measBy = {}; }
function saveMeas() {
  const lim = Date.now() - 14 * 86400e3;               // события храним 2 недели: цикл можно сложить из разных проездов
  for (const [k, m] of Object.entries(S.measBy)) {
    m.ev = (m.ev || []).filter(e => e.t > lim).slice(-800);
    m.obs = (m.obs || []).filter(o => o.t2 > lim).slice(-300);
    if (!m.ev.length && !m.obs.length && !Object.values(m.man || {}).some(Boolean)) delete S.measBy[k];
  }
  try { localStorage.setItem(LS_MEAS, JSON.stringify(S.measBy, (k, v) => k === 'res' ? undefined : v)); } catch (e) {}
}
function getMeas() { const k = S.ek; let m = S.measBy[k]; if (!m) m = S.measBy[k] = { ev: [], obs: [], man: {} }; m.man = m.man || {}; m.ev = m.ev || []; m.obs = m.obs || []; return m; }
// наблюдение «горел красный с t1 до t2» (подъехали — уже красный, дождались зелёного): красный не короче этого
function addObsTo(m, c, t1, t2, strong) {
  if (!(t2 - t1 >= 2000) || t2 - t1 > 300000) return;
  const i = m.obs.findIndex(o => o.c === c && Math.abs(o.t2 - t2) < 3000);
  if (i >= 0) { if (!strong) return; m.obs.splice(i, 1); }
  m.obs.push({ c, t1: Math.round(t1), t2: Math.round(t2) });
}
function addObs(c, t1, t2) { if (S.selected == null) return; const m = getMeas(); addObsTo(m, c, t1, t2, true); saveMeas(); recompute(m); }
// btn: gs/ge/rs/re; tEv — время касания или кадра; future — событие с табло (может быть в будущем) или точное время события
function mark(btn, tEv, future) {
  if (S.selected == null) return;
  const k = { gs: 'g', re: 'g', ge: 'y', rs: 'r' }[btn] || btn;     // 4 кнопки → 3 события
  if (!'gyr'.includes(k || '-') || !k) return;
  // нажатие пальцем запаздывает за сменой сигнала примерно на 0,3 с — вычитаем; события камеры и табло приходят с точным временем
  const t = future ? tEv : ((tEv && Math.abs(tEv - Date.now()) < 1500) ? tEv : Date.now()) - REACT;
  if (!Number.isFinite(t)) return;
  const m = getMeas();
  if (m.ev.some(e => e.k === k && Math.abs(e.t - t) < 2500)) { m.last = btn; updMeas(); return; }   // «Конец красного» + «Начало зелёного» — одно событие
  m.ev.push({ t: Math.round(t), k }); m.ev.sort((a, b) => a.t - b.t);
  const st = S.stop; if (k === 'g' && st && st.since && t - st.since > 3000 && t - st.since < 240000) addObsTo(m, 'R', st.since, t, false);
  m.last = btn;
  if (!future) { try { if (navigator.vibrate) navigator.vibrate(30); } catch (e) {} }
  saveMeas(); recompute(m);
}
// чистим последовательность: мерцание, повторы и невозможные переходы
function cleanEvents(ev) {
  let a = ev.slice().sort((x, y) => x.t - y.t);
  // мерцание: событие, после которого меньше чем через 1,5 с вернулся прежний цвет, — не было ни того, ни другого
  for (let changed = true; changed;) {
    changed = false;
    for (let i = 1; i + 1 < a.length; i++) if (a[i + 1].t - a[i].t < 1500 && a[i + 1].k === a[i - 1].k && a[i].k !== a[i - 1].k) { a.splice(i, 2); changed = true; break; }
  }
  const out = [];
  for (const e of a) {
    let last = out[out.length - 1];
    if (last && last.k === e.k && e.t - last.t < 5000) continue;          // повтор
    if (last && last.k === 'r' && e.k === 'y') continue;                  // красный+жёлтый или помеха
    if (last && last.k === 'y' && e.k === 'g') { out.pop(); last = out[out.length - 1]; if (last && last.k === e.k && e.t - last.t < 5000) continue; }   // «жёлтый» перед зелёным был ложным
    out.push(e);
  }
  return out;
}
// цикл по проездам, разнесённым во времени: между одноимёнными событиями уложилось целое число циклов.
// Перебираем варианты по ближайшей паре и уточняем, добавляя всё более далёкие события; остаётся тот, что сходится со всеми.
function fitCycleLong(ts, tol, minC) {
  if (ts.length < 4) return null;
  const t0 = ts[ts.length - 1], ds = ts.slice(0, -1).map(t => t0 - t).filter(d => d > 0).sort((a, b) => a - b);
  if (ds.length < 3 || ds[ds.length - 1] < 1200) return null;   // нужны проезды, разнесённые во времени
  const fit = P => { const mn = avg(P.map(p => p[0])), md = avg(P.map(p => p[1])); let nu = 0, de = 0; for (const [x, y] of P) { nu += (x - mn) * (y - md); de += (x - mn) ** 2; } const C = nu / de, b0 = md - C * mn; return { C, de, rms: Math.sqrt(avg(P.map(([x, y]) => (y - b0 - x * C) ** 2))) }; };
  // перебор: номер круга до каждого следующего проезда; если по точности цикла он неоднозначен — пробуем соседние
  const ok = []; let nodes = 0;
  const go = (i, P, C, err) => {
    if (++nodes > 30000) return;
    if (i === ds.length) { const f = fit(P); if (f.rms <= tol) ok.push(f); return; }
    const d = ds[i], lo = Math.max(1, Math.ceil((d - tol * 1.6) / (C + err))), hi = Math.floor((d + tol * 1.6) / Math.max(1, C - err));
    for (let m = lo; m <= hi && m - lo < 50; m++) {
      P.push([m, d]); const f = fit(P);
      if (f.rms <= tol) go(i + 1, P, f.C, Math.max(0.002, tol * 1.6 / Math.sqrt(f.de)));
      P.pop();
    }
  };
  const d1 = ds[0];
  for (let n = Math.max(1, Math.ceil(d1 / 150)); n <= Math.floor(d1 / 35); n++) go(1, [[0, 0], [n, d1]], d1 / n, tol * 1.6 / n);
  // одинаковые варианты (почти тот же цикл) — оставляем лучший
  const cand = [];
  for (const o of ok.filter(o => o.C >= 35 && o.C <= 150 && !(minC && o.C < minC)).sort((a, b) => a.rms - b.rms)) if (!cand.some(c => Math.abs(c.C - o.C) < 0.05)) cand.push(o);
  if (!cand.length) return null;
  // лучший по точности; соперник (не кратный ему) почти так же хорош — данных пока мало
  const best = cand[0], lim = Math.max(2.5 * best.rms, best.rms + 0.3);
  const rel = (p, q) => { const k = Math.max(p.C, q.C) / Math.min(p.C, q.C); return Math.abs(k - Math.round(k)) < 0.02; };
  const group = [best];
  for (const o of cand.slice(1)) { if (o.rms >= lim) continue; if (!rel(best, o)) return null; group.push(o); }
  if (group.length === 1) return best;
  // C, C/2, C/3… по одним началам зелёного не различить: берём больший, но только при достаточном числе проездов
  group.sort((a, b) => b.C - a.C);
  return ts.length >= 7 ? group[0] : null;
}
// уточнить уже известный цикл C0 по проездам в другие дни/часы: идём от близких к далёким,
// пока ошибка цикла × число кругов заведомо меньше допуска (иначе номер круга угадать нельзя)
function refineSeed(ts, C0, tol) {
  const t0 = ts[ts.length - 1], ds = ts.slice(0, -1).map(t => t0 - t).filter(d => d > 0).sort((a, b) => a - b);
  let C = C0, err = 0.15, used = 0; const P = [[0, 0]];
  for (const d of ds) {
    const m = Math.round(d / C);
    if (m * err > C / 2 - tol) break;                    // номер круга неоднозначен — дальше не верим
    if (Math.abs(d - m * C) > tol * 1.6) return null;    // проезд не сходится с циклом — что-то не так
    P.push([m, d]); used++;
    const mn = avg(P.map(p => p[0])), md = avg(P.map(p => p[1])); let nu = 0, de = 0;
    for (const [x, y] of P) { nu += (x - mn) * (y - md); de += (x - mn) ** 2; }
    if (de > 0) { C = nu / de; err = Math.max(0.01, tol / Math.sqrt(de)); }
  }
  return used && P[P.length - 1][1] >= 1200 ? { C, span: P[P.length - 1][1] } : null;
}
// расчёт по событиям и наблюдениям: цикл C, фазы, точка отсчёта
function deriveTiming(evRaw, extra) {
  extra = extra || {};
  const ev = cleanEvents(evRaw);
  const out = { ev, need: 'cycle' };
  if (!ev.length) return out;
  const by = { g: [], y: [], r: [] };
  for (const e of ev) by[e.k].push(e.t / 1000);
  const tl = ev[ev.length - 1].t / 1000;
  // 1) цикл внутри одной стоянки: интервалы до 15 минут между одноимёнными событиями
  const ints = [];
  for (const k of 'gyr') for (let i = 1; i < by[k].length; i++) { const d = by[k][i] - by[k][i - 1]; if (d >= 15 && d <= 900) ints.push(d); }
  let C = null, src = null;
  if (extra.fixC) { C = extra.fixC.C; src = 'hint'; out.hint = extra.fixC.src; out.hintSame = true; }   // цикл всего перекрёстка уже известен по другому подъезду
  else if (ints.length) {
    let C0 = null, best = -1;
    for (const c of ints) {
      if (c < 35 || c > 150) continue;   // кандидат — один круг; длинные интервалы учитываются как кратные
      let sc = 0; for (const d of ints) { const n = Math.round(d / c); if (n >= 1 && Math.abs(d - n * c) < Math.max(2.5, 0.04 * c)) sc += 1 / n; }
      if (sc > best + 1e-9 || (Math.abs(sc - best) < 1e-9 && c < C0)) { best = sc; C0 = c; }
    }
    if (C0) {
      // уточняем по каждой стоянке отдельно (свой сдвиг на каждую стоянку и тип события)
      let num = 0, den = 0;
      const addSes = ses => {
        if (ses.length < 2) return;
        const pts = ses.map(t => ({ t, n: Math.round((t - ses[0]) / C0) }));
        const a0 = med(pts.map(p => p.t - p.n * C0)), P = pts.filter(p => Math.abs(p.t - p.n * C0 - a0) <= 2.5);
        if (P.length < 2) return;
        const mn = avg(P.map(p => p.n)), mt = avg(P.map(p => p.t));
        for (const p of P) { num += (p.n - mn) * (p.t - mt); den += (p.n - mn) ** 2; }
      };
      for (const k of 'gyr') {
        let ses = []; const arr = by[k];
        for (let i = 0; i < arr.length; i++) { if (i && arr[i] - arr[i - 1] > 900) { addSes(ses); ses = []; } ses.push(arr[i]); }
        addSes(ses);
      }
      C = den > 0 ? num / den : C0; src = 'stop';
    }
  }
  // 2) цикл по разным проездам (только начала зелёного — их видно почти при каждой остановке)
  const wmx = Math.max(0, ...(extra.obs || []).filter(o => o.c === 'R').map(o => (o.t2 - o.t1) / 1000).filter(w => w < 200));
  const long = extra.fixC ? null : fitCycleLong(by.g, 1.2, wmx ? wmx + YDEF + 4 : 0);
  if (long && (!C || Math.abs(long.C - C) < 1)) { C = long.C; src = 'passes'; }
  else if (C && !long && !extra.fixC && by.g.length >= 3) { const rs = refineSeed(by.g, C, 1.2); if (rs) { C = rs.C; src = 'passes'; } }
  // 3) цикл у других направлений этого перекрёстка или у соседей по улице (обычно общий — «зелёная волна»)
  if (!C && extra.hints) {
    for (const h of extra.hints) {
      let fits = true;
      // каждый промежуток между началами зелёного должен быть целым числом кругов (с небольшим запасом на часы)
      for (let i = 1; i < by.g.length; i++) { const d = by.g[i] - by.g[i - 1]; if (d < 5) continue; const n = Math.round(d / h.C); if (n < 1 || Math.abs(d - n * h.C) > 1.5 + d * 0.00002) { fits = false; break; } }
      if (fits) { C = h.C; src = 'hint'; out.hint = h.src; out.hintSame = !!h.same; break; }
    }
  }
  if (!C) return out;
  out.C = C; out.src = src; out.need = null;
  // 4) фазы: при надёжном цикле — по всем событиям, иначе по последним 30 минутам
  const win = extra.fixC ? extra.fixC.win : src === 'passes' ? Infinity : src === 'stop' ? 6 * 3600 : 1800;
  const ph = {}, res = [];
  for (const k of 'gyr') {
    const arr = by[k].filter(t => tl - t <= win); if (!arr.length) continue;
    const tk = arr[arr.length - 1];                       // отсчёт от последнего события этого типа — без перескока через край цикла
    let xs = arr.map(t => t - tk - Math.round((t - tk) / C) * C);
    const mx = med(xs); const inl = xs.filter(x => Math.abs(x - mx) <= 2.5); if (inl.length) xs = inl;
    const m0 = avg(xs); ph[k] = tk + m0; for (const x of xs) res.push(x - m0);
  }
  out.rms = res.length > 1 ? Math.sqrt(avg(res.map(v => v * v))) : 0;
  out.nCyc = src === 'passes' ? 0 : Math.max(0, ...Object.values(by).map(a => { const b = a.filter(t => tl - t <= 900 * 4); return b.length ? Math.round((b[b.length - 1] - b[0]) / C) : 0; }));
  out.nPass = by.g.length;
  if (ph.g == null) { out.need = 'g'; return out; }
  const mod = v => ((v % C) + C) % C;
  let g, y, r, est = null;
  if (ph.y != null || ph.r != null) {
    if (ph.y != null) { g = mod(ph.y - ph.g); y = ph.r != null ? mod(ph.r - ph.y) : YDEF; }
    else { const gy = mod(ph.r - ph.g); y = gy > 2 * YDEF ? YDEF : 0; g = gy - y; }
    r = C - g - y;
  } else {
    // 5) начала красного не видели — оцениваем по наблюдениям:
    //    каждое ожидание на красном не длиннее красного, каждый проезд на зелёный — не позже конца зелёного.
    //    Самое большое из n случайных значений в среднем равно настоящему·n/(n+1) — на это и поправляем.
    const obs = (extra.obs || []).filter(o => tl - o.t2 / 1000 <= win);
    const ws = obs.filter(o => o.c === 'R').map(o => (o.t2 - o.t1) / 1000).filter(w => w > 2 && w < C);
    const ps = obs.filter(o => o.c === 'G').map(o => mod(o.t1 / 1000 - ph.g)).filter(p => p < C - YDEF - 5);
    if (!ws.length && !ps.length) { out.need = 'r'; return out; }
    y = YDEF;
    const Rl = ws.length ? Math.max(...ws) : 0, Gl = ps.length ? Math.max(...ps) : 0;
    let Rh = ws.length ? Rl * (ws.length + 1) / ws.length : null, Gh = ps.length ? Gl * (ps.length + 1) / ps.length : null;
    if (Rh != null && Gh != null) { const k = (C - y) / (Rh + Gh); Rh *= k; Gh *= k; }
    if (Rh != null) r = Math.min(Math.max(Rh, Rl), C - y - Math.max(6, Gl)); else r = C - y - Math.min(Math.max(Gh, Gl), C - y - 6);
    // при малом числе наблюдений подтягиваем к середине (половина круга), но не нарушая увиденного
    { const N = ws.length + ps.length, pr = (C - y) / 2; r = (r * N + pr) / (N + 1); r = Math.max(r, Rl); r = Math.min(r, C - y - Math.max(6, Gl)); }
    g = C - y - r;
    est = { n: ws.length, wmax: Rl, np: ps.length, gmin: Gl };
  }
  if (!(g > 0) || y > 8 || g + y >= C) { out.need = 'r'; return out; }
  const a = (ph.g + Math.round((tl - ph.g) / C) * C) * 1000;   // начало зелёного ближайшего к последнему событию круга
  return Object.assign(out, { g, y, r, a, est });
}
// поля и сохранение (вписанное вручную не перезаписывается)
function recompute(m) {
  const man = m.man || {}, R = deriveKey(S.selected, S.ek), d = R.d;
  m.res = d;
  if (d.g == null && d.need === 'cycle' && S.mine[S.ek] && S.mine[S.ek].auto && S.mine[S.ek].part) {
    delete S.timings[S.ek]; delete m.fit; saveTimings(); loadFields(); renderLightList(); draw();
    toast('Прежний расчёт не сошёлся с новыми отметками — тайминг убран, ждём ещё проездов');
  }
  if (d.g != null) {
    let { g, y, r } = d;
    const num = id => parseFloat($(id).value);
    if (man.y && num('fY') >= 0) { y = num('fY'); }
    if (man.g && num('fG') > 0) { g = num('fG'); }
    r = man.r && num('fR') > 0 ? num('fR') : d.C - g - y;
    if (!man.g) $('fG').value = r1(g); if (!man.y) $('fY').value = r1(y); if (!man.r) $('fR').value = r1(r);
    $('fA').value = fmtT(d.a);
    m.fit = { g, y, r, a: d.a, est: !!d.est };
    if (g > 0 && r > 0) saveLight(true, autoFlags(R));
  }
  try { updateRelated(S.selected, S.ek); } catch (e) { console.warn(e); }
  updMeas();
}
// Зеркало: пока у поперечного подъезда красный — у нас зелёный, и наоборот; у встречного — та же фаза.
// Между фазами у всех красный ~AR с, а перед красным горит жёлтый.
const AR = 2;
function mirrorData(id, key) {
  const out = { ev: [], obs: [], n: 0 }, L = S.lights[id], ps = String(key).split('|');
  if (!L || L.kind !== 'X' || ps.length !== 2) return out;
  const ap = approaches(L), me = ap.find(a => a.k === ps[1]); if (!me) return out;
  for (const a of ap) {
    if (a.k === me.k) continue;
    const m = S.measBy[`${id}|${a.k}`]; if (!m || !m.ev || !m.ev.length) continue;
    const dg = Math.abs(angD(a.b, me.b)), cross = dg >= 60 && dg <= 120, opp = dg >= 150; if (!cross && !opp) continue;
    const ev = cleanEvents(m.ev); out.n++;
    const sd = deriveTiming(m.ev, { obs: m.obs }); if ((sd.src === 'stop' || sd.src === 'passes') && (!out.fix || ev.length > out.fix.n)) out.fix = { C: sd.C, win: sd.src === 'passes' ? Infinity : 6 * 3600, n: ev.length, src: 'другой подъезд этого перекрёстка' };
    for (let i = 0; i < ev.length; i++) {
      const e = ev[i];
      if (opp) { out.ev.push({ t: e.t, k: e.k, m: 1 }); continue; }
      if (e.k === 'g') out.ev.push({ t: e.t - AR * 1000, k: 'r', m: 1 });
      else if (e.k === 'r') out.ev.push({ t: e.t + AR * 1000, k: 'g', m: 1 });
      else { const nx = ev[i + 1]; if (!(nx && nx.k === 'r' && nx.t - e.t < 6000)) out.ev.push({ t: e.t + (YDEF + AR) * 1000, k: 'g', m: 1 }); }
    }
    for (const o of m.obs || []) {
      if (opp) out.obs.push(o);
      else if (o.c === 'R' && o.t2 - o.t1 > 4000) out.obs.push({ c: 'G', t1: o.t1, t2: o.t1 });   // там стояли на красном — здесь в это время зелёный
    }
  }
  return out;
}
// тайминг подъезда: сначала по своим отметкам; не хватает — вместе с зеркальными.
// full — замер готов: цикл надёжен, обе смены сигнала увидены (не оценка), а зеркальный ещё и подтверждён своей отметкой
function deriveKey(id, key) {
  const m = S.measBy[key] || { ev: [], obs: [] }, hints = cycleHints(id, key), obs = m.obs || [];
  const isFull = d => d.g != null && !d.est && (d.src !== 'hint' || d.hintSame);
  const own = deriveTiming(m.ev, { obs, hints });
  const pack = (d, via, conf) => ({ d, via, conf, full: isFull(d) && (via !== 'mirror' || conf), cs: d.src === 'stop' || d.src === 'passes' || (d.src === 'hint' && d.hintSame) });
  if (isFull(own)) return pack(own, null, true);
  const mi = mirrorData(id, key);
  if (!mi.ev.length) return pack(own, null, true);
  const all = deriveTiming(m.ev.concat(mi.ev), { obs: obs.concat(mi.obs), hints, fixC: mi.fix });
  if (all.g == null) return pack(own, null, true);
  // подтверждение: хотя бы одна своя смена сигнала легла на расчёт (±3 с)
  const C = all.C, a = all.a / 1000, b = { g: 0, y: all.g, r: all.g + all.y };
  const conf = cleanEvents(m.ev).some(e => { const off = (((e.t / 1000 - a - b[e.k]) % C) + C) % C; return Math.min(off, C - off) <= 3; });
  all.mirror = { n: mi.n, conf };
  return pack(all, 'mirror', conf);
}
function autoFlags(R) { const f = { auto: 1 }; if (!R.full) f.part = 1; if (R.d.est) f.est = 1; if (R.cs) f.cs = 1; if (R.via) f.via = R.via; return f; }
// пересчитать соседние подъезды этого перекрёстка (для них наши отметки — зеркальные)
function updateRelated(id, key) {
  const L = S.lights[id]; if (!L || L.kind !== 'X') return;
  let ch = false;
  for (const a of approaches(L)) {
    const k = `${id}|${a.k}`; if (k === key) continue;
    const prev = S.mine[k]; if (prev && !prev.auto) continue;      // введённое вручную не трогаем
    const R = deriveKey(id, k), d = R.d;
    if (d.g == null || !(d.r > 0)) { if (prev && prev.part) { delete S.mine[k]; ch = true; } continue; }
    if (prev && !prev.part && R.via === 'mirror' && !R.full) continue;   // готовый замер не заменяем недособранным
    S.timings[k] = Object.assign({ g: d.g, y: d.y, r: d.r, a: d.a }, autoFlags(R)); ch = true;
  }
  if (ch) saveTimings();
}
// подсказки цикла: другие направления этого перекрёстка, затем соседние светофоры на той же улице (до 1,5 км)
function cycleHints(id, key) {
  const out = [], L = S.lights[id]; if (!L) return out;
  const cyc = T => T && T.g > 0 && T.r > 0 && (!T.part || T.cs) ? T.g + (T.y || 0) + T.r : null;   // цикл надёжен, даже если красный — по оценке
  for (const src of [S.mine, S.shared]) for (const [k, T] of Object.entries(src)) {
    if (parseInt(k) !== id || k === key) continue; const c = cyc(T); if (c) out.push({ C: c, src: 'другое направление этого перекрёстка', same: true });
  }
  const near = [];
  for (const M of liveLights()) {
    if (M.id === id || !M.streets || !L.streets) continue;
    const d = Math.hypot(M.x - L.x, M.y - L.y); if (d > 1500) continue;
    const st = M.streets.find(s => L.streets.includes(s)); if (!st) continue;
    for (const src of [S.mine, S.shared]) for (const [k, T] of Object.entries(src)) if (parseInt(k) === M.id) { const c = cyc(T); if (c) near.push({ C: c, d, src: `соседний #${M.id + 1} (${st})` }); }
  }
  near.sort((a, b) => a.d - b.d);
  return out.concat(near);
}
// табло обратного отсчёта: «осталось N с» на зелёном/красном = будущее нажатие кнопки
function countdown(color) {
  if (S.selected == null) return;
  const n = parseFloat($('fCd').value);
  if (!(n >= 0 && n < 300)) { toast('Впишите число секунд с табло светофора'); return; }
  const t = Date.now() + n * 1000;
  mark(color === 'g' ? 'rs' : 'gs', t, true);
  $('fCd').value = '';
  toast(color === 'g' ? `Учтено: красный загорится в ${fmtT(t)}` : `Учтено: зелёный загорится в ${fmtT(t)}`);
}
function updMeas() {
  const el = $('eMeas'); if (!el) return;
  const m = S.measBy[S.ek], ev = (m && m.ev) || [];
  document.querySelectorAll('[data-mk]').forEach(b => b.classList.toggle('last', !!(ev.length && m.last === b.dataset.mk)));
  const R = deriveKey(S.selected, S.ek), d = R.d;
  if (!ev.length && d.g != null) { el.innerHTML = `По отметкам на поперечных и встречных подъездах этого перекрёстка: цикл <b>${d.C.toFixed(1)} с</b>, зелёный ≈ <b>${d.g.toFixed(0)} с</b>, красный ≈ <b>${d.r.toFixed(0)} с</b>.<br><span style="color:var(--muted)">Собирается — на карте пока не показывается. Нужна одна своя отметка с этого подъезда (например, остановка на красном до зелёного), чтобы проверить, что здесь всё действительно «наоборот».</span>`; return; }
  if (!ev.length) { el.innerHTML = 'Жмите кнопку в момент смены сигнала. Подъехали на красный — нажмите «Конец красного», когда загорится зелёный, затем «Начало красного», затем снова «Начало зелёного». Есть табло с секундами — впишите число и нажмите цвет. Длительность можно вписать и вручную в поля ниже.'; return; }
  const now = Date.now(), cl = cleanEvents(ev);
  const past = cl.filter(e => e.t <= now), lastE = past[past.length - 1], nextE = cl.find(e => e.t > now);
  let head = '';
  if (nextE) head = `⏳ ${nextE.k === 'g' ? 'зелёный' : 'красный'} загорится через <b>${((nextE.t - now) / 1000).toFixed(1)} с</b>`;
  else if (lastE && now - lastE.t > 300000) head = `Последняя отметка ${fmtT(lastE.t)}${now - lastE.t > 86400e3 ? ' (' + new Date(lastE.t).toLocaleDateString('ru-RU') + ')' : ''} · всего отметок: ${cl.length}`;
  else if (lastE) {
    const what = { g: 'горит зелёный', y: 'горит жёлтый', r: 'горит красный' }[lastE.k];
    const next = { g: '«Конец зелёного» или «Начало красного»', y: '«Начало красного»', r: '«Начало зелёного»' }[lastE.k];
    head = `⏱ ${what}: <b>${((now - lastE.t) / 1000).toFixed(1)} с</b> · дальше ${next}`;
  }
  let acc = '';
  if (d.C) acc = ` · цикл <b>${d.C.toFixed(1)} с</b>` + (d.src === 'passes' ? ` по ${d.nPass} проездам` : d.src === 'hint' ? ` (взят: ${d.hint})` : d.nCyc >= 1 ? ` по ${d.nCyc} ${d.nCyc === 1 ? 'кругу' : 'кругам'}` : '');
  if (d.est) acc += `<br>красный ≈ <b>${d.r.toFixed(0)} с</b>, зелёный ≈ <b>${d.g.toFixed(0)} с</b> — оценка по ${d.est.n} ожид. на красном` + (d.est.np ? ` и ${d.est.np} проездам на зелёный` : '') + `; станет точной, когда камера увидит, как загорается красный или жёлтый`;
  const dropped = ev.length - cl.length;
  let tail;
  if (d.need === 'cycle') tail = '<span style="color:var(--muted)">Ещё нужно: длина цикла — дождитесь следующего такого же сигнала, или она сложится из нескольких проездов (обычно 4–5 остановок), или возьмётся у соседнего замеренного светофора на этой улице</span>';
  else if (d.need === 'g') tail = '<span style="color:var(--muted)">Ещё нужно: момент начала зелёного</span>';
  else if (d.need === 'r') tail = '<span style="color:var(--muted)">Ещё нужно: начало красного (или жёлтого) — либо хотя бы одна остановка на красном до зелёного</span>';
  else if (R.full) tail = '<span style="color:var(--g)">✓ Посчитан полностью — показывается на карте и учитывается в маршрутах</span>' + (d.via === 'mirror' || R.via === 'mirror' ? '<span style="color:var(--muted)"> · с учётом отметок на других подъездах</span>' : '') + (d.nCyc < 3 ? '<span style="color:var(--muted)"> · каждый следующий круг делает его точнее</span>' : '');
  else {
    const why = [];
    if (d.est) why.push('увидеть, как загорается красный или жёлтый (сейчас красный — по оценке)');
    if (d.src === 'hint' && !d.hintSame) why.push('свой цикл: ещё несколько остановок здесь (сейчас цикл взят у соседа)');
    if (R.via === 'mirror' && !R.conf) why.push('своя отметка с этого подъезда, совпавшая с расчётом по другим подъездам');
    tail = '<span style="color:var(--y)">◐ Собирается — на карте пока не показывается.</span><span style="color:var(--muted)"> Ещё нужно: ' + (why.join('; ') || 'ещё отметок') + '</span>';
  }
  if (R.via === 'mirror') acc += `<br><span style="color:var(--muted)">Учтены отметки других подъездов этого перекрёстка (${d.mirror.n}): у поперечных всё наоборот, у встречных — так же${R.conf ? ', своя отметка совпала ✓' : ''}</span>`;
  if (d.rms > 1.5) tail += `<br><span style="color:var(--r)">⚠ Смены сигнала гуляют на ±${d.rms.toFixed(1)} с — похоже, у светофора меняется режим (адаптивный, вызывная кнопка или другое время суток). Предсказание может ошибаться.</span>`;
  if (dropped > 0) tail += `<br><span style="color:var(--muted)">Отброшено как ошибки или мерцание: ${dropped}</span>`;
  el.innerHTML = head + acc + '<br>' + tail;
}
function tickEditor() {
  if (S.selected == null) return;
  updMeas();
  const ph = phase(S.mine[S.ek] || S.timings[S.ek], Date.now()), el = $('eLive');
  if (!ph) { el.textContent = 'Нет таймингов — заполните поля и сохраните.'; return; }
  const nm = { G: 'ЗЕЛЁНЫЙ', Y: 'ЖЁЛТЫЙ', R: 'КРАСНЫЙ' }[ph.s], part = (S.mine[S.ek] || S.timings[S.ek] || {}).part;
  el.innerHTML = `${part ? 'Предварительно' : 'Сейчас'}: <b style="color:var(${ph.s === 'G' ? '--g' : ph.s === 'Y' ? '--y' : '--r'})">${nm}</b>, переключится через <b>${ph.left.toFixed(1)} с</b> · цикл ${r1(ph.cyc)} с` + (part ? ' <span style="color:var(--muted)">(собирается — на карте не показывается)</span>' : '');
}
function saveTimings() { try { localStorage.setItem(LS_TIMINGS, JSON.stringify(S.mine)); } catch (e) { toast('Не удалось сохранить на устройстве'); } }
function saveLight(auto, flags) {
  if (S.selected == null) return;
  let g = parseFloat($('fG').value), y = parseFloat($('fY').value || '0'), r = parseFloat($('fR').value), a = parseClock($('fA').value);
  const fm = S.measBy[S.ek] && S.measBy[S.ek].fit;   // точные значения расчёта (в полях они округлены)
  if (fm) { if (r1(fm.g) === g) g = fm.g; if (r1(fm.y) === y) y = fm.y; if (r1(fm.r) === r) r = fm.r; if (fmtT(fm.a) === $('fA').value.trim()) a = fm.a; }
  const prev = S.mine[S.ek];
  if (!(g > 0) || isNaN(r) || r < 0) { toast('Укажите зелёный и красный в секундах'); return; }
  if (a == null) { toast('Отметьте начало зелёного кнопкой или впишите время ЧЧ:ММ:СС'); return; }
  const T = S.ek.includes('|') ? { g, y: isNaN(y) ? 0 : y, r, a } : { g, y: isNaN(y) ? 0 : y, r, a, main: $('fMain').value };
  if (auto && flags) Object.assign(T, flags);           // расчёт по отметкам: помечаем, готов ли замер
  S.timings[S.ek] = T;                                  // ручной ввод (без флагов) — всегда готов
  saveTimings(); renderLightList(); renderApr(); tickEditor(); draw();
  if (auto && T.part) return;   // недособранный — без сообщений, о нём пишет окно замера
  if (auto && prev && prev.part) { toast(`✓ Светофор посчитан полностью — теперь он на карте: зелёный ${r1(g)} с, жёлтый ${r1(isNaN(y) ? 0 : y)} с, красный ${r1(r)} с`); if (S.route) computeRoute(); return; }
  if (auto && prev && Math.abs(prev.g - g) < 0.3 && Math.abs((prev.y || 0) - y) < 0.3 && Math.abs(prev.r - r) < 0.3) return;   // уточнение без заметных изменений — без лишних сообщений
  toast(auto ? `Замер сохранён: зелёный ${r1(g)} с, жёлтый ${r1(isNaN(y) ? 0 : y)} с, красный ${r1(r)} с` : (lsGet('kostroma_share_off', '') ? 'Сохранено в «Мои»' : 'Сохранено в «Мои» и отправлено в общую базу'));
  if (S.route) computeRoute();
}
function clearLight() { if (S.selected == null) return; delete S.timings[S.ek]; saveTimings(); loadFields(); renderLightList(); if (S.route) computeRoute(); }
function exportTimings() {
  const out = { app: 'kostroma-lights', v: 1, saved: new Date().toISOString(), my_lights: S.my.add.map(a => ({ id: a.id + 1, kind: a.kind, name: a.name, x: a.x, y: a.y, lat: +toLL(a.x, a.y)[0].toFixed(6), lon: +toLL(a.x, a.y)[1].toFixed(6) })), removed: S.my.del.map(i => i + 1), lights: Object.entries(S.mine).filter(([k]) => S.lights[parseInt(k)]).map(([k, T]) => ({ id: parseInt(k) + 1, key: k, direction: keyLabel(k), name: S.lights[parseInt(k)].name, x: Math.round(S.lights[parseInt(k)].x), y: Math.round(S.lights[parseInt(k)].y), green: T.g, yellow: T.y, red: T.r, green_at: fmtT(T.a), green_at_ms: T.a, main: T.main })) };
  const blob = new Blob([JSON.stringify(out, null, 1)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'светофоры-кострома.json'; document.body.appendChild(a); a.click(); a.remove();
  toast('Файл с таймингами сохранён');
}
function importTimings(file) {
  const fr = new FileReader();
  fr.onload = () => {
    try {
      const j = JSON.parse(fr.result); let n = 0;
      if (j.my_lights || j.removed) { applyMy({ add: (j.my_lights || []).map(a => ({ id: a.id - 1, x: a.x, y: a.y, kind: a.kind === 'P' ? 'P' : 'X', name: a.name || '' })), del: (j.removed || []).map(i => i - 1) }); saveMy(); }
      for (const l of j.lights || []) { const i = l.id - 1; if (!S.lights[i]) continue; S.timings[l.key && parseInt(l.key) === i ? l.key : i] = { g: +l.green, y: +l.yellow || 0, r: +l.red, a: l.green_at_ms || parseClock(l.green_at), main: l.main }; n++; }
      saveTimings(); renderLightList(); draw(); toast('Загружено таймингов: ' + n);
    } catch (e) { toast('Файл не похож на файл таймингов'); }
  };
  fr.readAsText(file);
}

// ======================= ОБЩАЯ БАЗА =================================
// Две версии таймингов: «Мои» — только на этом устройстве, меняет их только владелец телефона;
// «Общие» — замеры всех пользователей. Свои правки отправляются в общую базу, а общая база мои не меняет.
// Записи автора (с ключом автора) в общей базе главные: чужой замер их длительности не перебивает.
const SUPA_URL = 'https://tvafpyewubnsvxzfmbdi.supabase.co', SUPA_KEY = 'sb_publishable_oXzPF1MbyTopYVt72vBc5g_mE_SNI4f';
const LS_SHARED = 'kostroma_shared_v1', LS_SHQ = 'kostroma_shareq_v1';
const KEY_RE = /^\d{1,4}(\|b\d{1,3}(\|[LSR])?)?$/;
function lsGet(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } }
function lsSet(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }
function makeTimingsProxy() {
  const get = k => typeof k !== 'string' ? undefined : S.tmode === 'shared' ? S.shared[k] : (S.mine[k] ?? S.shared[k]);
  return new Proxy({}, {
    get: (_, k) => get(k),
    set: (_, k, v) => { const prev = S.mine[k]; S.mine[k] = v && typeof v === 'object' ? { ...v } : v; shareQueue(k, S.mine[k], prev); return true; },
    deleteProperty: (_, k) => { delete S.mine[k]; return true; },
    has: (_, k) => get(k) !== undefined,
    ownKeys: () => S.tmode === 'shared' ? Object.keys(S.shared) : [...new Set([...Object.keys(S.mine), ...Object.keys(S.shared)])],
    getOwnPropertyDescriptor: (_, k) => { const v = get(k); return v === undefined ? undefined : { value: v, enumerable: true, configurable: true, writable: true }; }
  });
}
const supaH = () => ({ apikey: SUPA_KEY, 'Content-Type': 'application/json' });
function devId() { let d = lsGet('kostroma_dev', ''); if (!d) { d = 'd' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36).slice(-4); lsSet('kostroma_dev', d); } return d; }
const ownerKey = () => lsGet('kostroma_owner', '');
let shareQ = {}; try { shareQ = JSON.parse(lsGet(LS_SHQ, '{}')) || {}; } catch (e) { shareQ = {}; }
let shareTimer = 0;
function shareQueue(k, v, prev) {
  if (lsGet('kostroma_share_off', '') || !KEY_RE.test(k) || parseInt(k) >= LIGHTS_BASE.length) return;   // свои добавленные светофоры пока только локально
  if (!v || !(v.g > 0) || !(v.r > 0) || v.a == null || v.part) return;   // в общую базу — только готовые замеры
  const sync = prev && prev.g === v.g && prev.r === v.r && (prev.y || 0) === (v.y || 0);
  shareQ[k] = { key: k, g: +(+v.g).toFixed(2), y: +(+(v.y || 0)).toFixed(2), r: +(+v.r).toFixed(2), a: Math.round(v.a), src: sync ? 'sync' : 'manual' };
  lsSet(LS_SHQ, JSON.stringify(shareQ));
  clearTimeout(shareTimer); shareTimer = setTimeout(shareFlush, 4000);
}
async function shareFlush() {
  clearTimeout(shareTimer);
  const items = Object.values(shareQ); if (!items.length || !navigator.onLine) return;
  const sec = ownerKey(); let sent = 0, failed = false;
  for (const it of items) {
    const cyc = (it.g + it.y + it.r) * 1000; let a = it.a;
    if (cyc > 0 && Date.now() - a > cyc) a += Math.floor((Date.now() - a) / cyc) * cyc;   // точку отсчёта переносим к текущему циклу
    try {
      const r = sec
        ? await fetch(SUPA_URL + '/rest/v1/rpc/owner_submit', { method: 'POST', headers: supaH(), body: JSON.stringify({ secret: sec, p_key: it.key, p_g: it.g, p_y: it.y, p_r: it.r, p_a: a, p_src: it.src, p_device: devId() }) })
        : await fetch(SUPA_URL + '/rest/v1/timings', { method: 'POST', headers: { ...supaH(), Prefer: 'return=minimal' }, body: JSON.stringify({ key: it.key, g: it.g, y: it.y, r: it.r, a, src: it.src, device: devId() }) });
      if (r.ok) { delete shareQ[it.key]; sent++; sharedLocal({ ...it, a }, !!sec); }
      else if (r.status === 429 || r.status >= 500) { failed = true; break; }
      else {   // запись отклонена (неверные данные или ключ автора) — повторять бесполезно
        delete shareQ[it.key];
        if (sec && /not owner/.test(await r.text())) { lsSet('kostroma_owner', null); toast('Ключ автора не подошёл — замеры отправлены как обычные', 4000); renderShareInfo(); }
      }
    } catch (e) { failed = true; break; }
  }
  lsSet(LS_SHQ, JSON.stringify(shareQ));
  if (failed || Object.keys(shareQ).length) shareTimer = setTimeout(shareFlush, 60000);
  if (sent) renderShareInfo();
}
// свой отправленный замер сразу виден в общей версии, не дожидаясь обновления
function sharedLocal(it, owner) {
  const p = S.shared[it.key], rec = { g: it.g, y: it.y, r: it.r, a: it.a, owner, n: Math.max(1, p ? p.n : 1), at: Date.now() };
  if (!p || owner || !p.owner) S.shared[it.key] = rec;
  else if (Math.abs((p.g + p.y + p.r) - (it.g + it.y + it.r)) <= Math.max(2, 0.04 * (p.g + p.y + p.r))) p.a = it.a;   // у автора те же длительности — обновляем только точку отсчёта
  lsSet(LS_SHARED, JSON.stringify({ t: S.shared, at: S.sharedAt || 0 }));
}
function aggregateShared(rows) {
  const by = {}, out = {};
  for (const x of rows) if (KEY_RE.test(x.key) && parseInt(x.key) < LIGHTS_BASE.length) (by[x.key] = by[x.key] || []).push(x);   // строки — от новых к старым
  for (const [k, list] of Object.entries(by)) {
    const own = list.filter(x => x.owner), base = own[0] || list[0], cyc = base.g + base.y + base.r;
    const same = list.filter(x => Math.abs((x.g + x.y + x.r) - cyc) <= Math.max(2, cyc * 0.04));
    out[k] = { g: base.g, y: base.y, r: base.r, a: same[0].a, owner: own.length > 0, n: new Set(same.map(x => x.device)).size, at: Date.parse(list[0].created_at) };
  }
  return out;
}
async function shareLoad(manual) {
  if (!navigator.onLine) { if (manual) toast('Нет интернета — показываю сохранённую копию общей базы'); return; }
  try {
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const r = await fetch(`${SUPA_URL}/rest/v1/timings?select=key,g,y,r,a,owner,device,created_at&created_at=gte.${since}&order=created_at.desc&limit=10000`, { headers: supaH() });
    if (!r.ok) throw new Error(r.status);
    S.shared = aggregateShared(await r.json()); S.sharedAt = Date.now();
    lsSet(LS_SHARED, JSON.stringify({ t: S.shared, at: S.sharedAt }));
    renderLightList(); renderShareInfo(); if (S.selected != null) loadFields(); else draw();
    if (S.route) computeRoute();
    if (manual) toast('Общая база обновлена: светофоров с данными — ' + Object.keys(S.shared).length);
  } catch (e) { if (manual) toast('Общая база сейчас недоступна — работаю с сохранённой копией'); }
}
function setTmode(m) {
  S.tmode = m; lsSet('kostroma_tmode', m);
  document.querySelectorAll('#tmode button').forEach(b => b.classList.toggle('on', b.dataset.m === m));
  $('tmodeHint').textContent = m === 'shared' ? 'Общие: замеры всех пользователей. Ваши правки тоже попадают сюда.' : 'Мои: ваши замеры; где вы не мерили — общие данные.';
  renderLightList(); if (S.selected != null) loadFields(); else draw();
  if (S.route) computeRoute();
}
function ago(ms) { const s = (Date.now() - ms) / 1000; return s < 90 ? 'только что' : s < 5400 ? Math.round(s / 60) + ' мин назад' : s < 129600 ? Math.round(s / 3600) + ' ч назад' : Math.round(s / 86400) + ' дн назад'; }
function srcLabel(k) {
  const m = S.mine[k], sh = S.shared[k];
  const shTxt = sh ? `общая база: ${sh.owner ? 'данные автора ✓, ' : ''}подтверждений ${sh.n}, обновлено ${ago(sh.at)}` : '';
  if (S.tmode === 'shared') return sh ? 'Показаны общие данные — ' + shTxt : 'В общей базе этого направления пока нет — ваш замер будет первым';
  if (m) return 'Ваш замер' + (sh ? ' · ' + shTxt : '');
  return sh ? 'Вы ещё не мерили — показаны общие данные (' + shTxt.replace('общая база: ', '') + ')' : '';
}
function renderShareInfo() {
  const el = $('shareInfo'); if (!el) return;
  const q = Object.keys(shareQ).length, sec = ownerKey();
  el.textContent = `В общей базе: ${Object.keys(S.shared).length} направлений` + (S.sharedAt ? `, обновлено ${ago(S.sharedAt)}` : '') + (q ? ` · ждут отправки: ${q}` : '');
  $('ownerInfo').textContent = sec ? 'Вы автор: ваши замеры в общей базе главные, чужие их не перебивают.' : 'Ключ не введён — ваши замеры уходят в общую базу как обычные.';
  $('shareOn').checked = !lsGet('kostroma_share_off', '');
}
async function saveOwnerKey() {
  const v = $('ownerKey').value.trim().toUpperCase();
  if (!v) { lsSet('kostroma_owner', null); renderShareInfo(); toast('Ключ автора удалён с этого устройства'); return; }
  try {
    const r = await fetch(SUPA_URL + '/rest/v1/rpc/owner_check', { method: 'POST', headers: supaH(), body: JSON.stringify({ secret: v }) });
    if (r.ok && (await r.json()) === true) {
      lsSet('kostroma_owner', v); $('ownerKey').value = ''; renderShareInfo(); toast('Ключ принят: вы автор');
      for (const [k, t] of Object.entries(S.mine)) shareQueue(k, t, null);   // переотправляем свои замеры уже как автор
    } else toast('Ключ не подошёл');
  } catch (e) { toast('Нет связи с общей базой — попробуйте позже'); }
}

// ======================= ИНИЦИАЛИЗАЦИЯ ==============================
function bind() {
  window.addEventListener('resize', resize);
  $('hideSide').onclick = e => { e.stopPropagation(); setSideHidden(true); };
  $('showSide').onclick = () => { setSideHidden(false); if (window.innerWidth < 760) document.body.classList.add('sheet-open'); };
  // жест по вкладкам: вниз — свернуть (сначала содержимое, потом всю панель), вверх — раскрыть
  { let y0 = null; const tb = document.querySelector('.tabs');
    tb.addEventListener('pointerdown', e => { y0 = e.clientY; try { tb.setPointerCapture(e.pointerId); } catch (_) {} });
    tb.addEventListener('pointerup', e => { if (y0 == null) return; const dy = e.clientY - y0; y0 = null; if (Math.abs(dy) > 40) { tb.dataset.sw = '1'; setTimeout(() => { tb.dataset.sw = ''; }, 400); }
      if (dy > 40) { if (window.innerWidth < 760 && document.body.classList.contains('sheet-open')) document.body.classList.remove('sheet-open'); else setSideHidden(true); }
      else if (dy < -40 && window.innerWidth < 760) document.body.classList.add('sheet-open'); });
    tb.addEventListener('click', e => { if (tb.dataset.sw) { e.stopPropagation(); e.preventDefault(); } }, true);
    tb.addEventListener('pointercancel', () => { y0 = null; }); }
  try { if (localStorage.getItem('kostroma_side_hidden')) setSideHidden(true); } catch (e) {}
  $('zin').onclick = () => zoomBy(1.6); $('zout').onclick = () => zoomBy(1 / 1.6);
  $('zfit').onclick = () => { fitAll(); S.follow = false; draw(); };
  $('locate').onclick = () => locate(false);
  $('q').addEventListener('input', e => doSearch(e.target.value));
  $('q').addEventListener('keydown', e => { if (e.key !== 'Enter') return; e.preventDefault(); const q = e.target.value.trim(); if (!q) return;
    if (S.searchFirst) { S.searchFirst.go(); $('results').hidden = true; e.target.blur(); } else onlineSearch(q); });
  $('bHere').onclick = iAmAtLight; $('bDelLight').onclick = () => { if (S.selected != null) askRemove(S.selected); }; $('bRestore').onclick = restoreRemoved;
  $('pinTo').onclick = () => pinTo('B'); $('pinFrom').onclick = () => pinTo('A'); $('pinX').onclick = hidePin;
  $('q').addEventListener('focus', e => doSearch(e.target.value));
  document.addEventListener('pointerdown', e => { if (!e.target.closest('.searchbox')) $('results').hidden = true; });
  document.querySelectorAll('.tab[data-tab]').forEach(b => b.onclick = () => { if (b.classList.contains('on') && document.body.classList.contains('sheet-open') && window.innerWidth < 760) document.body.classList.remove('sheet-open'); else showTab(b.dataset.tab); });
  $('pickA').onclick = () => pick('A'); $('pickB').onclick = () => pick('B');
  $('meA').onclick = () => { if (!S.me) { locate(); toast('Сначала дождитесь определения местоположения'); return; } S.A = [S.me.x, S.me.y]; S.meRef = S.A; S.Aname = null; updateRouteUI(); computeRoute(); };
  $('swap').onclick = () => { [S.A, S.B] = [S.B, S.A]; [S.Aname, S.Bname] = [S.Bname, S.Aname]; updateRouteUI(); computeRoute(); };
  $('clearRoute').onclick = () => { S.A = S.B = S.route = null; updateRouteUI(); computeRoute(); };
  document.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => { S.mode = b.dataset.mode; updateRouteUI(); computeRoute(); });
  document.querySelectorAll('[data-opt]').forEach(b => b.onclick = () => { S.opt = b.dataset.opt; updateRouteUI(); computeRoute(); });
  $('depart').onchange = e => { S.depart = +e.target.value; computeRoute(); };
  $('lq').addEventListener('input', renderLightList);
  document.querySelectorAll('[data-mk]').forEach(b => {
    b.addEventListener('pointerdown', e => { if (e.button > 0) return; e.preventDefault(); mark(b.dataset.mk, performance.timeOrigin + e.timeStamp); });
    b.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); mark(b.dataset.mk); } });
  });
  $('bReset').onclick = () => { delete S.measBy[S.ek]; saveMeas(); updMeas(); toast('Начат новый замер'); };
  document.querySelectorAll('[data-cd]').forEach(b => b.onclick = () => countdown(b.dataset.cd));
  for (const [id, key] of [['fG', 'g'], ['fY', 'y'], ['fR', 'r']]) $(id).addEventListener('change', () => {
    if (S.selected == null) return;
    const m = getMeas(); m.man[key] = $(id).value.trim() !== ''; saveMeas();
    if (m.ev.length) recompute(m); else updMeas();
  });
  $('bSave').onclick = () => saveLight(false); $('bClear').onclick = clearLight;
  $('bExport').onclick = exportTimings;
  document.querySelectorAll('#tmode button').forEach(b => b.onclick = () => setTmode(b.dataset.m));
  $('shareSync').onclick = () => { shareFlush(); shareLoad(true); };
  $('ownerSave').onclick = saveOwnerKey;
  $('shareOn').onchange = e => { lsSet('kostroma_share_off', e.target.checked ? null : '1'); renderShareInfo(); };
  $('bImport').onclick = () => $('fileIn').click();
  $('fileIn').onchange = e => { if (e.target.files[0]) importTimings(e.target.files[0]); e.target.value = ''; };
  $('reload').onclick = () => loadData(true);
  setInterval(() => { if (document.hidden) return; draw(); tickEditor(); if (!$('pane-lights').hidden && document.activeElement !== $('lq')) {
    const now = Date.now(); $('lightList').querySelectorAll('.li').forEach(d => { const ph = phase(anyRec(S.lights[d.dataset.i]), now); if (ph) { const dot = d.querySelector('.dot'); dot.className = 'dot on'; dot.style.background = `var(${ph.s === 'G' ? '--g' : ph.s === 'Y' ? '--y' : '--r'})`; d.querySelector('.tm').textContent = Math.ceil(ph.left) + ' с'; } }); } }, 500);
}
(function init() {
  loadMy(); renderMyInfo(); bind(); setTmode(S.tmode); renderShareInfo(); resize();
  setTimeout(() => { shareFlush(); shareLoad(false); }, 1500);
  setInterval(() => { if (!document.hidden) { shareFlush(); shareLoad(false); } }, 300000);
  window.addEventListener('online', () => { shareFlush(); shareLoad(false); });
  fitAll(); useFallback(); updateRouteUI(); renderLightList();
  loadData(false);
  locate(true);   // местоположение отслеживается сразу при запуске
  document.addEventListener('visibilitychange', () => { if (!document.hidden && geoWatch == null) locate(true); });
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
