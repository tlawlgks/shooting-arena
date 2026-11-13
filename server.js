const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const WEAPONS = require('./weapons.js');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 8;
const KILL_LIMIT = { ffa: 10, team: 0 }; // 개인전: 10킬 선취 / 팀전: 킬 제한 없음(시간제)
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
const MAX_HP = 200;             // 최대 체력 (피해 100이 넘는 총도 한 방에 죽지 않게)
const KNIFE_DMG = 100;         // 칼: 근접 한 방
const NADES = () => ({ frag: 2, smoke: 1 }); // 목숨마다 수류탄 2, 연막탄 1
const REWARDS = WEAPONS.REWARDS;
const ARENA = 50;

// 정적 파일 서버 (shooter.html)
const STATIC = { // 요청 경로 -> [파일, Content-Type]
  '/weapons.js': ['weapons.js', 'text/javascript; charset=utf-8'],
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
const NO_COS = { color: 0, skin: 0, title: 0 };
const cosOf = p => (p.user && users[p.user] && users[p.user].cos) || NO_COS;
function cleanCos(u, d) { // 레벨이 모자란 보상은 기본값으로
  const lv = levelOf(u.stats.xp), out = {};
  for (const k of ['color', 'skin', 'title']) { const i = Math.floor(+((d || {})[k])); const item = REWARDS[k][i]; out[k] = (item && lv >= item.lv) ? i : 0; }
  return out;
}
const statOf = c => (c.user && users[c.user]) ? users[c.user].stats : null;

const send = (c, m) => { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(m)); };
const inRoom = (room, m) => room.players.forEach(p => send(p, m));

function roomInfo(r) {
  return { id: r.id, name: r.name, mode: r.mode, map: r.map || 0, count: r.players.size, max: MAX_PLAYERS, state: r.state };
}
const listRooms = () => [...rooms.values()].filter(r => !r.practice).map(roomInfo); // 훈련장은 목록에 나오지 않음
function broadcastRooms() {
  const list = listRooms();
  clients.forEach(c => { if (!c.room) send(c, { t: 'rooms', rooms: list }); });
}
function roomPayload(r) {
  return {
    t: 'room', id: r.id, name: r.name, mode: r.mode, map: r.map || 0, state: r.state, host: r.host, max: MAX_PLAYERS,
    players: [...r.players.values()].map(p => ({ id: p.id, nick: p.nick, level: statOf(p) ? levelOf(statOf(p).xp) : 0, title: cosOf(p).title }))
  };
}
function sendRoom(r) { inRoom(r, roomPayload(r)); broadcastRooms(); }

function spawnPoint() {
  const a = Math.random() * Math.PI * 2, d = 10 + Math.random() * (ARENA - 20);
  return { x: Math.cos(a) * d, z: Math.sin(a) * d };
}

function leaveRoom(c) {
  const r = c.room; if (!r) return;
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
  list.forEach(p => { Object.assign(p, { hp: MAX_HP, kills: 0, deaths: 0, alive: true, state: null, sp: spawnPoint(), lastHurt: 0, prot: 0, lastHit: {}, lastMed: 0, healing: null, healUntil: 0, streak: 0, air: 0, nades: NADES(), pendingBoom: 0, nextRegen: 0 }); });
  r.players.forEach(p => {
    send(p, {
      t: 'start', mode: r.mode, map: r.map || 0, you: p.id, limit: KILL_LIMIT[r.mode], duration, countdown: COUNTDOWN_MS,
      players: [...r.players.values()].map(q => ({ id: q.id, nick: q.nick, team: q.team, x: q.sp.x, z: q.sp.z, cos: cosOf(q) }))
    });
  });
  broadcastRooms();
}

