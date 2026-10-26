/* ゾンビメーカー  — Canvas / ドラッグ操作のみ / 外部依存なし */
(() => {
'use strict';

// ===================================================================
// 調整パラメータ（ここを変えるだけで手触り・難易度を調整できる）
// ===================================================================
const TUNING = {
  roundSeconds: 60,          // 1プレイの秒数
  worldArea: 360000,         // 画面に映る世界の広さ(単位^2)。大きいほどキャラが小さく見える
  leaderRadius: 13,
  leaderSpeed: 235,          // 主人公の最高速度(単位/秒)
  leaderAccel: 11,           // 主人公の追従の鋭さ(大きいほどキビキビ)
  zombieRadius: 8.5,
  zombieSpeed: 270,          // 仲間の最高速度
  zombieAccel: 6.5,          // 仲間の加速(小さいほどヌルっと遅れてついてくる)
  zombieHuntRange: 70,       // 仲間が近くの人に自分から飛びつく距離
  slotSpacing: 18,           // 群れの隊形の間隔
  maxZombies: 650,           // 処理上限(超えた分も得点にはなる)
  humanRadius: 8.5,
  humanWalkSpeed: 38,
  humanFleeSpeed: [88, 150], // 逃げる速さ [開始時, 終了時]
  humanFleeRange: 135,
  humanTarget: [30, 56],     // 画面内にいる人の目標数 [開始時, 終了時]
  humanSpawnPerSec: [3.5, 8],// 足りない時に補充される速さ(人/秒)
  infectTime: 0.32,          // 噛まれてからゾンビになるまでの秒数
  comboWindow: 0.7,          // この秒数以内に続けて噛むとコンボ
  policeFirst: 9,            // 最初の警官が出る秒
  policeInterval: [10, 4.5], // 警官の出現間隔 [開始時, 終了時]
  policeSpeed: [85, 125],
  policeOverwhelm: [4, 9],   // 同時にこの数で囲むと警官を倒せる [開始時, 終了時]
  soldierFirst: 28,
  soldierInterval: [9, 5],
  soldierSpeed: 70,
  soldierOverwhelm: [7, 14],
  soldierShootEvery: [1.9, 1.2],
  bulletSpeed: 300,
  enemyKillEvery: 0.28,      // 囲みが足りない時、敵が仲間を倒す間隔
  maxEnemies: 7,
  leaderHitLose: 5,          // 主人公が攻撃された時に減る仲間の最低数
  leaderHitLoseRate: 0.15,   // 〃 群れに対する割合(大きい群れほど痛い)
  leaderInvuln: 1.3,
  soloHitTimePenalty: 3,     // 仲間0の時に攻撃されると減る残り時間(秒)
  spawnWarn: 1.1,            // 敵出現の予告(秒)
  shakeBite: 2.2, shakeHit: 10, shakeKill: 6,
};
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const diffLerp = (arr, d) => lerp(arr[0], arr[1], d);
const rand = (a, b) => a + Math.random() * (b - a);
const TAU = Math.PI * 2;

const params = new URLSearchParams(location.search);
const DEMO = params.has('demo');
const THUMB = params.has('thumb');
if (DEMO) document.body.classList.add('demo');
// デモ(プレビュー動画用)はキャラを大きく映す
if (DEMO) TUNING.worldArea = Number(params.get('area')) || 170000;

// ------------------------------------------------------------------
// 保存(ベストスコア / ミュート)
// ------------------------------------------------------------------
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
};
const BEST_KEY = 'gamelab.zombie-maker.best';
const MUTE_KEY = 'gamelab.muted';

// ------------------------------------------------------------------
// 効果音(WebAudioで合成。音声ファイルなし)
// ------------------------------------------------------------------
const Sfx = (() => {
  let ac = null, master = null, noiseBuf = null;
  let muted = DEMO ? true : store.get(MUTE_KEY, false);
  const last = {};
  function ensure() {
    if (ac || DEMO) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ac = new AC();
    master = ac.createGain(); master.gain.value = muted ? 0 : 0.55; master.connect(ac.destination);
    noiseBuf = ac.createBuffer(1, ac.sampleRate * 0.5, ac.sampleRate);
    const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  function unlock() { ensure(); if (ac && ac.state === 'suspended') ac.resume(); }
  function throttle(name, ms) { const n = performance.now(); if (last[name] && n - last[name] < ms) return false; last[name] = n; return true; }
  function tone(type, f0, f1, dur, vol, delay = 0) {
    if (!ac || muted) return;
    const t = ac.currentTime + delay;
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.006); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(master); o.start(t); o.stop(t + dur + 0.02);
  }
  function noise(dur, vol, freq, q = 1, type = 'bandpass', delay = 0) {
    if (!ac || muted) return;
    const t = ac.currentTime + delay;
    const s = ac.createBufferSource(); s.buffer = noiseBuf;
    const f = ac.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = ac.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(master); s.start(t, Math.random() * 0.3); s.stop(t + dur + 0.02);
  }
  return {
    unlock,
    get muted() { return muted; },
    setMuted(m) { muted = m; store.set(MUTE_KEY, m); if (master) master.gain.value = m ? 0 : 0.55; },
    bite(combo) {
      if (!throttle('bite', 45)) return;
      const p = Math.min(combo, 12);
      noise(0.05, 0.35, 1800, 1.5);
      tone('square', 260 + p * 45, 140 + p * 30, 0.09, 0.12);
      tone('sine', 520 + p * 70, 900 + p * 90, 0.07, 0.08, 0.03);
    },
    hit() { tone('sine', 160, 45, 0.3, 0.5); noise(0.18, 0.4, 400, 0.8, 'lowpass'); },
    lose() { if (throttle('lose', 70)) { tone('triangle', 300, 120, 0.1, 0.15); } },
    kill() { [0, 0.06, 0.12].forEach((d, i) => tone('square', 330 * (1 + i * 0.26), 340 * (1 + i * 0.26), 0.09, 0.12, d)); noise(0.15, 0.3, 900, 0.7); },
    shoot() { if (throttle('shoot', 60)) { noise(0.06, 0.25, 3000, 0.7, 'highpass'); tone('square', 900, 200, 0.06, 0.05); } },
    siren() { tone('triangle', 700, 700, 0.14, 0.07); tone('triangle', 520, 520, 0.14, 0.07, 0.15); },
    tick() { tone('sine', 1000, 1000, 0.05, 0.12); },
    start() { [0, 0.08, 0.16].forEach((d, i) => tone('triangle', 392 * Math.pow(1.26, i), 392 * Math.pow(1.26, i), 0.12, 0.18, d)); },
    end() { [0, 0.12, 0.24, 0.36].forEach((d, i) => tone('triangle', 523 / Math.pow(1.19, i), 523 / Math.pow(1.19, i), 0.16, 0.18, d)); },
    best() { [0, 0.09, 0.18, 0.27].forEach((d, i) => tone('square', 523 * Math.pow(1.26, i), 523 * Math.pow(1.26, i), 0.12, 0.1, d)); },
  };
})();

// ------------------------------------------------------------------
// 画面・座標系
// ------------------------------------------------------------------
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
let cssW = 0, cssH = 0, dpr = 1, S = 1, W = 600, H = 600; // S: 1単位あたりのCSSピクセル
let bgCanvas = null;

function resize() {
  cssW = Math.max(1, window.innerWidth); cssH = Math.max(1, window.innerHeight);
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
  S = Math.sqrt((cssW * cssH) / TUNING.worldArea);
  W = cssW / S; H = cssH / S;
  buildBackground();
  if (game) game.clampAll();
}

// 街の背景(1回だけ描いて使い回す)
function hash2(x, y) { let h = (x * 374761393 + y * 668265263) | 0; h = (h ^ (h >>> 13)) * 1274126177; return ((h ^ (h >>> 16)) >>> 0) / 4294967295; }
function buildBackground() {
  bgCanvas = document.createElement('canvas');
  bgCanvas.width = canvas.width; bgCanvas.height = canvas.height;
  const b = bgCanvas.getContext('2d');
  b.setTransform(dpr * S, 0, 0, dpr * S, 0, 0);
  b.fillStyle = '#262938'; b.fillRect(0, 0, W, H);           // 道路
  const block = 190, road = 54;
  const ox = ((W - road) % block) / 2, oy = ((H - road) % block) / 2;
  for (let gx = -1; gx * block < W + block; gx++) {
    for (let gy = -1; gy * block < H + block; gy++) {
      const x = ox + gx * block + road, y = oy + gy * block + road, s = block - road;
      // 歩道
      b.fillStyle = '#353a4d'; roundRect(b, x - 6, y - 6, s + 12, s + 12, 10); b.fill();
      const r = hash2(gx + 50, gy + 50);
      if (r < 0.28) { // 公園
        b.fillStyle = '#2b4a3a'; roundRect(b, x, y, s, s, 8); b.fill();
        b.strokeStyle = '#3d5a48'; b.lineWidth = 6; b.beginPath(); b.moveTo(x, y + s / 2); b.lineTo(x + s, y + s / 2); b.stroke();
        for (let i = 0; i < 6; i++) {
          const tx = x + 18 + hash2(gx * 7 + i, gy * 3) * (s - 36), ty = y + 18 + hash2(gx * 5, gy * 11 + i) * (s - 36);
          b.fillStyle = 'rgba(0,0,0,.22)'; b.beginPath(); b.ellipse(tx + 3, ty + 4, 13, 11, 0, 0, TAU); b.fill();
          b.fillStyle = '#3f7a52'; b.beginPath(); b.arc(tx, ty, 12, 0, TAU); b.fill();
          b.fillStyle = '#4f9363'; b.beginPath(); b.arc(tx - 3, ty - 3, 7, 0, TAU); b.fill();
        }
      } else if (r < 0.42) { // 広場
        b.fillStyle = '#3c3a4a'; roundRect(b, x, y, s, s, 8); b.fill();
        b.strokeStyle = 'rgba(255,255,255,.04)'; b.lineWidth = 1.5;
        for (let i = 1; i < 6; i++) { b.beginPath(); b.moveTo(x + i * s / 6, y); b.lineTo(x + i * s / 6, y + s); b.stroke(); b.beginPath(); b.moveTo(x, y + i * s / 6); b.lineTo(x + s, y + i * s / 6); b.stroke(); }
        b.fillStyle = '#2f5d73'; b.beginPath(); b.arc(x + s / 2, y + s / 2, 22, 0, TAU); b.fill();
        b.strokeStyle = '#4b5470'; b.lineWidth = 5; b.stroke();
      } else { // 建物(屋上)
        const cols = ['#3b3550', '#33414f', '#463a46', '#2f3b4c', '#3e4057'];
        const c = cols[Math.floor(hash2(gx, gy + 9) * cols.length)];
        const split = hash2(gx + 3, gy) < 0.5;
        const parts = split ? [[x, y, s / 2 - 3, s], [x + s / 2 + 3, y, s / 2 - 3, s]] : [[x, y, s, s]];
        for (const [px, py, pw, ph] of parts) {
          b.fillStyle = 'rgba(0,0,0,.25)'; roundRect(b, px + 5, py + 7, pw, ph, 6); b.fill();
          b.fillStyle = c; roundRect(b, px, py, pw, ph, 6); b.fill();
          b.strokeStyle = 'rgba(255,255,255,.06)'; b.lineWidth = 3; roundRect(b, px + 6, py + 6, pw - 12, ph - 12, 4); b.stroke();
          b.fillStyle = 'rgba(255,255,255,.07)'; b.fillRect(px + pw * 0.2, py + ph * 0.25, 18, 14); // 室外機
          b.fillStyle = 'rgba(0,0,0,.18)'; b.beginPath(); b.arc(px + pw * 0.7, py + ph * 0.65, 10, 0, TAU); b.fill();
        }
      }
    }
  }
  // 横断歩道・センターライン
  b.fillStyle = 'rgba(255,255,255,.07)';
  for (let gx = -1; gx * block < W + block; gx++) {
    for (let gy = -1; gy * block < H + block; gy++) {
      const cx = ox + gx * block + road / 2, cy = oy + gy * block + road / 2;
      for (let i = -2; i <= 2; i++) { b.fillRect(cx + i * 9 - 3, cy + road / 2 + 4, 6, 20); b.fillRect(cx + road / 2 + 4, cy + i * 9 - 3, 20, 6); }
      b.fillStyle = 'rgba(255,214,102,.08)';
      for (let k = 30; k < block - 40; k += 26) { b.fillRect(cx + road / 2 + k, cy - 1, 12, 2); b.fillRect(cx - 1, cy + road / 2 + k, 2, 12); }
      b.fillStyle = 'rgba(255,255,255,.07)';
    }
  }
}
function roundRect(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }

// ------------------------------------------------------------------
// 空間ハッシュ(近くのキャラを素早く探す)
// ------------------------------------------------------------------
const CELL = 40;
class Grid {
  constructor() { this.map = new Map(); }
  clear() { this.map.clear(); }
  key(cx, cy) { return (cx + 512) * 4096 + (cy + 512); }
  add(o) { const k = this.key(Math.floor(o.x / CELL), Math.floor(o.y / CELL)); let a = this.map.get(k); if (!a) { a = []; this.map.set(k, a); } a.push(o); }
  query(x, y, r, out) {
    out.length = 0;
    const x0 = Math.floor((x - r) / CELL), x1 = Math.floor((x + r) / CELL), y0 = Math.floor((y - r) / CELL), y1 = Math.floor((y + r) / CELL);
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) { const a = this.map.get(this.key(cx, cy)); if (a) for (let i = 0; i < a.length; i++) out.push(a[i]); }
    return out;
  }
}
const tmp = [];

