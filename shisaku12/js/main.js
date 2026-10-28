// 試作12 - 薬局3Dプロトタイプ。three.js (MIT) を js/vendor にローカル同梱。
import * as THREE from './vendor/three.module.js';

const params = new URLSearchParams(location.search);
const AUTOTEST = params.get('autotest') === '1';
const AUTO_CORRECT = Math.max(0, Math.min(10, parseInt(params.get('correct') ?? '10', 10) || 0));
const AUTO_TIMEOUT_AT = parseInt(params.get('timeoutAt') ?? '-1', 10); // 自動テストで時間切れを起こす問題番号(0始まり)
const AUTO_PATTERN = params.get('pattern') || ''; // 例: 0101010101(1=正解,0=不正解,t=時間切れ)。指定時は correct より優先
const SPEED = AUTOTEST ? 4 : 1;
const TOTAL = 10, LIMIT = 10;

const $ = (id) => document.getElementById(id);
const ui = { hud: $('hud'), qno: $('qno'), score: $('score'), timer: $('timer'), bar: $('bar'), sec: $('sec'),
  bubble: $('bubble'), rx: $('rx'), rxno: $('rxno'), rxdis: $('rxdis'), rxmemo: $('rxmemo'), rxres: $('rxres'),
  mute: $('mute'), choices: $('choices'), start: $('start'), go: $('go'), end: $('end'), endscore: $('endscore'), endtext: $('endtext'), again: $('again') };

// ---------- 効果音(WebAudioでその場で合成。外部ファイルなし。最初のタップ後に鳴る) ----------
const sfx = (() => {
  let ac = null, master = null;
  let muted = false; try { muted = localStorage.getItem('shisaku12_mute') === '1'; } catch (e) {}
  const log = []; // 自動テスト用(鳴らした名前)
  function unlock() {
    if (ac) { if (ac.state === 'suspended') ac.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    ac = new AC(); master = ac.createGain(); master.gain.value = muted ? 0 : 0.22; master.connect(ac.destination);
  }
  function tone(freq, t0, dur, type = 'triangle', vol = 1, slideTo = 0) {
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t0); if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(vol, t0 + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(master); o.start(t0); o.stop(t0 + dur + 0.02);
  }
  const N = (m) => 440 * Math.pow(2, (m - 69) / 12); // MIDIノート番号→Hz
  const SOUNDS = {
    correct: (t) => { tone(N(84), t, 0.12, 'triangle', 0.8); tone(N(88), t + 0.08, 0.12, 'triangle', 0.8); tone(N(91), t + 0.16, 0.22, 'triangle', 0.8); },
    wrong: (t) => { tone(220, t, 0.32, 'square', 0.35, 110); tone(207, t + 0.02, 0.32, 'square', 0.25, 98); },
    timeout: (t) => { tone(330, t, 0.18, 'square', 0.3, 300); tone(220, t + 0.2, 0.35, 'square', 0.3, 100); },
    tick: (t) => tone(1046, t, 0.06, 'sine', 0.5),
    tickLast: (t) => tone(1318, t, 0.09, 'sine', 0.6),
    end0: (t) => [72, 76, 79, 84].forEach((m, i) => tone(N(m), t + i * 0.13, i === 3 ? 0.5 : 0.16, 'triangle', 0.7)),
    end1: (t) => [72, 76, 79].forEach((m, i) => tone(N(m), t + i * 0.14, i === 2 ? 0.45 : 0.16, 'triangle', 0.6)),
    end2: (t) => [67, 72, 71].forEach((m, i) => tone(N(m), t + i * 0.18, i === 2 ? 0.5 : 0.18, 'triangle', 0.55)),
    end3: (t) => [67, 63, 60].forEach((m, i) => tone(N(m), t + i * 0.2, i === 2 ? 0.6 : 0.2, 'sine', 0.6)),
    end4: (t) => [64, 60, 55, 48].forEach((m, i) => tone(N(m), t + i * 0.24, i === 3 ? 0.9 : 0.22, 'sine', 0.6)),
  };
  function play(name) {
    log.push(name); if (log.length > 50) log.shift();
    if (!ac || muted || ac.state !== 'running') return;
    SOUNDS[name](ac.currentTime + 0.01);
  }
  function setMuted(v) {
    muted = v; try { localStorage.setItem('shisaku12_mute', v ? '1' : '0'); } catch (e) {}
    if (master) master.gain.setTargetAtTime(v ? 0 : 0.22, ac.currentTime, 0.02);
  }
  return { unlock, play, setMuted, get muted() { return muted; }, get state() { return ac ? ac.state : 'none'; }, log };
})();
for (const ev of ['pointerdown', 'touchend', 'keydown']) addEventListener(ev, () => sfx.unlock(), { passive: true });

// ---------- 3D ----------
const canvas = $('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
// 描画負荷: 画素密度は1.5倍まで(高DPIスマホでも塗る画素数を抑える)
const MAX_DPR = params.has('dpr') ? +params.get('dpr') : 1.5;
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, MAX_DPR));
renderer.shadowMap.enabled = true;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xdfe9ec);
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 60);
const camTarget = new THREE.Vector3(0, 0, -1);

