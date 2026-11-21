/* Авто-замер светофора камерой (прототип).
   Телефон в держателе, касание по светофору на экране → приложение следит за цветом в этой точке
   и само жмёт «Начало зелёного» / «Конец зелёного» / «Начало красного» в момент смены сигнала.
   Отключается удалением этого файла и строки <script src="camera.js"> — остальное приложение от него не зависит. */
(function () {
  'use strict';
  if (typeof S === 'undefined' || typeof mark !== 'function') return;

  const st = document.createElement('style');
  st.textContent = `
  #camOv{position:fixed;inset:0;background:#000;z-index:50;display:flex;flex-direction:column;color:#fff;font:14px/1.35 system-ui,-apple-system,sans-serif}
  #camOv video{flex:1;min-height:0;width:100%;object-fit:contain;background:#000;touch-action:none}
  #camOv .ct{position:absolute;top:0;left:0;right:0;display:flex;align-items:center;gap:8px;padding:calc(10px + env(safe-area-inset-top,0px)) 12px 10px;background:linear-gradient(#000c,#0000)}
  #camOv .ct b{flex:1;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #camOv button{font:inherit;border:1px solid #fff5;background:#fff2;color:#fff;border-radius:10px;padding:7px 12px}
  #camOv .roi{position:absolute;border:2px solid #fff;border-radius:8px;box-shadow:0 0 0 2px #0008;pointer-events:none}
  #camOv .cb{padding:10px 12px calc(12px + env(safe-area-inset-bottom,0px));background:#111;display:flex;flex-direction:column;gap:8px}
  #camOv .row{display:flex;align-items:center;gap:10px}
  #camOv .lamp{width:22px;height:22px;border-radius:50%;background:#333;flex:none;box-shadow:0 0 0 2px #fff3}
  #camOv .st{flex:1}
  #camOv .lg{font-size:12.5px;color:#bbb;font-variant-numeric:tabular-nums;max-height:64px;overflow:auto}
  #camOv input[type=range]{flex:1}
  #camOv small{color:#aaa}
  `;
  document.head.appendChild(st);

  let ov, video, roiEl, stream = null, running = false, wakeLock = null;
  let roi = null;            // {cx, cy} в долях видимой картинки, size в px экрана
  let roiSize = 44;
  let colorState = null;     // подтверждённый цвет: 'G' | 'Y' | 'R'
  let run = { c: null, n: 0, t0: 0 };   // текущая серия одинаковых кадров
  const NEED = 3;            // сколько кадров подряд нужно, чтобы поверить в смену цвета (~0,1 с)
  const cvs = document.createElement('canvas'); cvs.width = cvs.height = 24;
  const cx = cvs.getContext('2d', { willReadFrequently: true });
  const events = [];

  function nearestLight() {
    if (!S.me) return null;
    let best = null, bd = 160;
    for (const L of S.lights) { if (L.off) continue; const d = Math.hypot(L.x - S.me.x, L.y - S.me.y); if (d < bd) { bd = d; best = L; } }
    return best;
  }

  function build() {
    ov = document.createElement('div'); ov.id = 'camOv';
    ov.innerHTML = `<video playsinline muted autoplay></video><div class="roi" hidden></div>
      <div class="ct"><b id="camT"></b><button id="camX">Готово</button></div>
      <div class="cb">
        <div class="row"><span class="lamp" id="camL"></span><span class="st" id="camS">Коснитесь светофора на экране</span></div>
        <div class="row"><small>Рамка</small><input id="camZ" type="range" min="14" max="140" value="${roiSize}"></div>
        <div class="lg" id="camLog"></div>
      </div>`;
    document.body.appendChild(ov);
    video = ov.querySelector('video'); roiEl = ov.querySelector('.roi');
    ov.querySelector('#camX').onclick = close;
    ov.querySelector('#camZ').oninput = e => { roiSize = +e.target.value; placeRoi(); };
    video.addEventListener('pointerdown', e => {
      const r = video.getBoundingClientRect();
      roi = { fx: (e.clientX - r.left) / r.width, fy: (e.clientY - r.top) / r.height };
      colorState = null; run = { c: null, n: 0, t0: 0 };
      placeRoi(); setStatus(null, 'Слежу за сигналом…');
    });
  }
  function placeRoi() {
    if (!roi) { roiEl.hidden = true; return; }
    const r = video.getBoundingClientRect(), o = ov.getBoundingClientRect();
    roiEl.hidden = false;
    roiEl.style.width = roiEl.style.height = roiSize + 'px';
    roiEl.style.left = (r.left - o.left + roi.fx * r.width - roiSize / 2) + 'px';
    roiEl.style.top = (r.top - o.top + roi.fy * r.height - roiSize / 2) + 'px';
  }
  function setStatus(c, text) {
    ov.querySelector('#camL').style.background = c === 'G' ? '#1fbf62' : c === 'Y' ? '#f0b400' : c === 'R' ? '#e5392c' : '#333';
    ov.querySelector('#camS').textContent = text;
  }
  function logEv(t, text) {
    events.unshift(fmtT(t) + '.' + String(Math.floor(t % 1000 / 100)) + '  ' + text);
    ov.querySelector('#camLog').innerHTML = events.slice(0, 6).map(s => '<div>' + s + '</div>').join('');
  }

  // классификация цвета в рамке
  function classify() {
    const vw = video.videoWidth, vh = video.videoHeight; if (!vw || !roi) return null;
    const r = video.getBoundingClientRect();
    const k = Math.min(r.width / vw, r.height / vh);            // object-fit: contain
    const dx = (r.width - vw * k) / 2, dy = (r.height - vh * k) / 2;
    const px = (roi.fx * r.width - dx) / k, py = (roi.fy * r.height - dy) / k, half = roiSize / 2 / k;
    if (px < 0 || py < 0 || px > vw || py > vh) return null;
    cx.drawImage(video, Math.max(0, px - half), Math.max(0, py - half), half * 2, half * 2, 0, 0, 24, 24);
    const d = cx.getImageData(0, 0, 24, 24).data;
    let R = 0, Y = 0, G = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r8 = d[i], g8 = d[i + 1], b8 = d[i + 2];
      const mx = Math.max(r8, g8, b8), mn = Math.min(r8, g8, b8);
      if (mx < 140 || mx - mn < 50) continue;                    // только яркие и насыщенные пиксели
      let h;
      if (mx === r8) h = 60 * (((g8 - b8) / (mx - mn)) % 6);
      else if (mx === g8) h = 60 * ((b8 - r8) / (mx - mn) + 2);
      else h = 60 * ((r8 - g8) / (mx - mn) + 4);
      if (h < 0) h += 360;
      if (h < 22 || h > 330) R++; else if (h < 70) Y++; else if (h >= 85 && h <= 200) G++;
    }
    const min = 6, best = Math.max(R, Y, G);
    if (best < min) return 'off';
    return best === R ? 'R' : best === Y ? 'Y' : 'G';
  }

  function onFrame(tFrame) {
    const c = classify();
    if (c && c !== 'off') {
      if (c === run.c) run.n++; else run = { c, n: 1, t0: tFrame };
      if (run.n === NEED && c !== colorState) commit(c, run.t0);
    }
    // 'off' (мигание зелёного, промежуток между кадрами) не считаем сменой сигнала
  }
  function commit(c, t) {
    const prev = colorState; colorState = c;
    const name = { G: 'зелёный', Y: 'жёлтый', R: 'красный' }[c];
    setStatus(c, 'Горит ' + name);
    if (prev == null) { logEv(t, 'вижу ' + name + ' (начало замера)'); return; }
    if (c === 'G') { mark('gs', t); logEv(t, '→ начало зелёного'); }
    else if (c === 'Y' && prev === 'G') { mark('ge', t); logEv(t, '→ конец зелёного (жёлтый)'); }
    else if (c === 'R' && prev !== 'R') { mark('rs', t); logEv(t, '→ начало красного'); }
    else if (c === 'Y' && prev === 'R') { colorState = 'R'; logEv(t, 'красный + жёлтый (ждём зелёный)'); }
  }

  function loop() {
    if (!running) return;
    const tick = (now, meta) => {
      if (!running) return;
      // время кадра в эпохе: момент показа кадра, если браузер его сообщает
      const t = performance.timeOrigin + (meta && meta.expectedDisplayTime ? meta.expectedDisplayTime : performance.now());
      try { onFrame(t); } catch (e) {}
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(tick); else requestAnimationFrame(tick);
    };
    if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(tick); else requestAnimationFrame(tick);
  }

  async function open() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast('Камера недоступна в этом браузере'); return; }
    const near = nearestLight();
    if (near && near.id !== S.selected) { selectLight(near.id, true); toast('Выбран ближайший светофор: #' + (near.id + 1)); }
    if (S.selected == null) { toast('Сначала выберите светофор на карте'); return; }
    if (!ov) build();
    ov.style.display = 'flex';
    const L = S.lights[S.selected];
    ov.querySelector('#camT').textContent = '#' + (L.id + 1) + ' ' + (L.name || 'Светофор') + ' · ' + ($('fMain').value || '');
    events.length = 0; ov.querySelector('#camLog').innerHTML = '';
    roi = null; colorState = null; placeRoi(); setStatus(null, 'Коснитесь светофора на экране');
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } }, audio: false });
      video.srcObject = stream; await video.play();
      running = true; loop();
      try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
    } catch (e) {
      setStatus(null, 'Нет доступа к камере: разрешите его в настройках браузера');
    }
  }
  function close() {
    running = false;
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    try { if (wakeLock) wakeLock.release(); } catch (e) {} wakeLock = null;
    if (ov) ov.style.display = 'none';
    if (typeof updMeas === 'function') updMeas();
  }
  window.addEventListener('resize', () => { if (ov && ov.style.display !== 'none') placeRoi(); });

  // кнопка в редакторе светофора
  const anchor = document.querySelector('.cd');
  if (anchor) {
    const b = document.createElement('button');
    b.id = 'bCam'; b.type = 'button'; b.textContent = '📷 Авто-замер камерой (бета)';
    b.style.cssText = 'width:100%;margin-top:8px;padding:8px 10px;font-size:13px';
    b.onclick = open;
    anchor.insertAdjacentElement('afterend', b);
  }
  window.gwCamera = { open, close, _classify: classify, _commit: commit };
})();