// ------------------------------------------------------------------
// ゲーム本体
// ------------------------------------------------------------------
const SHIRTS = ['#ffb35c', '#ff7aa8', '#5cc8ff', '#ffe066', '#c59bff', '#ff8c6b', '#7af0d4', '#f5f5f5'];
const SKINS = ['#f6d3b3', '#e8b48c', '#c98d62', '#8d5a3b'];

class Game {
  constructor() { this.reset(); this.state = 'title'; }
  reset() {
    this.t = 0; this.score = 0; this.combo = 0; this.lastBite = -9; this.maxHorde = 1; this.enemiesDown = 0;
    this.leader = { x: W / 2, y: H / 2, vx: 0, vy: 0, r: TUNING.leaderRadius, inv: 0, face: 0, bob: 0, hitFlash: 0 };
    this.zombies = []; this.humans = []; this.enemies = []; this.bullets = []; this.parts = []; this.floaters = []; this.decals = []; this.warns = [];
    this.shake = 0; this.flash = 0; this.slow = 1; this.endTimer = -1; this.overReason = '';
    this.nextPolice = TUNING.policeFirst; this.nextSoldier = TUNING.soldierFirst; this.spawnAcc = 0; this.lastTick = 99;
    this.zgrid = new Grid();
    for (let i = 0; i < TUNING.humanTarget[0]; i++) this.spawnHuman(true);
  }
  get diff() { return clamp(this.t / TUNING.roundSeconds, 0, 1); }
  clampAll() {
    const all = [this.leader, ...this.zombies, ...this.humans, ...this.enemies];
    for (const o of all) { o.x = clamp(o.x, 10, W - 10); o.y = clamp(o.y, 10, H - 10); }
  }
  spawnHuman(initial) {
    let x, y;
    if (initial) {
      do { x = rand(20, W - 20); y = rand(20, H - 20); } while (Math.hypot(x - W / 2, y - H / 2) < 150);
    } else {
      const e = Math.floor(Math.random() * 4);
      x = e === 0 ? -10 : e === 1 ? W + 10 : rand(20, W - 20);
      y = e === 2 ? -10 : e === 3 ? H + 10 : rand(20, H - 20);
      // 主人公のすぐ近くの端からは出さない
      if (Math.hypot(x - this.leader.x, y - this.leader.y) < 120) { x = W - x; y = H - y; }
    }
    this.humans.push({ x, y, vx: 0, vy: 0, r: TUNING.humanRadius, wa: rand(0, TAU), state: 'walk', t: 0, panic: 0,
      shirt: SHIRTS[Math.floor(Math.random() * SHIRTS.length)], skin: SKINS[Math.floor(Math.random() * SKINS.length)], bob: rand(0, TAU), enter: initial ? 0 : 1.2 });
  }
  queueEnemy(type) {
    // 端の予告マーク → 少し後に出現
    const e = Math.floor(Math.random() * 4);
    let x = e === 0 ? 14 : e === 1 ? W - 14 : rand(40, W - 40);
    let y = e === 2 ? 14 : e === 3 ? H - 14 : rand(40, H - 40);
    if (Math.hypot(x - this.leader.x, y - this.leader.y) < 220) { x = W - x; y = H - y; }
    this.warns.push({ type, x, y, t: TUNING.spawnWarn });
    if (!DEMO) Sfx.siren();
  }
  spawnEnemy(w) {
    const d = this.diff;
    const isP = w.type === 'police';
    this.enemies.push({ type: w.type, x: w.x, y: w.y, vx: 0, vy: 0, r: isP ? 11 : 12, need: Math.round(diffLerp(isP ? TUNING.policeOverwhelm : TUNING.soldierOverwhelm, d)),
      speed: isP ? diffLerp(TUNING.policeSpeed, d) : TUNING.soldierSpeed, killCd: 0.4, shootCd: 1.2, touching: 0, face: 0, bob: 0, born: 0 });
  }
  addZombie(x, y) {
    if (this.zombies.length >= TUNING.maxZombies) return;
    const i = this.zombies.length;
    this.zombies.push({ x, y, vx: 0, vy: 0, r: TUNING.zombieRadius * rand(0.92, 1.08), born: 0, bob: rand(0, TAU), face: 0, wob: rand(0, TAU), hue: rand(-12, 12), idx: i });
  }
  burst(x, y, color, n, spd, size = 3, life = 0.5) {
    for (let i = 0; i < n; i++) { const a = rand(0, TAU), s = rand(spd * 0.3, spd); this.parts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life, max: life, color, size: rand(size * 0.6, size * 1.3) }); }
  }
  float(x, y, text, color = '#9df58f', size = 15) { this.floaters.push({ x, y, text, color, size, life: 0.8 }); }
  infect(h) {
    h.state = 'infecting'; h.t = 0;
    this.score++;
    this.combo = (this.t - this.lastBite < TUNING.comboWindow) ? this.combo + 1 : 1; this.lastBite = this.t;
    this.shake = Math.max(this.shake, TUNING.shakeBite + Math.min(this.combo, 10) * 0.25);
    this.burst(h.x, h.y, '#9df58f', 7, 120, 3, 0.4);
    this.burst(h.x, h.y, h.shirt, 4, 90, 2.5, 0.35);
    if (this.decals.length > 80) this.decals.shift();
    this.decals.push({ x: h.x, y: h.y, r: rand(9, 14), a: rand(0, TAU), life: 1 });
    this.float(h.x, h.y - 14, this.combo >= 3 ? `+1  ×${this.combo}` : '+1', this.combo >= 5 ? '#ffcf4a' : '#9df58f', this.combo >= 5 ? 17 : 14);
    Sfx.bite(this.combo); ui.bump();
  }
  loseZombie(z, cause) {
    const i = this.zombies.indexOf(z); if (i < 0) return;
    this.zombies.splice(i, 1);
    this.burst(z.x, z.y, '#a9b0c4', 8, 110, 3, 0.45);
    this.burst(z.x, z.y, '#5d9a57', 4, 70, 2.5, 0.4);
    Sfx.lose();
  }
  hitLeader(fromX, fromY) {
    const L = this.leader; if (L.inv > 0 || this.state !== 'play') return;
    if (this.zombies.length === 0) { // 仲間がいない時は時間が減る(いきなり終わらない)
      this.t += TUNING.soloHitTimePenalty; L.inv = TUNING.leaderInvuln; L.hitFlash = 0.3; this.flash = 0.45; this.shake = TUNING.shakeHit; Sfx.hit();
      const a0 = Math.atan2(L.y - fromY, L.x - fromX); L.vx += Math.cos(a0) * 420; L.vy += Math.sin(a0) * 420;
      this.burst(L.x, L.y, '#9df58f', 12, 180, 3, 0.5); this.float(L.x, L.y - 24, `-${TUNING.soloHitTimePenalty}秒`, '#ff6b7d', 18); ui.timePenalty();
      return;
    }
    L.inv = TUNING.leaderInvuln; L.hitFlash = 0.3; this.flash = 0.35; this.shake = TUNING.shakeHit; Sfx.hit();
    const a = Math.atan2(L.y - fromY, L.x - fromX); L.vx += Math.cos(a) * 380; L.vy += Math.sin(a) * 380;
    // 主人公に近い仲間から減る
    const sorted = this.zombies.slice().sort((p, q) => ((p.x - L.x) ** 2 + (p.y - L.y) ** 2) - ((q.x - L.x) ** 2 + (q.y - L.y) ** 2));
    const n = Math.min(Math.max(TUNING.leaderHitLose, Math.round(sorted.length * TUNING.leaderHitLoseRate)), sorted.length);
    for (let i = 0; i < n; i++) this.loseZombie(sorted[i]);
    this.float(L.x, L.y - 24, `-${n}`, '#ff6b7d', 18);
  }
  gameOver(reason) {
    if (this.state !== 'play') return;
    this.state = 'ending'; this.overReason = reason; this.endTimer = 1.0; this.slow = 0.25;
    if (!DEMO) Sfx.end();
  }
  start() {
    this.reset(); this.state = 'play'; if (!DEMO) Sfx.start();
  }

  update(rdt) {
    const dt = rdt * this.slow;
    if (this.state === 'ending') { this.endTimer -= rdt; this.slow = Math.min(1, this.slow + rdt * 0.6); if (this.endTimer <= 0) { this.state = 'over'; ui.showOver(); } }
    const playing = this.state === 'play';
    const live = this.state === 'play' || this.state === 'ending';
    if (playing) {
      this.t += dt;
      const remain = TUNING.roundSeconds - this.t;
      if (remain <= 5 && Math.ceil(remain) !== this.lastTick && remain > 0) { this.lastTick = Math.ceil(remain); if (!DEMO) Sfx.tick(); }
      if (remain <= 0) { this.t = TUNING.roundSeconds; this.gameOver('タイムアップ！'); }
    }
    const d = this.diff;
    const L = this.leader;

    // ---- 入力 → 主人公 ----
    let tx = L.x, ty = L.y, steer = false;
    if (DEMO) { const p = demoTarget(this); tx = p.x; ty = p.y; steer = true; }
    else if (input.down && playing) { tx = input.x + input.offX; ty = input.y + input.offY; steer = true; }
    tx = clamp(tx, L.r, W - L.r); ty = clamp(ty, L.r, H - L.r);
    let dvx = 0, dvy = 0;
    if (steer && live) {
      dvx = (tx - L.x) * 9; dvy = (ty - L.y) * 9;
      const m = Math.hypot(dvx, dvy), max = TUNING.leaderSpeed; if (m > max) { dvx *= max / m; dvy *= max / m; }
    }
    const la = 1 - Math.exp(-TUNING.leaderAccel * dt);
    L.vx += (dvx - L.vx) * la; L.vy += (dvy - L.vy) * la;
    L.x = clamp(L.x + L.vx * dt, L.r, W - L.r); L.y = clamp(L.y + L.vy * dt, L.r, H - L.r);
    const lsp = Math.hypot(L.vx, L.vy);
    if (lsp > 20) L.face = Math.atan2(L.vy, L.vx);
    L.bob += dt * (4 + lsp * 0.05); L.inv = Math.max(0, L.inv - dt); L.hitFlash = Math.max(0, L.hitFlash - dt);

    // ---- 空間ハッシュ ----
    const zg = this.zgrid; zg.clear();
    for (const z of this.zombies) zg.add(z);

    // ---- 仲間ゾンビ(群れ) ----
    // 隊形: ひまわりの種の並び(黄金角)で主人公のまわりに集まる。動いている時は少し後ろに伸びる
    const back = Math.min(lsp / TUNING.leaderSpeed, 1);
    const fx = Math.cos(L.face), fy = Math.sin(L.face);
    const zs = this.zombies, zr = TUNING.zombieRadius;
    const za = 1 - Math.exp(-TUNING.zombieAccel * dt);
    for (let i = 0; i < zs.length; i++) {
      const z = zs[i];
      z.born = Math.min(1, z.born + dt * 4); z.wob += dt * 2;
      const k = i + 2, rad = TUNING.slotSpacing * Math.sqrt(k) * 0.95, ang = k * 2.39996;
      let sx = Math.cos(ang) * rad, sy = Math.sin(ang) * rad;
      // 進行方向の後ろへ引き伸ばす
      const along = sx * fx + sy * fy;
      sx -= fx * (Math.abs(along) * 0.45 + rad * 0.35) * back; sy -= fy * (Math.abs(along) * 0.45 + rad * 0.35) * back;
      let gx = L.x + sx + Math.cos(z.wob) * 3, gy = L.y + sy + Math.sin(z.wob * 1.3) * 3;
      // 近くに人がいれば飛びつく
      let hunt = null, hd = TUNING.zombieHuntRange * TUNING.zombieHuntRange;
      const nearSlot = (gx - z.x) ** 2 + (gy - z.y) ** 2 < 70 * 70; // 隊形から離れすぎている時は飛びつかない(群れがまとまる)
      if (live && nearSlot) for (const h of this.humans) { if (h.state !== 'infecting') { const dd = (h.x - z.x) ** 2 + (h.y - z.y) ** 2; if (dd < hd) { hd = dd; hunt = h; } } }
      if (hunt) { gx = hunt.x; gy = hunt.y; }
      let vx = (gx - z.x) * (hunt ? 8 : 4.2), vy = (gy - z.y) * (hunt ? 8 : 4.2);
      const m = Math.hypot(vx, vy), max = TUNING.zombieSpeed * (hunt ? 1.05 : 1); if (m > max) { vx *= max / m; vy *= max / m; }
      // 押し合い(重なり防止)
      zg.query(z.x, z.y, zr * 2.2, tmp);
      for (const o of tmp) {
        if (o === z) continue;
        const dx = z.x - o.x, dy = z.y - o.y, dd = dx * dx + dy * dy, min = z.r + o.r;
        if (dd < min * min && dd > 0.0001) { const dl = Math.sqrt(dd), push = (min - dl) / dl * 22; vx += dx * push; vy += dy * push; }
      }
      { const dx = z.x - L.x, dy = z.y - L.y, dd = dx * dx + dy * dy, min = z.r + L.r + 1; if (dd < min * min && dd > 0.0001) { const dl = Math.sqrt(dd), p = (min - dl) / dl * 22; vx += dx * p; vy += dy * p; } }
      z.vx += (vx - z.vx) * za; z.vy += (vy - z.vy) * za;
      z.x = clamp(z.x + z.vx * dt, z.r, W - z.r); z.y = clamp(z.y + z.vy * dt, z.r, H - z.r);
      const sp = Math.hypot(z.vx, z.vy); if (sp > 15) z.face = Math.atan2(z.vy, z.vx); z.bob += dt * (3 + sp * 0.05);
    }
    this.maxHorde = Math.max(this.maxHorde, zs.length + 1);

    // ---- 人 ----
    const fleeSp = diffLerp(TUNING.humanFleeSpeed, d), fr = TUNING.humanFleeRange;
    for (let i = this.humans.length - 1; i >= 0; i--) {
      const h = this.humans[i];
      h.bob += dt * 8;
      if (h.state === 'infecting') {
        h.t += dt;
        if (h.t >= TUNING.infectTime) { this.humans.splice(i, 1); this.addZombie(h.x, h.y); this.burst(h.x, h.y, '#9df58f', 5, 60, 2, 0.3); }
        continue;
      }
      if (h.enter > 0) h.enter -= dt;
      // 一番近いゾンビ
      let nx = L.x, ny = L.y, nd = (L.x - h.x) ** 2 + (L.y - h.y) ** 2;
      zg.query(h.x, h.y, fr, tmp);
      for (const z of tmp) { const dd = (z.x - h.x) ** 2 + (z.y - h.y) ** 2; if (dd < nd) { nd = dd; nx = z.x; ny = z.y; } }
      let vx, vy;
      if (live && nd < fr * fr) {
        if (h.state !== 'flee') { h.panic = 0.6; }
        h.state = 'flee';
        const dl = Math.sqrt(nd) || 1; vx = (h.x - nx) / dl; vy = (h.y - ny) / dl;
        // 壁から少し離れようとする(角に追い込まれやすいのは仕様)
        const m = 50; if (h.x < m) vx += (m - h.x) / m * 0.8; if (h.x > W - m) vx -= (h.x - (W - m)) / m * 0.8; if (h.y < m) vy += (m - h.y) / m * 0.8; if (h.y > H - m) vy -= (h.y - (H - m)) / m * 0.8;
        const n = Math.hypot(vx, vy) || 1; vx = vx / n * fleeSp; vy = vy / n * fleeSp;
      } else {
        h.state = 'walk';
        h.wa += rand(-1.5, 1.5) * dt;
        if (h.enter > 0) h.wa = Math.atan2(H / 2 - h.y, W / 2 - h.x);
        if (h.x < 20) h.wa = 0; else if (h.x > W - 20) h.wa = Math.PI; if (h.y < 20) h.wa = Math.PI / 2; else if (h.y > H - 20) h.wa = -Math.PI / 2;
        vx = Math.cos(h.wa) * TUNING.humanWalkSpeed; vy = Math.sin(h.wa) * TUNING.humanWalkSpeed;
      }
      const ha = 1 - Math.exp(-8 * dt);
      h.vx += (vx - h.vx) * ha; h.vy += (vy - h.vy) * ha;
      h.x += h.vx * dt; h.y += h.vy * dt;
      if (h.enter <= 0) { h.x = clamp(h.x, h.r, W - h.r); h.y = clamp(h.y, h.r, H - h.r); }
      h.panic = Math.max(0, h.panic - dt);
      // 接触判定
      if (playing) {
        let bitten = (h.x - L.x) ** 2 + (h.y - L.y) ** 2 < (h.r + L.r) ** 2;
        if (!bitten) { zg.query(h.x, h.y, h.r + zr + 2, tmp); for (const z of tmp) { if ((h.x - z.x) ** 2 + (h.y - z.y) ** 2 < (h.r + z.r) ** 2) { bitten = true; break; } } }
        if (bitten) this.infect(h);
      }
    }
    // 補充
    if (live || this.state === 'title') {
      const target = Math.round(diffLerp(TUNING.humanTarget, d));
      this.spawnAcc += dt * diffLerp(TUNING.humanSpawnPerSec, d);
      while (this.spawnAcc >= 1) { this.spawnAcc -= 1; if (this.humans.length < target) this.spawnHuman(false); }
    }

    // ---- 敵 ----
    if (playing) {
      if (this.t >= this.nextPolice && this.enemies.length + this.warns.length < TUNING.maxEnemies) { this.queueEnemy('police'); this.nextPolice = this.t + diffLerp(TUNING.policeInterval, d); }
      if (this.t >= this.nextSoldier && this.enemies.length + this.warns.length < TUNING.maxEnemies) { this.queueEnemy('soldier'); this.nextSoldier = this.t + diffLerp(TUNING.soldierInterval, d); }
    }
    for (let i = this.warns.length - 1; i >= 0; i--) { const w = this.warns[i]; w.t -= dt; if (w.t <= 0) { this.warns.splice(i, 1); if (live) this.spawnEnemy(w); } }
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      e.born = Math.min(1, e.born + dt * 3); e.bob += dt * 7;
      const dx = L.x - e.x, dy = L.y - e.y, dl = Math.hypot(dx, dy) || 1;
      let vx, vy;
      if (e.type === 'police') { vx = dx / dl * e.speed; vy = dy / dl * e.speed; }
      else { // 兵士: 一定距離を保って撃つ
        const want = 210, s = dl > want + 30 ? 1 : dl < want - 30 ? -1 : 0;
        vx = dx / dl * e.speed * s + (-dy / dl) * 25; vy = dy / dl * e.speed * s + (dx / dl) * 25;
        e.shootCd -= dt;
        if (e.shootCd <= 0 && live && this.state === 'play') {
          e.shootCd = diffLerp(TUNING.soldierShootEvery, d);
          const a = Math.atan2(dy, dx);
          this.bullets.push({ x: e.x + Math.cos(a) * 16, y: e.y + Math.sin(a) * 16, vx: Math.cos(a) * TUNING.bulletSpeed, vy: Math.sin(a) * TUNING.bulletSpeed, life: 2.2 });
          this.burst(e.x + Math.cos(a) * 16, e.y + Math.sin(a) * 16, '#ffe680', 4, 80, 2, 0.15);
          Sfx.shoot();
        }
      }
      // 囲まれ判定
      zg.query(e.x, e.y, e.r + zr + 6, tmp);
      const touching = [];
      for (const z of tmp) if ((z.x - e.x) ** 2 + (z.y - e.y) ** 2 < (e.r + z.r + 3) ** 2) touching.push(z);
      const leaderTouch = (L.x - e.x) ** 2 + (L.y - e.y) ** 2 < (e.r + L.r + 2) ** 2;
      e.touching = touching.length + (leaderTouch ? 1 : 0);
      if (touching.length) { vx *= 0.25; vy *= 0.25; }
      e.vx += (vx - e.vx) * (1 - Math.exp(-6 * dt)); e.vy += (vy - e.vy) * (1 - Math.exp(-6 * dt));
      e.x = clamp(e.x + e.vx * dt, e.r, W - e.r); e.y = clamp(e.y + e.vy * dt, e.r, H - e.r);
      e.face = Math.atan2(dy, dx);
      if (!playing) continue;
      if (e.touching >= e.need) { // 囲んで倒した → 仲間になる
        this.enemies.splice(i, 1); this.enemiesDown++; this.score += 3;
        this.burst(e.x, e.y, e.type === 'police' ? '#4d8bff' : '#a7ad6a', 14, 180, 3.5, 0.6); this.burst(e.x, e.y, '#ffcf4a', 10, 220, 2.5, 0.5);
        this.shake = Math.max(this.shake, TUNING.shakeKill); this.float(e.x, e.y - 20, '+3 撃破!', '#ffcf4a', 18);
        this.addZombie(e.x, e.y); Sfx.kill(); ui.bump();
        continue;
      }
      e.killCd -= dt;
      if (e.killCd <= 0) {
        if (leaderTouch && L.inv <= 0) { e.killCd = TUNING.enemyKillEvery * 2; this.hitLeader(e.x, e.y); }
        else if (touching.length) { e.killCd = TUNING.enemyKillEvery; this.loseZombie(touching[0]); this.shake = Math.max(this.shake, 3); }
      }
    }
    // 弾
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i]; b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt;
      let hit = false;
      if (playing) {
        zg.query(b.x, b.y, zr + 4, tmp);
        for (const z of tmp) if ((z.x - b.x) ** 2 + (z.y - b.y) ** 2 < (z.r + 3) ** 2 && this.zombies.includes(z)) { this.loseZombie(z); hit = true; this.shake = Math.max(this.shake, 3); break; }
        if (!hit && (L.x - b.x) ** 2 + (L.y - b.y) ** 2 < (L.r + 3) ** 2) { if (L.inv <= 0) { this.hitLeader(b.x - b.vx, b.y - b.vy); hit = true; } }
      }
      if (hit || b.life <= 0 || b.x < -20 || b.y < -20 || b.x > W + 20 || b.y > H + 20) this.bullets.splice(i, 1);
    }
    // 演出
    for (let i = this.parts.length - 1; i >= 0; i--) { const p = this.parts[i]; p.life -= rdt; p.x += p.vx * rdt; p.y += p.vy * rdt; p.vx *= 0.9; p.vy *= 0.9; if (p.life <= 0) this.parts.splice(i, 1); }
    for (let i = this.floaters.length - 1; i >= 0; i--) { const f = this.floaters[i]; f.life -= rdt; f.y -= 34 * rdt; if (f.life <= 0) this.floaters.splice(i, 1); }
    for (const dc of this.decals) dc.life = Math.max(0.25, dc.life - rdt * 0.06);
    this.shake *= Math.exp(-10 * rdt); if (this.shake < 0.05) this.shake = 0;
    this.flash = Math.max(0, this.flash - rdt);
  }

  // ---------------- 描画 ----------------
  draw(now) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const sh = this.shake;
    if (sh) { ctx.fillStyle = '#14161f'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
    const ox = sh ? (Math.random() * 2 - 1) * sh : 0, oy = sh ? (Math.random() * 2 - 1) * sh : 0;
    ctx.setTransform(dpr * S, 0, 0, dpr * S, ox * dpr * S, oy * dpr * S);
    ctx.drawImage(bgCanvas, 0, 0, W, H);

    // 地面のしみ
    ctx.fillStyle = '#6fd36b';
    for (const dc of this.decals) { ctx.globalAlpha = 0.14 * dc.life; splat(dc.x, dc.y, dc.r, dc.a); }
    ctx.globalAlpha = 1;

    // 影
    ctx.fillStyle = 'rgba(0,0,0,.28)';
    ctx.beginPath();
    for (const h of this.humans) { ctx.moveTo(h.x + h.r + 2, h.y + 4); ctx.ellipse(h.x + 2, h.y + 4, h.r, h.r * 0.7, 0, 0, TAU); }
    for (const z of this.zombies) { ctx.moveTo(z.x + z.r + 2, z.y + 4); ctx.ellipse(z.x + 2, z.y + 4, z.r, z.r * 0.7, 0, 0, TAU); }
    for (const e of this.enemies) { ctx.moveTo(e.x + e.r + 2, e.y + 4); ctx.ellipse(e.x + 2, e.y + 4, e.r, e.r * 0.7, 0, 0, TAU); }
    ctx.fill();

    // 敵出現予告
    for (const w of this.warns) {
      const p = 1 - w.t / TUNING.spawnWarn, a = 0.5 + 0.5 * Math.sin(now * 0.025);
      ctx.strokeStyle = w.type === 'police' ? `rgba(77,139,255,${a})` : `rgba(255,107,125,${a})`; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(w.x, w.y, 22 - p * 8, 0, TAU); ctx.stroke();
      ctx.fillStyle = ctx.strokeStyle; ctx.font = '900 18px system-ui,sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('!', w.x, w.y + 1);
    }

    // 人
    for (const h of this.humans) {
      const inf = h.state === 'infecting' ? h.t / TUNING.infectTime : 0;
      const sc = inf ? 1 + Math.sin(inf * Math.PI) * 0.35 : 1;
      const run = h.state === 'flee';
      const bob = run ? Math.sin(h.bob * 1.6) * 1.2 : Math.sin(h.bob * 0.6) * 0.6;
      ctx.save(); ctx.translate(h.x, h.y + bob); ctx.scale(sc, sc);
      ctx.fillStyle = inf ? mix(h.shirt, '#8de07f', inf) : h.shirt;
      ctx.beginPath(); ctx.arc(0, 0, h.r, 0, TAU); ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.stroke();
      ctx.fillStyle = inf ? mix(h.skin, '#8de07f', inf) : h.skin; ctx.beginPath(); ctx.arc(0, -1, h.r * 0.55, 0, TAU); ctx.fill();
      if (inf) { ctx.fillStyle = `rgba(255,255,255,${1 - inf})`; ctx.beginPath(); ctx.arc(0, 0, h.r * 1.2, 0, TAU); ctx.fill(); }
      ctx.restore();
      if (h.panic > 0 || (run && Math.sin(h.bob) > 0.7)) {
        ctx.fillStyle = '#fff'; ctx.font = '900 13px system-ui,sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
        ctx.fillText('!', h.x, h.y - h.r - 4 - (h.panic > 0 ? (0.6 - h.panic) * 8 : 0));
      }
    }

    // 仲間ゾンビ
    for (const z of this.zombies) drawZombie(z.x, z.y, z.r * (z.born < 1 ? easeOutBack(z.born) : 1), z.face, z.bob, z.hue, false, 0);
    // 敵
    for (const e of this.enemies) drawEnemy(e, now);
    // 主人公
    const L = this.leader;
    if (!(L.inv > 0 && Math.floor(now / 70) % 2 === 0)) {
      const pul = 0.5 + 0.5 * Math.sin(now * 0.006);
      ctx.strokeStyle = `rgba(124,92,255,${0.35 + pul * 0.35})`; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(L.x, L.y, L.r + 6 + pul * 2, 0, TAU); ctx.stroke();
      drawZombie(L.x, L.y, L.r, L.face, L.bob, 0, true, L.hitFlash);
    }
    // 弾
    for (const b of this.bullets) {
      ctx.strokeStyle = 'rgba(255,230,128,.45)'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(b.x - b.vx * 0.05, b.y - b.vy * 0.05); ctx.stroke();
      ctx.fillStyle = '#fff3b0'; ctx.beginPath(); ctx.arc(b.x, b.y, 3.2, 0, TAU); ctx.fill();
    }
    // 粒
    for (const p of this.parts) { ctx.globalAlpha = clamp(p.life / p.max, 0, 1); ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, TAU); ctx.fill(); }
    ctx.globalAlpha = 1;
    // 文字
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const f of this.floaters) {
      const a = clamp(f.life / 0.8, 0, 1), s = f.life > 0.65 ? 1 + (f.life - 0.65) * 3 : 1;
      ctx.globalAlpha = a; ctx.font = `900 ${f.size * s}px system-ui,sans-serif`;
      ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.strokeText(f.text, f.x, f.y); ctx.fillStyle = f.color; ctx.fillText(f.text, f.x, f.y);
    }
    ctx.globalAlpha = 1;
    // 被弾フラッシュ
    if (this.flash > 0) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const g = ctx.createRadialGradient(canvas.width / 2, canvas.height / 2, Math.min(canvas.width, canvas.height) * 0.3, canvas.width / 2, canvas.height / 2, Math.max(canvas.width, canvas.height) * 0.7);
      g.addColorStop(0, 'rgba(255,40,70,0)'); g.addColorStop(1, `rgba(255,40,70,${this.flash * 1.3})`);
      ctx.fillStyle = g; ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
  }
}