scene.add(new THREE.HemisphereLight(0xffffff, 0xb8c4c8, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(3, 8, 5); sun.castShadow = true; sun.shadow.mapSize.set(512, 512);
// 影は人物まわり(カメラに映る手前側)だけに絞る
Object.assign(sun.shadow.camera, { left: -4.5, right: 4.5, top: 5, bottom: -6, near: 1, far: 22 });
scene.add(sun);

const mat = (c) => new THREE.MeshLambertMaterial({ color: c });
// 動かない箱は最後に1つのInstancedMeshへまとめる(描画呼び出しを百数十回→1回に)
const staticBoxes = [];
function box(w, h, d, c, x, y, z, parent = scene) {
  const o = new THREE.Object3D(); o.position.set(x, y, z); o.scale.set(w, h, d); parent.add(o);
  staticBoxes.push({ o, c }); return o;
}
function bakeStaticBoxes() {
  scene.updateMatrixWorld(true);
  const im = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial(), staticBoxes.length);
  const col = new THREE.Color();
  staticBoxes.forEach(({ o, c }, i) => { im.setMatrixAt(i, o.matrixWorld); im.setColorAt(i, col.setHex(c)); o.parent.remove(o); });
  im.castShadow = true; im.receiveShadow = true; scene.add(im);
}
// 床・壁
const floor = new THREE.Mesh(new THREE.PlaneGeometry(14, 22), mat(0xf2efe6));
floor.rotation.x = -Math.PI / 2; floor.position.z = -3; floor.receiveShadow = true; scene.add(floor);
for (let i = -6; i <= 6; i += 1.0) box(0.02, 0.005, 22, 0xe0dccf, i, 0.003, -3);
box(14, 4.5, 0.2, 0xcfe3e0, 0, 2.25, -13.5);
box(0.2, 4.5, 22, 0xd9e7e4, -7, 2.25, -3);
box(0.2, 4.5, 22, 0xd9e7e4, 7, 2.25, -3);
// 入口(奥の壁の明るい四角)
box(2.4, 2.6, 0.05, 0xffffff, 0, 1.3, -13.38);
// 調剤棚(手前、薬剤師の後ろ側)と側面の棚
const boxColors = [0xe85d5d, 0x5d9be8, 0xf2c14e, 0x6cc070, 0xb07ad6, 0xf29b4e, 0xffffff];
function shelf(x, z, rotY, w = 3.2) {
  const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = rotY; scene.add(g);
  box(w, 2.6, 0.5, 0xa7805a, 0, 1.3, 0, g);
  for (let s = 0; s < 4; s++) {
    box(w - 0.1, 0.05, 0.52, 0x8b6743, 0, 0.35 + s * 0.6, 0.02, g);
    for (let k = 0; k < 7; k++) {
      const c = boxColors[(k * 3 + s * 5 + Math.round(x)) % boxColors.length];
      box(0.3, 0.32 + ((k + s) % 3) * 0.06, 0.3, c, -w / 2 + 0.3 + k * ((w - 0.5) / 6), 0.55 + s * 0.6, 0.12, g);
    }
  }
  return g;
}
shelf(-6.6, -2, Math.PI / 2, 4); shelf(-6.6, -7, Math.PI / 2, 4);
shelf(6.6, -2, -Math.PI / 2, 4); shelf(6.6, -7, -Math.PI / 2, 4);
// 薬剤師の後ろは低い調剤台にして、カメラから薬剤師が隠れないようにする
box(0.6, 0.95, 2.4, 0xa7805a, 2.75, 0.475, 1.6); box(0.66, 0.05, 2.5, 0x8b6743, 2.75, 0.97, 1.6);
for (let k = 0; k < 5; k++) box(0.26, 0.22 + (k % 3) * 0.05, 0.26, boxColors[k % boxColors.length], 2.75, 1.1, 0.7 + k * 0.45);
// カウンター
// 列の先頭の右横に、奥行き方向へ短いカウンター。薬剤師はその向こう(右)に立ち、客と同じ奥行きに並ぶので画面内で全身が見える
box(0.6, 1.05, 1.2, 0x6b8fa3, 1.3, 0.525, 1.45);
box(0.7, 0.08, 1.3, 0xf5f5f0, 1.3, 1.08, 1.45);
box(0.4, 0.3, 0.4, 0x333333, 1.35, 1.27, 1.0); // レジ
const tray = box(0.4, 0.04, 0.5, 0xffffff, 1.25, 1.14, 1.65);
// 待合の床ライン
for (let i = 0; i < 7; i++) box(0.9, 0.01, 0.06, 0x5aa0a0, 0, 0.006, 1.5 - i * 1.0);
bakeStaticBoxes();

// 棒人間
// 形状と共通色は全員で使い回す
const GEO = {
  body: new THREE.CapsuleGeometry(0.16, 0.55, 3, 10), head: new THREE.SphereGeometry(0.2, 14, 10),
  eye: new THREE.SphereGeometry(0.03, 6, 4), mouth: new THREE.BoxGeometry(0.09, 0.02, 0.02),
  arm: new THREE.CapsuleGeometry(0.07, 0.45, 2, 6), leg: new THREE.CapsuleGeometry(0.07, 0.6, 2, 6),
};
const skinMat = mat(0xf3d2b3), eyeMat = mat(0x222222), coatMat = mat(0xffffff);
const colorMats = new Map();
function stickman(color, coat = false) {
  const g = new THREE.Group();
  if (!colorMats.has(color)) colorMats.set(color, mat(color));
  const m = colorMats.get(color), skin = skinMat;
  const limb = (len) => len > 0.5 ? GEO.leg : GEO.arm;
  const body = new THREE.Mesh(GEO.body, coat ? coatMat : m);
  body.position.y = 1.15; g.add(body);
  const head = new THREE.Mesh(GEO.head, skin); head.position.y = 1.7; g.add(head);
  const eyeM = eyeMat;
  const e1 = new THREE.Mesh(GEO.eye, eyeM); e1.position.set(-0.07, 1.73, 0.18); g.add(e1);
  const e2 = e1.clone(); e2.position.x = 0.07; g.add(e2);
  const mouth = new THREE.Mesh(GEO.mouth, eyeM); mouth.position.set(0, 1.62, 0.19); g.add(mouth);
  const mk = (x, y, len, mm) => { const p = new THREE.Group(); p.position.set(x, y, 0); const l = new THREE.Mesh(limb(len), mm); l.position.y = -len / 2 - 0.05; p.add(l); g.add(p); return p; };
  const armL = mk(-0.25, 1.4, 0.45, m), armR = mk(0.25, 1.4, 0.45, m);
  const legL = mk(-0.1, 0.85, 0.6, m), legR = mk(0.1, 0.85, 0.6, m);
  for (const o of [body, head, armL.children[0], armR.children[0], legL.children[0], legR.children[0]]) o.castShadow = true; // 目・口は影なし
  if (coat) { const crossM = mat(0x2a9d8f); const c1 = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.04, 0.02), crossM); c1.position.set(0.08, 1.3, 0.17); g.add(c1); }
  g.userData = { armL, armR, legL, legR, head, mouth, body, walk: 0 };
  scene.add(g); return g;
}
const pharmacist = stickman(0x2a6f97, true);
pharmacist.position.set(1.85, 0, 2.25); pharmacist.rotation.y = -1.95; // カウンター越しに列の先頭(左)を向く

