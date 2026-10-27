/* 落として同じゾンビをくっつける。物理は自前の簡易Verlet */
(() => {
'use strict';
// ===================================================================
// 調整パラメータ
// ===================================================================
const TUNING = {
  // レベルごとの半径(単位)。11段階
  radii: [13, 17, 22, 28, 34, 41, 49, 58, 68, 80, 94],
  dropMaxLevel: 5,        // 落とせるのはLv1〜この数まで
  gravity: 1500,          // 重力(単位/秒^2)
  substeps: 8,            // 物理の細かさ(多いほど安定・重い)
  damping: 0.995,         // 空気抵抗
  wallFriction: 0.6,      // 壁・床でのすべりにくさ(0〜1)
  dropCooldown: 0.45,     // 連続で落とせる間隔(秒)
  overTime: 1.6,          // 線を越えた状態がこの秒数続くと終了
  mergeGrow: 0.14,        // 合成直後に大きくなるまでの秒数
};
const NAMES = ['ゾンベビ', 'ちびゾン', 'ゾンキッズ', 'ゾン学生', 'ゾン社員', 'ゾン店長', 'マッチョゾン', 'ゾン力士', 'でかゾン', 'ゾンビ大王', 'ゾンビ神'];
const COLORS = ['#b9f5a6', '#8de07f', '#6fd3a8', '#7cc7e8', '#a99cf0', '#e89ad8', '#f5a36b', '#f5d36b', '#c8e66b', '#ff7a7a', '#ffe9a8'];
const STAGE_W = 360, STAGE_H = 640;
const JAR = { l: 28, r: 332, t: 150, b: 612 };
const LINE_Y = 196, DROP_Y = 118;
const TAU = Math.PI * 2;
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const params = new URLSearchParams(location.search);
const DEMO = params.has('demo');
if (DEMO) document.body.classList.add('demo');

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
};
const BEST_KEY = 'gamelab.zombie-merge.best', MUTE_KEY = 'gamelab.muted';

// ---------------- 効果音 ----------------
const Sfx = (() => {
  let ac = null, master = null, muted = DEMO ? true : store.get(MUTE_KEY, false);
  function unlock() { if (DEMO) return; if (!ac) { const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return; ac = new AC(); master = ac.createGain(); master.gain.value = muted ? 0 : 0.5; master.connect(ac.destination); } if (ac.state === 'suspended') ac.resume(); }
  function tone(type, f0, f1, dur, vol, delay = 0) {
    if (!ac || muted) return; const t = ac.currentTime + delay;
    const o = ac.createOscillator(), g = ac.createGain(); o.type = type;
    o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(master); o.start(t); o.stop(t + dur + 0.02);
  }
  let lastBump = 0;
  return {
    unlock, get muted() { return muted; },
    setMuted(m) { muted = m; store.set(MUTE_KEY, m); if (master) master.gain.value = m ? 0 : 0.5; },
    drop() { tone('sine', 520, 300, 0.08, 0.15); },
    bump(v) { const n = performance.now(); if (n - lastBump < 70 || v < 120) return; lastBump = n; tone('sine', 140, 90, 0.06, Math.min(0.12, v / 3000)); },
    merge(lv) { const f = 300 * Math.pow(1.12, lv); tone('triangle', f, f * 1.6, 0.12, 0.2); tone('sine', f * 2, f * 2.4, 0.09, 0.08, 0.04); },
    over() { [0, 0.14, 0.28].forEach((d, i) => tone('triangle', 440 / Math.pow(1.22, i), 400 / Math.pow(1.22, i), 0.18, 0.2, d)); },
    start() { [0, 0.08, 0.16].forEach((d, i) => tone('triangle', 392 * Math.pow(1.26, i), 392 * Math.pow(1.26, i), 0.12, 0.18, d)); },
  };
})();

// ---------------- 画面 ----------------
const canvas = document.getElementById('game');
let ctx = canvas.getContext('2d');
let cssW = 1, cssH = 1, dpr = 1, S = 1, OX = 0, OY = 0;
function resize() {
  cssW = Math.max(1, innerWidth); cssH = Math.max(1, innerHeight); dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
  S = Math.min(cssW / STAGE_W, cssH / STAGE_H); OX = (cssW - STAGE_W * S) / 2; OY = (cssH - STAGE_H * S) / 2;
}
addEventListener('resize', resize); resize();

// ---------------- 状態 ----------------
let balls = [], parts = [], floaters = [], score = 0, maxLv = 0, state = 'title', nextLv = 0, curLv = 0, aimX = STAGE_W / 2;
let cooldown = 0, overT = 0, shake = 0, idSeq = 1, time = 0, dangerFlash = 0, combo = 0, comboT = 0;
function randLv() { // 小さいほど出やすい
  const w = [5, 4, 3, 2, 1].slice(0, TUNING.dropMaxLevel); let s = w.reduce((a, b) => a + b), r = Math.random() * s;
  for (let i = 0; i < w.length; i++) { r -= w[i]; if (r < 0) return i; } return 0;
}
let bestCache = store.get(BEST_KEY, 0);
function reset() { bestCache = store.get(BEST_KEY, 0); balls = []; parts = []; floaters = []; score = 0; maxLv = 0; curLv = randLv(); nextLv = randLv(); cooldown = 0.3; overT = 0; shake = 0; time = 0; combo = 0; }
function makeBall(x, y, lv, grow) {
  const r = TUNING.radii[lv];
  return { id: idSeq++, x, y, px: x, py: y, lv, r: grow ? r * 0.55 : r, tr: r, age: 0, merged: false, face: Math.random() * TAU, blink: Math.random() * 4 };
}
function drop() {
  if (state !== 'play' || cooldown > 0) return;
  const r = TUNING.radii[curLv];
  const x = clamp(aimX, JAR.l + r, JAR.r - r);
  const b = makeBall(x, DROP_Y, curLv, false); b.py = DROP_Y - 2; balls.push(b);
  curLv = nextLv; nextLv = randLv(); cooldown = TUNING.dropCooldown; Sfx.drop();
}
function burst(x, y, color, n, spd, size) { for (let i = 0; i < n; i++) { const a = Math.random() * TAU, s = spd * (0.3 + Math.random() * 0.7); parts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.55, max: 0.55, color, size: size * (0.6 + Math.random() * 0.7) }); } }

