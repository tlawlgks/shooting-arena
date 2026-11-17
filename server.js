const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const WEAPONS = require('./weapons.js');
const BRMAP = require('./brmap.js');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 8;
const KILL_LIMIT = { ffa: 10, team: 0, dog: 10 }; // 기본값. 개인전: 10킬 선취 / 팀전: 킬 제한 없음(3분 시간제)
const LIMITS = [5, 10, 15, 20, 30, 50]; // 방에서 고를 수 있는 최대 킬 수 (팀전은 0 = 제한 없음도 가능)
const BR_TOTALS = [10, 20, 30, 40, 50]; // 배틀로얄: 봇 포함 전체 인원
const limitOf = (mode, v) => { v = Math.floor(+v); if (mode === 'br') return BR_TOTALS.includes(v) ? v : 30; return LIMITS.includes(v) || (mode === 'team' && v === 0) ? v : KILL_LIMIT[mode]; };
const TEAM_TIME_MS = 3 * 60 * 1000; // 팀전 제한시간 3분 (개인전은 무제한)
const RESPAWN_MS = 3000;
const MAP_COUNT = 5;    // 맵 개수 (클라이언트의 MAPS와 같아야 함)
const BOT_WEAPON = 6;    // 훈련장 봇의 총 (M4A1)
const OUTRO_MS = 3000;  // 경기 종료 연출 시간 (1등은 이 동안 계속 움직일 수 있음)
const mapIdx = v => { v = Math.floor(+v); return v >= 0 && v < MAP_COUNT ? v : 0; };
const COUNTDOWN_MS = 3000;   // 시작 카운트다운
const SPAWN_PROTECT_MS = 2000; // 부활 직후 무적
const MEDKIT_CD_MS = 40000;   // 구급상자 쿨타임
const MEDKIT_HEAL = 50;       // 구급상자 총 회복량 (개수 무제한)
const MEDKIT_TICKS = 5;       // 5초 동안 1초마다 10씩 회복, 그동안 다른 행동 불가
const REGEN_DELAY_MS = 10000;  // 마지막 피격 후 자동 회복 시작까지 (10초)
const REGEN_STEP_MS = 333;     // 자동 회복 속도: 초당 3 (구급상자는 초당 10)
const JET = { gun: 9, missile: 110, missiles: 4 }; // 도그파이트: 기총 한 발 / 미사일 피해, 목숨당 미사일 수
const MAX_HP = 200;             // 최대 체력 (피해 100이 넘는 총도 한 방에 죽지 않게)
const KNIFE_DMG = 100;         // 칼: 근접 한 방
const NADES = () => ({ frag: 2, smoke: 1 }); // 목숨마다 수류탄 2, 연막탄 1
const REWARDS = WEAPONS.REWARDS;
const ARENA = 50;

// 정적 파일 서버 (shooter.html)
const STATIC = { // 요청 경로 -> [파일, Content-Type]
  '/weapons.js': ['weapons.js', 'text/javascript; charset=utf-8'],
  '/dogfight': ['dogfight.html', 'text/html; charset=utf-8'], // 도그파이트(전투기) 화면
  '/brmap.js': ['brmap.js', 'text/javascript; charset=utf-8'],     // 배틀로얄 섬 생성기
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
  '/icon-192.png': ['icon-192.png', 'image/png'],
  '/icon-512.png': ['icon-512.png', 'image/png'],
  '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'],
};
const server = http.createServer((req, res) => {
  const [file, type] = STATIC[req.url.split('?')[0]] || ['shooter.html', 'text/html; charset=utf-8'];
  fs.readFile(path.join(__dirname, file), (err, data) => {
    if (err) { res.writeHead(404); return res.end('file not found'); }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': type.startsWith('image') ? 'public, max-age=86400' : 'no-cache' });
    res.end(data);
  });
});
const wss = new WebSocketServer({ server });

let nextId = 1, nextRoomId = 1;
const clients = new Map(); // id -> {ws,id,nick,room}
const rooms = new Map();   // id -> room

