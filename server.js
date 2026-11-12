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
const COUNTDOWN_MS = 3000;   // 시작 카운트다운
const SPAWN_PROTECT_MS = 2000; // 부활 직후 무적
const MEDKIT_CD_MS = 40000;   // 구급상자 쿨타임
const MEDKIT_HEAL = 50;       // 구급상자 총 회복량 (개수 무제한)
const MEDKIT_TICKS = 5;       // 5초 동안 1초마다 10씩 회복, 그동안 다른 행동 불가
const REGEN_DELAY_MS = 5000;   // 마지막 피격 후 체력 회복 시작까지
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
    .map(u => ({ name: u.name, level: levelOf(u.stats.xp), kills: u.stats.kills, deaths: u.stats.deaths, wins: u.stats.wins }));
}
// 터치 버튼 배치(계정에 저장): 알려진 버튼과 숫자 범위만 받아들임
const TB_IDS = ['fire', 'jump', 'reload', 'swap', 'zoom', 'prone', 'joy', 'med'];
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
const statOf = c => (c.user && users[c.user]) ? users[c.user].stats : null;

const send = (c, m) => { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(m)); };
const inRoom = (room, m) => room.players.forEach(p => send(p, m));

function roomInfo(r) {
  return { id: r.id, name: r.name, mode: r.mode, count: r.players.size, max: MAX_PLAYERS, state: r.state };
}
function broadcastRooms() {
  const list = [...rooms.values()].map(roomInfo);
  clients.forEach(c => { if (!c.room) send(c, { t: 'rooms', rooms: list }); });
}
function roomPayload(r) {
  return {
    t: 'room', id: r.id, name: r.name, mode: r.mode, state: r.state, host: r.host, max: MAX_PLAYERS,
    players: [...r.players.values()].map(p => ({ id: p.id, nick: p.nick, level: statOf(p) ? levelOf(statOf(p).xp) : 0 }))
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
  if (r.players.size === 0) { clearTimeout(r.timer); rooms.delete(r.id); }
  else {
    if (r.host === c.id) r.host = r.players.keys().next().value;
    if (r.state === 'play') {
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
  clearTimeout(r.timer);
  const duration = r.mode === 'team' ? TEAM_TIME_MS : 0;
  r.startAt = Date.now() + COUNTDOWN_MS;
  if (duration) r.timer = setTimeout(() => endGame(r), duration + COUNTDOWN_MS);
  list.forEach(p => { Object.assign(p, { hp: 100, kills: 0, deaths: 0, alive: true, state: null, sp: spawnPoint(), lastHurt: 0, prot: 0, lastHit: {}, lastMed: 0, healing: null, healUntil: 0 }); });
  r.players.forEach(p => {
    send(p, {
      t: 'start', mode: r.mode, you: p.id, limit: KILL_LIMIT[r.mode], duration, countdown: COUNTDOWN_MS,
      players: [...r.players.values()].map(q => ({ id: q.id, nick: q.nick, team: q.team, x: q.sp.x, z: q.sp.z }))
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
  inRoom(r, {
    t: 'end', winner, reason: reason || '',
    scores: ps.map(p => ({ nick: p.nick, team: p.team, kills: p.kills, deaths: p.deaths })), teamKills: r.teamKills
  });
  r.players.forEach(p => { p.team = -1; });
  setTimeout(() => { if (rooms.has(r.id)) sendRoom(r); }, 100);
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
    const authOk = (key, token) => { c.user = key; c.guest = false; c.nick = users[key].name; send(c, { t: 'authed', user: users[key].name, token, stats: publicStats(users[key]), layout: users[key].layout || null }); };
    if (!c.user && !c.guest && (m.t === 'create' || m.t === 'join' || m.t === 'start')) return send(c, { t: 'err', msg: '먼저 로그인하거나 게스트로 입장하세요' });
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
      case 'layout': { // 터치 버튼 배치를 계정에 저장 (로그인 유저만)
        if (!c.user || !users[c.user]) break;
        const lay = cleanLayout(m.data);
        if (lay) users[c.user].layout = lay; else delete users[c.user].layout;
        saveUsers(); break;
      }
      case 'lobby': send(c, { t: 'rooms', rooms: [...rooms.values()].map(roomInfo) }); break;
      case 'create': {
        if (r) break;
        const mode = m.mode === 'team' ? 'team' : 'ffa';
        const room = { id: nextRoomId++, name: String(m.name || '').slice(0, 20) || (c.nick + '의 방'), mode, host: c.id, state: 'wait', players: new Map(), teamKills: [0, 0] };
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
      case 'leave': leaveRoom(c); send(c, { t: 'rooms', rooms: [...rooms.values()].map(roomInfo) }); break;
      case 'start':
        if (!r || r.host !== c.id || r.state !== 'wait') break;
        if (r.players.size < 2) return send(c, { t: 'err', msg: '2명 이상이어야 시작할 수 있어요' });
        startGame(r); break;
      case 'state':
        if (!r || r.state !== 'play' || !c.alive) break;
        c.state = { x: +m.x, y: +m.y, z: +m.z, yaw: +m.yaw, pitch: +m.pitch, pr: m.pr ? 1 : 0 }; break;
      case 'medkit': { // 구급상자: 체력 50 회복, 쿨타임 40초, 개수 무제한
        if (!r || r.state !== 'play' || !c.alive || c.hp >= 100 || c.healing) break;
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
        v.hp -= w.dmg * (nb + 2 * nh); v.lastHurt = now;
        send(c, { t: 'hitconfirm', hs: !!m.hs, dmg: w.dmg * (nb + 2 * nh) });
        if (v.hp > 0) { inRoom(r, { t: 'hp', id: v.id, hp: v.hp, by: c.id }); break; }
        v.hp = 0; v.alive = false; v.deaths++; c.kills++; v.healing = null; v.healUntil = 0;
        { const ks = statOf(c), vs = statOf(v);
          if (ks) { ks.kills++; ks.xp += 100; if (m.hs) { ks.hs++; ks.xp += 25; } }
          if (vs) vs.deaths++;
          if (ks || vs) saveUsers(); }
        if (r.mode === 'team') r.teamKills[c.team]++;
        inRoom(r, { t: 'kill', killer: c.id, victim: v.id, hs: !!m.hs, kills: c.kills, deaths: v.deaths, teamKills: r.teamKills });
        const limit = KILL_LIMIT[r.mode];
        const reached = limit > 0 && (r.mode === 'team' ? Math.max(...r.teamKills) >= limit : c.kills >= limit);
        if (reached) { endGame(r); break; }
        setTimeout(() => {
          if (r.state !== 'play' || !r.players.has(v.id)) return;
          v.hp = 100; v.alive = true; v.sp = spawnPoint(); v.prot = Date.now() + SPAWN_PROTECT_MS;
          inRoom(r, { t: 'respawn', id: v.id, x: v.sp.x, z: v.sp.z, prot: SPAWN_PROTECT_MS });
        }, RESPAWN_MS);
        break;
      }
    }
  });
  ws.on('close', () => { leaveRoom(c); clients.delete(c.id); });
});

// 20Hz 위치 동기화
setInterval(() => {
  rooms.forEach(r => {
    if (r.state !== 'play') return;
    const s = {};
    const now = Date.now();
    r.players.forEach(p => {
      if (p.state) s[p.id] = p.state;
      if (p.healing) { // 구급상자: 1초마다 회복
        if (!p.alive) p.healing = null;
        else if (now >= p.healing.next) {
          p.hp = Math.min(100, p.hp + MEDKIT_HEAL / MEDKIT_TICKS); send(p, { t: 'hp', id: p.id, hp: p.hp });
          p.healing.next += 1000; if (--p.healing.ticks <= 0) p.healing = null;
        }
      }
      if (p.alive && p.hp < 100 && now - (p.lastHurt || 0) > REGEN_DELAY_MS) { p.hp = Math.min(100, p.hp + 1); send(p, { t: 'hp', id: p.id, hp: p.hp }); } // 초당 20 회복
    });
    inRoom(r, { t: 'states', s });
  });
}, 50);

initStore().catch(e => console.error('MongoDB 연결 실패 → users.json 파일로 계속합니다:', e.message)).finally(() => server.listen(PORT, () => {
  console.log('서버 실행 중: http://localhost:' + PORT);
  const nets = require('os').networkInterfaces();
  for (const k in nets) for (const n of nets[k]) if (n.family === 'IPv4' && !n.internal) console.log('같은 와이파이의 다른 기기: http://' + n.address + ':' + PORT);
}));
