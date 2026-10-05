'use strict';

// ---------- Telegram ----------
const tg = window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData !== undefined
  ? window.Telegram.WebApp : null;
if (tg) {
  tg.ready();
  tg.expand();
  try { tg.disableVerticalSwipes && tg.disableVerticalSwipes(); } catch (e) {}
  try { tg.setHeaderColor('#0e0e12'); tg.setBackgroundColor('#0e0e12'); } catch (e) {}
}
const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) ||
  (tg && /ios|android/.test(tg.platform || ''));

// ---------- Захват микрофона: AudioWorklet с привязкой к кадрам AudioContext ----------
// Каждый блок приходит с номером кадра (currentFrame), поэтому мы точно знаем,
// в какой момент времени контекста был записан каждый сэмпл.
const WORKLET_SRC = `
class RecProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false; this.buf = new Float32Array(4096); this.n = 0; this.f0 = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'start') { this.on = true; this.n = 0; }
      else if (e.data === 'stop') { this.flush(); this.on = false; this.port.postMessage({ done: true }); }
    };
  }
  flush() {
    if (this.n > 0) { this.port.postMessage({ f0: this.f0, data: this.buf.slice(0, this.n) }); this.n = 0; }
  }
  process(inputs) {
    if (!this.on) return true;
    const ch = inputs[0] && inputs[0][0];
    const len = ch ? ch.length : 128;
    if (this.n + len > this.buf.length) this.flush();
    if (this.n === 0) this.f0 = currentFrame;
    if (ch) this.buf.set(ch, this.n); else this.buf.fill(0, this.n, this.n + len);
    this.n += len;
    if (this.n >= this.buf.length) this.flush();
    return true;
  }
}
registerProcessor('rec-processor', RecProcessor);
`;

// ---------- Состояние ----------
const S = {
  ctx: null, master: null, stream: null, micSource: null, recNode: null, analyser: null,
  beat: null,            // { name, buffer, bytes, peaks }
  beatVol: 1,
  bpm: 120,
  tracks: [],            // { id, name, buffer, start, nudge, vol, mute, solo, peaks, el, gain }
  cursor: 0,             // позиция старта (сек) в таймлайне бита
  playing: false, recording: false,
  t0: 0, p0: 0,          // время контекста и позиция таймлайна в момент старта
  sources: [], beatGain: null,
  latency: null,         // сек, задержка «туда-обратно» из калибровки
  latencyEstimated: false,
  deviceId: localStorage.getItem('micId') || '',
  micLabel: '',
  chunks: [], captureDone: null,
  rec: null,             // { startFrame, cursor, latency }
  nextId: 1,
};