// ---------- アニメーション(簡易tween) ----------
const tasks = [];
function tween(dur, fn) { return new Promise(res => tasks.push({ t: 0, dur: dur / SPEED, fn, res })); }
const wait = (ms) => tween(ms / 1000, () => {});
const ease = (t) => t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
function walkTo(man, x, z, dur) {
  const sx = man.position.x, sz = man.position.z;
  const ang = Math.atan2(x - sx, z - sz);
  if (Math.hypot(x - sx, z - sz) > 0.01) man.rotation.y = ang;
  return tween(dur, (k) => {
    man.position.x = sx + (x - sx) * k; man.position.z = sz + (z - sz) * k;
    const u = man.userData; const s = Math.sin(k * dur * 14) * 0.6 * (k < 1 ? 1 : 0);
    u.legL.rotation.x = s; u.legR.rotation.x = -s; u.armL.rotation.x = -s * .7; u.armR.rotation.x = s * .7;
    man.position.y = Math.abs(Math.sin(k * dur * 14)) * 0.05 * (k < 1 ? 1 : 0);
  });
}
// 血(デフォルメした赤い粒)
const parts = [];
const dropGeo = new THREE.SphereGeometry(0.05, 6, 5), dropMat = mat(0xd61f2b);
const splatGeo = new THREE.CircleGeometry(0.09, 8);
// 床のしみは1つのInstancedMesh(上限つき、古いものから再利用)
const SPLAT_MAX = 140;
const splatIM = new THREE.InstancedMesh(splatGeo, dropMat, SPLAT_MAX); splatIM.count = 0; splatIM.frustumCulled = false; scene.add(splatIM);
let splatN = 0; const splatObj = new THREE.Object3D(); splatObj.rotation.x = -Math.PI / 2;
function addSplat(x, z) {
  splatObj.position.set(x, 0.012 + Math.random() * .002, z); splatObj.scale.setScalar(.6 + Math.random()); splatObj.updateMatrix();
  splatIM.setMatrixAt(splatN % SPLAT_MAX, splatObj.matrix); splatN++;
  splatIM.count = Math.min(splatN, SPLAT_MAX); splatIM.instanceMatrix.needsUpdate = true;
}
function spit(man, n = 16) {
  const p = new THREE.Vector3(); man.userData.mouth.getWorldPosition(p);
  const dir = new THREE.Vector3(-1, 0, 0.2).normalize(); // 左前へ(倒れる側)。帰り道(右)にはかからない
  for (let i = 0; i < n; i++) {
    const m = new THREE.Mesh(dropGeo, dropMat); m.position.copy(p); scene.add(m);
    const v = dir.clone().multiplyScalar(1.2 + Math.random() * 1.6).add(new THREE.Vector3((Math.random() - .5) * 1.2, 1 + Math.random() * 1.5, (Math.random() - .5) * .6));
    parts.push({ m, v, life: 0 });
  }
}
function updateParts(dt) {
  for (let i = parts.length - 1; i >= 0; i--) {
    const q = parts[i]; q.v.y -= 9.8 * dt; q.m.position.addScaledVector(q.v, dt);
    if (q.m.position.y <= 0.02) {
      scene.remove(q.m); parts.splice(i, 1);
      if (q.m.position.x < 0.3 && Math.random() < .6) addSplat(q.m.position.x, q.m.position.z);
    }
  }
}