// ---------- 계정 / 전적 (users.json 에 저장, 비밀번호는 scrypt 해시) ----------
const crypto = require('crypto');
// DATA_DIR 환경변수가 있으면 그 폴더에 저장 (Render의 영구 디스크 경로를 지정할 때 사용)
const USERS_FILE = path.join(process.env.DATA_DIR || __dirname, 'users.json');
const users = Object.create(null); // key = 소문자 아이디
try { Object.assign(users, JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'))); } catch {}
let saveT = null;
// 저장소: MONGODB_URI 환경변수가 있으면 MongoDB(Atlas), 없으면 users.json 파일
let mongoCol = null;
const lastSaved = new Map(); // key -> 마지막으로 DB에 저장한 내용 (바뀐 유저만 다시 저장)
async function flushUsers() {
  if (!mongoCol) return fs.writeFile(USERS_FILE, JSON.stringify(users), () => {});
  const ops = [], keys = [];
  for (const k in users) {
    const j = JSON.stringify(users[k]);
    if (lastSaved.get(k) === j) continue;
    ops.push({ replaceOne: { filter: { _id: k }, replacement: Object.assign({ _id: k }, JSON.parse(j)), upsert: true } });
    keys.push([k, j]);
  }
  if (!ops.length) return;
  try { await mongoCol.bulkWrite(ops); keys.forEach(([k, j]) => lastSaved.set(k, j)); }
  catch (e) { console.error('DB 저장 실패 (다음 저장 때 다시 시도):', e.message); }
}
function saveUsers() { clearTimeout(saveT); saveT = setTimeout(flushUsers, 500); }
async function initStore() {
  if (!process.env.MONGODB_URI) return console.log('저장소: users.json 파일');
  const { MongoClient } = require('mongodb');
  const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  const col = client.db(process.env.MONGODB_DB || 'shooting_arena').collection('users');
  for (const d of await col.find().toArray()) {
    const k = d._id; delete d._id;
    users[k] = d; lastSaved.set(k, JSON.stringify(d));
    (d.tokens || []).forEach(t => tokens.set(t, k));
  }
  mongoCol = col;
  console.log('저장소: MongoDB 연결됨 (유저 ' + Object.keys(users).length + '명)');
}
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const tokens = new Map(); // 로그인 유지 토큰 -> key
for (const k in users) (users[k].tokens || []).forEach(t => tokens.set(t, k));
const newStats = () => ({ kills: 0, deaths: 0, hs: 0, games: 0, wins: 0, xp: 0 });
const levelOf = xp => Math.floor(Math.sqrt(xp / 300)) + 1;
const publicStats = u => Object.assign({}, u.stats, { level: levelOf(u.stats.xp) });
const NAME_RE = /^[A-Za-z0-9가-힣_]{2,12}$/;
function issueToken(key) {
  const t = crypto.randomBytes(24).toString('hex'), u = users[key];
  const all = (u.tokens || []).concat(t);
  all.slice(0, -5).forEach(old => tokens.delete(old));
  u.tokens = all.slice(-5); tokens.set(t, key); saveUsers(); return t;
}
function topList() {
  return Object.values(users).sort((a, b) => b.stats.kills - a.stats.kills).slice(0, 10)
    .map(u => ({ name: u.name, level: levelOf(u.stats.xp), kills: u.stats.kills, deaths: u.stats.deaths, wins: u.stats.wins, title: (u.cos || NO_COS).title }));
}
// 터치 버튼 배치(계정에 저장): 알려진 버튼과 숫자 범위만 받아들임
const TB_IDS = ['fire', 'jump', 'reload', 'swap', 'zoom', 'prone', 'joy', 'med', 'nade', 'smoke', 'knife'];
const clampN = (v, a, b) => Math.max(a, Math.min(b, v));
function cleanLayout(d) {
  if (!d || typeof d !== 'object') return null;
  const out = {};
  if (d.tb && typeof d.tb === 'object') {
    out.tb = {};
    for (const id of TB_IDS) {
      const b = d.tb[id]; if (!b || typeof b !== 'object') continue;
      const x = +b.x, y = +b.y, sz = +b.s;
      if (![x, y, sz].every(Number.isFinite)) continue;
      out.tb[id] = { x: +clampN(x, 0, 100).toFixed(2), y: +clampN(y, 0, 100).toFixed(2), s: clampN(Math.round(sz), 30, 300) };
    }
  }
  const op = +d.tbOp;
  if (d.tbOp != null && Number.isFinite(op)) out.tbOp = clampN(op, 0.2, 1);
  return out;
}
const NO_COS = { color: 0, skin: 0, title: 0, jet: 0 };
const cosOf = p => (p.user && users[p.user] && users[p.user].cos) || NO_COS;
function cleanCos(u, d) { // 레벨이 모자란 보상은 기본값으로
  const lv = levelOf(u.stats.xp), out = {};
  for (const k of ['color', 'skin', 'title', 'jet']) { const i = Math.floor(+((d || {})[k])); const item = REWARDS[k][i]; out[k] = (item && lv >= item.lv) ? i : 0; }
  return out;
}
const statOf = c => (c.user && users[c.user]) ? users[c.user].stats : null;

const send = (c, m) => { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(m)); };
const inRoom = (room, m) => room.players.forEach(p => send(p, m));

function roomInfo(r) {
  return { id: r.id, name: r.name, mode: r.mode, map: r.map || 0, limit: r.limit, count: humansIn(r), max: r.mode === 'br' ? r.limit : MAX_PLAYERS, state: r.state };
}
const listRooms = () => [...rooms.values()].filter(r => !r.practice).map(roomInfo); // 훈련장은 목록에 나오지 않음
function broadcastRooms() {
  const list = listRooms();
  clients.forEach(c => { if (!c.room) send(c, { t: 'rooms', rooms: list }); });
}
function roomPayload(r) {
  return {
    t: 'room', id: r.id, name: r.name, mode: r.mode, map: r.map || 0, limit: r.limit, state: r.state, host: r.host, max: MAX_PLAYERS,
    players: [...r.players.values()].map(p => ({ id: p.id, nick: p.nick, level: statOf(p) ? levelOf(statOf(p).xp) : 0, title: cosOf(p).title }))
  };
}
function sendRoom(r) { inRoom(r, roomPayload(r)); broadcastRooms(); }

function spawnPoint() {
  const a = Math.random() * Math.PI * 2, d = 10 + Math.random() * (ARENA - 20);
  return { x: Math.cos(a) * d, z: Math.sin(a) * d };
}

const humansIn = r => { let n = 0; r.players.forEach(p => { if (!p.bot) n++; }); return n; };
function leaveRoom(c) {
  const r = c.room; if (!r) return;
  if (r.mode === 'br' && r.state === 'play') { // 배틀로얄 도중 나감: 살아 있었다면 그 자리에서 탈락 처리 (순위 = 그때 남은 인원)
    if (c.alive) { c.alive = false; c.hp = 0; const n = brAlive(r); inRoom(r, { t: 'kill', killer: c.id, victim: c.id, hs: false, kills: c.kills, deaths: c.deaths, teamKills: r.teamKills, air: 0, alive: n }); brOut(r, c, n); }
    r.players.delete(c.id); c.room = null;
    if (!humansIn(r)) { stopBR(r); rooms.delete(r.id); broadcastRooms(); return; } // 사람이 아무도 없으면 방 종료
    if (r.host === c.id) r.host = [...r.players.values()].find(p => !p.bot).id;
    inRoom(r, { t: 'left', id: c.id }); broadcastRooms(); return;
  }
  r.players.delete(c.id); c.room = null;
  if (r.practice) { rooms.delete(r.id); return; } // 훈련장은 나가면 바로 사라짐
  if (r.players.size === 0) { clearTimeout(r.timer); rooms.delete(r.id); }
  else {
    if (r.host === c.id) r.host = r.players.keys().next().value;
    if (r.state === 'play') {
      // 경기 도중 나간 사람: 킬 수와 상관없이 결과에서 무조건 최하위. 전적에는 한 판(패배)으로 기록
      (r.left = r.left || []).push({ nick: c.nick, team: c.team, kills: c.kills || 0, deaths: c.deaths || 0, left: true });
      const lst = statOf(c); if (lst) { lst.games++; saveUsers(); }
      inRoom(r, { t: 'left', id: c.id });
      if (r.players.size < 2) return endGame(r, '인원이 부족해서 게임이 종료되었어요');
    } else sendRoom(r);
  }
  broadcastRooms();
}

function startGame(r) {
  if (r.mode === 'br') return startBR(r);
  r.state = 'play';
  const list = [...r.players.values()];
  if (r.mode === 'team') { // 랜덤 팀 배정: 섞은 뒤 번갈아 배정
    for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
    list.forEach((p, i) => p.team = i % 2);
  } else list.forEach(p => p.team = -1);
  r.teamKills = [0, 0];
  r.left = []; // 이번 경기 도중 나간 사람들
  clearTimeout(r.timer);
  const duration = r.mode === 'team' ? TEAM_TIME_MS : 0;
  r.startAt = Date.now() + COUNTDOWN_MS;
  if (duration) r.timer = setTimeout(() => endGame(r), duration + COUNTDOWN_MS);
  list.forEach(p => { Object.assign(p, { hp: MAX_HP, kills: 0, deaths: 0, alive: true, state: null, sp: spawnPoint(), lastHurt: 0, prot: 0, lastHit: {}, lastMed: 0, healing: null, healUntil: 0, streak: 0, air: 0, nades: NADES(), pendingBoom: 0, mis: JET.missiles, pendMis: 0, nextRegen: 0 }); });
  r.players.forEach(p => {
    send(p, {
      t: 'start', mode: r.mode, map: r.map || 0, you: p.id, limit: r.limit, duration, countdown: COUNTDOWN_MS,
      players: [...r.players.values()].map(q => ({ id: q.id, nick: q.nick, team: q.team, x: q.sp.x, z: q.sp.z, cos: cosOf(q) }))
    });
  });
  broadcastRooms();
}

function endGame(r, reason) {
  if (r.mode === 'br') return endBR(r, reason);
  if (r.state !== 'play') return;
  clearTimeout(r.timer);
  r.state = 'wait';
  let winner = '';
  const ps = [...r.players.values()];
  if (r.mode === 'team') winner = r.teamKills[0] === r.teamKills[1] ? '무승부' : (r.teamKills[0] > r.teamKills[1] ? '레드 팀 승리' : '블루 팀 승리');
  else { ps.sort((a, b) => b.kills - a.kills); winner = ps.length ? ps[0].nick + ' 승리' : ''; }
  if (!reason) { // 정상 종료된 게임만 전적에 반영
    const wt = r.mode === 'team' ? (r.teamKills[0] === r.teamKills[1] ? -1 : (r.teamKills[0] > r.teamKills[1] ? 0 : 1)) : -2;
    ps.forEach((p, i) => {
      const st = statOf(p); if (!st) return;
      st.games++; st.xp += 50;
      const won = r.mode === 'team' ? p.team === wt : (i === 0 && p.kills > 0);
      if (won) { st.wins++; st.xp += 300; }
    });
    saveUsers();
  }
  ps.forEach(p => { if (statOf(p)) send(p, { t: 'stats', stats: publicStats(users[p.user]) }); });
  // 1등: 개인전 = 최다 킬, 팀전 = 이긴 팀의 최다 킬 (무승부면 전체 최다 킬)
  let winnerId = null;
  if (!reason && ps.length) {
    const sorted = [...ps].sort((a, b) => b.kills - a.kills);
    const wt2 = r.mode === 'team' ? (r.teamKills[0] === r.teamKills[1] ? -1 : (r.teamKills[0] > r.teamKills[1] ? 0 : 1)) : -1;
    winnerId = ((wt2 >= 0 ? sorted.filter(p => p.team === wt2)[0] : null) || sorted[0]).id;
    r.outroUntil = Date.now() + OUTRO_MS;
  }
  inRoom(r, {
    t: 'end', winner, winnerId, reason: reason || '',
    scores: [...ps].sort((a, b) => b.kills - a.kills).map(p => ({ nick: p.nick, team: p.team, kills: p.kills, deaths: p.deaths })).concat(r.left || []), teamKills: r.teamKills
  });
  r.players.forEach(p => { p.team = -1; });
  setTimeout(() => { if (rooms.has(r.id)) sendRoom(r); }, 100);
}

// 피해 적용: 체력 감소 → (사망 시) 킬 처리, 전적, 종료 판정, 부활 예약
function damage(r, c, v, dmg, hs, src) {
  const self = c === v; // 자기 수류탄에 맞은 경우
  v.hp -= dmg; v.lastHurt = Date.now();
  if (!self) send(c, { t: 'hitconfirm', hs: !!hs, dmg });
  if (v.hp > 0) { const hm = { t: 'hp', id: v.id, hp: v.hp, by: c.id }; return r.mode === 'br' ? send(v, hm) : inRoom(r, hm); } // 배틀로얄은 맞은 사람에게만 (인원이 많아서)
  v.hp = 0; v.alive = false; v.deaths++; v.healing = null; v.healUntil = 0; v.streak = 0;
  if (!self) { // 자폭은 킬로 치지 않음
    c.kills++; c.streak = (c.streak || 0) + 1;
    if (c.streak % 5 === 0) c.air = (c.air || 0) + 1; // 5연속 처치마다 공습 1회
    if (r.mode === 'team') r.teamKills[c.team]++;
  }
  if (!r.practice) { // 훈련장은 전적에 반영하지 않음
    const ks = self ? null : statOf(c), vs = statOf(v);
    if (ks) { ks.kills++; ks.xp += 100; if (hs) { ks.hs++; ks.xp += 25; } }
    if (vs) vs.deaths++;
    if (ks || vs) saveUsers();
  }
  const aliveN = r.mode === 'br' ? brAlive(r) : 0;
  inRoom(r, { t: 'kill', killer: c.id, victim: v.id, hs: !!hs, kills: c.kills, deaths: v.deaths, teamKills: r.teamKills, air: c.air || 0, zone: src === 'zone', alive: aliveN });
  if (r.mode === 'br') return brOut(r, v, aliveN); // 배틀로얄: 부활 없음
  const limit = r.practice ? 0 : r.limit; // 훈련장은 킬 제한 없음 (끝나지 않음)
  if (limit > 0 && (r.mode === 'team' ? Math.max(...r.teamKills) >= limit : c.kills >= limit)) return endGame(r);
  setTimeout(() => {
    if (r.state !== 'play' || !r.players.has(v.id)) return;
    v.hp = MAX_HP; v.alive = true; v.sp = spawnPoint(); v.prot = Date.now() + SPAWN_PROTECT_MS; v.nades = NADES(); v.mis = JET.missiles;
    inRoom(r, { t: 'respawn', id: v.id, x: v.sp.x, z: v.sp.z, prot: SPAWN_PROTECT_MS });
  }, RESPAWN_MS);
}

// =====================================================================
// 배틀로얄: 섬 · 봇(서버가 조종) · 아이템/탄약 · 인벤토리 · 자기장 · 순위
// =====================================================================
const AMMO = WEAPONS.AMMO;
const BR_ZONE = { R0: 285, PH: [[60, 40, 170, 2], [45, 35, 100, 4], [40, 30, 55, 8], [30, 25, 28, 14], [25, 20, 12, 25], [20, 20, 0, 40]] }; // [대기 초, 축소 초, 다음 반지름, 밖에 있을 때 초당 피해]
const wWeight = w => /대물/.test(w.type) ? 0.12 : /석궁|레버/.test(w.type) ? 0.2 : /볼트/.test(w.type) ? 0.35 : /기관총/.test(w.type) ? 0.4 : /지정사수|반자동/.test(w.type) ? 0.6 : /샷건/.test(w.type) ? 0.8 : 1;
const W_POOL = []; { let acc = 0; WEAPONS.forEach(w => { acc += wWeight(w); W_POOL.push([acc, w]); }); }
const pickWeapon = () => { const x = Math.random() * W_POOL[W_POOL.length - 1][0]; return W_POOL.find(e => e[0] >= x)[1]; };
const AMMO_W = [['9mm', 3], ['.45 ACP', 2], ['5.56mm', 3], ['7.62mm', 3], ['12게이지', 1.5], ['.300 매그넘', 0.4], ['.50 BMG', 0.25], ['화살', 0.15]];
const pickAmmo = () => { let x = Math.random() * AMMO_W.reduce((a, b) => a + b[1], 0); for (const [a, wt] of AMMO_W) { x -= wt; if (x <= 0) return a; } return '9mm'; };
const BOT_POOL = WEAPONS.filter(w => !/대물|석궁|레버|기관권총/.test(w.type)).map(w => w.id);
const rndf = (a, b) => a + Math.random() * (b - a), r2 = v => Math.round(v * 100) / 100;
const brAlive = r => { let n = 0; r.players.forEach(p => { if (p.alive) n++; }); return n; };
const invOf = p => ({ w: p.inv.w, ammo: p.inv.ammo, meds: p.inv.meds, frag: p.nades.frag, smoke: p.nades.smoke });
const brHas = (p, wid) => p.inv && p.inv.w.some(x => x && x.id === wid);
const nearHumans = (r, x, z, d, msg) => r.players.forEach(h => { if (!h.bot && (!h.alive || !h.state || (Math.abs(h.state.x - x) < d && Math.abs(h.state.z - z) < d))) send(h, msg); });

function buildBRGrid(r, map) { // 충돌·시야 계산용 격자 (8m 칸)
  const list = map.boxes.map(b => b.slice(0, 6)).filter(b => b[3] > 0.6);
  for (const [x, z, w, d, h] of map.rocks) list.push([x - w / 2, x + w / 2, 0, h, z - d / 2, z + d / 2]);
  for (const [x, z] of map.trees) list.push([x - 0.4, x + 0.4, 0, 5, z - 0.4, z + 0.4]);
  const G = new Map(), C = 8;
  list.forEach((b, i) => { for (let x = Math.floor(b[0] / C); x <= Math.floor(b[1] / C); x++) for (let z = Math.floor(b[4] / C); z <= Math.floor(b[5] / C); z++) { const k = x * 1000 + z; if (!G.has(k)) G.set(k, []); G.get(k).push(i); } });
  r.brBoxes = list; r.brGrid = G;
}
function cellBoxes(r, x, z) { return r.brGrid.get(Math.floor(x / 8) * 1000 + Math.floor(z / 8)) || []; }
function segHits(ax, ay, az, bx, by, bz, b) { // 선분이 상자를 지나는지 (slab)
  let t0 = 0, t1 = 1; const o = [ax, ay, az], d = [bx - ax, by - ay, bz - az], mn = [b[0], b[2], b[4]], mx = [b[1], b[3], b[5]];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) { if (o[i] < mn[i] || o[i] > mx[i]) return false; continue; }
    let ta = (mn[i] - o[i]) / d[i], tb = (mx[i] - o[i]) / d[i]; if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb); if (t0 > t1) return false;
  }
  return true;
}
function brLOS(r, ax, ay, az, bx, by, bz) { // 두 점 사이가 트였는지
  const L = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(L / 4)), seen = new Set();
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    for (const bi of cellBoxes(r, ax + (bx - ax) * t, az + (bz - az) * t)) { if (seen.has(bi)) continue; seen.add(bi); if (segHits(ax, ay, az, bx, by, bz, r.brBoxes[bi])) return false; }
  }
  return true;
}
function brPush(r, x, z) { // 봇이 벽을 통과하지 않게 밀어냄
  const P = 0.45;
  for (let pass = 0; pass < 2; pass++) for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (const bi of cellBoxes(r, x + dx * 8, z + dz * 8)) {
    const b = r.brBoxes[bi]; if (b[3] <= 0.6 || b[2] >= 1.8) continue;
    const x0 = b[0] - P, x1 = b[1] + P, z0 = b[4] - P, z1 = b[5] + P;
    if (x > x0 && x < x1 && z > z0 && z < z1) { const m = Math.min(x - x0, x1 - x, z - z0, z1 - z); if (m === x - x0) x = x0; else if (m === x1 - x) x = x1; else if (m === z - z0) z = z0; else z = z1; }
  }
  return [Math.max(-197, Math.min(197, x)), Math.max(-197, Math.min(197, z))];
}
function addItem(r, it) { it.i = r.itemSeq++; it.x = r2(it.x); it.y = r2(it.y); it.z = r2(it.z); r.items.set(it.i, it); return it; }
function genLoot(r, map) {
  for (const [x, y, z] of map.loot) {
    if (Math.random() < 0.1) continue;
    const roll = Math.random();
    if (roll < 0.34) { // 총 + 그 총의 탄약 1~2상자
      const w = pickWeapon(); addItem(r, { k: 'w', w: w.id, n: w.mag, x, y, z });
      for (let i = Math.random() < 0.5 ? 2 : 1; i > 0; i--) addItem(r, { k: 'a', a: w.ammo, n: AMMO[w.ammo].box, x: x + rndf(-0.8, 0.8), y, z: z + rndf(-0.8, 0.8) });
    } else if (roll < 0.7) { const a = pickAmmo(); addItem(r, { k: 'a', a, n: AMMO[a].box, x, y, z }); }
    else if (roll < 0.84) addItem(r, { k: 'm', n: 1, x, y, z });
    else if (roll < 0.94) addItem(r, { k: 'f', n: 1, x, y, z });
    else addItem(r, { k: 's', n: 1, x, y, z });
  }
}
function nextZoneCenter(z) { const a = Math.random() * Math.PI * 2, d = Math.random() * Math.max(0, z.r - z.nr) * 0.85; z.nx = Math.max(-170, Math.min(170, z.cx + Math.cos(a) * d)); z.nz = Math.max(-170, Math.min(170, z.cz + Math.sin(a) * d)); }
function zoneNow(z, now) { if (now <= z.shrinkAt) return { x: z.cx, z: z.cz, r: z.r }; const t = Math.min(1, (now - z.shrinkAt) / Math.max(1, z.endAt - z.shrinkAt)); return { x: z.cx + (z.nx - z.cx) * t, z: z.cz + (z.nz - z.cz) * t, r: z.r + (z.nr - z.r) * t }; }
function sendZone(r) { const z = r.zone, now = Date.now(); inRoom(r, { t: 'zone', phase: z.phase, cx: r2(z.cx), cz: r2(z.cz), r: r2(z.r), nx: r2(z.nx), nz: r2(z.nz), nr: z.nr, wait: Math.max(0, z.shrinkAt - now), dur: z.endAt - z.shrinkAt, dps: z.dps }); }
function makeBot(n) {
  const w = WEAPONS[BOT_POOL[Math.floor(Math.random() * BOT_POOL.length)]];
  return { ws: { readyState: 0 }, id: nextId++, nick: '봇 ' + n, bot: true, user: null, guest: true, bw: w,
    ai: { wx: 0, wz: 0, wt: 0, scan: Math.random(), target: null, react: 0, cool: 0, mag: w.mag, rl: 0, stuck: 0, strafe: 1, st: 0 } };
}
function startBR(r) {
  const seed = (Math.random() * 2147483647) | 0, map = BRMAP.genBR(seed);
  r.state = 'play'; r.startAt = Date.now() + COUNTDOWN_MS; r.teamKills = [0, 0]; r.left = []; r.brScores = []; r.items = new Map(); r.itemSeq = 1; r.outroUntil = 0;
  buildBRGrid(r, map);
  const total = Math.max(humansIn(r), r.limit); r.bots = [];
  for (let i = humansIn(r); i < total; i++) { const b = makeBot(r.bots.length + 1); r.bots.push(b); r.players.set(b.id, b); }
  const sp = map.spawns.slice().sort(() => Math.random() - 0.5); let si = 0;
  r.players.forEach(p => {
    const [x, z] = sp[si++ % sp.length];
    Object.assign(p, { team: -1, hp: MAX_HP, kills: 0, deaths: 0, alive: true, sp: { x, z }, lastHurt: 0, prot: 0, lastHit: {}, lastMed: 0, healing: null, healUntil: 0,
      streak: 0, air: 0, nades: { frag: 0, smoke: 0 }, pendingBoom: 0, mis: 0, pendMis: 0, inv: { w: [null, null], ammo: {}, meds: 0 }, place: 0 });
    p.state = { x, y: 1.7, z, yaw: Math.random() * 6.28, pitch: 0, pr: 0 };
  });
  r.brTotal = r.players.size;
  genLoot(r, map);
  const ph = BR_ZONE.PH[0]; r.zone = { phase: 0, cx: 0, cz: 0, r: BR_ZONE.R0, nr: ph[2], shrinkAt: r.startAt + ph[0] * 1000, endAt: r.startAt + (ph[0] + ph[1]) * 1000, dps: ph[3] }; nextZoneCenter(r.zone);
  const players = [...r.players.values()].map(q => ({ id: q.id, nick: q.nick, team: -1, x: q.sp.x, z: q.sp.z, cos: cosOf(q), bot: !!q.bot })), loot = [...r.items.values()];
  r.players.forEach(p => { if (!p.bot) send(p, { t: 'start', mode: 'br', seed, map: 5, you: p.id, limit: 0, duration: 0, countdown: COUNTDOWN_MS, players, loot, inv: invOf(p), total: r.brTotal }); });
  sendZone(r);
  r.brLast = Date.now(); r.zoneDmgAt = 0; clearInterval(r.brTimer); r.brTimer = setInterval(() => brTick(r), 100);
  broadcastRooms();
}
function stopBR(r) { clearInterval(r.brTimer); r.brTimer = null; for (const b of r.bots || []) r.players.delete(b.id); r.bots = []; }
function brOut(r, v, aliveN) { // 탈락: 순위 = 탈락 순간 남은 인원 + 1
  v.place = aliveN + 1; r.brScores.push({ id: v.id, nick: v.nick, kills: v.kills, place: v.place, human: !v.bot });
  send(v, { t: 'brdead', place: v.place, total: r.brTotal, kills: v.kills });
  if (aliveN <= 1) endBR(r);
}
function endBR(r, reason) {
  if (r.state !== 'play') return;
  r.state = 'wait'; clearTimeout(r.timer); clearInterval(r.brTimer); r.brTimer = null;
  r.players.forEach(p => { if (p.alive && !r.brScores.some(s => s.id === p.id)) r.brScores.push({ id: p.id, nick: p.nick, kills: p.kills, place: 1, human: !p.bot }); });
  r.brScores.sort((a, b) => a.place - b.place);
  const win = r.brScores[0], winnerId = reason ? null : (win ? win.id : null);
  if (!reason) {
    r.outroUntil = Date.now() + OUTRO_MS;
    r.players.forEach(p => { const st = statOf(p); if (!st) return; st.games++; st.xp += 50; if (win && win.id === p.id) { st.wins++; st.xp += 300; } });
    saveUsers();
  }
  const scores = r.brScores.filter((x, i) => i < 10 || x.human).map(x => ({ nick: x.nick, team: -1, kills: x.kills, deaths: 0, place: x.place, bot: !x.human }));
  inRoom(r, { t: 'end', winner: win ? win.nick + ' 승리 · 🍗 이겼닭! 오늘 저녁은 치킨이닭!' : '게임 종료', winnerId, reason: reason || '', scores, br: true, total: r.brTotal });
  r.players.forEach(p => { if (!p.bot && statOf(p)) send(p, { t: 'stats', stats: publicStats(users[p.user]) }); });
  setTimeout(() => { // 종료 연출이 끝나면 봇을 치우고 대기실로
    for (const b of r.bots || []) r.players.delete(b.id); r.bots = [];
    r.players.forEach(p => { p.team = -1; });
    if (rooms.has(r.id)) sendRoom(r);
  }, reason ? 100 : OUTRO_MS + 200);
}
function botFire(r, b, t) {
  const w = b.bw, st = b.state, ts = t.state, d = Math.hypot(ts.x - st.x, ts.z - st.z);
  let p = Math.max(0.05, Math.min(0.45, 0.4 - d / 150 - (ts.pr ? 0.1 : 0)));
  if (w.zoom >= 2.5) p = Math.max(0.08, 0.4 - d / 450);
  const hit = Math.random() < p, ty = (ts.y || 1.7) - 0.5 - (ts.pr ? 0.9 : 0);
  const to = hit ? [r2(ts.x), r2(ty), r2(ts.z)] : [r2(ts.x + rndf(-1.5, 1.5)), r2(ty + rndf(-0.6, 1)), r2(ts.z + rndf(-1.5, 1.5))];
  nearHumans(r, st.x, st.z, 150, { t: 'shot', id: b.id, from: [r2(st.x), 1.45, r2(st.z)], to });
  if (!hit) return;
  const hs = Math.random() < 0.08;
  let dmg = w.dmg * (hs ? 2 : 1);
  if (w.pellets > 1) dmg = w.dmg * Math.max(1, Math.round(w.pellets * Math.max(0.15, 1 - d / 25)));
  if (t.bot) dmg *= 0.35; // 봇끼리 싸울 때는 피해를 줄임 (경기가 너무 빨리 끝나지 않게)
  damage(r, b, t, dmg, hs);
}
function botsTick(r, dt, zc, now) {
  const z = r.zone, ents = []; r.players.forEach(p => { if (p.alive && p.state) ents.push(p); });
  for (const b of r.bots) {
    if (r.state !== 'play') return;
    if (!b.alive) continue;
    const ai = b.ai, st = b.state, w = b.bw, range = w.zoom >= 2.5 ? 120 : w.pellets > 1 ? 28 : 55;
    ai.scan -= dt;
    if (ai.scan <= 0) { // 0.3초마다 가까운 적 중 보이는 상대 찾기 (최대 3명 검사)
      ai.scan = 0.3 + Math.random() * 0.25; const cand = [];
      for (const e of ents) { if (e === b || !e.alive) continue; const d = Math.hypot(e.state.x - st.x, e.state.z - st.z); if (d < range) cand.push([d, e]); }
      cand.sort((a, c) => a[0] - c[0]); let found = null;
      for (let i = 0; i < Math.min(3, cand.length); i++) { const e = cand[i][1]; if (brLOS(r, st.x, 1.6, st.z, e.state.x, (e.state.y || 1.7) - 0.5 - (e.state.pr ? 0.9 : 0), e.state.z)) { found = e; break; } }
      if (found !== ai.target) { ai.target = found; ai.react = 0.9 + Math.random() * 0.8; } // 발견 후 조준까지 0.9~1.7초
    }
    const t = ai.target && ai.target.alive ? ai.target : null; if (!t) ai.target = null;
    // 이동 목표: 자기장 밖이면 안쪽으로, 교전 중이면 옆걸음, 아니면 다음 안전 구역 안을 돌아다님
    let gx, gz, spd;
    const outNext = Math.hypot(st.x - z.nx, st.z - z.nz) > z.nr * 0.8 + 3, outNow = Math.hypot(st.x - zc.x, st.z - zc.z) > zc.r - 2;
    if (outNow) { gx = zc.x; gz = zc.z; spd = 5; }
    else if (t) {
      const dx = t.state.x - st.x, dz = t.state.z - st.z, d = Math.hypot(dx, dz) || 1; ai.st -= dt;
      if (ai.st <= 0) { ai.st = 1 + Math.random() * 2; ai.strafe = Math.random() < 0.5 ? -1 : 1; }
      const want = d < 8 ? -1 : d > range * 0.7 ? 1 : 0;
      gx = st.x + dx / d * want * 3 - dz / d * ai.strafe * 3; gz = st.z + dz / d * want * 3 + dx / d * ai.strafe * 3; spd = 2.3;
    } else if (outNext) { gx = z.nx; gz = z.nz; spd = 4.8; }
    else {
      ai.wt -= dt;
      if (ai.wt <= 0 || Math.hypot(ai.wx - st.x, ai.wz - st.z) < 2) { const a = Math.random() * 6.283, rr = Math.random() * z.nr * 0.8; ai.wx = z.nx + Math.cos(a) * rr; ai.wz = z.nz + Math.sin(a) * rr; ai.wt = 6 + Math.random() * 8; }
      gx = ai.wx; gz = ai.wz; spd = 3.8;
    }
    const mx = gx - st.x, mz = gz - st.z, ml = Math.hypot(mx, mz);
    if (ml > 0.3) {
      let [nx, nz] = brPush(r, st.x + mx / ml * spd * dt, st.z + mz / ml * spd * dt);
      if (Math.hypot(nx - st.x, nz - st.z) < spd * dt * 0.3) { ai.stuck += dt; if (ai.stuck > 0.8) { ai.stuck = 0; ai.wt = 3; ai.wx = st.x + rndf(-15, 15); ai.wz = st.z + rndf(-15, 15); } } else ai.stuck = 0; // 막히면 다른 곳으로
      st.x = r2(nx); st.z = r2(nz); if (!t) st.yaw = r2(Math.atan2(mx, mz));
    }
    if (t) {
      st.yaw = r2(Math.atan2(t.state.x - st.x, t.state.z - st.z)); ai.react -= dt;
      if (ai.rl > 0) { ai.rl -= dt; if (ai.rl <= 0) ai.mag = w.mag; }
      else if (ai.react <= 0) { ai.cool -= dt; if (ai.cool <= 0) { botFire(r, b, t); ai.cool = Math.max(w.cd, 0.3) * (1.4 + Math.random()); if (--ai.mag <= 0) ai.rl = w.reload + 0.5; } }
    }
  }
}
function brTick(r) {
  if (r.state !== 'play') return;
  const now = Date.now(), dt = Math.min(0.25, (now - r.brLast) / 1000); r.brLast = now;
  if (now < r.startAt) return;
  const z = r.zone;
  if (now >= z.endAt && z.phase < BR_ZONE.PH.length - 1) { // 다음 단계
    z.phase++; z.cx = z.nx; z.cz = z.nz; z.r = z.nr; const ph = BR_ZONE.PH[z.phase];
    z.nr = ph[2]; nextZoneCenter(z); z.shrinkAt = now + ph[0] * 1000; z.endAt = z.shrinkAt + ph[1] * 1000; z.dps = ph[3]; sendZone(r);
  }
  const zc = zoneNow(z, now);
  if (now >= r.zoneDmgAt) { // 1초마다 자기장 밖 피해
    r.zoneDmgAt = now + 1000;
    for (const p of [...r.players.values()]) {
      if (r.state !== 'play') return;
      if (p.alive && p.state && Math.hypot(p.state.x - zc.x, p.state.z - zc.z) > zc.r) damage(r, p, p, z.dps, false, 'zone');
    }
  }
  botsTick(r, dt, zc, now);
}

