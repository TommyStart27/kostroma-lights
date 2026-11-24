/* Режим АВТО (бета): камера + местоположение.
   Телефон в держателе смотрит вперёд. Пока вы тормозите и стоите у светофора, приложение анализирует
   верхнюю зону кадра (фары и стоп-сигналы машин ниже линии), определяет светофор впереди и направление
   подъезда, выбирает в кадре его огонь и ловит смену сигнала.
   Нажмите на окошко камеры — оно увеличится: можно ткнуть в нужный светофор и поменять высоту зоны.
   Удаляется вместе со строкой <script src="auto.js"> — остальное приложение от него не зависит. */
(function () {
  'use strict';
  if (typeof S === 'undefined' || typeof mark !== 'function') return;

  const st = document.createElement('style');
  st.textContent = `
  #autoBox{position:absolute;left:12px;top:calc(124px + var(--safe-t));width:168px;background:#000;border-radius:12px;overflow:hidden;z-index:7;box-shadow:0 3px 14px rgba(0,0,0,.3);color:#fff;font:12px/1.3 system-ui,-apple-system,sans-serif;cursor:pointer}
  #autoBox[hidden]{display:none}
  #autoBox .vw{position:relative;width:100%;aspect-ratio:16/9;background:#111}
  #autoBox video,#autoBox canvas.ov{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}
  #autoBox canvas.ov{pointer-events:none}
  #autoBox .as{padding:5px 7px}
  #autoBox .as b{display:block;font-size:12px}
  #autoBox .ab{display:none;gap:6px;padding:0 7px 8px;flex-wrap:wrap}
  #autoBox .ab button{font:inherit;font-size:12.5px;border:1px solid #fff5;background:#fff2;color:#fff;border-radius:9px;padding:6px 9px}
  #autoBox.big{left:8px;right:8px;width:auto;max-width:640px;margin:0 auto;top:calc(64px + var(--safe-t));z-index:9;cursor:default}
  #autoBox.big video{cursor:crosshair}
  #autoBox.big .ab{display:flex}
  #autoBox.big .as{font-size:13px}
  #auto.on{background:var(--accent);color:#fff}
  #auto{font-size:11px!important;font-weight:700;letter-spacing:.3px}
  `;
  document.head.appendChild(st);

  const ctrl = document.querySelector('.ctrl');
  const btn = document.createElement('button');
  btn.id = 'auto'; btn.textContent = 'АВТО'; btn.title = 'Авто-замер: камера + местоположение'; btn.setAttribute('aria-label', 'Авто-замер');
  if (ctrl) ctrl.appendChild(btn);
  const box = document.createElement('div');
  box.id = 'autoBox'; box.hidden = true;
  box.innerHTML = `<div class="vw"><video playsinline muted autoplay></video><canvas class="ov"></canvas></div>
    <div class="as"><b id="autoT">АВТО</b><span id="autoS">Запуск…</span></div>
    <div class="ab"><button id="aUp">Зона ▲</button><button id="aDn">Зона ▼</button><button id="aWatch">▶ Следить сейчас</button><button id="aRst">Сбросить выбор</button><button id="aMin">Свернуть</button></div>`;
  (document.getElementById('mapwrap') || document.body).appendChild(box);
  const video = box.querySelector('video'), ovc = box.querySelector('canvas.ov'), octx = ovc.getContext('2d');
  const $a = id => box.querySelector('#' + id);
  const nowE = () => performance.timeOrigin + performance.now();

  // mode: idle — едем быстро (кадр не анализируем), pre — тормозим (копим огни), watch — стоим у светофора
  let on = false, stream = null, wake = null, mode = 'idle';
  let preTried = false, lamps = [], lock = null, lastEvt = 0, stopInfo = null, nEv = 0, pend = null, gotG = false, watchKey = null, holdMsg = 0, lastCH = 0;
  let zone = 0.5;                                    // доля кадра сверху, где ищем огни
  try { const z = parseFloat(localStorage.getItem('kostroma_auto_zone')); if (z >= 0.25 && z <= 0.85) zone = z; } catch (e) {}
  const CW = 480;                                    // ширина кадра для анализа
  const cvs = document.createElement('canvas');
  const cx = cvs.getContext('2d', { willReadFrequently: true });
  const setS = (t, s, hold) => {
    if (t != null) $a('autoT').textContent = t;
    if (s != null && (hold || nowE() > holdMsg)) { $a('autoS').textContent = s; if (hold) holdMsg = nowE() + hold; }
  };
  const lightLbl = () => S.selected == null ? 'светофор не выбран' : '#' + (S.selected + 1) + ' ' + (typeof keyLabel === 'function' ? keyLabel(S.ek) : '');

  async function start() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast('Камера недоступна в этом браузере'); return; }
    if (window.gwCamera && gwCamera.isOpen()) gwCamera.close();
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } }, audio: false });
    } catch (e) { toast('Нет доступа к камере — разрешите его в настройках'); return; }
    video.srcObject = stream; try { await video.play(); } catch (e) {}
    on = true; btn.classList.add('on'); box.hidden = false; mode = 'idle'; resetWatch(); lamps = [];
    if (typeof locate === 'function') locate(true);
    try { if ('wakeLock' in navigator) wake = await navigator.wakeLock.request('screen'); } catch (e) {}
    setS('АВТО включён', 'Еду… Светофоры должны быть выше пунктирной линии. Нажмите на окошко, чтобы увеличить.', 1);
    loop();
  }
  function stop() {
    on = false; btn.classList.remove('on'); box.hidden = true; box.classList.remove('big');
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    try { if (wake) wake.release(); } catch (e) {} wake = null;
    toast(nEv ? `АВТО выключен. Поймано смен сигнала: ${nEv}` : 'АВТО выключен');
  }
  btn.onclick = () => on ? stop() : start();
  document.addEventListener('visibilitychange', async () => { if (on && !document.hidden) { try { if ('wakeLock' in navigator) wake = await navigator.wakeLock.request('screen'); } catch (e) {} } });

  function resetWatch() { lock = null; pend = null; gotG = false; }
  function startWatch(lbl) {
    stopInfo = { t: nowE(), pos: S.me ? [S.me.x, S.me.y] : null }; watchKey = S.ek; mode = 'watch'; resetWatch();   // огни, накопленные при торможении, сохраняем
    const T = S.timings[S.ek];
    setS(lbl, T && T.g > 0 && T.r > 0 ? 'Стою — жду смены сигнала, синхронизирую' : 'Стою — жду смены сигнала, замеряю', 1);
  }
  // вызывается из app.js при остановке
  function onStop(det) {
    if (!det) { if (mode !== 'watch') setS('АВТО', 'Стою, но светофора впереди на карте нет. Выберите его на карте и нажмите на окошко → «▶ Следить».', 1); return; }
    if (mode === 'watch' && watchKey === S.ek) { stopInfo.pos = S.me ? [S.me.x, S.me.y] : stopInfo.pos; return; }   // подползли в очереди к тому же светофору
    startWatch('#' + (det.L.id + 1) + (det.a ? ' ' + det.a.arrow + ' ' + det.a.from : ''));
  }
  function leaveWatch() {
    if (mode !== 'watch') return;
    // красный у выбранного светофора погас, зелёный камера не разглядела, но мы поехали — это был зелёный
    if (pend && !gotG && nowE() - pend.t < 15000) { fire('gs', pend.t, 'по погасшему красному и началу движения'); if (pend.first && typeof addObs === 'function') addObs('R', pend.first, pend.t); }
    mode = 'idle'; resetWatch(); lamps = []; preTried = false; setS('АВТО включён', 'Еду…', 1);
  }
  function onTrack(p) {
    if (!on) return;
    if (mode === 'watch') {
      const far = stopInfo && stopInfo.pos && Math.hypot(p.x - stopInfo.pos[0], p.y - stopInfo.pos[1]) > 15;
      if (p.sp > 3 || far) leaveWatch();
      return;
    }
    if (p.sp < 3.5) { if (mode === 'idle') { mode = 'pre'; lamps = []; preTried = false; } }
    else if (p.sp > 6 && mode === 'pre') { mode = 'idle'; lamps = []; }
  }

  // ---- анализ кадра
  function scan(t) {
    const vw = video.videoWidth, vh = video.videoHeight; if (!vw) return;
    const sh = vh * zone, CH = Math.round(CW * sh / vw); lastCH = CH;
    if (cvs.width !== CW || cvs.height !== CH) { cvs.width = CW; cvs.height = CH; }
    cx.drawImage(video, 0, 0, vw, sh, 0, 0, CW, CH);
    const d = cx.getImageData(0, 0, CW, CH).data, n = CW * CH;
    const cls = new Uint8Array(n);                   // 1 красный, 2 жёлтый, 3 зелёный
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const r = d[p], g = d[p + 1], b = d[p + 2], mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
      if (mx < 140) continue;
      const mn = r < g ? (r < b ? r : b) : (g < b ? g : b), c = mx - mn;
      if (c < 0.25 * mx) continue;                    // белое (фары, засветка) — не сигнал
      let h;
      if (mx === r) h = 60 * (((g - b) / c) % 6); else if (mx === g) h = 60 * ((b - r) / c + 2); else h = 60 * ((r - g) / c + 4);
      if (h < 0) h += 360;
      const sat = c / mx;
      if ((h < 16 || h > 340) && sat > 0.45 && mx > 160) cls[i] = 1;
      else if (h >= 24 && h <= 62 && sat > 0.45 && mx > 160) cls[i] = 2;
      else if (h >= 110 && h <= 200) cls[i] = 3;        // зелёный светодиод в камере бирюзовый и бледный; листва — ниже 110
    }
    const seen = new Uint8Array(n), blobs = [], stack = [];
    for (let i = 0; i < n; i++) {
      if (!cls[i] || seen[i]) continue;
      const c = cls[i]; let area = 0, sx = 0, sy = 0; stack.push(i); seen[i] = 1;
      while (stack.length) {
        const k = stack.pop(), x = k % CW; area++; sx += x; sy += (k - x) / CW;
        if (x > 0 && !seen[k - 1] && cls[k - 1] === c) { seen[k - 1] = 1; stack.push(k - 1); }
        if (x < CW - 1 && !seen[k + 1] && cls[k + 1] === c) { seen[k + 1] = 1; stack.push(k + 1); }
        if (k >= CW && !seen[k - CW] && cls[k - CW] === c) { seen[k - CW] = 1; stack.push(k - CW); }
        if (k + CW < n && !seen[k + CW] && cls[k + CW] === c) { seen[k + CW] = 1; stack.push(k + CW); }
      }
      if (area >= 2 && area <= 700) blobs.push({ x: sx / area, y: sy / area, c, a: area });
    }
    // сопоставляем с огнями прошлых кадров (погасший недавно огонь «оживает» — так переживаем мигание зелёного)
    for (const b of blobs) {
      let m = null, md = 4 + Math.sqrt(b.a);
      for (const L of lamps) { if (L.c !== b.c || L.hit === t) continue; const dd = Math.hypot(L.x - b.x, L.y - b.y); if (dd < md) { md = dd; m = L; } }
      if (m) { m.x = b.x; m.y = b.y; m.a = b.a; m.last = t; m.n++; m.hit = t; if (m.gone) { m.gone = 0; m.pendDone = false; } }
      else lamps.push({ x: b.x, y: b.y, c: b.c, a: b.a, first: t, last: t, n: 1, gone: 0, hit: t });
    }
    for (const L of lamps) if (!L.gone && t - L.last > 250) L.gone = L.last + 33;
    lamps = lamps.filter(L => !L.gone || t - L.gone < 3000);
    if (lock && lock.y > CH) lock = null;
    for (const L of lamps) if (!L.gone && (!L.h || t - L.h[L.h.length - 1].t > 200)) { (L.h = L.h || []).push({ x: L.x, y: L.y, t }); if (L.h.length > 8) L.h.shift(); }
    if (mode === 'pre' && !preTried && stillCam(t)) camStop();
    if (mode === 'watch') events(t, CH);
    if (box.classList.contains('big') || mode !== 'idle') drawOv();
  }

  // огни в кадре стоят на месте уже секунду — машина остановилась (GPS сообщает об этом на несколько секунд позже)
  function stillCam(t) {
    return lamps.some(L => !L.gone && L.n >= 20 && L.h && L.h.length >= 5 && (() => { const o = L.h.find(q => t - q.t >= 900); return o && Math.hypot(o.x - L.x, o.y - L.y) < 1.5; })());
  }
  function camStop() {
    preTried = true;
    const det = typeof detectAhead === 'function' ? detectAhead() : null;
    if (det) { if (typeof pickDet === 'function') pickDet(det); else selectLight(det.L.id, false, det.key); startWatch('#' + (det.L.id + 1) + (det.a ? ' ' + det.a.arrow + ' ' + det.a.from : '')); }
  }
  const near = (L, k) => lock && Math.hypot(lock.x - L.x, lock.y - L.y) < lock.r * (k || 1);
  const diam = L => 1.13 * Math.sqrt(L.a);
  function events(t, CH) {
    // 1) автовыбор светофора: устойчивый красный или зелёный — выше, крупнее и ближе к центру
    if (!lock && t - stopInfo.t > 1200) {
      let best = null, bs = 0;
      for (const L of lamps) if (!L.gone && L.n >= 10 && (L.c === 1 || L.c === 3) && L.a <= 300) {   // огонь светофора небольшой; крупные пятна — листва, вывески
        const s = Math.sqrt(L.a) * (1.3 - L.y / CH) * (1.25 - Math.abs(L.x / CW - 0.55)) * (L.c === 1 ? 3 : 1);   // стоим обычно на красный — он в приоритете
        if (s > bs) { bs = s; best = L; }
      }
      if (best) lock = { x: best.x, y: best.y, r: 16 + 5 * Math.sqrt(best.a), auto: true };
    }
    if (lock && lock.auto) { const own = lamps.find(L => !L.gone && L.n >= 5 && near(L)); if (own) { lock.x += (own.x - lock.x) * 0.05; lock.y += (own.y - lock.y) * 0.05; } }
    // 2) красный у выбранного светофора погас — кандидат на «начало зелёного»
    if (lock && !gotG) for (const L of lamps) if (L.c === 1 && L.gone && !L.pendDone && L.n >= 8 && near(L)) { L.pendDone = true; pend = { t: L.gone, first: L.first }; }
    if (pend) {
      // снова виден красный у этого светофора — значит, его заслонили или это мигали цифры табло
      if (lamps.some(L => L.c === 1 && !L.gone && near(L) && L.last > pend.t + 400)) pend = null;
      else if (t - pend.t > 15000) pend = null;
    }
    // 3) новый огонь, а рядом в той же секции погас огонь другого цвета → смена сигнала
    for (const L of lamps) {
      if (L.done || L.gone || L.n < 3) continue;
      if (t - L.first > 2500) { L.done = true; continue; }
      if (L.first - stopInfo.t < 600) { L.done = true; continue; }
      if (t - L.first < 900) continue;                   // новый цвет должен продержаться почти секунду — иначе это мерцание
      if (lock && !near(L, 1.3)) continue;
      const dl = diam(L);
      // сколько должен был гореть прежний цвет, чтобы смена считалась настоящей (жёлтый горит 3 с, зелёный и красный — дольше)
      const minOld = { '1>3': 2000, '3>2': 2000, '2>1': 1500, '3>1': 2000 };
      const old = lamps.find(O => {
        if (!O.gone || O.c === L.c || Math.abs(O.gone - L.first) > 900 || (lock && !near(O, 1.3))) return false;
        const mo = minOld[O.c + '>' + L.c]; if (!mo || O.gone - O.first < mo) return false;
        const dd = Math.hypot(O.x - L.x, O.y - L.y), dm = Math.max(dl, diam(O));
        return dd <= 4.5 * dm + 6 && dd >= 0.7 * dm;   // соседняя секция того же светофора, а не тот же огонь другим оттенком
      });
      let evt = old && { '1>3': 'gs', '3>2': 'ge', '2>1': 'rs', '3>1': 'rs' }[old.c + '>' + L.c];
      let how = '';
      if (!evt && L.c === 3 && pend && L.first - pend.t > -400 && L.first - pend.t < 2500) { evt = 'gs'; how = 'красный погас, рядом зелёный'; }
      if (!evt || L.first - lastEvt < 800) continue;
      L.done = true; lastEvt = L.first;
      if (!lock || lock.auto) lock = { x: old ? (L.x + old.x) / 2 : L.x, y: old ? (L.y + old.y) / 2 : L.y, r: 16 + 5 * Math.max(Math.sqrt(L.a), old ? Math.sqrt(old.a) : 0), auto: true };
      const te = evt === 'gs' && pend && Math.abs(pend.t - L.first) < 1000 ? Math.min(pend.t, L.first) : L.first;
      fire(evt, te, how);
      // красный горел с того момента, как камера его впервые увидела, — для оценки длины красного
      const redFrom = old && old.c === 1 ? old.first : pend && pend.first;
      if (evt === 'gs' && redFrom && typeof addObs === 'function') addObs('R', redFrom, te);
      if (evt === 'gs') { gotG = true; pend = null; }
    }
    const cnt = [0, 0, 0, 0]; for (const L of lamps) if (!L.gone && L.n >= 3 && (!lock || near(L))) cnt[L.c]++;
    setS(null, (lock ? (lock.auto ? 'Слежу (выбрал сам)' : 'Слежу за выбранным') : 'Ищу светофор в кадре') + ` · 🔴${cnt[1]} 🟡${cnt[2]} 🟢${cnt[3]}` + (pend ? ' · красный погас…' : ''));
  }

  // разметка поверх видео: линия зоны, найденные огни, выбранный светофор
  function drawOv() {
    const r = ovc.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    if (!r.width) return;
    if (ovc.width !== Math.round(r.width * dpr) || ovc.height !== Math.round(r.height * dpr)) { ovc.width = Math.round(r.width * dpr); ovc.height = Math.round(r.height * dpr); }
    const vw = video.videoWidth, vh = video.videoHeight; octx.setTransform(dpr, 0, 0, dpr, 0, 0); octx.clearRect(0, 0, r.width, r.height);
    if (!vw) return;
    const k = Math.min(r.width / vw, r.height / vh), ox = (r.width - vw * k) / 2, oy = (r.height - vh * k) / 2, s = vw / CW * k;
    octx.fillStyle = 'rgba(0,0,0,.35)'; octx.fillRect(ox, oy + vh * zone * k, vw * k, vh * (1 - zone) * k);   // ниже линии не смотрим
    octx.strokeStyle = 'rgba(255,255,255,.7)'; octx.setLineDash([5, 4]); octx.lineWidth = 1;
    octx.beginPath(); octx.moveTo(ox, oy + vh * zone * k); octx.lineTo(ox + vw * k, oy + vh * zone * k); octx.stroke(); octx.setLineDash([]);
    for (const L of lamps) { if (L.gone || L.n < 3) continue; octx.strokeStyle = ['', '#ff4d3d', '#ffc21a', '#2ee88a'][L.c]; octx.lineWidth = 1.5; octx.beginPath(); octx.arc(ox + L.x * s, oy + L.y * s, Math.max(3, diam(L) * s * 0.7), 0, 7); octx.stroke(); }
    if (lock) { octx.strokeStyle = '#fff'; octx.lineWidth = 2; octx.setLineDash(lock.auto ? [4, 3] : []); octx.beginPath(); octx.arc(ox + lock.x * s, oy + lock.y * s, lock.r * s, 0, 7); octx.stroke(); octx.setLineDash([]); }
  }
  // нажатие на увеличенное видео — выбрать светофор вручную
  video.addEventListener('pointerdown', e => {
    if (!box.classList.contains('big')) return;
    e.stopPropagation(); e.preventDefault();
    const r = video.getBoundingClientRect(), vw = video.videoWidth, vh = video.videoHeight; if (!vw) return;
    const k = Math.min(r.width / vw, r.height / vh), ox = (r.width - vw * k) / 2, oy = (r.height - vh * k) / 2;
    const vx = (e.clientX - r.left - ox) / k, vy = (e.clientY - r.top - oy) / k;
    if (vx < 0 || vy < 0 || vx > vw || vy > vh) return;
    if (vy > vh * zone - 10) { zone = Math.min(0.85, vy / vh + 0.1); saveZone(); }   // светофор ниже линии — опускаем её
    const sc = CW / vw;
    lock = { x: vx * sc, y: vy * sc, r: 40, auto: false }; pend = null; gotG = false;
    if (S.selected == null && typeof detectAhead === 'function') { const det = detectAhead(); if (det) selectLight(det.L.id, false, det.key); }
    if (mode !== 'watch') startWatch(lightLbl());
    lock = { x: vx * sc, y: vy * sc, r: 40, auto: false };
    setS(null, S.selected == null ? 'Светофор в кадре выбран, но на карте не выбран — выберите его на карте' : 'Светофор выбран — слежу за ним', 3000);
  });
  function saveZone() { try { localStorage.setItem('kostroma_auto_zone', zone.toFixed(2)); } catch (e) {} }
  box.addEventListener('click', e => {
    if (e.target.closest('.ab') || box.classList.contains('big')) return;
    box.classList.add('big'); setS(null, 'Ткните в светофор на видео, чтобы следить именно за ним', 4000);
  });
  $a('aMin').onclick = () => box.classList.remove('big');
  $a('aUp').onclick = () => { zone = Math.max(0.25, zone - 0.07); saveZone(); setS(null, `Зона поиска: верхние ${Math.round(zone * 100)}% кадра`, 2000); };
  $a('aDn').onclick = () => { zone = Math.min(0.85, zone + 0.07); saveZone(); setS(null, `Зона поиска: верхние ${Math.round(zone * 100)}% кадра`, 2000); };
  $a('aRst').onclick = () => { lock = null; pend = null; setS(null, 'Выбор сброшен — ищу светофор сам', 2000); };
  $a('aWatch').onclick = () => {
    if (S.selected == null && typeof detectAhead === 'function') { const det = detectAhead(); if (det) selectLight(det.L.id, false, det.key); }
    if (S.selected == null) { toast('Сначала выберите светофор на карте'); return; }
    startWatch(lightLbl());
  };

  function fire(evt, t, how) {
    if (S.selected == null) return;
    nEv++;
    const k = S.ek, T0 = S.timings[k], known = T0 && T0.g > 0 && T0.r > 0 ? { ...T0 } : null;
    mark(evt, t, true);                                   // точное время события, даже если оно было несколько секунд назад
    const nm = { gs: 'загорелся зелёный', ge: 'загорелся жёлтый', rs: 'загорелся красный' }[evt] + (how ? ' (' + how + ')' : '');
    if (known) {                                          // тайминг уже известен — подправляем точку отсчёта (начало зелёного)
      const a = evt === 'gs' ? t : evt === 'ge' ? t - known.g * 1000 : t - (known.g + (known.y || 0)) * 1000;
      const T = S.timings[k] || known, cyc = known.g + (known.y || 0) + known.r;
      let drift = '';
      if (known.a != null) { let dd = ((a - known.a) / 1000) % cyc; if (dd > cyc / 2) dd -= cyc; if (dd < -cyc / 2) dd += cyc; drift = ` (сдвиг ${dd >= 0 ? '+' : ''}${dd.toFixed(1)} с)`; }
      T.a = a; S.timings[k] = T; saveTimings(); if (typeof loadFields === 'function') loadFields();
      setS(null, '✓ ' + nm + ', синхронизировано' + drift, 3000); toast('АВТО: #' + (S.selected + 1) + ' синхронизирован' + drift);
    } else { setS(null, '✓ ' + nm, 3000); toast('АВТО: #' + (S.selected + 1) + ' — ' + nm); }
    try { if (navigator.vibrate) navigator.vibrate(30); } catch (e) {}
    if (S.route) computeRoute();
  }

  function loop() {
    if (!on) return;
    const tick = (now, meta) => {
      if (!on) return;
      const base = meta && (meta.captureTime || meta.expectedDisplayTime);
      const t = performance.timeOrigin + (base || performance.now());
      try { if (mode !== 'idle') scan(t); else if (box.classList.contains('big')) drawOv(); } catch (e) {}
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(tick); else requestAnimationFrame(tick);
    };
    if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(tick); else requestAnimationFrame(tick);
  }
  window.gwAuto = {
    get on() { return on; }, onStop, onTrack, start, stop,
    _state: () => ({ mode, lock, pend, gotG, lamps: lamps.filter(L => !L.gone).map(L => [L.c, Math.round(L.x), Math.round(L.y), L.n]), zone, nEv }),
    _watch: lbl => startWatch(lbl || 'test'), _leave: leaveWatch
  };
})();