function easeOutBack(t) { const c = 1.9; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); }
function splat(x, y, r, a) { ctx.beginPath(); ctx.arc(x, y, r * 0.8, 0, TAU); for (let i = 0; i < 3; i++) { const an = a + i * 2.1; ctx.moveTo(x + Math.cos(an) * r * 1.1, y + Math.sin(an) * r * 1.1); ctx.arc(x + Math.cos(an) * r * 1.1 - r * 0.3, y + Math.sin(an) * r * 1.1, r * 0.3, 0, TAU); } ctx.fill(); }
function blob(x, y, r, a) { ctx.beginPath(); for (let i = 0; i < 9; i++) { const an = a + i / 9 * TAU, rr = r * (0.85 + 0.15 * Math.sin(i * 2.7 + a)); ctx.lineTo(x + Math.cos(an) * rr, y + Math.sin(an) * rr); } ctx.closePath(); ctx.fill(); }
function mix(c1, c2, t) {
  const p = (c) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
  const a = p(c1), b = p(c2); return `rgb(${Math.round(lerp(a[0], b[0], t))},${Math.round(lerp(a[1], b[1], t))},${Math.round(lerp(a[2], b[2], t))})`;
}
// ゾンビの絵(丸い体+目+小さな腕)
function drawZombie(x, y, r, face, bob, hue, leader, flash) {
  const sq = 1 + Math.sin(bob) * 0.06;
  ctx.save(); ctx.translate(x, y); ctx.rotate(face);
  // 腕(前に伸ばす)
  ctx.fillStyle = leader ? '#5fae5a' : '#6fbf68';
  const arm = Math.sin(bob * 1.3) * r * 0.12;
  ctx.beginPath(); ctx.ellipse(r * 0.75 + arm, -r * 0.62, r * 0.42, r * 0.2, 0, 0, TAU); ctx.fill();
  ctx.beginPath(); ctx.ellipse(r * 0.75 - arm, r * 0.62, r * 0.42, r * 0.2, 0, 0, TAU); ctx.fill();
  ctx.scale(sq, 1 / sq);
  ctx.fillStyle = flash > 0 ? '#ffffff' : leader ? '#7ad372' : `hsl(${110 + hue},55%,${62 + hue * 0.3}%)`;
  ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill();
  ctx.lineWidth = leader ? 2.5 : 1.8; ctx.strokeStyle = leader ? '#2f6b3a' : 'rgba(30,70,35,.75)'; ctx.stroke();
  // ほっぺのつぎはぎ
  ctx.strokeStyle = 'rgba(40,80,40,.55)'; ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.moveTo(-r * 0.5, -r * 0.2); ctx.lineTo(-r * 0.15, -r * 0.45); ctx.stroke();
  // 目
  const ex = r * 0.38, ey = r * 0.34, er = r * (leader ? 0.3 : 0.28);
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(ex, -ey, er, 0, TAU); ctx.arc(ex, ey, er * 0.85, 0, TAU); ctx.fill();
  ctx.fillStyle = leader ? '#b0003a' : '#1d1d28'; ctx.beginPath(); ctx.arc(ex + er * 0.35, -ey, er * 0.5, 0, TAU); ctx.arc(ex + er * 0.3, ey, er * 0.42, 0, TAU); ctx.fill();
  if (leader) { // 主人公だけ頭に包帯
    ctx.strokeStyle = '#f2efe6'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(0, 0, r * 0.72, Math.PI * 0.62, Math.PI * 1.38); ctx.stroke();
  }
  ctx.restore();
}
function drawEnemy(e, now) {
  const r = e.r * (e.born < 1 ? easeOutBack(e.born) : 1);
  const isP = e.type === 'police';
  // 囲みゲージ
  if (e.touching > 0) {
    const p = Math.min(1, e.touching / e.need);
    ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(e.x, e.y, r + 9, 0, TAU); ctx.stroke();
    ctx.strokeStyle = '#ffcf4a'; ctx.beginPath(); ctx.arc(e.x, e.y, r + 9, -Math.PI / 2, -Math.PI / 2 + p * TAU); ctx.stroke();
  }
  ctx.save(); ctx.translate(e.x, e.y + Math.sin(e.bob) * 0.8); ctx.rotate(e.face);
  if (!isP) { ctx.fillStyle = '#2a2a2a'; ctx.fillRect(r * 0.3, r * 0.25, r * 1.25, r * 0.32); } // 銃
  ctx.fillStyle = isP ? '#3f7cf0' : '#8b915a'; ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill();
  ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(0,0,0,.45)'; ctx.stroke();
  if (isP) {
    ctx.fillStyle = '#1b2f66'; ctx.beginPath(); ctx.arc(-r * 0.05, 0, r * 0.66, 0, TAU); ctx.fill(); // 帽子
    ctx.fillStyle = '#10204a'; ctx.beginPath(); ctx.ellipse(r * 0.55, 0, r * 0.22, r * 0.5, 0, 0, TAU); ctx.fill(); // つば
    ctx.fillStyle = '#ffd34d'; ctx.beginPath(); ctx.arc(-r * 0.05, 0, r * 0.18, 0, TAU); ctx.fill(); // バッジ
  } else {
    ctx.fillStyle = '#5c6136'; ctx.beginPath(); ctx.arc(0, 0, r * 0.72, 0, TAU); ctx.fill(); // ヘルメット
    ctx.strokeStyle = 'rgba(0,0,0,.25)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(-r * 0.5, 0); ctx.lineTo(r * 0.5, 0); ctx.stroke();
  }
  ctx.restore();
  if (isP && Math.floor(now / 250) % 2 === 0) { ctx.fillStyle = 'rgba(255,60,80,.9)'; ctx.beginPath(); ctx.arc(e.x, e.y - r - 6, 2.6, 0, TAU); ctx.fill(); }
  else if (isP) { ctx.fillStyle = 'rgba(80,140,255,.9)'; ctx.beginPath(); ctx.arc(e.x, e.y - r - 6, 2.6, 0, TAU); ctx.fill(); }
}