function endGame(r, reason) {
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
function damage(r, c, v, dmg, hs) {
  const self = c === v; // 자기 수류탄에 맞은 경우
  v.hp -= dmg; v.lastHurt = Date.now();
  if (!self) send(c, { t: 'hitconfirm', hs: !!hs, dmg });
  if (v.hp > 0) return inRoom(r, { t: 'hp', id: v.id, hp: v.hp, by: c.id });
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
  inRoom(r, { t: 'kill', killer: c.id, victim: v.id, hs: !!hs, kills: c.kills, deaths: v.deaths, teamKills: r.teamKills, air: c.air || 0 });
  const limit = r.practice ? 0 : KILL_LIMIT[r.mode]; // 훈련장은 킬 제한 없음 (끝나지 않음)
  if (limit > 0 && (r.mode === 'team' ? Math.max(...r.teamKills) >= limit : c.kills >= limit)) return endGame(r);
  setTimeout(() => {
    if (r.state !== 'play' || !r.players.has(v.id)) return;
    v.hp = MAX_HP; v.alive = true; v.sp = spawnPoint(); v.prot = Date.now() + SPAWN_PROTECT_MS; v.nades = NADES();
    inRoom(r, { t: 'respawn', id: v.id, x: v.sp.x, z: v.sp.z, prot: SPAWN_PROTECT_MS });
  }, RESPAWN_MS);
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
        const mode = m.mode === 'team' ? 'team' : 'ffa';
        const room = { id: nextRoomId++, name: String(m.name || '').slice(0, 20) || (c.nick + '의 방'), mode, map: mapIdx(m.map), host: c.id, state: 'wait', players: new Map(), teamKills: [0, 0] };
        rooms.set(room.id, room); room.players.set(c.id, c); c.room = room; sendRoom(room); break;
      }
      case 'join': {
        if (r) break;
        const room = rooms.get(m.id);
        if (!room) return send(c, { t: 'err', msg: '방이 사라졌어요' });
        if (room.state !== 'wait') return send(c, { t: 'err', msg: '이미 게임이 진행 중이에요' });
        if (room.players.size >= MAX_PLAYERS) return send(c, { t: 'err', msg: '방이 가득 찼어요' });
        room.players.set(c.id, c); c.room = room; sendRoom(room); break;
      }
      case 'leave': leaveRoom(c); send(c, { t: 'rooms', rooms: listRooms() }); break;
      case 'practice': { // 훈련장: 봇 1명과 끝나지 않는 연습 (전적 미반영, 방 목록에 안 나옴)
        if (r) break;
        const bot = { ws: { readyState: 0 }, id: nextId++, nick: '훈련 봇', bot: true, room: null, user: null, guest: true, loadout: [BOT_WEAPON] };
        const room = { id: nextRoomId++, name: '훈련장', mode: 'ffa', practice: true, bot, map: mapIdx(m.map), host: c.id, state: 'play', players: new Map(), teamKills: [0, 0], startAt: Date.now() + COUNTDOWN_MS };
        rooms.set(room.id, room); room.players.set(c.id, c); room.players.set(bot.id, bot); c.room = room;
        [c, bot].forEach(p => Object.assign(p, { team: -1, hp: MAX_HP, kills: 0, deaths: 0, alive: true, state: null, sp: spawnPoint(), lastHurt: 0, prot: 0, lastHit: {}, lastMed: 0, healing: null, healUntil: 0, streak: 0, air: 0, nades: NADES(), pendingBoom: 0, nextRegen: 0 }));
        send(c, { t: 'start', mode: 'ffa', practice: true, bot: bot.id, map: room.map, you: c.id, limit: 0, duration: 0, countdown: COUNTDOWN_MS,
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
      case 'setmap': // 방장이 대기실에서 맵 변경
        if (!r || r.host !== c.id || r.state !== 'wait') break;
        r.map = mapIdx(m.map); sendRoom(r); break;
      case 'start':
        if (!r || r.host !== c.id || r.state !== 'wait') break;
        if (r.players.size < 2) return send(c, { t: 'err', msg: '2명 이상이어야 시작할 수 있어요' });
        startGame(r); break;
      case 'state':
        if (!r || !(r.state === 'play' ? c.alive : Date.now() < (r.outroUntil || 0))) break; // 종료 연출 중에도 위치는 계속 전달
        c.state = { x: +m.x, y: +m.y, z: +m.z, yaw: +m.yaw, pitch: +m.pitch, pr: m.pr ? 1 : 0 }; break;
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
      case 'medkit': { // 구급상자: 체력 50 회복, 쿨타임 40초, 개수 무제한
        if (!r || r.state !== 'play' || !c.alive || c.hp >= MAX_HP || c.healing) break;
        const now = Date.now();
        if (now - (c.lastMed || 0) < MEDKIT_CD_MS) break;
        c.lastMed = now; c.healing = { ticks: MEDKIT_TICKS, next: now + 1000 }; c.healUntil = now + MEDKIT_TICKS * 1000;
        send(c, { t: 'med', cd: MEDKIT_CD_MS, heal: MEDKIT_HEAL, dur: MEDKIT_TICKS * 1000 });
        break;
      }
      case 'shot': // 다른 플레이어에게 사격 이펙트 전달
        if (r && r.state === 'play' && c.alive) r.players.forEach(p => { if (p !== c) send(p, { t: 'shot', id: c.id, from: m.from, to: m.to }); });
        break;
      case 'hit': {
        if (!r || r.state !== 'play' || !c.alive) break;
        const v = r.players.get(m.target);
        if (!v || v === c || !v.alive) break;
        if (r.mode === 'team' && v.team === c.team) break; // 아군 피해 없음
        const w = WEAPONS[m.w];
        if (!w || !(c.loadout || [0, 6]).includes(m.w)) break; // 선택하지 않은 총은 무시
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
    const s = {};
    const now = Date.now();
    r.players.forEach(p => {
      if (p.state) s[p.id] = p.state;
      if (p.healing) { // 구급상자: 1초마다 회복
        if (!p.alive) p.healing = null;
        else if (now >= p.healing.next) {
          p.hp = Math.min(MAX_HP, p.hp + MEDKIT_HEAL / MEDKIT_TICKS); send(p, { t: 'hp', id: p.id, hp: p.hp });
          p.healing.next += 1000; if (--p.healing.ticks <= 0) p.healing = null;
        }
      }
      if (p.alive && p.hp < MAX_HP && now - (p.lastHurt || 0) > REGEN_DELAY_MS && now >= (p.nextRegen || 0)) { p.nextRegen = now + REGEN_STEP_MS; p.hp = Math.min(MAX_HP, p.hp + 1); send(p, { t: 'hp', id: p.id, hp: p.hp }); } // 느린 자동 회복
    });
    inRoom(r, { t: 'states', s });
  });
}, 50);

initStore().catch(e => console.error('MongoDB 연결 실패 → users.json 파일로 계속합니다:', e.message)).finally(() => server.listen(PORT, () => {
  console.log('서버 실행 중: http://localhost:' + PORT);
  const nets = require('os').networkInterfaces();
  for (const k in nets) for (const n of nets[k]) if (n.family === 'IPv4' && !n.internal) console.log('같은 와이파이의 다른 기기: http://' + n.address + ':' + PORT);
}));
