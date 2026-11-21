/* Режим АВТО (бета): камера + местоположение.
   Телефон в держателе смотрит вперёд. Когда вы останавливаетесь, приложение само определяет светофор впереди
   и направление подъезда, ищет в кадре сигналы и ловит момент смены цвета: красный погас — рядом загорелся зелёный.
   Если для этого подъезда уже есть тайминг — подправляет точку отсчёта (синхронизация), иначе копит замер.
   Удаляется вместе со строкой <script src="auto.js"> — остальное приложение от него не зависит. */
(function () {
  'use strict';
  if (typeof S === 'undefined' || typeof mark !== 'function') return;

  const st = document.createElement('style');
  st.textContent = `
  #autoBox{position:absolute;left:12px;top:calc(124px + var(--safe-t));width:150px;background:#000;border-radius:12px;overflow:hidden;z-index:7;box-shadow:0 3px 14px rgba(0,0,0,.3);color:#fff;font:12px/1.3 system-ui,-apple-system,sans-serif}
  #autoBox[hidden]{display:none}
  #autoBox video{display:block;width:150px;height:84px;object-fit:cover;background:#111}
  #autoBox .as{padding:5px 7px}
  #autoBox .as b{display:block;font-size:12px}
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
  box.innerHTML = '<video playsinline muted autoplay></video><div class="as"><b id="autoT">АВТО</b><span id="autoS">Запуск…</span></div>';
  (document.getElementById('mapwrap') || document.body).appendChild(box);
  const video = box.querySelector('video');

  let on = false, stream = null, wake = null, mode = 'idle';   // idle — едем, watch — стоим у светофора
  let lamps = [], lock = null, lastEvt = 0, stopInfo = null, nEv = 0;
  const CW = 480;                                   // ширина кадра для анализа (берём верхние 65% картинки)
  const cvs = document.createElement('canvas');
  const cx = cvs.getContext('2d', { willReadFrequently: true });

  const setS = (t, s) => { if (t != null) box.querySelector('#autoT').textContent = t; if (s != null) box.querySelector('#autoS').textContent = s; };

  async function start() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast('Камера недоступна в этом браузере'); return; }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } }, audio: false });
    } catch (e) { toast('Нет доступа к камере — разрешите его в настройках'); return; }
    video.srcObject = stream; try { await video.play(); } catch (e) {}
    on = true; btn.classList.add('on'); box.hidden = false; mode = 'idle'; lamps = []; lock = null;
    if (typeof locate === 'function') locate(true);
    try { if ('wakeLock' in navigator) wake = await navigator.wakeLock.request('screen'); } catch (e) {}
    setS('АВТО включён', 'Еду… остановлюсь у светофора — начну замер');
    toast('АВТО: телефон в держателе камерой вперёд. Всё остальное приложение сделает само.', 4500);
    loop();
  }
  function stop() {
    on = false; btn.classList.remove('on'); box.hidden = true;
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    try { if (wake) wake.release(); } catch (e) {} wake = null;
    toast(nEv ? `АВТО выключен. Поймано смен сигнала: ${nEv}` : 'АВТО выключен');
  }
  btn.onclick = () => on ? stop() : start();
  document.addEventListener('visibilitychange', async () => { if (on && !document.hidden) { try { if ('wakeLock' in navigator) wake = await navigator.wakeLock.request('screen'); } catch (e) {} } });

  // остановка у светофора (вызывается из app.js)
  function onStop(det, lbl) {
    stopInfo = { det, lbl, t: Date.now() }; mode = 'watch'; lamps = []; lock = null;
    const T = S.timings[S.ek];
    setS('#' + (det.L.id + 1) + (det.a ? ' ' + det.a.arrow + ' ' + det.a.from : ''), T ? 'Жду смены сигнала — синхронизирую' : 'Жду смены сигнала — замеряю');
  }
  function onTrack(p) {
    if (mode === 'watch' && p.sp > 3) { mode = 'idle'; lamps = []; lock = null; setS('АВТО включён', 'Еду…'); }
  }

  // ---- поиск огней светофора в кадре
  function scan(t) {
    const vw = video.videoWidth, vh = video.videoHeight; if (!vw) return;
    const sh = vh * 0.65, CH = Math.round(CW * sh / vw);
    if (cvs.width !== CW || cvs.height !== CH) { cvs.width = CW; cvs.height = CH; }
    cx.drawImage(video, 0, 0, vw, sh, 0, 0, CW, CH);
    const d = cx.getImageData(0, 0, CW, CH).data, n = CW * CH;
    const cls = new Uint8Array(n);                   // 1 красный, 2 жёлтый, 3 зелёный
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const r = d[p], g = d[p + 1], b = d[p + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      if (mx < 170 || mx - mn < 0.42 * mx) continue;
      let h; const c = mx - mn;
      if (mx === r) h = 60 * (((g - b) / c) % 6); else if (mx === g) h = 60 * ((b - r) / c + 2); else h = 60 * ((r - g) / c + 4);
      if (h < 0) h += 360;
      cls[i] = (h < 16 || h > 340) ? 1 : (h >= 24 && h <= 62) ? 2 : (h >= 115 && h <= 195) ? 3 : 0;
    }
    // связные пятна
    const seen = new Uint8Array(n), blobs = [], stack = [];
    for (let i = 0; i < n; i++) {
      if (!cls[i] || seen[i]) continue;
      const c = cls[i]; let area = 0, sx = 0, sy = 0; stack.push(i); seen[i] = 1;
      while (stack.length) {
        const k = stack.pop(), x = k % CW, y = (k / CW) | 0; area++; sx += x; sy += y;
        if (area > 500) continue;
        for (const q of [k - 1, k + 1, k - CW, k + CW]) if (q >= 0 && q < n && !seen[q] && cls[q] === c && Math.abs((q % CW) - x) <= 1) { seen[q] = 1; stack.push(q); }
      }
      if (area >= 2 && area <= 400) blobs.push({ x: sx / area, y: sy / area, c, a: area });
    }
    // сопоставляем с огнями прошлых кадров
    for (const b of blobs) {
      let m = null, md = 4 + Math.sqrt(b.a);
      for (const L of lamps) { if (L.c !== b.c) continue; const dd = Math.hypot(L.x - b.x, L.y - b.y); if (dd < md) { md = dd; m = L; } }
      if (m) { m.x = b.x; m.y = b.y; m.a = b.a; m.last = t; m.n++; } else lamps.push({ x: b.x, y: b.y, c: b.c, a: b.a, first: t, last: t, n: 1, gone: 0 });
    }
    for (const L of lamps) if (!L.gone && t - L.last > 250) L.gone = L.last;
    lamps = lamps.filter(L => !L.gone || t - L.gone < 1500);
    // новый огонь (устойчиво 3+ кадров), а рядом по вертикали погас огонь другого цвета → смена сигнала
    for (const L of lamps) {
      if (L.done || L.gone || L.n < 3) continue;
      if (t - L.first > 1000) { L.done = true; continue; }   // пару погасшего огня ищем в течение секунды после появления
      if (t - (stopInfo ? stopInfo.t : 0) < 600) continue;
      const D = Math.max(8, 6 * Math.sqrt(L.a));
      if (lock && Math.hypot(lock.x - L.x, lock.y - L.y) > 10 + 4.5 * Math.sqrt(L.a)) continue;   // после первой смены следим только за этим светофором
      const old = lamps.find(O => O.gone && O.c !== L.c && Math.abs(O.gone - L.first) < 700 && Math.abs(O.x - L.x) < D * 0.7 && Math.abs(O.y - L.y) < D * 1.6);
      if (!old) continue;
      const tr = old.c + '>' + L.c, evt = { '1>3': 'gs', '3>2': 'ge', '2>1': 'rs', '3>1': 'rs' }[tr];
      if (!evt || L.first - lastEvt < 800) continue;
      L.done = true; lastEvt = L.first; lock = { x: (L.x + old.x) / 2, y: (L.y + old.y) / 2 };
      fire(evt, L.first);
    }
    const cnt = [0, 0, 0, 0]; for (const L of lamps) if (!L.gone && L.n >= 3) cnt[L.c]++;
    if (mode === 'watch') setS(null, `Жду смены сигнала · вижу 🔴${cnt[1]} 🟡${cnt[2]} 🟢${cnt[3]}`);
  }
  function fire(evt, t) {
    if (S.selected == null) return;
    nEv++;
    const k = S.ek, T = S.timings[k];
    mark(evt, t);
    const nm = { gs: 'загорелся зелёный', ge: 'загорелся жёлтый', rs: 'загорелся красный' }[evt];
    if (evt === 'gs' && T && T.g > 0 && T.r >= 0) {            // тайминг уже известен — обновляем точку отсчёта
      const was = T.a; T.a = t; saveTimings(); if (typeof loadFields === 'function') loadFields();
      let drift = ''; if (was != null) { const cyc = T.g + (T.y || 0) + T.r; let dd = ((t - was) / 1000) % cyc; if (dd > cyc / 2) dd -= cyc; drift = ` (сдвиг ${dd >= 0 ? '+' : ''}${dd.toFixed(1)} с)`; }
      setS(null, '✓ ' + nm + ', синхронизировано' + drift); toast('АВТО: #' + (S.selected + 1) + ' синхронизирован' + drift);
    } else { setS(null, '✓ ' + nm); toast('АВТО: #' + (S.selected + 1) + ' — ' + nm); }
    if (navigator.vibrate) navigator.vibrate(30);
    if (S.route) computeRoute();
  }

  function loop() {
    if (!on) return;
    const tick = (now, meta) => {
      if (!on) return;
      const t = performance.timeOrigin + (meta && meta.expectedDisplayTime ? meta.expectedDisplayTime : performance.now());
      if (mode === 'watch') { try { scan(t); } catch (e) {} }
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(tick); else requestAnimationFrame(tick);
    };
    if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(tick); else requestAnimationFrame(tick);
  }
  box.onclick = () => { if (typeof selectLight === 'function' && S.selected != null) { selectLight(S.selected, true, S.ek); showTab('lights'); } };
  window.gwAuto = { get on() { return on; }, onStop, onTrack, start, stop, _scan: scan, _fire: fire };
})();