// ------------------------------------------------------------------
// デモ(プレビュー動画・サムネ用): 自動で近くの人を追いかける
// ------------------------------------------------------------------
let demoGoal = null, demoRetarget = 0;
function demoTarget(g) {
  const L = g.leader;
  demoRetarget -= 1 / 60;
  // 近くの敵が強いなら逃げる
  for (const e of g.enemies) { const d = Math.hypot(e.x - L.x, e.y - L.y); if (d < 90 && g.zombies.length < e.need * 2) return { x: L.x - (e.x - L.x) * 2, y: L.y - (e.y - L.y) * 2 }; }
  if (!demoGoal || demoRetarget <= 0 || !g.humans.includes(demoGoal) || demoGoal.state === 'infecting') {
    let best = null, bd = 1e9;
    for (const h of g.humans) { if (h.state === 'infecting' || h.enter > 0) continue; const d = Math.hypot(h.x - L.x, h.y - L.y) + Math.hypot(h.x - W / 2, h.y - H / 2) * 0.6; if (d < bd) { bd = d; best = h; } }
    demoGoal = best; demoRetarget = 0.8;
  }
  if (!demoGoal) return { x: W / 2, y: H / 2 };
  return { x: demoGoal.x + demoGoal.vx * 0.3, y: demoGoal.y + demoGoal.vy * 0.3 };
}