// ---------------- 物理 ----------------
function physics(dt) {
  const n = TUNING.substeps, h = dt / n, g = TUNING.gravity * h * h;
  for (let s = 0; s < n; s++) {
    for (const b of balls) {
      const vx = (b.x - b.px) * TUNING.damping, vy = (b.y - b.py) * TUNING.damping;
      b.px = b.x; b.py = b.y; b.x += vx; b.y += vy + g;
      if (b.r < b.tr) b.r = Math.min(b.tr, b.r + (b.tr * 0.45) * (h / TUNING.mergeGrow));
    }
    // 円どうし
    for (let i = 0; i < balls.length; i++) {
      const a = balls[i]; if (a.merged) continue;
      for (let j = i + 1; j < balls.length; j++) {
        const b = balls[j]; if (b.merged) continue;
        const dx = b.x - a.x, dy = b.y - a.y, min = a.r + b.r, dd = dx * dx + dy * dy;
        if (dd >= min * min || dd < 1e-6) continue;
        const d = Math.sqrt(dd);
        if (a.lv === b.lv && state === 'play') { mergeBalls(a, b); break; }
        const ov = (min - d), nx = dx / d, ny = dy / d;
        const ma = a.tr * a.tr, mb = b.tr * b.tr, ta = mb / (ma + mb), tb = ma / (ma + mb);
        a.x -= nx * ov * ta; a.y -= ny * ov * ta; b.x += nx * ov * tb; b.y += ny * ov * tb;
      }
    }
    balls = balls.filter((b) => !b.merged);
    // 壁
    for (const b of balls) {
      if (b.x - b.r < JAR.l) { b.x = JAR.l + b.r; b.py += (b.y - b.py) * (1 - TUNING.wallFriction) * 0.2; }
      if (b.x + b.r > JAR.r) { b.x = JAR.r - b.r; b.py += (b.y - b.py) * (1 - TUNING.wallFriction) * 0.2; }
      if (b.y + b.r > JAR.b) {
        const vy = b.y - b.py; if (vy * n / dt > 200) Sfx.bump(vy * n / dt);
        b.y = JAR.b - b.r; b.px += (b.x - b.px) * TUNING.wallFriction * 0.25;
      }
    }
  }
}
function mergeBalls(a, b) {
  a.merged = b.merged = true;
  const x = (a.x + b.x) / 2, y = (a.y + b.y) / 2, lv = a.lv + 1;
  comboT = 1.2; combo++;
  if (lv >= TUNING.radii.length) { // 最大同士 → 消えてボーナス
    score += 500; burst(x, y, '#ffe9a8', 40, 420, 6); shake = 14; floaters.push({ x, y, text: '+500 昇天!', life: 1.2, color: '#ffe9a8', size: 26 }); Sfx.merge(12);
    return;
  }
  const nb = makeBall(x, y, lv, true); nb.px = x - ((a.x - a.px) + (b.x - b.px)) / 2; nb.py = y - ((a.y - a.py) + (b.y - b.py)) / 2;
  balls.push(nb);
  const pts = (lv + 1) * (lv + 2) / 2; score += pts; maxLv = Math.max(maxLv, lv);
  burst(x, y, COLORS[lv], 10 + lv * 2, 140 + lv * 20, 3 + lv * 0.4); burst(x, y, '#ffffff', 5, 120, 2.5);
  shake = Math.max(shake, 1.5 + lv * 0.9);
  floaters.push({ x, y: y - TUNING.radii[lv], text: `+${pts}`, life: 0.9, color: lv >= 6 ? '#ffcf4a' : '#ffffff', size: 15 + lv * 1.2 });
  if (lv >= 5) floaters.push({ x, y: y - TUNING.radii[lv] - 22, text: NAMES[lv] + '!', life: 1.1, color: COLORS[lv], size: 16 + lv });
  Sfx.merge(lv);
}