// ---------- 吹き出し ----------
let bubbleMan = null;
function say(man, text) { bubbleMan = man; ui.bubble.textContent = text; ui.bubble.hidden = false; placeBubble(); }
function hush() { bubbleMan = null; ui.bubble.hidden = true; }
function placeBubble() {
  if (!bubbleMan) return;
  const p = new THREE.Vector3(); bubbleMan.userData.head.getWorldPosition(p); p.y += 0.35; p.project(camera);
  let x = (p.x * .5 + .5) * innerWidth, y = (-p.y * .5 + .5) * innerHeight;
  const w = ui.bubble.offsetWidth; x = Math.max(w / 2 + 6, Math.min(innerWidth - w / 2 - 6, x)); y = Math.max(ui.bubble.offsetHeight + 80, y);
  ui.bubble.style.left = x + 'px'; ui.bubble.style.top = y + 'px';
}

// ---------- ゲーム ----------
const LINES_DIE = ['ちがう…これ…じゃ…', 'せんせい…それ…ちがう…', 'ぐふっ…説明…聞けば…', '胃が…あつい…', '最後に…プリン…食べたかった…', 'ちゃんと…見て…', 'うそ…でしょ…', 'もっと…ちゃんとした…薬局に…'];
const LINES_TIMEOUT = ['まだ…ですか…ぐふっ', '待ちきれ…ない…', '10秒って…長いね…ぐはっ'];
const LINES_OK = ['助かった!', 'これこれ!', 'ありがとう!', 'さすが!', 'また来るね!', '楽になりそう!'];
const COLORS = [0xe76f51, 0xf4a261, 0x2a9d8f, 0xe9c46a, 0x9b5de5, 0x00bbf9, 0xf15bb5, 0x8ac926, 0xff595e, 0x6a4c93, 0x1982c4, 0xffca3a];
const ENDINGS = [
  { min: 10, text: '10人全員が笑って帰っていった。\n次の日、行列は店の外まで伸びていた。\n「あの薬局なら間違いない」という噂だけを残して。' },
  { min: 8, text: 'ほとんどの人は元気に帰った。\n床の赤いしみは、モップで拭けばだいたい取れた。\n明日もカウンターに立つ。' },
  { min: 5, text: '半分くらいは助かった。\n残りの人は、床の上で静かにしている。\n店長が無言で「研修」と書かれた冊子を置いていった。' },
  { min: 2, text: '帰っていった人より、床に残った人のほうが多い。\n入口の自動ドアが、もう開かなくなった。\n誰も入ってこない。' },
  { min: 0, text: '気づけば、立っているのは自分だけだった。\n棚の薬だけが整然と並んでいる。\nシャッターを下ろす音が、やけに大きく響いた。' },
];
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