wss.on('connection', ws => {
  const c = { ws, id: nextId++, nick: '게스트' + Math.floor(Math.random() * 1000), room: null, user: null, guest: false, tries: 0 };
  clients.set(c.id, c);
  send(c, { t: 'hello', id: c.id });

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.nick && c.guest && !c.room) c.nick = String(m.nick).slice(0, 12) || c.nick; // 닉네임 변경은 게스트만 (로그인 유저는 아이디가 닉네임)
    if (Array.isArray(m.loadout)) { // 총은 최대 2개, 중복/잘못된 번호 제거
      const ids = [...new Set(m.loadout.map(Number))].filter(i => Number.isInteger(i) && WEAPONS[i]).slice(0, 2);
      if (ids.length) c.loadout = ids;
    }
    const r = c.room;
    const authErr = msg => send(c, { t: 'autherr', msg });
    const authOk = (key, token) => { c.user = key; c.guest = false; c.nick = users[key].name; send(c, { t: 'authed', user: users[key].name, token, stats: publicStats(users[key]), layout: users[key].layout || null, cos: users[key].cos || NO_COS }); };
    if (!c.user && !c.guest && (m.t === 'create' || m.t === 'join' || m.t === 'start' || m.t === 'practice')) return send(c, { t: 'err', msg: '먼저 로그인하거나 게스트로 입장하세요' });
    switch (m.t) {
      case 'register': case 'login': {
        if (r) break;
        if (++c.tries > 20) return authErr('시도가 너무 많아요. 새로고침 후 다시 시도하세요');
        const name = String(m.user || '').trim(), pw = String(m.pass || ''), key = name.toLowerCase();
        if (m.t === 'register') {
          if (!NAME_RE.test(name)) return authErr('아이디는 2~12자 (한글, 영문, 숫자, _)');
          if (pw.length < 4 || pw.length > 64) return authErr('비밀번호는 4자 이상이어야 해요');
          if (users[key]) return authErr('이미 있는 아이디예요');
          const salt = crypto.randomBytes(16).toString('hex');
          users[key] = { name, salt, hash: hashPw(pw, salt), stats: newStats(), tokens: [], created: Date.now() };
        } else {
          const u = users[key];
          if (!u || !crypto.timingSafeEqual(Buffer.from(hashPw(pw, u.salt), 'hex'), Buffer.from(u.hash, 'hex'))) return authErr('아이디 또는 비밀번호가 틀렸어요');
        }
        authOk(key, issueToken(key)); break;
      }
      case 'auth': { // 저장된 토큰으로 자동 로그인
        if (r) break;
        const key = tokens.get(String(m.token || ''));
        if (key && users[key]) authOk(key, m.token); else send(c, { t: 'autherr', msg: '', expired: true });
        break;
      }
      case 'guest':
        if (r) break;
        c.user = null; c.guest = true; c.nick = String(m.nick || '').slice(0, 12) || c.nick;
        send(c, { t: 'authed', user: c.nick, guest: true }); break;
      case 'logout':
        if (r) break;
        if (c.user && users[c.user] && m.token) { users[c.user].tokens = (users[c.user].tokens || []).filter(t => t !== m.token); tokens.delete(m.token); saveUsers(); }
        c.user = null; c.guest = false; send(c, { t: 'loggedout' }); break;
      case 'top': send(c, { t: 'top', list: topList() }); break;
      case 'cos': { // 꾸미기 선택 저장 (레벨 보상)
        if (!c.user || !users[c.user]) break;
        users[c.user].cos = cleanCos(users[c.user], m); saveUsers();
        send(c, { t: 'cos', cos: users[c.user].cos }); break;
      }
      case 'layout': { // 터치 버튼 배치를 계정에 저장 (로그인 유저만)
        if (!c.user || !users[c.user]) break;
        const lay = cleanLayout(m.data);
        if (lay) users[c.user].layout = lay; else delete users[c.user].layout;
        saveUsers(); break;
      }
      case 'lobby': send(c, { t: 'rooms', rooms: listRooms() }); break;
      case 'create': {
        if (r) break;
        const mode = ['team', 'dog', 'br'].includes(m.mode) ? m.mode : 'ffa'; // dog = 도그파이트, br = 배틀로얄 // dog = 도그파이트(전투기 개인전)
        const room = { id: nextRoomId++, name: String(m.name || '').slice(0, 20) || (c.nick + '의 방'), mode, map: mapIdx(m.map), limit: limitOf(mode, m.limit), host: c.id, state: 'wait', players: new Map(), teamKills: [0, 0] };
        rooms.set(room.id, room); room.players.set(c.id, c); c.room = room; sendRoom(room); break;
      }
      case 'join': {
        if (r) break;
        const room = rooms.get(m.id);
        if (!room) return send(c, { t: 'err', msg: '방이 사라졌어요' });
        if (room.state !== 'wait') return send(c, { t: 'err', msg: '이미 게임이 진행 중이에요' });
        if (humansIn(room) >= (room.mode === 'br' ? room.limit : MAX_PLAYERS)) return send(c, { t: 'err', msg: '방이 가득 찼어요' });
        room.players.set(c.id, c); c.room = room; sendRoom(room); break;
      }
      case 'leave': leaveRoom(c); send(c, { t: 'rooms', rooms: listRooms() }); break;
      case 'practice': { // 훈련장: 봇 1명과 끝나지 않는 연습 (전적 미반영, 방 목록에 안 나옴)
        if (r) break;
        const bot = { ws: { readyState: 0 }, id: nextId++, nick: '훈련 봇', bot: true, room: null, user: null, guest: true, loadout: [BOT_WEAPON] };
        const room = { id: nextRoomId++, name: '훈련장', mode: m.dog ? 'dog' : 'ffa', practice: true, bot, map: mapIdx(m.map), host: c.id, state: 'play', players: new Map(), teamKills: [0, 0], startAt: Date.now() + COUNTDOWN_MS };
        rooms.set(room.id, room); room.players.set(c.id, c); room.players.set(bot.id, bot); c.room = room;
        [c, bot].forEach(p => Object.assign(p, { team: -1, hp: MAX_HP, kills: 0, deaths: 0, alive: true, state: null, sp: spawnPoint(), lastHurt: 0, prot: 0, lastHit: {}, lastMed: 0, healing: null, healUntil: 0, streak: 0, air: 0, nades: NADES(), pendingBoom: 0, mis: JET.missiles, pendMis: 0, nextRegen: 0 }));
        send(c, { t: 'start', mode: room.mode, practice: true, bot: bot.id, map: room.map, you: c.id, limit: 0, duration: 0, countdown: COUNTDOWN_MS,
          players: [c, bot].map(q => ({ id: q.id, nick: q.nick, team: -1, x: q.sp.x, z: q.sp.z, cos: cosOf(q) })) });
        break;
      }
      case 'bothit': { // 훈련장 봇이 나를 맞힘 (봇의 움직임·시야·명중 판정은 클라이언트가 계산)
        if (!r || !r.practice || !c.alive) break;
        const bot = r.bot, w = WEAPONS[BOT_WEAPON], now = Date.now();
        if (!bot.alive || now < r.startAt || now < (c.prot || 0)) break;
        if (now - (bot.lastShot || 0) < w.cd * 600 + 250) break;
        bot.lastShot = now; damage(r, bot, c, w.dmg, false); break;
      }
      case 'setlimit': // 방장이 대기실에서 최대 킬 수 변경
        if (!r || r.host !== c.id || r.state !== 'wait') break;
        r.limit = limitOf(r.mode, m.limit); sendRoom(r); break;
      case 'setmap': // 방장이 대기실에서 맵 변경
        if (!r || r.host !== c.id || r.state !== 'wait') break;
        r.map = mapIdx(m.map); sendRoom(r); break;
      case 'start':
        if (!r || r.host !== c.id || r.state !== 'wait') break;
        if (r.players.size < (r.mode === 'br' ? 1 : 2)) return send(c, { t: 'err', msg: '2명 이상이어야 시작할 수 있어요' }); // 배틀로얄은 혼자서도 (봇이 채움)
        startGame(r); break;
      case 'state':
        if (!r || !(r.state === 'play' ? c.alive : Date.now() < (r.outroUntil || 0))) break; // 종료 연출 중에도 위치는 계속 전달
        c.state = { x: +m.x, y: +m.y, z: +m.z, yaw: +m.yaw, pitch: +m.pitch, pr: m.pr ? 1 : 0, roll: +m.roll || 0,
          q: (Array.isArray(m.q) && m.q.length === 4 && m.q.every(Number.isFinite)) ? m.q : null }; break; // 전투기 자세(쿼터니언)
      case 'throw': { // 수류탄·연막탄 던지기: 개수 확인 후 다른 사람들에게 궤적 전달
        if (!r || r.state !== 'play' || !c.alive || Date.now() < (r.startAt || 0)) break;
        const k = m.k === 'smoke' ? 'smoke' : 'frag';
        const vec = a => Array.isArray(a) && a.length === 3 && a.every(n => typeof n === 'number' && Number.isFinite(n)) ? a : null;
        const p = vec(m.p), v = vec(m.v);
        if (!p || !v || !c.nades || c.nades[k] <= 0) break;
        c.nades[k]--; if (k === 'frag') c.pendingBoom = (c.pendingBoom || 0) + 1;
        r.players.forEach(q => { if (q !== c) send(q, { t: 'throw', id: c.id, k, p, v }); });
        break;
      }
      case 'boom': { // 폭발 피해 (던진 사람의 브라우저가 거리·엄폐를 계산해서 보고). 던진 만큼만 인정
        if (!r || r.state !== 'play' || !(c.pendingBoom > 0)) break;
        c.pendingBoom--;
        const hits = Array.isArray(m.hits) ? m.hits.slice(0, 8) : [], now = Date.now();
        for (const h of hits) {
          if (r.state !== 'play') break;
          const v = r.players.get(h && h.id), dmg = Math.min(150, Math.max(1, Math.round(+(h && h.dmg) || 0)));
          if (!v || !v.alive || now < (v.prot || 0)) continue;
          if (v !== c && r.mode === 'team' && v.team === c.team) continue; // 아군 피해 없음 (자기 자신은 맞음)
          damage(r, c, v, dmg, false);
        }
        break;
      }
      case 'air': { // 공습 요청 (5연속 처치 보상)
        if (!r || r.state !== 'play' || !c.alive || !(c.air > 0)) break;
        const x = +m.x, z = +m.z; if (!Number.isFinite(x) || !Number.isFinite(z)) break;
        c.air--; c.pendingBoom = (c.pendingBoom || 0) + 5;
        inRoom(r, { t: 'air', id: c.id, x: clampN(x, -48, 48), z: clampN(z, -48, 48), a: Math.random() * Math.PI });
        break;
      }
      case 'melee': { // 칼
        if (!r || r.state !== 'play' || !c.alive) break;
        const v = r.players.get(m.target), now = Date.now();
        if (!v || v === c || !v.alive || now < (r.startAt || 0) || now < (v.prot || 0) || now < (c.healUntil || 0)) break;
        if (r.mode === 'team' && v.team === c.team) break;
        if (now - (c.lastMelee || 0) < 700) break;
        c.lastMelee = now;
        if (c.state && v.state && Math.hypot(c.state.x - v.state.x, c.state.z - v.state.z) > 5) break; // 너무 멀면 무효
        damage(r, c, v, KNIFE_DMG, false); break;
      }
      // ---------- 도그파이트 (전투기) ----------
      case 'jhit': { // 기총 명중 (명중 판정은 쏜 사람의 브라우저가 계산)
        if (!r || r.mode !== 'dog' || r.state !== 'play' || !c.alive) break;
        const v = r.players.get(m.target), now = Date.now();
        if (!v || v === c || !v.alive || now < (r.startAt || 0) || now < (v.prot || 0)) break;
        if (now - (c.lastJet || 0) < 50) break; // 발사 속도 제한
        c.lastJet = now; damage(r, c, v, JET.gun, false); break;
      }
      case 'jfire': { // 미사일 발사: 개수 확인 후 다른 사람들에게 알림 (표적에게는 경고가 뜸)
        if (!r || r.mode !== 'dog' || r.state !== 'play' || !c.alive || !(c.mis > 0)) break;
        c.mis--; c.pendMis = (c.pendMis || 0) + 1;
        r.players.forEach(q => { if (q !== c) send(q, { t: 'jfire', id: c.id, target: m.target }); });
        break;
      }
      case 'jmis': { // 미사일 명중: 쏜 만큼만 인정
        if (!r || r.mode !== 'dog' || r.state !== 'play' || !(c.pendMis > 0)) break;
        c.pendMis--;
        const v = r.players.get(m.target);
        if (!v || v === c || !v.alive || Date.now() < (v.prot || 0)) break;
        damage(r, c, v, JET.missile, false); break;
      }
      case 'jlock': // 무유도로 쏜 미사일이 비행 중 목표를 잡음 (다른 화면에 알림)
        if (r && r.mode === 'dog' && r.state === 'play' && c.alive) r.players.forEach(q => { if (q !== c) send(q, { t: 'jlock', id: c.id, target: m.target }); });
        break;
      case 'jflare': // 플레어: 나를 쫓는 미사일을 속임 (다른 화면에 전달)
        if (r && r.mode === 'dog' && r.state === 'play' && c.alive) r.players.forEach(q => { if (q !== c) send(q, { t: 'jflare', id: c.id }); });
        break;
      case 'jcrash': // 추락 / 산에 충돌 / 전투 구역 이탈: 자폭 처리 (킬로 치지 않음)
        if (r && r.mode === 'dog' && r.state === 'play' && c.alive && Date.now() >= (r.startAt || 0)) damage(r, c, c, 9999, false);
        break;
      case 'medkit': { // 구급상자: 체력 50 회복 (일반: 쿨타임 40초·무제한 / 배틀로얄: 주운 개수만큼)
        if (!r || r.state !== 'play' || !c.alive || c.hp >= MAX_HP || c.healing) break;
        const now = Date.now(), br = r.mode === 'br';
        if (br ? !(c.inv.meds > 0) : now - (c.lastMed || 0) < MEDKIT_CD_MS) break;
        if (br) { c.inv.meds--; send(c, { t: 'inv', inv: invOf(c), why: 'med' }); }
        c.lastMed = now; c.healing = { ticks: MEDKIT_TICKS, next: now + 1000 }; c.healUntil = now + MEDKIT_TICKS * 1000;
        send(c, { t: 'med', cd: br ? MEDKIT_TICKS * 1000 : MEDKIT_CD_MS, heal: MEDKIT_HEAL, dur: MEDKIT_TICKS * 1000 });
        break;
      }
      case 'shot': // 다른 플레이어에게 사격 이펙트 전달 (배틀로얄: 탄창 확인 후 가까운 사람에게만)
        if (!r || r.state !== 'play' || !c.alive) break;
        if (r.mode === 'br') {
          const sl = c.inv.w.find(x => x && x.id === m.w); if (!sl || sl.mag <= 0) break; sl.mag--;
          if (c.state) r.players.forEach(p => { if (p !== c && !p.bot && (!p.alive || !p.state || (Math.abs(p.state.x - c.state.x) < 150 && Math.abs(p.state.z - c.state.z) < 150))) send(p, { t: 'shot', id: c.id, from: m.from, to: m.to }); });
          break;
        }
        r.players.forEach(p => { if (p !== c) send(p, { t: 'shot', id: c.id, from: m.from, to: m.to }); });
        break;
      case 'pick': { // 배틀로얄: 아이템 줍기 (가까이 있어야 함)
        if (!r || r.mode !== 'br' || r.state !== 'play' || !c.alive || !c.state) break;
        const it = r.items.get(m.id); if (!it) break;
        if (Math.hypot(c.state.x - it.x, c.state.z - it.z) > 3.2 || Math.abs((c.state.y - 1.7) - it.y) > 2.2) break;
        r.items.delete(it.i); let dropped = null;
        if (it.k === 'w') { // 빈 칸에 넣고, 두 칸이 다 차 있으면 들고 있던 총과 바꿈 (원래 총은 그 자리에 떨어짐)
          const inv = c.inv; let sl = !inv.w[0] ? 0 : !inv.w[1] ? 1 : -1;
          if (sl < 0) { sl = m.slot === 1 ? 1 : 0; const old = inv.w[sl]; dropped = addItem(r, { k: 'w', w: old.id, n: old.mag, x: c.state.x, y: Math.max(0, c.state.y - 1.7), z: c.state.z }); }
          inv.w[sl] = { id: it.w, mag: it.n };
        } else if (it.k === 'a') c.inv.ammo[it.a] = (c.inv.ammo[it.a] || 0) + it.n;
        else if (it.k === 'm') c.inv.meds += it.n;
        else if (it.k === 'f') c.nades.frag += it.n;
        else c.nades.smoke += it.n;
        r.players.forEach(p => { if (p.bot) return; send(p, { t: 'loot-', id: it.i }); if (dropped) send(p, { t: 'loot+', item: dropped }); });
        send(c, { t: 'inv', inv: invOf(c), why: 'pick' });
        break;
      }
      case 'reload': { // 배틀로얄: 가진 탄약만큼만 재장전
        if (!r || r.mode !== 'br' || r.state !== 'play' || !c.alive) break;
        const sl = c.inv.w[m.slot === 1 ? 1 : 0]; if (!sl) break;
        const w = WEAPONS[sl.id], have = c.inv.ammo[w.ammo] || 0, take = Math.min(w.mag - sl.mag, have);
        if (take > 0) { sl.mag += take; c.inv.ammo[w.ammo] = have - take; }
        send(c, { t: 'inv', inv: invOf(c), why: 'reload' });
        break;
      }
      case 'hit': {
        if (!r || r.state !== 'play' || !c.alive) break;
        const v = r.players.get(m.target);
        if (!v || v === c || !v.alive) break;
        if (r.mode === 'team' && v.team === c.team) break; // 아군 피해 없음
        const w = WEAPONS[m.w];
        if (!w || !(r.mode === 'br' ? brHas(c, m.w) : (c.loadout || [0, 6]).includes(m.w))) break; // 선택하지(주운) 않은 총은 무시
        const nb = Math.max(0, m.nb | 0), nh = Math.max(0, m.nh | 0);
        if (nb + nh < 1 || nb + nh > w.pellets) break;
        const now = Date.now(), key = m.w + ':' + v.id;
        if (now < (r.startAt || 0) || now < (v.prot || 0)) break; // 카운트다운 중 / 부활 직후 무적
        if (now < (c.healUntil || 0)) break; // 치료 중에는 사격 불가
        c.lastHit = c.lastHit || {};
        if (now - (c.lastHit[key] || 0) < w.cd * 600) break; // 발사 간격 검사
        c.lastHit[key] = now;
        m.hs = nh > 0;
        damage(r, c, v, w.dmg * (nb + 2 * nh), nh > 0);
        break;
      }
    }
  });
  ws.on('close', () => { leaveRoom(c); clients.delete(c.id); });
});