// ---------------- 更新 ----------------
function update(dt) {
  time += dt; cooldown = Math.max(0, cooldown - dt); comboT -= dt; if (comboT <= 0) combo = 0;
  physics(dt);
  for (const b of balls) { b.age += dt; b.face += (b.x - b.px) * 0.02; b.blink -= dt; if (b.blink < -0.12) b.blink = 2 + Math.random() * 4; }
  // あふれ判定: 落ち着いた玉の上端が線より上
  if (state === 'play') {
    const over = balls.some((b) => b.age > 1.0 && b.y - b.r < LINE_Y && Math.abs(b.y - b.py) < 1.5);
    overT = over ? overT + dt : Math.max(0, overT - dt * 2);
    dangerFlash = balls.some((b) => b.age > 0.8 && b.y - b.r < LINE_Y + 40) ? dangerFlash + dt : 0;
    if (overT >= TUNING.overTime) gameOver();
  }
  if (DEMO && state === 'play') demoAI(dt);
  for (let i = parts.length - 1; i >= 0; i--) { const p = parts[i]; p.life -= dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.9; p.vy = p.vy * 0.9 + 300 * dt; if (p.life <= 0) parts.splice(i, 1); }
  for (let i = floaters.length - 1; i >= 0; i--) { const f = floaters[i]; f.life -= dt; f.y -= 30 * dt; if (f.life <= 0) floaters.splice(i, 1); }
  shake *= Math.exp(-9 * dt); if (shake < 0.05) shake = 0;
}
function gameOver() {
  state = 'over'; Sfx.over(); shake = 10;
  for (const b of balls) burst(b.x, b.y, COLORS[b.lv], 3, 120, 3);
  setTimeout(showOver, 700);
}
// デモ用: 同じレベルの近くを狙って落とす
let demoT = 0;
function demoAI(dt) {
  demoT -= dt; if (demoT > 0) return; demoT = 0.6;
  let tx = JAR.l + 40 + Math.random() * (JAR.r - JAR.l - 80);
  const same = balls.filter((b) => b.lv === curLv && b.age > 0.5).sort((a, b) => a.y - b.y)[0];
  if (same) tx = same.x;
  aimX = tx; drop();
  if (balls.length > 34 || overT > 0.5) { reset(); }
}