let DATA = null;
const state = { phase: 'title', q: 0, score: 0, dead: 0, ending: -1, log: [] };
window.__game = state; // 自動テスト用の読み取り口(操作には使わない)
if (params.get('debug') === '1') window.__dbg = () => ({ THREE, scene, camera, renderer, pharmacist, bodies, queue });
let queue = [], round = [], bodies = [];
let timerLeft = 0, timerOn = false, answerResolve = null;

// 先頭(i=0)はカウンター前。2人目以降は少し下がって左寄り(帰る客が右側を通れるように)
function queuePos(i) { return i === 0 ? { x: 0.45, z: 1.6 } : { x: -0.08, z: 0.45 - (i - 1) * 0.95 }; }
// 倒れた人の置き場所(足が列の左0.75、頭はさらに左へ約1.8)。10人で奥行き約5.4
const BODY_YAW = -0.75; // 頭を左奥へ斜めに向けて横幅を詰める
function bodySlot(n) { return { x: -0.6 - (n % 2) * 0.1, z: 1.45 - n * 0.62 }; }
// 正解した客の帰り道(列の右側を通って奥の入口へ)。倒れた人(列の左側)とは交差しない
const EXIT_PATH = [{ x: 0.75, z: 0.35 }, { x: 1.2, z: -0.4 }, { x: 1.3, z: -9.5 }, { x: 0.6, z: -12.6 }];
function clearPeople() {
  for (const m of [...queue, ...bodies]) scene.remove(m);
  splatN = 0; splatIM.count = 0;
  for (const q of parts) scene.remove(q.m); parts.length = 0;
  queue = []; bodies = [];
}

function setupRound() {
  clearPeople();
  round = shuffle([...DATA.questions]).slice(0, TOTAL).map(q => {
    const wrong = shuffle([...q.wrong]).slice(0, 2);
    return { ...q, options: shuffle([q.answer, ...wrong]) };
  });
  const cols = shuffle([...COLORS]);
  for (let i = 0; i < TOTAL; i++) {
    const m = stickman(cols[i % cols.length]);
    const p = queuePos(i + 1); m.position.set(p.x + (Math.random() - .5) * .25, 0, p.z - 0.6); m.rotation.y = 0;
    queue.push(m);
  }
  Object.assign(state, { q: 0, score: 0, dead: 0, ending: -1, log: [] });
  Object.assign(chk, { exitOverlap: 0, minExitDist: 99, bodyOffscreen: 0, pharmacistOffscreen: 0 });
}

async function advanceQueue() {
  const moves = queue.map((m, i) => { const p = queuePos(i); return walkTo(m, p.x + (i ? (i % 2 ? .06 : -.06) : 0), p.z, 0.9); });
  await Promise.all(moves);
  queue.forEach((m, i) => { m.rotation.y = i === 0 ? Math.PI / 2 : 0; }); // 先頭は薬剤師(右)の方を向く
}