// 20Hz 위치 동기화
setInterval(() => {
  rooms.forEach(r => {
    if (r.state !== 'play' && Date.now() > (r.outroUntil || 0)) return;
    const s = {}, br = r.mode === 'br';
    const now = Date.now();
    r.players.forEach(p => {
      if (p.state && (!br || p.alive || r.state !== 'play')) s[p.id] = p.state;
      if (p.healing) { // 구급상자: 1초마다 회복
        if (!p.alive) p.healing = null;
        else if (now >= p.healing.next) {
          p.hp = Math.min(MAX_HP, p.hp + MEDKIT_HEAL / MEDKIT_TICKS); send(p, { t: 'hp', id: p.id, hp: p.hp });
          p.healing.next += 1000; if (--p.healing.ticks <= 0) p.healing = null;
        }
      }
      if (!br && p.alive && p.hp < MAX_HP && now - (p.lastHurt || 0) > REGEN_DELAY_MS && now >= (p.nextRegen || 0)) { p.nextRegen = now + REGEN_STEP_MS; p.hp = Math.min(MAX_HP, p.hp + 1); send(p, { t: 'hp', id: p.id, hp: p.hp }); } // 느린 자동 회복
    });
    if (!br) return inRoom(r, { t: 'states', s });
    r.players.forEach(h => { // 배틀로얄: 각자 주변 170m 안의 것만 (죽은 사람은 관전용으로 전부)
      if (h.bot) return;
      if (!h.alive || !h.state) return send(h, { t: 'states', s });
      const f = {}; for (const id in s) { const q = s[id]; if (Math.abs(q.x - h.state.x) < 170 && Math.abs(q.z - h.state.z) < 170) f[id] = q; }
      send(h, { t: 'states', s: f });
    });
  });
}, 50);

initStore().catch(e => console.error('MongoDB 연결 실패 → users.json 파일로 계속합니다:', e.message)).finally(() => server.listen(PORT, () => {
  console.log('서버 실행 중: http://localhost:' + PORT);
  const nets = require('os').networkInterfaces();
  for (const k in nets) for (const n of nets[k]) if (n.family === 'IPv4' && !n.internal) console.log('같은 와이파이의 다른 기기: http://' + n.address + ':' + PORT);
}));