// ---------------- 描画 ----------------
const bgGrad = () => { const g = ctx.createLinearGradient(0, 0, 0, cssH); g.addColorStop(0, '#1d1830'); g.addColorStop(0.6, '#15172a'); g.addColorStop(1, '#101219'); return g; };
function drawZombieBall(x, y, r, lv, face, blink, alpha = 1) {
  ctx.save(); ctx.globalAlpha = alpha; ctx.translate(x, y);
  const c = COLORS[lv];
  ctx.fillStyle = c; ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill();
  // 光と影
  const g = ctx.createRadialGradient(-r * 0.35, -r * 0.4, r * 0.1, 0, 0, r);
  g.addColorStop(0, 'rgba(255,255,255,.35)'); g.addColorStop(0.6, 'rgba(255,255,255,0)'); g.addColorStop(1, 'rgba(0,0,0,.22)');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill();
  ctx.lineWidth = Math.max(1.5, r * 0.07); ctx.strokeStyle = 'rgba(20,30,25,.55)'; ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.stroke();
  ctx.rotate(Math.sin(face) * 0.15);
  // つぎはぎ
  ctx.strokeStyle = 'rgba(30,40,35,.45)'; ctx.lineWidth = Math.max(1, r * 0.05);
  ctx.beginPath(); ctx.moveTo(r * 0.25, -r * 0.75); ctx.lineTo(r * 0.55, -r * 0.45); ctx.stroke();
  for (let k = 0; k < 3; k++) { const t = k / 2; ctx.beginPath(); ctx.moveTo(r * (0.3 + t * 0.25) - r * 0.08, -r * (0.72 - t * 0.27) + r * 0.08); ctx.lineTo(r * (0.3 + t * 0.25) + r * 0.08, -r * (0.72 - t * 0.27) - r * 0.08); ctx.stroke(); }
  // 目(左右で大きさ違い)
  const ey = -r * 0.08, ex = r * 0.34;
  const shut = blink < 0;
  ctx.fillStyle = '#fff';
  if (!shut) { ctx.beginPath(); ctx.arc(-ex, ey, r * 0.24, 0, TAU); ctx.arc(ex, ey, r * 0.18, 0, TAU); ctx.fill(); ctx.fillStyle = '#1d1d28'; ctx.beginPath(); ctx.arc(-ex + r * 0.04, ey + r * 0.03, r * 0.11, 0, TAU); ctx.arc(ex - r * 0.02, ey + r * 0.03, r * 0.08, 0, TAU); ctx.fill(); }
  else { ctx.strokeStyle = '#1d1d28'; ctx.lineWidth = Math.max(1.2, r * 0.06); ctx.beginPath(); ctx.moveTo(-ex - r * 0.18, ey); ctx.lineTo(-ex + r * 0.18, ey); ctx.moveTo(ex - r * 0.14, ey); ctx.lineTo(ex + r * 0.14, ey); ctx.stroke(); }
  // 口
  ctx.fillStyle = '#3a1e2a'; ctx.beginPath(); ctx.ellipse(0, r * 0.38, r * 0.26, r * 0.13, 0, 0, TAU); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.fillRect(-r * 0.12, r * 0.27, r * 0.09, r * 0.09); ctx.fillRect(r * 0.04, r * 0.27, r * 0.09, r * 0.09);
  // レベルごとの小物
  ctx.lineWidth = Math.max(1.5, r * 0.08);
  if (lv === 0) { ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(0, -r * 0.95, r * 0.18, 0, TAU); ctx.fill(); }               // ぴょこ毛
  if (lv === 3) { ctx.fillStyle = '#2d3550'; ctx.beginPath(); ctx.ellipse(0, -r * 0.78, r * 0.7, r * 0.22, 0, 0, TAU); ctx.fill(); } // 学生帽
  if (lv === 4) { ctx.strokeStyle = '#d9475a'; ctx.beginPath(); ctx.moveTo(0, r * 0.62); ctx.lineTo(0, r * 0.95); ctx.stroke(); }    // ネクタイ
  if (lv === 5) { ctx.fillStyle = '#fff'; ctx.fillRect(-r * 0.55, -r * 0.98, r * 1.1, r * 0.25); }                                   // 帽子
  if (lv === 6) { ctx.strokeStyle = '#7a3c1e'; ctx.beginPath(); ctx.arc(0, 0, r * 0.98, Math.PI * 0.15, Math.PI * 0.85); ctx.stroke(); } // 筋肉ライン
  if (lv === 7) { ctx.fillStyle = '#2a2a2a'; ctx.beginPath(); ctx.arc(0, -r * 0.92, r * 0.2, 0, TAU); ctx.fill(); }                 // まげ
  if (lv >= 9) { ctx.fillStyle = '#ffcf4a'; ctx.beginPath(); const w = r * 0.6; ctx.moveTo(-w, -r * 0.7); ctx.lineTo(-w, -r * 1.05); ctx.lineTo(-w / 2, -r * 0.85); ctx.lineTo(0, -r * 1.15); ctx.lineTo(w / 2, -r * 0.85); ctx.lineTo(w, -r * 1.05); ctx.lineTo(w, -r * 0.7); ctx.closePath(); ctx.fill(); } // 王冠
  if (lv === 10) { ctx.strokeStyle = 'rgba(255,255,200,.9)'; ctx.beginPath(); ctx.ellipse(0, -r * 1.22, r * 0.5, r * 0.12, 0, 0, TAU); ctx.stroke(); } // 輪
  ctx.restore();
}
function draw(now) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = bgGrad(); ctx.fillRect(0, 0, cssW, cssH);
  const sx = shake ? (Math.random() * 2 - 1) * shake : 0, sy = shake ? (Math.random() * 2 - 1) * shake : 0;
  ctx.setTransform(dpr * S, 0, 0, dpr * S, dpr * (OX + sx * S), dpr * (OY + sy * S));
  // 背景: 月と墓
  ctx.fillStyle = 'rgba(255,240,200,.12)'; ctx.beginPath(); ctx.arc(290, 70, 34, 0, TAU); ctx.fill();
  ctx.fillStyle = '#1a1c2c';
  for (let i = 0; i < 6; i++) { const x = 10 + i * 64, h = 30 + (i * 37) % 25; ctx.beginPath(); ctx.moveTo(x, JAR.t + 10); ctx.lineTo(x, JAR.t + 10 - h); ctx.arc(x + 14, JAR.t + 10 - h, 14, Math.PI, 0); ctx.lineTo(x + 28, JAR.t + 10); ctx.fill(); }
  // 容器
  ctx.fillStyle = 'rgba(40,44,66,.85)'; rr(JAR.l - 8, JAR.t, JAR.r - JAR.l + 16, JAR.b - JAR.t + 10, 18); ctx.fill();
  ctx.fillStyle = '#121420'; rr(JAR.l, JAR.t + 4, JAR.r - JAR.l, JAR.b - JAR.t, 12); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.05)'; ctx.lineWidth = 1;
  for (let y = JAR.t + 40; y < JAR.b; y += 40) { ctx.beginPath(); ctx.moveTo(JAR.l, y); ctx.lineTo(JAR.r, y); ctx.stroke(); }
  // 危険ライン
  const dang = dangerFlash > 0 ? 0.5 + 0.5 * Math.sin(now * 0.02) : 0.35;
  ctx.strokeStyle = `rgba(255,90,110,${dang})`; ctx.lineWidth = 2.5; ctx.setLineDash([8, 6]); ctx.beginPath(); ctx.moveTo(JAR.l, LINE_Y); ctx.lineTo(JAR.r, LINE_Y); ctx.stroke(); ctx.setLineDash([]);
  // 落とす位置のガイド
  if (state === 'play') {
    const r = TUNING.radii[curLv], x = clamp(aimX, JAR.l + r, JAR.r - r);
    ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.lineWidth = 2; ctx.setLineDash([4, 8]); ctx.beginPath(); ctx.moveTo(x, DROP_Y + r); ctx.lineTo(x, JAR.b); ctx.stroke(); ctx.setLineDash([]);
    const a = cooldown > 0 ? 0.35 : 1;
    drawZombieBall(x, DROP_Y, r, curLv, 0, 1, a);
  }
  for (const b of balls) drawZombieBall(b.x, b.y, b.r, b.lv, b.face, b.blink);
  for (const p of parts) { ctx.globalAlpha = clamp(p.life / p.max, 0, 1); ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, TAU); ctx.fill(); }
  ctx.globalAlpha = 1; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const f of floaters) { ctx.globalAlpha = clamp(f.life / 0.5, 0, 1); ctx.font = `900 ${f.size}px system-ui,"Hiragino Sans","Noto Sans CJK JP",sans-serif`; ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.strokeText(f.text, f.x, f.y); ctx.fillStyle = f.color; ctx.fillText(f.text, f.x, f.y); }
  ctx.globalAlpha = 1;
  // HUD
  {
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#a4a9b8'; ctx.font = '700 12px system-ui,"Noto Sans CJK JP",sans-serif'; ctx.fillText('スコア', 22, 30);
    ctx.fillStyle = '#f2f4f8'; ctx.font = '900 30px system-ui,sans-serif'; ctx.fillText(score, 22, 62);
    ctx.fillStyle = '#a4a9b8'; ctx.font = '700 11px system-ui,"Noto Sans CJK JP",sans-serif'; ctx.fillText('ベスト ' + bestCache, 22, 80);
    // つぎ
    ctx.textAlign = 'center'; ctx.fillStyle = '#a4a9b8'; ctx.font = '700 12px system-ui,"Noto Sans CJK JP",sans-serif'; ctx.fillText('つぎ', 238, 30);
    ctx.fillStyle = 'rgba(255,255,255,.06)'; ctx.beginPath(); ctx.arc(238, 62, 24, 0, TAU); ctx.fill();
    drawZombieBall(238, 62, Math.min(20, TUNING.radii[nextLv]), nextLv, 0, 1);
    if (combo >= 2) { ctx.fillStyle = '#ffcf4a'; ctx.font = '900 16px system-ui,sans-serif'; ctx.fillText(`${combo}連鎖!`, 180, 100); }
  }
}
function rr(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }

// ---------------- 入力: 左右ドラッグで狙い、はなすと落とす ----------------
let pointerId = null;
const toStageX = (ev) => (ev.clientX - canvas.getBoundingClientRect().left - OX) / S;
canvas.addEventListener('pointerdown', (ev) => { Sfx.unlock(); if (state !== 'play' || pointerId !== null) return; pointerId = ev.pointerId; aimX = toStageX(ev); try { canvas.setPointerCapture(ev.pointerId); } catch (e) {} ev.preventDefault(); });
canvas.addEventListener('pointermove', (ev) => { if (ev.pointerType === 'mouse' && pointerId === null && state === 'play') { aimX = toStageX(ev); return; } if (ev.pointerId !== pointerId) return; aimX = toStageX(ev); });
const release = (ev) => { if (ev.pointerId !== pointerId) return; pointerId = null; if (ev.type === 'pointerup') drop(); };
canvas.addEventListener('pointerup', release); canvas.addEventListener('pointercancel', release);
document.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });

// ---------------- UI ----------------
const $ = (id) => document.getElementById(id);
function updateMuteIcon() { $('muteWave').style.display = Sfx.muted ? 'none' : ''; $('muteX').style.display = Sfx.muted ? '' : 'none'; }
$('muteBtn').addEventListener('click', () => { Sfx.unlock(); Sfx.setMuted(!Sfx.muted); updateMuteIcon(); }); updateMuteIcon();
function showTitle() {
  $('startBest').textContent = store.get(BEST_KEY, 0); $('startScreen').classList.remove('hidden');
  const lc = $('ladder'), l = lc.getContext('2d'); l.clearRect(0, 0, 600, 80);
  // 進化表
  for (let i = 0; i < 11; i++) { const x = 28 + i * 54.5, r = 8 + i * 1.9; drawOn(l, () => drawZombieBall(x, 44, r, i, 0, 1)); }
}
function drawOn(c2, fn) { const bk = ctx; ctx = c2; fn(); ctx = bk; }
function showOver() {
  const best = store.get(BEST_KEY, 0), isNew = score > best; if (isNew && !DEMO) store.set(BEST_KEY, score);
  $('overScore').textContent = score; $('overBest').textContent = Math.max(best, score);
  $('overMax').textContent = NAMES[maxLv] + ` (Lv${maxLv + 1})`; $('newBest').classList.toggle('hidden', !isNew);
  $('overScreen').classList.remove('hidden');
}
function start() { Sfx.unlock(); reset(); state = 'play'; $('startScreen').classList.add('hidden'); $('overScreen').classList.add('hidden'); Sfx.start(); }
$('startBtn').addEventListener('click', start); $('retryBtn').addEventListener('click', start);
addEventListener('keydown', (e) => {
  if ((e.key === 'Enter') && state !== 'play') start();
  if (state === 'play') { if (e.key === 'ArrowLeft') aimX -= 12; if (e.key === 'ArrowRight') aimX += 12; if (e.key === ' ' || e.key === 'ArrowDown') { e.preventDefault(); drop(); } }
});


// ---------------- ループ ----------------
let last = performance.now(), paused = false;
document.addEventListener('visibilitychange', () => { paused = document.hidden; last = performance.now(); });
const MANUAL = DEMO && params.has('manual'); // 動画書き出し用: 外部から1コマずつ進める
let simNow = 0;
if (MANUAL) window.__step = (n = 1, dt = 1 / 30) => { for (let i = 0; i < n; i++) { simNow += dt * 1000; update(dt); } draw(simNow); };
function frame(now) {
  if (MANUAL) return;
  requestAnimationFrame(frame); if (paused) return;
  let dt = Math.min(1 / 30, Math.max(0, (now - last) / 1000)); last = now;
  update(dt); draw(now);
}
reset();
if (DEMO) { state = 'play'; } else showTitle();
requestAnimationFrame(frame);
window.__zg = { get state() { return state; }, get score() { return score; }, get balls() { return balls.length; }, get maxLv() { return maxLv; }, drop: (x) => { aimX = x; drop(); }, TUNING };
})();