function showQuestion(q, i) {
  ui.qno.textContent = `${i + 1}/${TOTAL}`; ui.score.textContent = `○ ${state.score}`;
  ui.rxno.textContent = `No.${String(i + 1).padStart(2, '0')}`;
  ui.rxdis.textContent = q.disease; ui.rxmemo.textContent = q.memo; ui.rxres.textContent = '';
  ui.choices.innerHTML = '';
  for (const id of q.options) {
    const b = document.createElement('button'); b.textContent = DATA.drugs[id].name; b.dataset.id = id;
    b.addEventListener('click', () => answer(id)); ui.choices.appendChild(b);
  }
  ui.rx.hidden = false; ui.choices.hidden = false; ui.timer.hidden = false;
}
function answer(id) {
  if (!answerResolve) return;
  const r = answerResolve; answerResolve = null; timerOn = false; r(id);
}
let lastSec = -1;
function waitAnswer() {
  timerLeft = LIMIT; timerOn = true; lastSec = -1; ui.sec.textContent = LIMIT + '秒'; ui.sec.classList.remove('low');
  return new Promise(res => { answerResolve = res; });
}

async function playRound() {
  state.phase = 'play';
  ui.hud.hidden = false;
  for (let i = 0; i < TOTAL; i++) {
    state.q = i;
    await advanceQueue();
    const man = queue[0], q = round[i];
    say(man, 'これ、お願いします');
    await wait(500);
    hush();
    showQuestion(q, i);
    state.phase = 'answer';
    if (AUTOTEST) autoAnswer(q, i);
    const picked = await waitAnswer();
    state.phase = 'react';
    const ok = picked === q.answer;
    for (const b of ui.choices.children) { b.disabled = true; if (b.dataset.id === q.answer) b.classList.add('ok'); else if (b.dataset.id === picked) b.classList.add('ng'); else b.classList.add('dim'); }
    sfx.play(ok ? 'correct' : picked ? 'wrong' : 'timeout');
    ui.rxres.textContent = ok ? '○ 正解' : (picked ? '× 正解は ' : '× 時間切れ。正解は ') + (ok ? '' : DATA.drugs[q.answer].name);
    ui.rxres.style.color = ok ? '#1b7a3a' : '#c0262d';
    state.log.push({ id: q.id, picked, ok });
    queue.shift();
    if (ok) { state.score++; ui.score.textContent = `○ ${state.score}`; await happy(man); }
    else { state.dead++; await die(man, picked ? LINES_DIE : LINES_TIMEOUT); }
    hush();
    ui.rx.hidden = true; ui.choices.hidden = true; ui.timer.hidden = true;
  }
  showEnding();
}
const leaving = new Set(); // 帰り道を歩いている客(自動テストでの重なり検査用)
async function happy(man) {
  say(man, LINES_OK[Math.floor(Math.random() * LINES_OK.length)]);
  const u = man.userData;
  await tween(0.9, (k) => { const j = Math.abs(Math.sin(k * Math.PI * 3)); man.position.y = j * 0.35; u.armL.rotation.z = -2.6 * j - .2; u.armR.rotation.z = 2.6 * j + .2; });
  u.armL.rotation.z = u.armR.rotation.z = 0;
  hush();
  const durs = [0.45, 0.3, 1.3, 0.4];
  leaving.add(man);
  for (let k = 0; k < EXIT_PATH.length; k++) await walkTo(man, EXIT_PATH[k].x, EXIT_PATH[k].z, durs[k]);
  leaving.delete(man); scene.remove(man);
}
async function die(man, lines) {
  man.rotation.y = 0; // こちらを向いてから倒れる(左へ)
  say(man, lines[Math.floor(Math.random() * lines.length)]);
  const u = man.userData;
  const x0 = man.position.x;
  await tween(0.5, (k) => { man.position.x = x0 + Math.sin(k * 60) * 0.04; u.body.rotation.x = k * .3; u.head.position.z = k * 0.08; });
  spit(man);
  await wait(450);
  spit(man, 8);
  // 横(画面左=帰り道と反対側)へパタンと倒れる
  const sx0 = man.position.x;
  await tween(0.6, (k) => { const e = ease(k); man.rotation.z = e * Math.PI / 2; man.position.x = sx0 - e * 0.25; man.position.y = 0.14 * e; });
  await wait(700);
  hush();
  // 倒れた人は床に残る。列の左側に、手前から奥へ1列に並ぶ(頭は左向き)。
  // 新しく倒れた人が一番手前に入り、先にいた人は1つ奥へずれる(互いに重ならない)
  bodies.unshift(man);
  const moves = bodies.map((b, i) => ({ b, sx: b.position.x, sz: b.position.z, t: bodySlot(i) }));
  const ry0 = man.rotation.y;
  await tween(0.5, (k) => { const e = ease(k); man.rotation.y = ry0 + (BODY_YAW - ry0) * e; for (const m of moves) { m.b.position.x = m.sx + (m.t.x - m.sx) * e; m.b.position.z = m.sz + (m.t.z - m.sz) * e; } });
}
function autoAnswer(q, i) {
  if (i === AUTO_TIMEOUT_AT || AUTO_PATTERN[i] === 't') return; // 時間切れを待つ
  const good = AUTO_PATTERN ? AUTO_PATTERN[i] === '1' : i < AUTO_CORRECT;
  const pick = good ? q.answer : q.options.find(o => o !== q.answer);
  setTimeout(() => { const b = [...ui.choices.children].find(x => x.dataset.id === pick); b && b.click(); }, 250);
}
function showEnding() {
  const s = state.score;
  const idx = ENDINGS.findIndex(e => s >= e.min);
  state.ending = idx; state.phase = 'end';
  sfx.play('end' + idx);
  ui.endscore.textContent = `正解 ${s} / ${TOTAL}`;
  ui.endtext.textContent = ENDINGS[idx].text;
  ui.end.hidden = false; ui.hud.hidden = true;
}