// ------------------------------------------------------------------
// 入力(ドラッグのみ。指を置いた位置からの相対移動なので指でキャラが隠れない)
// ------------------------------------------------------------------
const input = { down: false, id: null, x: 0, y: 0, offX: 0, offY: 0 };
function toWorld(ev) { const r = canvas.getBoundingClientRect(); return { x: (ev.clientX - r.left) / S, y: (ev.clientY - r.top) / S }; }
canvas.addEventListener('pointerdown', (ev) => {
  Sfx.unlock();
  if (input.down) return;
  const p = toWorld(ev);
  input.down = true; input.id = ev.pointerId; input.x = p.x; input.y = p.y;
  input.offX = game.leader.x - p.x; input.offY = game.leader.y - p.y;
  try { canvas.setPointerCapture(ev.pointerId); } catch (e) {}
  ev.preventDefault();
});
canvas.addEventListener('pointermove', (ev) => {
  if (!input.down || ev.pointerId !== input.id) return;
  const p = toWorld(ev); input.x = p.x; input.y = p.y; ev.preventDefault();
});
const up = (ev) => { if (ev.pointerId === input.id) { input.down = false; input.id = null; } };
canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up); canvas.addEventListener('lostpointercapture', up);
document.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
document.addEventListener('gesturestart', (e) => e.preventDefault());