const $ = (id) => document.getElementById(id);
const fmt = (t) => {
  t = Math.max(0, t);
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`;
};

function toast(msg, ms = 2800) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), ms);
}
function busy(text) {
  if (text) { $('busyText').textContent = text; $('busy').classList.remove('hidden'); }
  else $('busy').classList.add('hidden');
}
function haptic(type = 'light') {
  try { tg && tg.HapticFeedback.impactOccurred(type); } catch (e) {}
}

// ---------- Инициализация звука ----------
// Режимы включения микрофона. iOS Safari ведёт себя по-разному, поэтому даём выбрать.
const MIC_MODES = {
  raw:   { title: 'Чистый (по умолчанию)', hint: 'Обработка выключена при запросе и ещё раз после включения' },
  apply: { title: 'Чистый, способ 2', hint: 'Микрофон включается обычным, потом обработка выключается. Помогает на части iPhone' },
  raw2:  { title: 'Чистый, без режима сессии', hint: 'Как «Чистый», но не трогаем аудиосессию iOS' },
  voice: { title: 'Голосовой (с шумодавом)', hint: 'Обработка как в звонке: меньше шума, но узкий звук. Для сравнения' },
};
S.micMode = MIC_MODES[localStorage.getItem('micMode')] ? localStorage.getItem('micMode') : 'raw';
const RAW = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };

function setAudioSession(mode) {
  try {
    if (navigator.audioSession) navigator.audioSession.type = mode === 'raw2' ? 'auto' : 'play-and-record';
  } catch (e) {}
}

async function openMic(deviceId) {
  if (S.stream) S.stream.getTracks().forEach((t) => t.stop());
  const mode = S.micMode;
  setAudioSession(mode);
  let audio;
  if (mode === 'voice') audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  else if (mode === 'apply') audio = {};
  else audio = { ...RAW };
  if (deviceId) audio.deviceId = { exact: deviceId };
  const req = (a) => navigator.mediaDevices.getUserMedia({ audio: Object.keys(a).length ? a : true });
  try {
    S.stream = await req(audio);
  } catch (e) {
    if (deviceId && e.name === 'OverconstrainedError') {
      delete audio.deviceId;
      S.stream = await req(audio);
    } else throw e;
  }
  const track = S.stream.getAudioTracks()[0];
  // Обходной путь для iOS: флаги, переданные в getUserMedia, игнорируются — применяем их к живой дорожке
  if (mode !== 'voice') {
    try { await track.applyConstraints(RAW); } catch (e) { console.warn('applyConstraints', e); }
  }
  S.micLabel = track.label || 'Микрофон';
  S.deviceId = (track.getSettings && track.getSettings().deviceId) || deviceId || '';
  localStorage.setItem('micId', S.deviceId);

  if (S.ctx) connectMic();
  await refreshDevices();
  loadLatencyForMic();
}

// iOS сам переключает запись на микрофон наушников. Если есть встроенный — берём его.
const BUILTIN_RE = /iphone|ipad|built-?in|встро|internal|microphone array|телефон/i;
const HEADSET_RE = /airpods|bluetooth|\bbt\b|buds|hands-?free|headset|headphone|наушник|гарнитур|beats|earpods|usb/i;
async function preferBuiltInMic() {
  if (!S.micLabel || BUILTIN_RE.test(S.micLabel) || !HEADSET_RE.test(S.micLabel)) return;
  const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
  const builtin = devs.find((d) => BUILTIN_RE.test(d.label));
  if (builtin && builtin.deviceId !== S.deviceId) {
    try { await openMic(builtin.deviceId); } catch (e) { console.warn(e); }
  }
}

function micSettings() {
  const t = S.stream && S.stream.getAudioTracks()[0];
  return t && t.getSettings ? t.getSettings() : {};
}

function connectMic() {
  if (S.micSource) S.micSource.disconnect();
  S.micSource = S.ctx.createMediaStreamSource(S.stream);
  S.micSource.connect(S.recNode);
  S.micSource.connect(S.analyser);
}

async function refreshDevices() {
  const sel = $('micSelect');
  const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
  sel.innerHTML = '';
  devs.forEach((d, i) => {
    const o = document.createElement('option');
    o.value = d.deviceId;
    o.textContent = '🎙 ' + (d.label || `Микрофон ${i + 1}`);
    sel.appendChild(o);
  });
  if (!devs.length) sel.innerHTML = '<option>🎙 Микрофон</option>';
  sel.value = S.deviceId;
  if (sel.selectedIndex < 0 && sel.options.length) sel.selectedIndex = 0;

  const BT_RE = /airpods|bluetooth|\bbt\b|buds|hands-?free|beats/i;
  const micIsBt = BT_RE.test(S.micLabel);
  const btConnected = devs.some((d) => BT_RE.test(d.label));
  const warn = $('micWarn');
  let msg = '';
  if (micIsBt) {
    msg = `Пишет микрофон Bluetooth-наушников («${S.micLabel}»): узкий звук, как в звонке. Для нормальной записи нужны проводные наушники.`;
  } else if (btConnected) {
    msg = 'Подключены Bluetooth-наушники. Пока пишет микрофон iPhone, Safari выводит звук в динамик, а не в наушники: это ограничение iOS для сайтов. Для записи нужны проводные наушники.';
  }
  warn.textContent = msg;
  warn.classList.toggle('hidden', !msg);
}

async function initAudio() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('Браузер не даёт доступ к микрофону. Нужен HTTPS и свежая версия Telegram/браузера.');
  }
  // Сначала микрофон, потом контекст: на iOS так частота дискретизации не скачет
  await openMic(S.deviceId);
  if (!localStorage.getItem('micManual')) await preferBuiltInMic();

  const AC = window.AudioContext || window.webkitAudioContext;
  S.ctx = new AC({ latencyHint: 'interactive' });
  await S.ctx.resume();
  if (!S.ctx.audioWorklet) throw new Error('Этот браузер не поддерживает AudioWorklet. Обнови Telegram или iOS.');

  const blobUrl = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
  try { await S.ctx.audioWorklet.addModule(blobUrl); }
  catch (e) { await S.ctx.audioWorklet.addModule('data:application/javascript;base64,' + btoa(WORKLET_SRC)); }

  S.recNode = new AudioWorkletNode(S.ctx, 'rec-processor', {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
  });
  S.recNode.port.onmessage = (e) => {
    if (e.data.done) { const r = S.captureDone; S.captureDone = null; r && r(S.chunks); }
    else S.chunks.push(e.data);
  };
  // Узел должен быть подключён к выходу, иначе Safari его не обрабатывает. Звук при этом не идёт.
  const sink = S.ctx.createGain(); sink.gain.value = 0;
  S.recNode.connect(sink).connect(S.ctx.destination);

  S.analyser = S.ctx.createAnalyser();
  S.analyser.fftSize = 1024;

  S.master = S.ctx.createGain();
  S.master.connect(S.ctx.destination);

  connectMic();
  loadLatencyForMic();
  meterLoop();

  // Telegram / iOS могут «усыпить» контекст после сворачивания
  const wake = () => { if (S.ctx.state !== 'running') S.ctx.resume(); };
  document.addEventListener('touchstart', wake, { passive: true });
  document.addEventListener('click', wake);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && S.playing) stopAll();
  });
}

function meterLoop() {
  const data = new Float32Array(S.analyser.fftSize);
  const fill = $('meterFill');
  const tick = () => {
    S.analyser.getFloatTimeDomainData(data);
    let peak = 0;
    for (let i = 0; i < data.length; i++) { const a = Math.abs(data[i]); if (a > peak) peak = a; }
    const db = 20 * Math.log10(peak + 1e-6);
    const w = Math.max(0, Math.min(1, (db + 60) / 60));
    fill.style.width = (w * 100).toFixed(1) + '%';
    fill.style.background = peak > 0.95 ? 'var(--rec)' : peak > 0.6 ? 'var(--warn)' : 'var(--ok)';
    requestAnimationFrame(tick);
  };
  tick();
}

// ---------- Захват ----------
function startCapture() {
  S.chunks = [];
  S.recNode.port.postMessage('start');
}
function stopCapture() {
  return new Promise((res) => { S.captureDone = res; S.recNode.port.postMessage('stop'); });
}
// Собирает блоки в один массив, начиная с кадра fromFrame
function assemble(chunks, fromFrame) {
  if (!chunks.length) return new Float32Array(0);
  let end = 0;
  for (const c of chunks) end = Math.max(end, c.f0 + c.data.length);
  const out = new Float32Array(Math.max(0, end - fromFrame));
  for (const c of chunks) {
    let off = c.f0 - fromFrame, src = c.data;
    if (off < 0) { if (-off >= src.length) continue; src = src.subarray(-off); off = 0; }
    out.set(src, off);
  }
  return out;
}

// ---------- Задержка ----------
function latencyKey() { return 'lat:' + S.micMode + ':' + (S.micLabel || 'default'); }
function loadLatencyForMic() {
  const v = localStorage.getItem(latencyKey());
  if (v !== null) { S.latency = parseFloat(v); S.latencyEstimated = false; }
  else if (S.ctx) {
    // Без калибровки — грубая оценка от браузера (на iOS часто занижена)
    S.latency = (S.ctx.baseLatency || 0) + (S.ctx.outputLatency || 0) + 0.01;
    S.latencyEstimated = true;
  } else { S.latency = null; }
  updateLatencyLabel();
}
function saveLatency(sec) {
  S.latency = sec; S.latencyEstimated = false;
  localStorage.setItem(latencyKey(), String(sec));
  updateLatencyLabel();
}
function updateLatencyLabel() {
  const btn = $('latencyBtn');
  if (S.latency == null) { $('latencyLabel').textContent = '—'; btn.classList.add('bad'); return; }
  const ms = Math.round(S.latency * 1000);
  $('latencyLabel').textContent = S.latencyEstimated ? `≈${ms} мс · калибровка` : `${ms} мс`;
  btn.classList.toggle('bad', S.latencyEstimated);
}

function makeClick(ctx) {
  const sr = ctx.sampleRate, n = Math.round(sr * 0.012);
  const b = ctx.createBuffer(1, n, sr), d = b.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (sr * 0.002)) * 0.95;
  return b;
}

async function runCalibration() {
  const ctx = S.ctx, sr = ctx.sampleRate;
  const N = 8, SPACING = 0.8, WINDOW = 0.7;
  const res = $('calResult');
  $('calRun').disabled = true;
  res.innerHTML = 'Слушаю щелчки…<span class="sub">не шуми</span>';
  stopAll();

  const click = makeClick(ctx);
  startCapture();
  const base = ctx.currentTime + 0.5;
  const clickFrames = [];
  for (let i = 0; i < N; i++) {
    const t = base + i * SPACING;
    const src = ctx.createBufferSource();
    src.buffer = click; src.connect(ctx.destination); src.start(t);
    clickFrames.push(Math.round(t * sr));
  }
  await new Promise((r) => setTimeout(r, (0.5 + N * SPACING + 0.3) * 1000));
  const chunks = await stopCapture();
  $('calRun').disabled = false;

  const f0 = chunks.length ? chunks[0].f0 : 0;
  const data = assemble(chunks, f0);

  // Общий уровень шума — медиана модуля
  const sample = [];
  for (let i = 0; i < data.length; i += 37) sample.push(Math.abs(data[i]));
  sample.sort((a, b) => a - b);
  const noise = sample[Math.floor(sample.length / 2)] || 0;

  const lags = [];
  for (const cf of clickFrames) {
    const a = cf - f0, b = a + Math.round(WINDOW * sr);
    if (a < 0 || b > data.length) continue;
    let max = 0;
    for (let i = a; i < b; i++) { const v = Math.abs(data[i]); if (v > max) max = v; }
    if (max < 0.01 || max < noise * 8) continue;
    const thr = max * 0.35;
    for (let i = a; i < b; i++) {
      if (Math.abs(data[i]) >= thr) { lags.push((i - a) / sr); break; }
    }
  }

  if (lags.length < 5) {
    res.innerHTML = 'Не расслышал щелчки 😕<span class="sub">Прибавь громкость и поднеси наушник ближе к микрофону</span>';
    return;
  }
  lags.sort((x, y) => x - y);
  const med = lags[Math.floor(lags.length / 2)];
  const spread = (lags[lags.length - 1] - lags[0]) * 1000;
  saveLatency(med);
  haptic('medium');
  res.innerHTML = `${Math.round(med * 1000)} мс` +
    `<span class="sub">разброс ${spread.toFixed(1)} мс · поймано ${lags.length}/${N} щелчков` +
    (spread > 15 ? '<br>⚠️ Задержка плавает — похоже на Bluetooth. Запись может «гулять».' : '<br>✅ Сохранено для этого микрофона') +
    '</span>';
  $('calManual').value = Math.round(med * 1000);
}

// ---------- Таймлайн ----------
function songEnd() {
  let end = S.beat ? S.beat.buffer.duration : 0;
  for (const t of S.tracks) end = Math.max(end, t.start + t.nudge / 1000 + t.buffer.duration);
  return end;
}
function viewEnd() { return Math.max(songEnd(), 15); }

// Пики с разрешением 200 точек/сек, чтобы быстро перерисовывать
function computePeaks(buffer) {
  const rate = 200, step = buffer.sampleRate / rate;
  const n = Math.ceil(buffer.duration * rate);
  const peaks = new Float32Array(n);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) {
      const a = Math.floor(i * step), b = Math.min(d.length, Math.floor((i + 1) * step));
      let m = peaks[i];
      for (let j = a; j < b; j++) { const v = d[j] < 0 ? -d[j] : d[j]; if (v > m) m = v; }
      peaks[i] = m;
    }
  }
  return peaks;
}

function drawLane(lane, peaks, start, color, grid) {
  const canvas = lane.querySelector('canvas');
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(lane.clientWidth * dpr)), h = Math.max(1, Math.round(lane.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, w, h);
  const ve = viewEnd(), pxPerSec = w / ve;

  if (grid && S.bpm > 0) {
    const bar = (60 / S.bpm) * 4;
    g.fillStyle = 'rgba(255,255,255,0.07)';
    for (let t = 0, k = 0; t < ve; t += bar, k++) g.fillRect(Math.round(t * pxPerSec), 0, k % 4 === 0 ? 2 : 1, h);
  }
  if (!peaks) return;
  g.fillStyle = color;
  const mid = h / 2;
  for (let x = 0; x < w; x++) {
    const t0 = x / pxPerSec - start, t1 = (x + 1) / pxPerSec - start;
    if (t1 <= 0) continue;
    const a = Math.max(0, Math.floor(t0 * 200)), b = Math.min(peaks.length, Math.ceil(t1 * 200));
    if (a >= peaks.length) break;
    let m = 0;
    for (let i = a; i < Math.max(b, a + 1); i++) if (peaks[i] > m) m = peaks[i];
    const y = Math.max(1, m * mid * 0.95);
    g.fillRect(x, mid - y, 1, y * 2);
  }
}

function redraw() {
  drawLane($('beatLane'), S.beat && S.beat.peaks, 0, '#4fc3f7', true);
  for (const t of S.tracks) drawLane(t.el.querySelector('.lane'), t.peaks, t.start + t.nudge / 1000, '#b9a8ff', false);
  setMarkers(S.playing ? currentPos() : S.cursor);
}

function setMarkers(pos) {
  const ve = viewEnd();
  const tl = $('timeline');
  tl.style.setProperty('--ph', Math.min(1, pos / ve).toFixed(5));
  tl.style.setProperty('--cur', Math.min(1, S.cursor / ve).toFixed(5));
  $('timeLabel').textContent = fmt(pos);
}

function laneTap(e) {
  if (S.playing) return;
  const lane = e.currentTarget;
  const r = lane.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width;
  S.cursor = Math.max(0, Math.min(viewEnd(), x * viewEnd()));
  // Привязка к доле, если задан BPM
  if (S.bpm > 0 && S.beat) {
    const beatLen = 60 / S.bpm;
    S.cursor = Math.round(S.cursor / beatLen) * beatLen;
  }
  setMarkers(S.cursor);
}

// ---------- Воспроизведение ----------
function anySolo() { return S.beatSolo || S.tracks.some((t) => t.solo); }
function beatGainValue() { return S.beatMute || (anySolo() && !S.beatSolo) ? 0 : S.beatVol; }
function trackGainValue(t) { return t.mute || (anySolo() && !t.solo) ? 0 : t.vol; }
function applyGains() {
  for (const t of S.tracks) {
    if (t.gain) t.gain.gain.value = trackGainValue(t);
    t.el.classList.toggle('muted-track', trackGainValue(t) === 0);
    t.el.querySelector('.m').classList.toggle('on', t.mute);
    t.el.querySelector('.s').classList.toggle('on', t.solo);
  }
  if (S.beatGain) S.beatGain.gain.value = beatGainValue();
  $('beatM').classList.toggle('on', !!S.beatMute);
  $('beatS').classList.toggle('on', !!S.beatSolo);
  $('beatLane').closest('.track').classList.toggle('muted-track', beatGainValue() === 0);
}

function currentPos() { return S.p0 + (S.ctx.currentTime - S.t0); }

function startPlayback() {
  const ctx = S.ctx;
  const when = ctx.currentTime + 0.12;
  const P = S.cursor;
  S.t0 = when; S.p0 = P; S.sources = [];

  S.beatGain = ctx.createGain();
  S.beatGain.gain.value = beatGainValue();
  S.beatGain.connect(S.master);
  if (S.beat && P < S.beat.buffer.duration) {
    const src = ctx.createBufferSource();
    src.buffer = S.beat.buffer;
    src.connect(S.beatGain);
    src.start(when, P);
    S.sources.push(src);
  }
  for (const t of S.tracks) {
    t.gain = ctx.createGain();
    t.gain.gain.value = trackGainValue(t);
    t.gain.connect(S.master);
    const eff = t.start + t.nudge / 1000;
    if (eff + t.buffer.duration <= P) continue;
    const src = ctx.createBufferSource();
    src.buffer = t.buffer;
    src.connect(t.gain);
    if (eff >= P) src.start(when + (eff - P)); else src.start(when, P - eff);
    S.sources.push(src);
  }
  S.playing = true;
  $('playBtn').textContent = '■';
  $('playBtn').classList.add('on');
  requestAnimationFrame(tickPlayhead);
}

function stopPlayback() {
  for (const s of S.sources) { try { s.stop(); } catch (e) {} }
  S.sources = [];
  if (S.beatGain) { S.beatGain.disconnect(); S.beatGain = null; }
  for (const t of S.tracks) if (t.gain) { t.gain.disconnect(); t.gain = null; }
  S.playing = false;
  $('playBtn').textContent = '▶';
  $('playBtn').classList.remove('on');
  setMarkers(S.cursor);
}

function tickPlayhead() {
  if (!S.playing) return;
  const pos = currentPos();
  setMarkers(Math.max(S.p0, pos));
  if (!S.recording && pos > songEnd() + 0.2) { stopPlayback(); return; }
  requestAnimationFrame(tickPlayhead);
}

function stopAll() {
  if (S.recording) stopRecording();
  else if (S.playing) stopPlayback();
}

// ---------- Запись ----------
function startRecording() {
  if (S.latencyEstimated) toast('Задержка не откалибрована — голос может опаздывать. Нажми ⏱ вверху.', 3500);
  startCapture();
  startPlayback();
  S.rec = {
    startFrame: Math.round(S.t0 * S.ctx.sampleRate),
    cursor: S.p0,
    latency: S.latency || 0,
  };
  S.recording = true;
  $('recBtn').classList.add('on');
  $('timeline').classList.add('recording');
  try { tg && tg.enableClosingConfirmation(); } catch (e) {}
  haptic('medium');
}

async function stopRecording() {
  S.recording = false;
  stopPlayback();
  $('recBtn').classList.remove('on');
  $('timeline').classList.remove('recording');
  const chunks = await stopCapture();
  const sr = S.ctx.sampleRate;
  let data = assemble(chunks, S.rec.startFrame);

  // Сэмпл №0 записан, когда в ушах звучала позиция (cursor - latency).
  // Сдвигаем дорожку назад на задержку — так голос встаёт ровно в бит.
  let start = S.rec.cursor - S.rec.latency;
  if (start < 0) {
    const cut = Math.round(-start * sr);
    data = data.slice(Math.min(cut, data.length));
    start = 0;
  }
  if (data.length < sr * 0.3) { toast('Слишком короткая запись'); return; }

  const buffer = S.ctx.createBuffer(1, data.length, sr);
  buffer.copyToChannel(data, 0);
  const n = S.nextId++;
  const t = addTrack({ id: 't' + n + '_' + Date.now(), name: `Дорожка ${n}`, buffer, start, nudge: 0, vol: 1, mute: false, solo: false });
  await saveTrackAudio(t);
  saveMeta();
  haptic('light');
}

// ---------- Дорожки (UI) ----------
function addTrack(t) {
  t.peaks = computePeaks(t.buffer);
  const el = $('trackTpl').content.firstElementChild.cloneNode(true);
  t.el = el;
  const name = el.querySelector('.name');
  name.value = t.name;
  name.addEventListener('change', () => { t.name = name.value.trim() || t.name; name.value = t.name; saveMeta(); });
  el.querySelector('.m').addEventListener('click', () => { t.mute = !t.mute; applyGains(); saveMeta(); });
  el.querySelector('.s').addEventListener('click', () => { t.solo = !t.solo; applyGains(); saveMeta(); });
  el.querySelector('.del').addEventListener('click', () => deleteTrack(t));
  const vol = el.querySelector('.vol');
  vol.value = t.vol;
  vol.addEventListener('input', () => { t.vol = parseFloat(vol.value); applyGains(); });
  vol.addEventListener('change', saveMeta);
  el.querySelectorAll('.nudge button').forEach((b) => b.addEventListener('click', () => {
    t.nudge += parseInt(b.dataset.d, 10);
    updateNudge(t); redraw(); saveMeta();
  }));
  el.querySelector('.lane').addEventListener('click', laneTap);
  updateNudge(t);
  $('tracks').appendChild(el);
  S.tracks.push(t);
  applyGains();
  redraw();
  return t;
}
function updateNudge(t) {
  t.el.querySelector('.nv').textContent = (t.nudge > 0 ? '+' : '') + t.nudge + ' мс';
}
async function deleteTrack(t) {
  if (!confirm(`Удалить «${t.name}»?`)) return;
  if (S.playing) stopAll();
  S.tracks = S.tracks.filter((x) => x !== t);
  t.el.remove();
  await idb('audio', 'readwrite', (st) => st.delete(t.id));
  applyGains(); redraw(); saveMeta();
}

// ---------- Бит ----------
async function loadBeatBytes(bytes, name) {
  const buffer = await S.ctx.decodeAudioData(bytes.slice(0));
  S.beat = { name, buffer, bytes, peaks: computePeaks(buffer) };
  $('beatName').textContent = `${name} · ${fmt(buffer.duration)}`;
  redraw();
}

// ---------- Экспорт ----------
// Имена файлов латиницей: некоторые распаковщики ломаются на кириллице
const TR = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'c',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya' };
function safeName(s) {
  const t = [...s].map((ch) => {
    const lo = ch.toLowerCase();
    if (!(lo in TR)) return ch;
    const r = TR[lo];
    return ch !== lo && r ? r[0].toUpperCase() + r.slice(1) : r;
  }).join('');
  return t.replace(/[^A-Za-z0-9 _.-]+/g, '').trim().replace(/\s+/g, '_') || 'Track';
}

async function exportProject() {
  if (!S.beat && !S.tracks.length) { toast('Нечего экспортировать'); return; }
  if (S.playing) stopAll();
  busy('Готовлю WAV-файлы…');
  await new Promise((r) => setTimeout(r, 50));
  try {
    const sr = S.ctx.sampleRate;
    const N = Math.ceil(songEnd() * sr) + 1;
    const files = [];
    let idx = 1;
    const num = () => String(idx++).padStart(2, '0');

    // Каждый файл одной длины и начинается с 0:00 — кидаешь все на такт 1, и всё совпадает
    if (S.beat) {
      const b = S.beat.buffer;
      const chans = [];
      for (let c = 0; c < b.numberOfChannels; c++) {
        const a = new Float32Array(N); a.set(b.getChannelData(c).subarray(0, N)); chans.push(a);
      }
      files.push({ name: `${num()}_Beat.wav`, data: encodeWav(chans, sr, 24) });
    }
    for (const t of S.tracks) {
      const a = new Float32Array(N);
      const off = Math.round((t.start + t.nudge / 1000) * sr);
      let src = t.buffer.getChannelData(0), dst = off;
      if (dst < 0) { src = src.subarray(-dst); dst = 0; }
      a.set(src.subarray(0, Math.max(0, N - dst)), dst);
      files.push({ name: `${num()}_${safeName(t.name)}.wav`, data: encodeWav([a], sr, 24) });
      await new Promise((r) => setTimeout(r, 0));
    }

    // Сведение с текущими громкостями (для прослушки)
    busy('Свожу микс…');
    const off = new OfflineAudioContext(2, N, sr);
    if (S.beat) {
      const s = off.createBufferSource(), g = off.createGain();
      s.buffer = S.beat.buffer; g.gain.value = beatGainValue(); s.connect(g).connect(off.destination); s.start(0);
    }
    for (const t of S.tracks) {
      const gv = trackGainValue(t);
      if (!gv) continue;
      const s = off.createBufferSource(), g = off.createGain();
      s.buffer = t.buffer; g.gain.value = gv; s.connect(g).connect(off.destination);
      const eff = t.start + t.nudge / 1000;
      if (eff >= 0) s.start(eff); else s.start(0, -eff);
    }
    const mix = await off.startRendering();
    files.push({ name: `Mix.wav`, data: encodeWav([mix.getChannelData(0), mix.getChannelData(1)], sr, 24) });

    const info = [
      'Rec Studio — проект для Ableton',
      '',
      `BPM: ${S.bpm}`,
      `Частота: ${sr} Гц, 24 бит`,
      `Длина: ${fmt(songEnd())}`,
      `Компенсация задержки: ${Math.round((S.latency || 0) * 1000)} мс (уже применена)`,
      '',
      'Как открыть:',
      `1. В Ableton поставь темп ${S.bpm}.`,
      '2. Перетащи все WAV (кроме Mix) в Arrangement на начало 1-го такта, каждый на свою дорожку.',
      '3. У клипов выключи Warp (или заранее: Preferences → Record/Warp/Launch → Auto-Warp Long Samples = Off).',
      '   Все файлы одной длины и начинаются с 0:00, поэтому встанут ровно.',
      '',
      'Дорожки:',
      ...S.tracks.map((t) => `- ${t.name}: сдвиг ${t.nudge} мс, громкость в приложении ${Math.round(t.vol * 100)}% (в WAV исходный уровень)`),
    ].join('\n');
    files.push({ name: 'README.txt', data: new TextEncoder().encode(info) });

    busy('Пакую архив…');
    const zip = makeZip(files);
    const date = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
    await deliver(zip, `RecStudio_${date}.zip`);
  } catch (e) {
    console.error(e);
    toast('Ошибка экспорта: ' + e.message, 5000);
  } finally {
    busy(false);
  }
}

async function deliver(blob, filename) {
  const file = new File([blob], filename, { type: 'application/zip' });
  if (isMobile && navigator.canShare && navigator.canShare({ files: [file] })) {
    busy(false);
    try { await navigator.share({ files: [file], title: filename }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  if (tg) toast('Если файл не скачался — в следующей версии бот будет присылать архив в чат.', 5000);
}

// ---------- Автосохранение (IndexedDB) ----------
let dbPromise = null;
function openDb() {
  if (!dbPromise) dbPromise = new Promise((res, rej) => {
    const r = indexedDB.open('rec-studio', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('meta'); r.result.createObjectStore('audio'); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbPromise;
}
async function idb(store, mode, fn) {
  try {
    const db = await openDb();
    return await new Promise((res, rej) => {
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => res(req && req.result);
      tx.onerror = () => rej(tx.error);
    });
  } catch (e) { console.warn('IndexedDB', e); return undefined; }
}
let metaTimer = null;
function saveMeta() {
  clearTimeout(metaTimer);
  metaTimer = setTimeout(() => {
    const meta = {
      bpm: S.bpm, beatVol: S.beatVol, beatMute: !!S.beatMute, beatSolo: !!S.beatSolo, beatName: S.beat ? S.beat.name : null, nextId: S.nextId,
      tracks: S.tracks.map((t) => ({ id: t.id, name: t.name, start: t.start, nudge: t.nudge, vol: t.vol, mute: t.mute, solo: t.solo })),
    };
    idb('meta', 'readwrite', (st) => st.put(meta, 'project'));
  }, 300);
}
function saveTrackAudio(t) {
  const data = t.buffer.getChannelData(0).slice();
  return idb('audio', 'readwrite', (st) => st.put({ sr: t.buffer.sampleRate, data }, t.id));
}
async function resample(data, fromSr) {
  const toSr = S.ctx.sampleRate;
  const src = S.ctx.createBuffer(1, data.length, fromSr);
  src.copyToChannel(data, 0);
  if (fromSr === toSr) return src;
  const off = new OfflineAudioContext(1, Math.ceil(data.length * toSr / fromSr), toSr);
  const s = off.createBufferSource(); s.buffer = src; s.connect(off.destination); s.start();
  return off.startRendering();
}
async function restoreProject() {
  const meta = await idb('meta', 'readonly', (st) => st.get('project'));
  if (!meta) return;
  S.bpm = meta.bpm || 120; $('bpmInput').value = S.bpm;
  S.beatVol = meta.beatVol ?? 1; $('beatVol').value = S.beatVol;
  S.beatMute = !!meta.beatMute; S.beatSolo = !!meta.beatSolo; applyGains();
  S.nextId = meta.nextId || 1;
  const beat = await idb('audio', 'readonly', (st) => st.get('beat'));
  if (beat && beat.bytes) {
    try { await loadBeatBytes(beat.bytes, meta.beatName || 'Бит'); } catch (e) { console.warn(e); }
  }
  for (const m of meta.tracks || []) {
    const a = await idb('audio', 'readonly', (st) => st.get(m.id));
    if (!a) continue;
    const buffer = await resample(a.data, a.sr);
    addTrack({ ...m, buffer });
  }
  if (S.tracks.length) toast('Проект восстановлен');
}
async function newProject() {
  if ((S.beat || S.tracks.length) && !confirm('Начать новый проект? Текущие дорожки удалятся с телефона.')) return;
  stopAll();
  S.tracks.forEach((t) => t.el.remove());
  S.tracks = []; S.beat = null; S.cursor = 0; S.nextId = 1;
  S.beatMute = false; S.beatSolo = false; applyGains();
  $('beatName').textContent = 'Бит не загружен. Можно записывать и без него.';
  await idb('audio', 'readwrite', (st) => st.clear());
  await idb('meta', 'readwrite', (st) => st.clear());
  redraw();
}

// ---------- Обработчики ----------
$('startBtn').addEventListener('click', async () => {
  $('startBtn').disabled = true;
  $('startError').textContent = '';
  try {
    await initAudio();
    await restoreProject();
    $('startScreen').classList.add('hidden');
    redraw();
    if (S.latencyEstimated) setTimeout(() => toast('Сначала сделай калибровку задержки: кнопка ⏱ вверху', 4000), 400);
  } catch (e) {
    console.error(e);
    $('startError').textContent = e.name === 'NotAllowedError'
      ? 'Нет доступа к микрофону. Разреши его в настройках Telegram/браузера и попробуй снова.'
      : (e.message || String(e));
    $('startBtn').disabled = false;
  }
});

$('micSelect').addEventListener('change', async (e) => {
  stopAll();
  localStorage.setItem('micManual', '1');
  try { await openMic(e.target.value); toast('Микрофон: ' + S.micLabel); }
  catch (err) { toast('Не удалось переключить микрофон: ' + err.message); }
});

$('beatInput').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  stopAll();
  busy('Загружаю бит…');
  try {
    const bytes = await f.arrayBuffer();
    const name = f.name.replace(/\.[^.]+$/, '');
    await loadBeatBytes(bytes, name);
    // Пробуем вытащить BPM из имени файла: "beat 140bpm.mp3", "Trap_92_BPM"
    const m = f.name.match(/(\d{2,3}(?:[.,]\d+)?)\s*-?_?\s*bpm/i);
    if (m) { S.bpm = parseFloat(m[1].replace(',', '.')); $('bpmInput').value = S.bpm; toast(`BPM из названия: ${S.bpm}`); }
    await idb('audio', 'readwrite', (st) => st.put({ bytes }, 'beat'));
    saveMeta();
  } catch (err) {
    toast('Не получилось открыть файл. Попробуй mp3 или wav.', 4000);
  } finally { busy(false); }
});

$('bpmInput').addEventListener('change', (e) => {
  const v = parseFloat(String(e.target.value).replace(',', '.'));
  if (v >= 40 && v <= 250) { S.bpm = v; redraw(); saveMeta(); } else e.target.value = S.bpm;
});
$('beatVol').addEventListener('input', (e) => { S.beatVol = parseFloat(e.target.value); applyGains(); });
$('beatVol').addEventListener('change', saveMeta);
$('beatLane').addEventListener('click', laneTap);
$('beatM').addEventListener('click', () => { S.beatMute = !S.beatMute; applyGains(); saveMeta(); });
$('beatS').addEventListener('click', () => { S.beatSolo = !S.beatSolo; applyGains(); saveMeta(); });

$('playBtn').addEventListener('click', () => {
  if (S.recording) stopRecording();
  else if (S.playing) stopPlayback();
  else startPlayback();
});
$('recBtn').addEventListener('click', () => {
  if (S.recording) stopRecording();
  else { if (S.playing) stopPlayback(); startRecording(); }
});
$('homeBtn').addEventListener('click', () => {
  if (S.playing) stopAll();
  S.cursor = 0; setMarkers(0);
});

$('latencyBtn').addEventListener('click', () => {
  stopAll();
  $('calResult').innerHTML = S.latency != null && !S.latencyEstimated
    ? `${Math.round(S.latency * 1000)} мс<span class="sub">текущая для «${S.micLabel}»</span>` : '—';
  $('calManual').value = S.latency != null ? Math.round(S.latency * 1000) : '';
  $('calScreen').classList.remove('hidden');
});
$('calClose').addEventListener('click', () => $('calScreen').classList.add('hidden'));
$('calRun').addEventListener('click', runCalibration);
$('calManualSave').addEventListener('click', () => {
  const v = parseFloat($('calManual').value);
  if (v >= 0 && v <= 1000) { saveLatency(v / 1000); toast('Задержка сохранена'); }
});

// ---------- Экран микрофона: режим и тест частот ----------
function renderMicInfo() {
  const st = micSettings();
  const yn = (v, goodWhenFalse = true) => v === undefined ? '<span class="muted">не сообщает</span>'
    : (v === !goodWhenFalse ? '<span class="good">выкл</span>' : '<span class="bad">вкл</span>');
  const isHeadset = HEADSET_RE.test(S.micLabel) && !BUILTIN_RE.test(S.micLabel);
  $('micInfo').innerHTML =
    `Пишет: <b>${S.micLabel}</b> ${isHeadset ? '<span class="bad">(наушники)</span>' : ''}<br>` +
    `Эхоподавление: ${yn(st.echoCancellation === undefined ? undefined : !st.echoCancellation, false)} · ` +
    `Шумодав: ${yn(st.noiseSuppression === undefined ? undefined : !st.noiseSuppression, false)} · ` +
    `Автогромкость: ${yn(st.autoGainControl === undefined ? undefined : !st.autoGainControl, false)}<br>` +
    `Частота: ${st.sampleRate ? st.sampleRate + ' Гц (мик)' : '—'} · ${S.ctx ? S.ctx.sampleRate + ' Гц (студия)' : ''}`;
  const box = $('micModes');
  box.innerHTML = '';
  for (const [k, m] of Object.entries(MIC_MODES)) {
    const b = document.createElement('button');
    b.className = 'mode' + (k === S.micMode ? ' on' : '');
    b.innerHTML = `${m.title}<span class="h">${m.hint}</span>`;
    b.addEventListener('click', async () => {
      if (k === S.micMode) return;
      S.micMode = k; localStorage.setItem('micMode', k);
      busy('Переключаю микрофон…');
      try { await openMic(S.deviceId); } catch (e) { toast('Ошибка: ' + e.message); }
      busy(false);
      renderMicInfo();
    });
    box.appendChild(b);
  }
}

// Простое БПФ (radix-2, на месте)
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = -2 * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const p = i + k, q = p + len / 2;
        const tr = re[q] * cr - im[q] * ci, ti = re[q] * ci + im[q] * cr;
        re[q] = re[p] - tr; im[q] = im[p] - ti; re[p] += tr; im[p] += ti;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

// Средний спектр громких фрагментов записи, в дБ
function spectrum(data, sr) {
  const N = 4096, half = N / 2, acc = new Float64Array(half);
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
  let frames = 0;
  for (let p = 0; p + N <= data.length; p += N / 2) {
    let e = 0;
    for (let i = 0; i < N; i++) e += data[p + i] * data[p + i];
    if (Math.sqrt(e / N) < 0.003) continue; // тишину не считаем
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = data[p + i] * win[i];
    fft(re, im);
    for (let k = 0; k < half; k++) acc[k] += re[k] * re[k] + im[k] * im[k];
    frames++;
  }
  if (!frames) return null;
  const db = new Float64Array(half);
  for (let k = 0; k < half; k++) db[k] = 10 * Math.log10(acc[k] / frames + 1e-20);
  return { db, binHz: sr / N };
}

function drawSpectrum(spec, sr) {
  const c = $('specCanvas'), dpr = window.devicePixelRatio || 1;
  c.width = c.clientWidth * dpr; c.height = c.clientHeight * dpr;
  const g = c.getContext('2d'), w = c.width, h = c.height;
  g.clearRect(0, 0, w, h);
  const maxF = Math.min(sr / 2, 22000);
  g.fillStyle = 'rgba(255,255,255,.35)'; g.font = `${10 * dpr}px sans-serif`;
  for (const f of [1000, 4000, 8000, 12000, 16000, 20000]) {
    if (f > maxF) continue;
    const x = (f / maxF) * w;
    g.fillRect(x, 0, 1, h);
    g.fillText(f / 1000 + 'k', x + 3 * dpr, 12 * dpr);
  }
  if (!spec) return;
  let top = -Infinity;
  for (const v of spec.db) top = Math.max(top, v);
  g.strokeStyle = '#b9a8ff'; g.lineWidth = 1.5 * dpr; g.beginPath();
  for (let x = 0; x < w; x++) {
    const k = Math.min(spec.db.length - 1, Math.floor((x / w) * maxF / spec.binHz));
    const y = h - Math.max(0, Math.min(1, (spec.db[k] - (top - 90)) / 90)) * h;
    x ? g.lineTo(x, y) : g.moveTo(x, y);
  }
  g.stroke();
}

let micTestBuffer = null;
async function runMicTest() {
  stopAll();
  const sr = S.ctx.sampleRate;
  $('micTestRun').disabled = true; $('micTestPlay').disabled = true;
  $('specResult').textContent = 'Звени ключами у микрофона… 4';
  startCapture();
  const f0 = Math.round(S.ctx.currentTime * sr);
  for (let i = 3; i >= 1; i--) { await new Promise((r) => setTimeout(r, 1000)); $('specResult').textContent = 'Звени ключами у микрофона… ' + i; }
  await new Promise((r) => setTimeout(r, 1000));
  const data = assemble(await stopCapture(), f0);
  $('micTestRun').disabled = false;
  micTestBuffer = S.ctx.createBuffer(1, Math.max(1, data.length), sr);
  if (data.length) micTestBuffer.copyToChannel(data, 0);
  $('micTestPlay').disabled = !data.length;

  const spec = spectrum(data, sr);
  drawSpectrum(spec, sr);
  if (!spec) { $('specResult').textContent = 'Слишком тихо — ничего не записалось. Проверь микрофон.'; return; }
  // Сглаживаем спектр (~200 Гц), берём самый громкий участок речи 300 Гц–10 кГц
  // и ищем последнюю частоту, где уровень не ниже его на 45 дБ
  const W = 16, sm = new Float64Array(spec.db.length);
  for (let k = 0; k < sm.length; k++) {
    let sum = 0, n = 0;
    for (let j = Math.max(0, k - W / 2); j < Math.min(sm.length, k + W / 2); j++) { sum += Math.pow(10, spec.db[j] / 10); n++; }
    sm[k] = 10 * Math.log10(sum / n + 1e-20);
  }
  let top = -Infinity;
  for (let k = Math.round(300 / spec.binHz); k < Math.round(10000 / spec.binHz); k++) top = Math.max(top, sm[k]);
  let cut = 0;
  for (let k = sm.length - 1; k > 0; k--) if (sm[k] > top - 45) { cut = k * spec.binHz; break; }
  const kHz = (cut / 1000).toFixed(1);
  const nyq = S.ctx.sampleRate / 2;
  if (nyq < 16000) {
    $('specResult').innerHTML = `🔴 Студия работает на ${S.ctx.sampleRate} Гц: выше ${(nyq / 1000).toFixed(0)} кГц звука быть не может. Перезапусти приложение без Bluetooth-наушников`;
    return;
  }
  $('specResult').innerHTML = cut >= 14000
    ? `✅ Звук до ~${kHz} кГц: широкий, обработки нет`
    : cut >= 10000
      ? `🟡 Звук до ~${kHz} кГц: верх подрезан. Попробуй другой режим ниже`
      : `🔴 Звук до ~${kHz} кГц: «телефонный». Скорее всего пишет микрофон Bluetooth-наушников или включена обработка`;
}

$('micBtn').addEventListener('click', () => {
  stopAll();
  renderMicInfo();
  drawSpectrum(null, S.ctx.sampleRate);
  $('micScreen').classList.remove('hidden');
});
$('micClose').addEventListener('click', () => $('micScreen').classList.add('hidden'));
$('micTestRun').addEventListener('click', runMicTest);
$('micTestPlay').addEventListener('click', () => {
  if (!micTestBuffer) return;
  const s = S.ctx.createBufferSource(); s.buffer = micTestBuffer; s.connect(S.master); s.start();
});

$('exportBtn').addEventListener('click', exportProject);
$('newBtn').addEventListener('click', newProject);
window.addEventListener('resize', () => { if (S.ctx) redraw(); });