function startGame() {
  ui.start.hidden = true; ui.end.hidden = true;
  setupRound();
  playRound();
}
ui.go.addEventListener('click', startGame);
function drawMute() {
  ui.mute.classList.toggle('off', sfx.muted);
  ui.mute.querySelector('#mwave').style.display = sfx.muted ? 'none' : '';
  ui.mute.querySelector('#mx').style.display = sfx.muted ? '' : 'none';
  const label = sfx.muted ? '音を出す' : '音を消す'; ui.mute.setAttribute('aria-label', label); ui.mute.title = label;
}
ui.mute.addEventListener('click', () => { sfx.unlock(); sfx.setMuted(!sfx.muted); drawMute(); });
drawMute();
state.sfx = sfx; // 自動テスト用
ui.again.addEventListener('click', startGame);

// ---------- 自動テスト用の配置検査(画面外・重なり) ----------
const chk = { exitOverlap: 0, minExitDist: 99, bodyOffscreen: 0, pharmacistOffscreen: 0 };
state.check = chk;
const _v = new THREE.Vector3();
function offscreen(obj, local) { _v.copy(local); obj.localToWorld(_v); _v.project(camera); return Math.abs(_v.x) > 1 || Math.abs(_v.y) > 1; }
const HEAD = new THREE.Vector3(0, 1.9, 0), FEET = new THREE.Vector3(0, 0, 0), HANDL = new THREE.Vector3(-0.35, 1.2, 0), HANDR = new THREE.Vector3(0.35, 1.2, 0);
function layoutCheck() {
  scene.updateMatrixWorld();
  for (const b of bodies) if ([HEAD, FEET, HANDL, HANDR].some(p => offscreen(b, p))) chk.bodyOffscreen++;
  if ([HEAD, FEET, HANDL, HANDR].some(p => offscreen(pharmacist, p))) chk.pharmacistOffscreen++;
  for (const w of leaving) for (const b of bodies) {
    // 倒れた人は足→頭の線分。歩く人の中心との距離
    const a = new THREE.Vector3().copy(FEET), h = new THREE.Vector3().copy(HEAD); b.localToWorld(a); b.localToWorld(h);
    const px = w.position.x, pz = w.position.z, dx = h.x - a.x, dz = h.z - a.z;
    const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (pz - a.z) * dz) / (dx * dx + dz * dz)));
    const d = Math.hypot(a.x + dx * t - px, a.z + dz * t - pz);
    chk.minExitDist = Math.min(chk.minExitDist, d); if (d < 0.6) chk.exitOverlap++;
  }
}