// ------------------------------------------------------------------
// UI(DOM)
// ------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const ui = {
  shownScore: -1, shownHorde: -1, shownTime: -1,
  timePenalty() { const t = $('hudTime'); t.classList.remove('hit'); void t.offsetWidth; t.classList.add('hit'); },
  bump() { const p = $('hudScore').parentElement; p.classList.remove('bump'); void p.offsetWidth; p.classList.add('bump'); },
  showTitle() { $('startBest').textContent = store.get(BEST_KEY, 0); $('startScreen').classList.remove('hidden'); $('overScreen').classList.add('hidden'); $('hud').classList.add('hidden'); },
  showPlay() { $('startScreen').classList.add('hidden'); $('overScreen').classList.add('hidden'); $('hud').classList.remove('hidden'); },
  showOver() {
    const best = store.get(BEST_KEY, 0), isNew = game.score > best;
    if (isNew && !DEMO) { store.set(BEST_KEY, game.score); setTimeout(() => Sfx.best(), 350); }
    $('overTitle').textContent = game.overReason;
    $('overBest').textContent = Math.max(best, game.score);
    $('overMaxHorde').textContent = game.maxHorde;
    $('overEnemies').textContent = game.enemiesDown;
    $('newBest').classList.toggle('hidden', !isNew);
    $('overScreen').classList.remove('hidden'); $('hud').classList.add('hidden');
    // スコアのカウントアップ
    const target = game.score, t0 = performance.now();
    const step = (n) => { const p = Math.min(1, (n - t0) / 700); $('overScore').textContent = Math.round(target * (1 - Math.pow(1 - p, 3))); if (p < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
    if (DEMO) setTimeout(() => game.start(), 600);
  },
  update() {
    if (game.state !== 'play' && game.state !== 'ending') return;
    if (game.score !== this.shownScore) { this.shownScore = game.score; $('hudScore').textContent = game.score; }
    const hz = game.zombies.length + 1; if (hz !== this.shownHorde) { this.shownHorde = hz; $('hudHorde').textContent = hz; }
    const remain = Math.max(0, TUNING.roundSeconds - game.t), sec = Math.ceil(remain);
    if (sec !== this.shownTime) { this.shownTime = sec; $('hudTime').textContent = sec; $('hudTime').classList.toggle('warn', sec <= 10); }
    $('hudBar').style.transform = `scaleX(${remain / TUNING.roundSeconds})`;
  },
};
function updateMuteIcon() { $('muteWave').style.display = Sfx.muted ? 'none' : ''; $('muteX').style.display = Sfx.muted ? '' : 'none'; }
$('muteBtn').addEventListener('click', (e) => { e.stopPropagation(); Sfx.unlock(); Sfx.setMuted(!Sfx.muted); updateMuteIcon(); });
function startGame() { Sfx.unlock(); game.start(); ui.shownScore = ui.shownHorde = ui.shownTime = -1; ui.showPlay(); }
$('startBtn').addEventListener('click', startGame);
$('retryBtn').addEventListener('click', startGame);
window.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && (game.state === 'title' || game.state === 'over')) { e.preventDefault(); startGame(); }
});
updateMuteIcon();

// ------------------------------------------------------------------
// ループ
// ------------------------------------------------------------------
let game = null;
resize();
game = new Game();
window.addEventListener('resize', resize);
let lastT = performance.now(), paused = false;
document.addEventListener('visibilitychange', () => { paused = document.hidden; lastT = performance.now(); });
const MANUAL = DEMO && params.has('manual'); // 動画書き出し用: 外部から1コマずつ進める
let simNow = 0;
if (MANUAL) window.__step = (n = 1, dt = 1 / 30) => { for (let i = 0; i < n; i++) { simNow += dt * 1000; game.update(dt / 2); game.update(dt / 2); } game.draw(simNow); };
function frame(now) {
  if (MANUAL) return;
  requestAnimationFrame(frame);
  if (paused) return;
  let dt = (now - lastT) / 1000; lastT = now;
  if (dt > 1 / 20) dt = 1 / 20; if (dt < 0) dt = 0;
  // 細かく分けて計算(速い動きでもすり抜けにくい)
  const steps = dt > 1 / 45 ? 2 : 1;
  for (let i = 0; i < steps; i++) game.update(dt / steps);
  game.draw(now);
  ui.update();
}
if (DEMO) { game.start(); if (THUMB) { /* サムネ用: 少し進めた状態から */ for (let i = 0; i < 60 * 9; i++) game.update(1 / 60); } }
else ui.showTitle();
requestAnimationFrame(frame);

// 自動テスト用の読み取り口(ゲームには影響しない)
window.__zm = {
  get state() { return game.state; }, get score() { return game.score; }, get horde() { return game.zombies.length + 1; },
  get time() { return game.t; }, get enemies() { return game.enemies.length; }, get humans() { return game.humans.length; },
  get leader() { return { x: game.leader.x * S, y: game.leader.y * S }; }, get best() { return store.get(BEST_KEY, 0); },
  get muted() { return Sfx.muted; }, TUNING,
  // テスト用: 一番近い人の画面座標(CSS px)
  get nearestHuman() { const L = game.leader; let b = null, bd = 1e9; for (const h of game.humans) { if (h.state === 'infecting' || h.x < 0 || h.y < 0 || h.x > W || h.y > H) continue; const d = Math.hypot(h.x - L.x, h.y - L.y); if (d < bd) { bd = d; b = h; } } return b && { x: b.x * S, y: b.y * S }; },
};
})();