// ---------- ループ ----------
let needRender = true;
function resize() {
  needRender = true;
  const w = innerWidth, h = innerHeight; renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // 斜め上の固定カメラ。列・倒れた人(左)・薬剤師(右)が横幅に収まる画角
  const portrait = w / h < 0.7;
  camera.fov = portrait ? 52 : 34;
  camera.position.set(0.15, 11, 12.5); camTarget.set(0.15, 0, -1.0);
  const cq = params.get('cam'); // 開発用: ?cam=x,y,z,tx,ty,tz,fov
  if (cq) { const v = cq.split(',').map(Number); camera.position.set(v[0], v[1], v[2]); camTarget.set(v[3], v[4], v[5]); camera.fov = v[6]; }
  camera.lookAt(camTarget);
  // 縦長画面では下側にUIが出るので、投影中心を上へずらして3Dの見どころを画面上部に収める
  // 縦横比が小さい(背の低い)縦画面ほど下の問題パネルの割合が大きいので、出題中だけさらに上へずらす
  // 横向きで背が低い画面では問題パネルを右に出すので、出題中は場面を左へ寄せる
  sideLayout = !portrait && h <= 500;
  voBase = portrait ? 0.34 : 0.3;
  voQuestion = portrait ? Math.min(0.62, Math.max(0.34, 0.34 + (2.16 - h / w) * 0.6)) : 0.3;
  if (params.has('voff')) voBase = voQuestion = +params.get('voff');
  applyVo(curVo == null ? voBase : curVo);
}
let voBase = 0.34, voQuestion = 0.34, curVo = null, curHo = 0, sideLayout = false;
function applyVo(vo, ho = curHo) {
  curVo = vo; curHo = ho; const w = innerWidth, h = innerHeight;
  if (vo > 0 || ho > 0) camera.setViewOffset(w * (1 + ho), h * (1 + vo), w * ho, h * vo, w, h); else camera.clearViewOffset();
  camera.updateProjectionMatrix();
}
function updateVo(dt) { // 問題パネルが出ている間だけ視点をずらす(ゆっくり移動)
  const inQ = state.phase === 'play' || state.phase === 'answer' || state.phase === 'react';
  const tv = inQ ? voQuestion : voBase, th = inQ && sideLayout ? 0.42 : 0;
  if (Math.abs(tv - curVo) > 0.0005 || Math.abs(th - curHo) > 0.0005) {
    const k = Math.min(1, dt * 4); applyVo(curVo + (tv - curVo) * k, curHo + (th - curHo) * k); needRender = true;
  }
}
addEventListener('resize', resize); resize();
let last = performance.now();
function loop(now) {
  const realDt = Math.min(0.5, (now - last) / 1000); const dt = Math.min(0.05, realDt); last = now;
  for (let i = tasks.length - 1; i >= 0; i--) {
    const t = tasks[i]; t.t += dt; const k = Math.min(1, t.t / t.dur); t.fn(k);
    if (k >= 1) { tasks.splice(i, 1); t.res(); }
  }
  updateParts(dt * SPEED);
  if (timerOn) {
    timerLeft -= realDt * SPEED; // 制限時間は実時間で減らす(描画が重くても10秒)
    const r = Math.max(0, timerLeft / LIMIT);
    ui.bar.style.transform = `scaleX(${r})`;
    ui.bar.className = r < .3 ? 'danger' : r < .6 ? 'warn' : '';
    const secLeft = Math.ceil(Math.max(0, timerLeft));
    if (secLeft !== lastSec) { // 残り3秒からは毎秒小さく鳴らす
      if (secLeft <= 3 && secLeft >= 1 && lastSec !== -1) sfx.play(secLeft === 1 ? 'tickLast' : 'tick');
      lastSec = secLeft; ui.sec.textContent = secLeft + '秒'; ui.sec.classList.toggle('low', secLeft <= 3);
    }
    if (timerLeft <= 0) answer(null);
  }
  // 薬剤師は前の客の方を向く。待っている客は少し揺れる
  const t = now / 1000;
  queue.forEach((m, i) => { if (i > 0) m.userData.head.position.y = 1.7 + Math.sin(t * 2 + i) * 0.015; });
  updateVo(realDt);
  placeBubble();
  if (AUTOTEST) layoutCheck();
  // 結果画面で何も動いていないときは描き直さない(電池・発熱対策)
  const still = state.phase === 'end' && !tasks.length && !parts.length;
  if (!still || needRender) { renderer.render(scene, camera); needRender = false; }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

fetch('./data.json').then(r => r.json()).then(d => { DATA = d; state.ready = true; if (AUTOTEST) startGame(); else setupRound(); })
  .catch(e => { console.error(e); ui.start.querySelector('p').textContent = 'データを読み込めませんでした'; });
