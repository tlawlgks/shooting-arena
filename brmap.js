// 배틀로얄 섬 생성기 (서버와 브라우저가 같은 시드로 똑같은 섬을 만듦)
// 4km x 4km 지형: 산·언덕(높이맵), 평평하게 다진 마을 터, 건물, 바위, 나무, 아이템 자리, 출발 자리
(function (g) {
  function rng(seed) { // 시드로 항상 같은 난수열
    let a = seed >>> 0 || 1;
    return function () { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  const TOWN_NAMES = ['솔밭', '붉은 지붕', '공업 단지', '강변', '언덕', '중앙 시가지', '기차역', '농장', '항구', '학교', '발전소', '병원', '채석장', '목장', '성당', '군부대',
    '시장', '호숫가', '광산', '공항', '별장', '등대', '폐공장', '온천', '방앗간', '캠프', '연구소', '은행', '교도소', '정유소'];
  const WALLC = [[0xb07a62, 'brick'], [0xc9b79c, 'concrete'], [0xa9a49a, 'concrete'], [0xe0d8c8, 'concrete'], [0x9c6b52, 'brick'], [0x8fa0a8, 'concrete']];
  const ROOFC = [0x5a5f68, 0x7a4a3a, 0x4a5a48, 0x6a6e76, 0x8a3a2a];
  const CONTC = [0xb4532a, 0x2f62b8, 0x2e8050, 0xc9a227, 0x8a3a3a];

  // 높이맵에서 (x, z)의 지면 높이: 화면에 그리는 지형 삼각형과 똑같이 보간 (서버·브라우저 공통)
  function heightAt(D, x, z) {
    const N = D.N, seg = 2 * D.S / N;
    let fx = (x + D.S) / seg, fz = (z + D.S) / seg;
    fx = Math.max(0, Math.min(N - 1e-6, fx)); fz = Math.max(0, Math.min(N - 1e-6, fz));
    const ix = Math.floor(fx), iz = Math.floor(fz), u = fx - ix, v = fz - iz, W = N + 1, H = D.H;
    const a = H[iz * W + ix], b = H[(iz + 1) * W + ix], c = H[(iz + 1) * W + ix + 1], d = H[iz * W + ix + 1];
    return u + v <= 1 ? a + (d - a) * u + (b - a) * v : c + (b - c) * (1 - u) + (d - c) * (1 - v);
  }

  // ===== 랜드마크 건축물 20종: 충돌 상자(서버·화면 공통). 모양은 shooter.html의 LMV가 그림 =====
  // 좌표는 건물 중심 기준(크기 배율 적용 전). C(폭, 높이, 깊이, 바닥높이, 중심x, 중심z)
  const C = (w, h, d, y0 = 0, cx = 0, cz = 0) => [cx - w / 2, cx + w / 2, y0, y0 + h, cz - d / 2, cz + d / 2];
  const LM = [
    { n: '등대', r: 5.5, sc: [0.9, 1.25], col: () => [C(8.4, 1, 8.4), C(6.4, 28, 6.4, 1), C(7.2, 0.3, 7.2, 29), C(4, 3, 4, 29.3), C(4.8, 2.4, 4.8, 32.3)] },
    { n: '풍차', r: 5, sc: [0.9, 1.3], col: () => [C(7.6, 13, 7.6), C(6.6, 3.2, 6.6, 13)] },
    { n: '급수탑', r: 5.5, sc: [0.9, 1.3], col: () => [C(0.8, 14, 0.8, 0, 3, 3), C(0.8, 14, 0.8, 0, -3, 3), C(0.8, 14, 0.8, 0, 3, -3), C(0.8, 14, 0.8, 0, -3, -3), C(9, 5, 9, 14), C(6, 2, 6, 19)] },
    { n: '계단 피라미드', r: 17.5, sc: [1, 1.2], col: () => { const o = []; for (let k = 0; k < 7; k++) { const hs = 16 - 1.8 * k; o.push(C(hs * 2, 2.4, hs * 2, 2.4 * k)); } for (let i = 0; i < 35; i++) o.push([-1.6, 1.6, 0, (i + 1) * 0.48, -17.2 + i * 0.36, -17.2 + (i + 1) * 0.36]); o.push(C(5, 4, 5, 16.8)); return o; } },
    { n: '돔 사원', r: 11.5, sc: [0.9, 1.2], col: () => [C(16, 9, 16), C(12, 2, 12, 9), C(9, 5, 9, 11), C(1.8, 24, 1.8, 0, 10, 10), C(1.8, 24, 1.8, 0, -10, 10), C(1.8, 24, 1.8, 0, 10, -10), C(1.8, 24, 1.8, 0, -10, -10)] },
    { n: '원형 경기장', r: 20, sc: [0.9, 1.15], col: () => { const o = []; for (let i = 0; i < 48; i++) { const a = i / 48 * Math.PI * 2, x = Math.cos(a) * 18, z = Math.sin(a) * 18, gate = i % 12 === 0; o.push(C(2.8, gate ? 9 : 14, 2.8, gate ? 5 : 0, x, z)); } return o; } },
    { n: '송신탑', r: 4.5, sc: [0.85, 1.3], col: () => [C(2.4, 60, 2.4), C(1.2, 1.5, 1.2, 0, 4, 4), C(1.2, 1.5, 1.2, 0, -4, 4), C(1.2, 1.5, 1.2, 0, 4, -4), C(1.2, 1.5, 1.2, 0, -4, -4)] },
    { n: '곡물 사일로', r: 13, sc: [0.9, 1.2], col: () => [C(6.4, 22, 6.4, 0, -7), C(6.4, 22, 6.4, 0, 0), C(6.4, 22, 6.4, 0, 7), C(21, 2, 2.4, 22), C(3.2, 27, 3.2, 0, 12.5)] },
    { n: '고딕 성당', r: 17, sc: [0.9, 1.15], col: () => [C(12, 14, 30, 0, 0, 4), C(9, 5, 30, 14, 0, 4), C(5.4, 30, 5.4, 0, 4.2, -12.5), C(5.4, 30, 5.4, 0, -4.2, -12.5), C(3, 8, 3, 30, 4.2, -12.5), C(3, 8, 3, 30, -4.2, -12.5)] },
    { n: '오층탑', r: 7, sc: [0.9, 1.3], col: () => { const o = []; for (let i = 0; i < 5; i++) { const w = (10 - 1.6 * i) * 0.8; o.push(C(w, 3.2, w, 3.2 * i)); } o.push(C(0.6, 4, 0.6, 16)); return o; } },
    { n: '유리 원통 빌딩', r: 7.5, sc: [0.8, 1.3], col: () => [C(12.4, 70, 12.4), C(9, 4, 9, 70)] },
    { n: '굴뚝 공장', r: 14, sc: [0.9, 1.2], col: () => [C(24, 8, 14), C(3, 40, 3, 0, -8, -9.5), C(3, 40, 3, 0, 6, -9.5)] },
    { n: '관제탑', r: 5.5, sc: [0.9, 1.3], col: () => [C(4.8, 26, 4.8), C(10, 4.5, 10, 26), C(10.6, 0.4, 10.6, 30.5)] },
    { n: '개선 아치', r: 13.5, sc: [0.9, 1.3], col: () => [C(4, 18, 4, 0, -11, 0), C(4, 18, 4, 0, 11, 0), C(26, 8, 4, 18, 0, 0)] },
    { n: '서커스 텐트', r: 10, sc: [0.9, 1.2], col: () => [C(17, 5, 17), C(10, 4, 10, 5), C(4, 3, 4, 9)] },
    { n: '오벨리스크', r: 3.2, sc: [0.9, 1.3], col: () => [C(6, 0.8, 6), C(4.4, 0.8, 4.4, 0.8), C(3, 38, 3, 1.6), C(2, 3, 2, 39.6)] },
    { n: '천문대', r: 6.5, sc: [0.9, 1.3], col: () => [C(12, 7, 12), C(9, 5, 9, 7)] },
    { n: '가스 탱크 단지', r: 13, sc: [0.9, 1.15], col: () => [C(8.4, 13.5, 8.4, 0, -8, 0), C(8.4, 13.5, 8.4, 0, 4, 6.5), C(8.4, 13.5, 8.4, 0, 5, -7)] },
    { n: '풍력발전기', r: 3, sc: [0.85, 1.25], col: () => [C(2.4, 55, 2.4), C(2.6, 2.6, 5, 55, 0, 0.8)] },
    { n: '유리 온실', r: 13.5, sc: [0.9, 1.2], col: () => [C(0.4, 4, 26, 0, 5.8, 0), C(0.4, 4, 26, 0, -5.8, 0), C(12, 0.6, 26, 5.4), C(1.6, 0.8, 22, 0, 2.6, 0), C(1.6, 0.8, 22, 0, -2.6, 0)] },
  ];
  LM.forEach(l => { l.boxes = l.col(); });
  const lmBoxesOf = (t, x, z, base, s) => LM[t].boxes.map(b => [x + b[0] * s, x + b[1] * s, base + b[2] * s, base + b[3] * s, z + b[4] * s, z + b[5] * s].map(v => Math.round(v * 100) / 100));
  // 개인전·팀전: 빈 자리에 랜드마크를 랜덤으로 (모두 같은 시드)
  function genLandmarks(seed, S, occ, count) {
    const R = rng((seed ^ 0x2c1b3c6d) >>> 0), rnd = (a, b) => a + R() * (b - a), types = [...Array(LM.length).keys()];
    for (let i = types.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [types[i], types[j]] = [types[j], types[i]]; }
    const marks = [], boxes = [], placed = [], CS = 8, occG = new Set(); // 이미 있는 건물 칸 (빠른 검사)
    for (const q of occ) if (q.miny < 4) for (let cx = Math.floor(q.minx / CS); cx <= Math.floor(q.maxx / CS); cx++) for (let cz = Math.floor(q.minz / CS); cz <= Math.floor(q.maxz / CS); cz++) occG.add(cx * 1000 + cz);
    const busy = (x0, x1, z0, z1) => { for (let cx = Math.floor(x0 / CS); cx <= Math.floor(x1 / CS); cx++) for (let cz = Math.floor(z0 / CS); cz <= Math.floor(z1 / CS); cz++) if (occG.has(cx * 1000 + cz)) return true; return false; };
    for (const t of types) {
      if (marks.length >= count) break;
      const s = Math.round(rnd(LM[t].sc[0], LM[t].sc[1]) * 100) / 100, rr = LM[t].r * s + 3;
      for (let k = 0; k < 250; k++) {
        const x = rnd(-S + rr + 4, S - rr - 4), z = rnd(-S + rr + 4, S - rr - 4);
        if (busy(x - rr, x + rr, z - rr, z + rr) || placed.some(p => Math.hypot(p[0] - x, p[1] - z) < p[2] + rr + 4)) continue;
        marks.push([t, Math.round(x * 100) / 100, Math.round(z * 100) / 100, 0, s]); boxes.push(...lmBoxesOf(t, x, z, 0, s)); placed.push([x, z, rr]); break;
      }
    }
    return { marks, boxes };
  }

  function genBR(seed) {
    const R = rng(seed), rnd = (a, b) => a + R() * (b - a), ri = (a, b) => Math.floor(a + R() * (b - a + 1)), pick = a => a[Math.floor(R() * a.length)];
    const S = 2000, T = 0.35, SH = 3.2, N = 256; // 섬 반 크기(4km x 4km), 벽 두께, 층 높이, 높이맵 칸 수
    const boxes = [], loot = [], trees = [], rocks = [], towns = [], roads = [], fields = [], spawns = [], foot = [], sites = [];
    const f2 = v => Math.round(v * 100) / 100;
    let BY = 0; // 지금 짓는 건물의 바닥 높이
    const B = (x0, x1, y0, y1, z0, z1, c, k) => { if (x1 - x0 < 0.05 || y1 - y0 < 0.05 || z1 - z0 < 0.05) return; boxes.push([f2(x0), f2(x1), f2(y0 + BY), f2(y1 + BY), f2(z0), f2(z1), c, k]); };
    const addLoot = (x, y, z) => loot.push([f2(x), f2(y + BY), f2(z)]);

    // ---------- 1. 원래 지형 (언덕 + 산) ----------
    const perm = new Uint8Array(512); { const p = [...Array(256).keys()]; for (let i = 255; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; } for (let i = 0; i < 512; i++) perm[i] = p[i & 255]; }
    const hash = (x, z) => perm[(perm[x & 255] + z) & 511] / 255;
    const vnoise = (x, z) => { const xi = Math.floor(x), zi = Math.floor(z), xf = x - xi, zf = z - zi, u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf); return (hash(xi, zi) * (1 - u) + hash(xi + 1, zi) * u) * (1 - v) + (hash(xi, zi + 1) * (1 - u) + hash(xi + 1, zi + 1) * u) * v; };
    const fbm = (x, z) => { let s = 0, a = 0.5, f = 1; for (let o = 0; o < 4; o++) { s += vnoise(x * f, z * f) * a; a *= 0.5; f *= 2.1; } return s; };
    const peaks = []; for (let i = 0; i < 9; i++) peaks.push([rnd(-1600, 1600), rnd(-1600, 1600), rnd(320, 620), rnd(120, 250)]);
    const raw0 = (x, z) => {
      let h = fbm(x / 650 + 3.1, z / 650 + 7.7) * 70 + fbm(x / 170 + 11, z / 170 + 5) * 10 + Math.max(0, fbm(x / 240 + 21, z / 240 + 9) - 0.42) * 90; // 큰 산 + 잔물결 + 곳곳의 언덕
      for (const [px, pz, pr, ph] of peaks) { const d = Math.hypot(x - px, z - pz) / pr; if (d < 2.2) h += ph * Math.exp(-d * d * 2.2); }
      const e = Math.max(0, Math.min(1, (S - Math.max(Math.abs(x), Math.abs(z))) / 380)); // 가장자리는 낮게
      return h * e * e * (3 - 2 * e);
    };
    // 강 2줄기(섬을 가로지르며 산을 만나면 깊은 골짜기를 깎음) + 마른 협곡 2개(산을 가르는 가파른 계곡)
    const cuts = [];
    for (let k = 0; k < 2; k++) {
      const a = rnd(0, 6.283), head = a + Math.PI + rnd(-0.35, 0.35), pts = []; let x = Math.cos(a) * 2150, z = Math.sin(a) * 2150, dir = head;
      for (let i = 0; i < 160; i++) { pts.push([x, z]); dir = dir * 0.85 + head * 0.15 + rnd(-0.5, 0.5); x += Math.cos(dir) * 35; z += Math.sin(dir) * 35; if (i > 10 && (Math.abs(x) > 2150 || Math.abs(z) > 2150)) { pts.push([x, z]); break; } }
      cuts.push({ river: true, w: 14, pts });
    }
    for (let k = 0; k < 2; k++) {
      const p = peaks[k], dir0 = rnd(0, 6.283), pts = []; let x = p[0] - Math.cos(dir0) * 600, z = p[1] - Math.sin(dir0) * 600, dir = dir0;
      for (let i = 0; i < 36; i++) { pts.push([x, z]); dir += rnd(-0.25, 0.25); x += Math.cos(dir) * 35; z += Math.sin(dir) * 35; }
      cuts.push({ river: false, w: 11, pts });
    }
    for (const c of cuts) { let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9; for (const [x, z] of c.pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); } c.bb = [x0 - 260, x1 + 260, z0 - 260, z1 + 260]; }
    const polyDist = (pts, x, z) => { let best = 1e9; for (let i = 1; i < pts.length; i++) { const [ax, az] = pts[i - 1], [bx, bz] = pts[i], dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz; let t = l2 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t; const ex = ax + dx * t - x, ez = az + dz * t - z, d = ex * ex + ez * ez; if (d < best) best = d; } return Math.sqrt(best); };
    const WATER = 1.0; // 물 높이 (강바닥은 그보다 낮음)
    const DN = 128; { const GW = DN + 1, gs = 2 * S / DN; // 강·협곡까지의 거리를 31m 격자에 미리 계산 (빠르게)
      for (const c of cuts) { c.dg = new Float32Array(GW * GW); for (let iz = 0; iz < GW; iz++) for (let ix = 0; ix < GW; ix++) { const x = ix * gs - S, z = iz * gs - S; c.dg[iz * GW + ix] = (x < c.bb[0] || x > c.bb[1] || z < c.bb[2] || z > c.bb[3]) ? 1e4 : polyDist(c.pts, x, z); } } }
    const cutDist = (c, x, z) => { const GW = DN + 1, gs = 2 * S / DN; let fx = (x + S) / gs, fz = (z + S) / gs; fx = Math.max(0, Math.min(DN - 1e-6, fx)); fz = Math.max(0, Math.min(DN - 1e-6, fz)); const ix = fx | 0, iz = fz | 0, u = fx - ix, v = fz - iz, g = c.dg;
      return (g[iz * GW + ix] * (1 - u) + g[iz * GW + ix + 1] * u) * (1 - v) + (g[(iz + 1) * GW + ix] * (1 - u) + g[(iz + 1) * GW + ix + 1] * u) * v; };
    const raw = (x, z) => {
      let h = raw0(x, z);
      for (const c of cuts) {
        if (x < c.bb[0] || x > c.bb[1] || z < c.bb[2] || z > c.bb[3]) continue;
        const d = cutDist(c, x, z), bed = c.river ? -1.2 : Math.max(3, h * 0.25); if (h <= bed) continue;
        const bw = c.river ? 7 + (h - bed) * 0.55 : 4 + (h - bed) * 0.28; // 둑 폭: 높은 곳을 지날수록 깊고 가파른 골짜기
        if (d <= c.w) h = bed; else if (d < c.w + bw) { const t = (d - c.w) / bw, s = t * t * (3 - 2 * t); h = bed * (1 - s) + h * s; }
      }
      return h;
    };
    const slope = (x, z) => Math.max(Math.abs(raw(x + 25, z) - raw(x - 25, z)), Math.abs(raw(x, z + 25) - raw(x, z - 25)));

    // ---------- 2. 마을 터와 외딴집 터 고르기 (낮고 완만한 곳) ----------
    for (let tries = 0; towns.length < 24 && tries < 4000; tries++) {
      const x = rnd(-1700, 1700), z = rnd(-1700, 1700), h = raw(x, z);
      if (h > 75 || h < 3 || slope(x, z) > 9 || towns.some(t => Math.hypot(t[0] - x, t[1] - z) < 520)) continue;
      const r = ri(45, 72); towns.push([f2(x), f2(z), r, TOWN_NAMES[towns.length], f2(h)]); sites.push([x, z, r, 70, h]);
    }
    const lone = [];
    for (let tries = 0; lone.length < 70 && tries < 3000; tries++) {
      const x = rnd(-1800, 1800), z = rnd(-1800, 1800), h = raw(x, z);
      if (h > 110 || h < 3 || slope(x, z) > 7 || towns.some(t => Math.hypot(t[0] - x, t[1] - z) < t[2] + 90) || lone.some(l => Math.hypot(l[0] - x, l[1] - z) < 60)) continue;
      lone.push([x, z, h]); sites.push([x, z, 14, 26, h]);
    }
    // 특수 지형지물 터: 성(언덕 위 가능), 군부대(벙커·참호), 높은 탑
    const tall = [], castles = [], camps = [], spires = [], away = (x, z, d) => !towns.some(t => Math.hypot(t[0] - x, t[1] - z) < t[2] + d) && ![...castles, ...camps, ...spires].some(q => Math.hypot(q[0] - x, q[1] - z) < q[3] + d);
    for (let tries = 0; castles.length < 3 && tries < 3000; tries++) { const x = rnd(-1650, 1650), z = rnd(-1650, 1650), h = raw(x, z); if (h < 6 || h > 190 || slope(x, z) > 16 || !away(x, z, 160)) continue; castles.push([x, z, h, 34]); sites.push([x, z, 34, 45, h]); }
    for (let tries = 0; camps.length < 5 && tries < 3000; tries++) { const x = rnd(-1700, 1700), z = rnd(-1700, 1700), h = raw(x, z); if (h < 4 || h > 120 || slope(x, z) > 9 || !away(x, z, 140)) continue; camps.push([x, z, h, 36]); sites.push([x, z, 36, 40, h]); }
    const lmk = []; // 랜드마크 20종 터 (종류마다 1개)
    for (let t = 0; t < LM.length; t++) { const s = Math.round(rnd(LM[t].sc[0], LM[t].sc[1]) * 100) / 100, rr = LM[t].r * s + 4;
      for (let tries = 0; tries < 600; tries++) { const x = rnd(-1750, 1750), z = rnd(-1750, 1750); if (!away(x, z, rr + 60) || lmk.some(q => Math.hypot(q[1] - x, q[2] - z) < q[5] + rr + 60)) continue; const h = raw(x, z); if (h < 4 || h > 160 || slope(x, z) > 11) continue;
        lmk.push([t, x, z, h, s, rr]); sites.push([x, z, rr, 30, h]); break; } }
    for (let tries = 0; spires.length < 9 && tries < 3000; tries++) { const x = rnd(-1750, 1750), z = rnd(-1750, 1750), h = raw(x, z); if (h < 4 || h > 220 || slope(x, z) > 14 || !away(x, z, 70)) continue; spires.push([x, z, h, 9]); sites.push([x, z, 9, 22, h]); }

    // ---------- 3. 높이맵 (터는 평평하게 다지고 주변과 부드럽게 이음) ----------
    const W = N + 1, seg = 2 * S / N, H = new Float32Array(W * W);
    for (let iz = 0; iz < W; iz++) for (let ix = 0; ix < W; ix++) {
      const x = ix * seg - S, z = iz * seg - S; let h = raw(x, z);
      for (let si = 0; si < sites.length; si++) {
        const st = sites[si], sr = st[2], fall = st[3], base = st[4], fr = sr + seg * 1.6, reach = fr + fall, dx = x - st[0], dz = z - st[1];
        if (dx > reach || dx < -reach || dz > reach || dz < -reach) continue; // 멀면 바로 건너뜀
        const d = Math.sqrt(dx * dx + dz * dz); if (d >= reach) continue; // 높이맵 칸 크기만큼 더 넓게 평평하게 (건물 바닥이 기울지 않게)
        if (d <= fr) h = base; else { const t = (d - fr) / fall, s = t * t * (3 - 2 * t); h = base * (1 - s) + h * s; }
      }
      H[iz * W + ix] = f2(h);
    }
    const D = { S, N, H };
    const hAt = (x, z) => heightAt(D, x, z);
    const fits = (x0, x1, z0, z1, pad) => {
      if (x0 < -S + 20 || x1 > S - 20 || z0 < -S + 20 || z1 > S - 20) return false;
      for (const f of foot) if (x0 - pad < f[1] && x1 + pad > f[0] && z0 - pad < f[3] && z1 + pad > f[2]) return false;
      return true;
    };
    const onRoad = (x0, x1, z0, z1) => roads.some(r => x0 < r[1] && x1 > r[0] && z0 < r[3] && z1 > r[2]);

    // ---------- 4. 건물 부품 ----------
    function wall(alongX, fixed, a, b, base, h, opens, c, k) {
      const seg2 = (p0, p1, y0, y1) => alongX ? B(p0, p1, base + y0, base + y1, fixed - T / 2, fixed + T / 2, c, k) : B(fixed - T / 2, fixed + T / 2, base + y0, base + y1, p0, p1, c, k);
      opens.sort((u, v) => u[0] - v[0]); let cur = a;
      for (const [o0, o1, y0, y1] of opens) { if (o0 > cur) seg2(cur, o0, 0, h); if (y0 > 0) seg2(o0, o1, 0, y0); if (y1 < h) seg2(o0, o1, y1, h); cur = o1; }
      if (cur < b) seg2(cur, b, 0, h);
    }
    function openings(a, b, door) {
      const L = b - a, res = []; if (L < 3) return res;
      if (door) { const c = rnd(a + 1.4, b - 1.4); res.push([c - 0.8, c + 0.8, 0, 2.3]); }
      const nWin = Math.floor(L / 4.5);
      for (let i = 0; i < nWin; i++) { const c = a + (i + 0.5) * L / nWin; if (res.some(o => c + 0.7 > o[0] - 0.4 && c - 0.7 < o[1] + 0.4)) continue; res.push([c - 0.7, c + 0.7, 1.1, 2.3]); }
      return res;
    }
    function house(cx, cz, w, d, stories) {
      const x0 = cx - w / 2, x1 = cx + w / 2, z0 = cz - d / 2, z1 = cz + d / 2, [c, k] = pick(WALLC), roof = pick(ROOFC);
      foot.push([x0, x1, z0, z1]);
      const doorSides = [0, 1, 2, 3].filter(() => R() < 0.45); if (!doorSides.length) doorSides.push(ri(0, 3));
      for (let s = 0; s < stories; s++) {
        const base = s * SH, door = i => s === 0 && doorSides.includes(i);
        wall(true, z0 + T / 2, x0, x1, base, SH, openings(x0, x1, door(0)), c, k);
        wall(true, z1 - T / 2, x0, x1, base, SH, openings(x0, x1, door(1)), c, k);
        wall(false, x0 + T / 2, z0 + T, z1 - T, base, SH, openings(z0 + T, z1 - T, door(2)), c, k);
        wall(false, x1 - T / 2, z0 + T, z1 - T, base, SH, openings(z0 + T, z1 - T, door(3)), c, k);
      }
      let lx0 = x0 + T + 0.7;
      if (stories === 2) {
        const sw = 1.3, run = 0.72, n = 7, rise = SH / n, sx0 = x0 + T, sx1 = sx0 + sw, sz0 = z0 + T + 1.1, sz1 = sz0 + run * n;
        for (let i = 0; i < n; i++) B(sx0, sx1, 0, (i + 1) * rise, sz0 + i * run, sz0 + (i + 1) * run, 0x9a9890, 'concrete');
        B(sx1, x1 - T, SH - 0.25, SH, z0 + T, z1 - T, 0x8a8478, 'wood');
        B(sx0, sx1, SH - 0.25, SH, sz1, z1 - T, 0x8a8478, 'wood');
        for (let i = 0; i < 2; i++) addLoot(rnd(sx1 + 0.8, x1 - T - 0.6), SH, rnd(z0 + T + 0.6, z1 - T - 0.6));
        lx0 = sx1 + 0.8;
      }
      B(x0 - 0.2, x1 + 0.2, stories * SH, stories * SH + 0.3, z0 - 0.2, z1 + 0.2, roof, 'roof');
      if (stories === 1 && w > 10.5) wall(false, cx + rnd(-1, 1), z0 + T, z1 - T, 0, SH, [[cz - 0.8, cz + 0.8, 0, 2.3]], c, k);
      for (let i = stories === 2 ? 1 : ri(2, 3); i > 0; i--) addLoot(rnd(lx0, x1 - T - 0.7), 0, rnd(z0 + T + 0.7, z1 - T - 0.7));
    }
    function warehouse(cx, cz, w, d) {
      const x0 = cx - w / 2, x1 = cx + w / 2, z0 = cz - d / 2, z1 = cz + d / 2, Hh = 5.5, c = pick([0x8a9aa8, 0x9aa3ad, 0x7d8b78, 0xa89a7a]);
      foot.push([x0, x1, z0, z1]);
      const big = (a, b) => { const m = rnd(a + 3, b - 3); return [[m - 2, m + 2, 0, 4]]; };
      wall(true, z0 + T / 2, x0, x1, 0, Hh, R() < 0.6 ? big(x0, x1) : openings(x0, x1, true), c, 'metal');
      wall(true, z1 - T / 2, x0, x1, 0, Hh, R() < 0.6 ? big(x0, x1) : openings(x0, x1, false), c, 'metal');
      wall(false, x0 + T / 2, z0 + T, z1 - T, 0, Hh, openings(z0 + T, z1 - T, R() < 0.5), c, 'metal');
      wall(false, x1 - T / 2, z0 + T, z1 - T, 0, Hh, openings(z0 + T, z1 - T, R() < 0.5), c, 'metal');
      B(x0 - 0.3, x1 + 0.3, Hh, Hh + 0.35, z0 - 0.3, z1 + 0.3, 0x5a646e, 'roof');
      for (let i = ri(3, 6); i > 0; i--) { const s = rnd(1.2, 2), hx = rnd(x0 + 2, x1 - 2), hz = rnd(z0 + 2, z1 - 2); B(hx - s / 2, hx + s / 2, 0, rnd(1, 2.2), hz - s / 2, hz + s / 2, 0xb48c58, 'wood'); }
      for (let i = ri(3, 5); i > 0; i--) addLoot(rnd(x0 + 1.2, x1 - 1.2), 0, rnd(z0 + 1.2, z1 - 1.2));
    }
    function tower(cx, cz) {
      const s = 4, h = 6, n = 12, run = 0.9, x0 = cx - s / 2, x1 = cx + s / 2, z0 = cz - s / 2, z1 = cz + s / 2;
      if (!fits(x0, x1, z0, z1 + n * run, 3) || onRoad(x0, x1, z0, z1 + n * run)) return;
      foot.push([x0, x1, z0, z1 + n * run]);
      B(x0, x1, 0, h, z0, z1, 0x7a6a55, 'wood');
      for (let i = 0; i < n; i++) B(cx - 0.8, cx + 0.8, 0, (i + 1) * h / n, z1 + (n - 1 - i) * run, z1 + (n - i) * run, 0x8a8478, 'wood');
      B(x0, x1, h, h + 1, z0, z0 + 0.3, 0x6a5a45, 'wood'); B(x0, x0 + 0.3, h, h + 1, z0, z1, 0x6a5a45, 'wood'); B(x1 - 0.3, x1, h, h + 1, z0, z1, 0x6a5a45, 'wood');
      addLoot(cx - 0.8, h, cz - 0.6); addLoot(cx + 0.8, h, cz - 0.4);
    }
    function containers(cx, cz) {
      const along = R() < 0.5;
      for (let i = ri(2, 4) - 1; i >= 0; i--) {
        const x = cx + (along ? 0 : i * 3.4), z = cz + (along ? i * 3.4 : 0), w = along ? 12 : 2.6, d = along ? 2.6 : 12;
        if (!fits(x - w / 2, x + w / 2, z - d / 2, z + d / 2, 1) || onRoad(x - w / 2, x + w / 2, z - d / 2, z + d / 2)) continue;
        foot.push([x - w / 2, x + w / 2, z - d / 2, z + d / 2]);
        B(x - w / 2, x + w / 2, 0, 2.6, z - d / 2, z + d / 2, pick(CONTC), 'metal');
        if (R() < 0.35) B(x - w / 2, x + w / 2, 2.6, 5.2, z - d / 2, z + d / 2, pick(CONTC), 'metal');
        addLoot(x + (along ? rnd(-4, 4) : 1.9), 0, z + (along ? 1.9 : rnd(-4, 4)));
      }
    }
    function spire(cx, cz) { // 높은 건물: 높이 10~100m 랜덤, 층마다 계단(지그재그)으로 옥상까지 올라감
      const hTot = rnd(10, 100), NF = Math.max(2, Math.round(hTot / 4)), FH = hTot / NF, s = 7.2 + Math.min(4.8, hTot * 0.05), x0 = cx - s / 2, x1 = cx + s / 2, z0 = cz - s / 2, z1 = cz + s / 2, c = pick([0x9a958a, 0xa89a82, 0x8a8d90]), k = 'concrete';
      foot.push([x0, x1, z0, z1]); tall.push([f2(cx), f2(cz), f2(s), NF, f2(FH), f2(BY)]);
      for (let f = 0; f < NF; f++) {
        const base = f * FH, door = i => f === 0 && i === 0;
        wall(true, z0 + T / 2, x0, x1, base, FH, openings(x0, x1, door(0)), c, k); wall(true, z1 - T / 2, x0, x1, base, FH, openings(x0, x1, false), c, k);
        wall(false, x0 + T / 2, z0 + T, z1 - T, base, FH, openings(z0 + T, z1 - T, false), c, k); wall(false, x1 - T / 2, z0 + T, z1 - T, base, FH, openings(z0 + T, z1 - T, false), c, k);
        const n = 8, rise = FH / n, run = 0.68, sw = 1.3, west = f % 2 === 0;
        const sx0 = west ? x0 + T : x1 - T - sw, sx1 = sx0 + sw, sStart = west ? z0 + T + 1.2 : z1 - T - 1.2;
        for (let i = 0; i < n; i++) { const a = west ? sStart + i * run : sStart - (i + 1) * run; B(sx0, sx1, base, base + (i + 1) * rise, a, a + run, 0x8a8478, 'concrete'); }
        const L = base + FH, sEnd = west ? sStart + n * run : sStart - n * run; // 위층 바닥 (올라오는 계단 자리는 비움)
        if (west) { B(sx1, x1 - T, L - 0.25, L, z0 + T, z1 - T, 0x7a7468, 'wood'); B(sx0, sx1, L - 0.25, L, sEnd, z1 - T, 0x7a7468, 'wood'); }
        else { B(x0 + T, sx0, L - 0.25, L, z0 + T, z1 - T, 0x7a7468, 'wood'); B(sx0, sx1, L - 0.25, L, z0 + T, sEnd, 0x7a7468, 'wood'); }
        if (NF <= 6 || f % 3 === 0) addLoot(west ? rnd(sx1 + 0.7, x1 - T - 0.7) : rnd(x0 + T + 0.7, sx0 - 0.7), base, rnd(z0 + T + 0.8, z1 - T - 0.8)); // 높은 건물은 3층마다
      }
      const top = NF * FH; // 옥상 난간 (총을 쏠 수 있는 높이)
      B(x0 - 0.2, x1 + 0.2, top, top + 1.1, z0 - 0.2, z0 + 0.2, c, k); B(x0 - 0.2, x1 + 0.2, top, top + 1.1, z1 - 0.2, z1 + 0.2, c, k);
      B(x0 - 0.2, x0 + 0.2, top, top + 1.1, z0 + 0.2, z1 - 0.2, c, k); B(x1 - 0.2, x1 + 0.2, top, top + 1.1, z0 + 0.2, z1 - 0.2, c, k);
      addLoot(cx - 1.2, top, cz); addLoot(cx + 1.2, top, cz - 1);
    }
    function castle(cx, cz) { // 성: 두꺼운 성벽(위를 걸을 수 있음) + 성문 + 모서리 망루 + 가운데 높은 탑
      const W2 = 22, t = 1.7, H = 7, x0 = cx - W2, x1 = cx + W2, z0 = cz - W2, z1 = cz + W2, c = 0xa49c8c, k = 'concrete', gw = 2.5;
      foot.push([x0 - 4, x1 + 4, z0 - 4, z1 + 4]);
      B(x0, x1, 0, H, z1 - t, z1, c, k); B(x0, x0 + t, 0, H, z0 + t, z1 - t, c, k); B(x1 - t, x1, 0, H, z0 + t, z1 - t, c, k);
      B(x0, cx - gw, 0, H, z0, z0 + t, c, k); B(cx + gw, x1, 0, H, z0, z0 + t, c, k); B(cx - gw, cx + gw, 4.6, H, z0, z0 + t, c, k); // 남쪽 성문
      for (const [a0, a1, b0, b1] of [[x0, x1, z1 - 0.45, z1], [x0, x1, z0, z0 + 0.45], [x0, x0 + 0.45, z0, z1], [x1 - 0.45, x1, z0, z1]]) // 바깥쪽 난간 (톱니 모양)
        for (let p = 0; p < 1; p += 0.0625) { const ax = a0 + (a1 - a0) * p, bx = a0 + (a1 - a0) * (p + 0.035), az = b0 + (b1 - b0) * p, bz = b0 + (b1 - b0) * (p + 0.035); if (a1 - a0 > b1 - b0) B(ax, bx, H, H + 1.2, b0, b1, c, k); else B(a0, a1, H, H + 1.2, az, bz, c, k); }
      for (const [tx, tz] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) { B(tx - 3.5, tx + 3.5, 0, 11, tz - 3.5, tz + 3.5, 0x968e80, 'brick'); B(tx - 3.5, tx + 3.5, 11, 12.2, tz - 3.5, tz - 2.9, 0x968e80, 'brick'); B(tx - 3.5, tx + 3.5, 11, 12.2, tz + 2.9, tz + 3.5, 0x968e80, 'brick'); }
      const n = 14, rise = H / n, run = 0.8; // 성벽 위로 오르는 계단 2곳
      for (let i = 0; i < n; i++) { B(x0 + 6 + i * run, x0 + 6 + (i + 1) * run, 0, (i + 1) * rise, z1 - t - 1.5, z1 - t, 0x8a8478, k); B(x1 - 6 - (i + 1) * run, x1 - 6 - i * run, 0, (i + 1) * rise, z0 + t, z0 + t + 1.5, 0x8a8478, k); }
      spire(cx, cz + 4);
      for (let i = 0; i < 4; i++) { const hx = cx + rnd(-15, 15), hz = cz + rnd(-15, -6), s2 = rnd(1.2, 1.8); B(hx - s2 / 2, hx + s2 / 2, 0, rnd(1, 1.8), hz - s2 / 2, hz + s2 / 2, 0xb48c58, 'wood'); }
      for (let i = 0; i < 4; i++) addLoot(cx + rnd(-17, 17), 0, cz + rnd(-17, 17));
      addLoot(x0 + 3, H, z1 - 0.9); addLoot(x1 - 3, H, z0 + 0.9);
    }
    function bunker(cx, cz) { // 벙커: 두꺼운 콘크리트, 사격용 가로 틈, 입구 하나
      const al = R() < 0.5, w = al ? 9 : 6.5, d = al ? 6.5 : 9, x0 = cx - w / 2, x1 = cx + w / 2, z0 = cz - d / 2, z1 = cz + d / 2, t = 0.6, H = 2.5, c = 0x80847c, k = 'concrete';
      if (!fits(x0, x1, z0, z1, 2) || onRoad(x0, x1, z0, z1)) return; foot.push([x0, x1, z0, z1]);
      const side = (a0, a1, b0, b1, door) => { // 낮은 벽 + 틈 + 위쪽 벽
        if (door) { const m = (a0 + a1) / 2; for (const [p0, p1] of [[a0, m - 0.8], [m + 0.8, a1]]) { B(p0, p1, 0, H, b0, b1, c, k); } B(m - 0.8, m + 0.8, 2.1, H, b0, b1, c, k); }
        else { B(a0, a1, 0, 1.45, b0, b1, c, k); B(a0, a1, 1.8, H, b0, b1, c, k); B(a0, a0 + 0.5, 1.45, 1.8, b0, b1, c, k); B(a1 - 0.5, a1, 1.45, 1.8, b0, b1, c, k); }
      };
      side(x0, x1, z0, z0 + t, true); side(x0, x1, z1 - t, z1, false);
      const sz = (a0, a1, b0, b1) => { B(b0, b1, 0, 1.45, a0, a1, c, k); B(b0, b1, 1.8, H, a0, a1, c, k); B(b0, b1, 1.45, 1.8, a0, a0 + 0.5, c, k); B(b0, b1, 1.45, 1.8, a1 - 0.5, a1, c, k); };
      sz(z0 + t, z1 - t, x0, x0 + t); sz(z0 + t, z1 - t, x1 - t, x1);
      B(x0 - 0.3, x1 + 0.3, H, H + 0.6, z0 - 0.3, z1 + 0.3, 0x74786f, k); B(x0, x1, H + 0.6, H + 1.1, z1 - 0.6, z1, 0xc2b08a, 'sandbag'); // 두꺼운 지붕 + 모래주머니
      addLoot(cx - 1.5, 0, cz); addLoot(cx + 1.5, 0, cz + 1);
    }
    function trench(x, z, len, alongX) { // 참호: 흙·모래주머니 벽 사이 좁은 통로 (중간중간 꺾인 방호벽)
      const hw = 0.95, wt = 0.7, hh = 1.3, c = 0x7a6448, k = 'sandbag';
      const x0 = alongX ? x - len / 2 : x - hw - wt, x1 = alongX ? x + len / 2 : x + hw + wt, z0 = alongX ? z - hw - wt : z - len / 2, z1 = alongX ? z + hw + wt : z + len / 2;
      if (!fits(x0, x1, z0, z1, 1.5) || onRoad(x0, x1, z0, z1)) return; foot.push([x0, x1, z0, z1]);
      if (alongX) { B(x0, x1, 0, hh, z - hw - wt, z - hw, c, k); B(x0, x1, 0, hh, z + hw, z + hw + wt, c, k); for (let p = x0 + 7; p < x1 - 3; p += 7) B(p, p + 0.7, 0, hh, z - hw, z - hw + 0.8, c, k); }
      else { B(x - hw - wt, x - hw, 0, hh, z0, z1, c, k); B(x + hw, x + hw + wt, 0, hh, z0, z1, c, k); for (let p = z0 + 7; p < z1 - 3; p += 7) B(x - hw, x - hw + 0.8, 0, hh, p, p + 0.7, c, k); }
      addLoot(alongX ? x + rnd(-len / 3, len / 3) : x, 0, alongX ? z : z + rnd(-len / 3, len / 3));
    }
    function camp(cx, cz) { // 군부대: 벙커 2~3개, 참호선, 망루, 모래주머니
      for (let i = 0; i < 3; i++) bunker(cx + rnd(-24, 24), cz + rnd(-24, 24));
      for (let i = 0; i < 3; i++) { const al = R() < 0.5; trench(cx + rnd(-26, 26), cz + rnd(-26, 26), rnd(18, 32), al); }
      tower(cx + rnd(-20, 20), cz + rnd(-20, 20));
      for (let i = 0; i < 4; i++) cover(cx + rnd(-28, 28), cz + rnd(-28, 28));
      if (R() < 0.6) containers(cx + rnd(-18, 18), cz + rnd(-18, 18));
    }
    const cover = (x, z) => { const al = R() < 0.5, hw = rnd(1.5, 3), x0 = al ? x - hw : x - 0.3, x1 = al ? x + hw : x + 0.3, z0 = al ? z - 0.3 : z - hw, z1 = al ? z + 0.3 : z + hw;
      if (!fits(x0, x1, z0, z1, 1.5) || onRoad(x0, x1, z0, z1)) return; foot.push([x0, x1, z0, z1]); const sb = R() < 0.6; B(x0, x1, 0, 1.1, z0, z1, sb ? 0xc2b08a : 0xb5b5b0, sb ? 'sandbag' : 'concrete'); if (R() < 0.35) addLoot(al ? x : x + 1.2, 0, al ? z + 1.2 : z); };

    // ---------- 5. 도로 (색만, 마을을 차례로 이음) ----------
    const RW = 4, road = (x0, z0, x1, z1) => {
      if (Math.abs(z1 - z0) < 0.1) roads.push([f2(Math.min(x0, x1) - RW), f2(Math.max(x0, x1) + RW), f2(z0 - RW), f2(z0 + RW)]);
      else roads.push([f2(x0 - RW), f2(x0 + RW), f2(Math.min(z0, z1) - RW), f2(Math.max(z0, z1) + RW)]);
    };
    const ord = towns.slice().sort((a, b) => Math.atan2(a[1], a[0]) - Math.atan2(b[1], b[0]));
    for (let i = 0; i < ord.length; i++) { const a = ord[i], b = ord[(i + 1) % ord.length]; road(a[0], a[1], b[0], a[1]); road(b[0], a[1], b[0], b[1]); }

    // ---------- 6. 마을 건물 ----------
    const building = (x, z, type, base) => {
      let w, d;
      if (type === 'wh') { w = rnd(16, 24); d = rnd(12, 16); } else if (type === 'h2') { w = rnd(8, 11); d = rnd(8.5, 11); } else { w = rnd(7, 12); d = rnd(6.5, 10); }
      if (R() < 0.5) [w, d] = [d, w];
      const x0 = x - w / 2, x1 = x + w / 2, z0 = z - d / 2, z1 = z + d / 2;
      if (!fits(x0, x1, z0, z1, 3) || onRoad(x0 - 1, x1 + 1, z0 - 1, z1 + 1)) return false;
      BY = base; if (type === 'wh') warehouse(x, z, w, d); else house(x, z, w, d, type === 'h2' ? 2 : 1); BY = 0;
      return true;
    };
    for (const t of towns) {
      const [tx, tz, tr, name, base] = t, ind = /공업|발전소|정유소|폐공장|광산|채석장/.test(name);
      for (let a = 0; a < 22; a++) { const ang = R() * 6.283, dist = R() * (tr - 11); building(tx + Math.cos(ang) * dist, tz + Math.sin(ang) * dist, ind ? (R() < 0.6 ? 'wh' : 'h1') : (R() < 0.62 ? 'h1' : R() < 0.7 ? 'h2' : 'wh'), base); }
      BY = base;
      for (let i = 0; i < 5; i++) { const ang = R() * 6.283, dist = rnd(4, tr - 4); cover(tx + Math.cos(ang) * dist, tz + Math.sin(ang) * dist); }
      if (R() < 0.5) { const ang = R() * 6.283, dist = rnd(10, tr - 14); containers(tx + Math.cos(ang) * dist, tz + Math.sin(ang) * dist); }
      if (R() < 0.4) { const ang = R() * 6.283, dist = rnd(10, tr - 12); tower(tx + Math.cos(ang) * dist, tz + Math.sin(ang) * dist); }
      BY = 0;
      for (let i = 0; i < 9; i++) { const ang = R() * 6.283, dist = rnd(tr * 0.3, tr + 40), x = tx + Math.cos(ang) * dist, z = tz + Math.sin(ang) * dist; if (fits(x - 0.6, x + 0.6, z - 0.6, z + 0.6, 1.2)) spawns.push([f2(x), f2(z)]); }
    }
    for (const [x, z, base] of lone) building(x, z, R() < 0.7 ? 'h1' : 'h2', base); // 외딴집
    const lmBoxes = [], marks = [];
    for (const [t, x, z, h, s, rr] of lmk) { // 랜드마크: 충돌 상자 + 주변 아이템
      lmBoxes.push(...lmBoxesOf(t, x, z, h, s)); marks.push([t, f2(x), f2(z), f2(h), s]); foot.push([x - rr, x + rr, z - rr, z + rr]);
      for (let i = 0; i < 3; i++) { const a = R() * 6.283; loot.push([f2(x + Math.cos(a) * (rr - 1)), f2(h), f2(z + Math.sin(a) * (rr - 1))]); }
      if (t === 3) { loot.push([f2(x - 1), f2(h + 16.8 * s), f2(z - 1.8 * s)]); loot.push([f2(x + 1), f2(h + 16.8 * s), f2(z - 1.8 * s)]); } // 피라미드 꼭대기
    }
    for (const [x, z, h] of castles) { BY = h; castle(x, z); BY = 0; } // 성
    for (const [x, z, h] of camps) { BY = h; camp(x, z); BY = 0; }     // 군부대
    for (const [x, z, h] of spires) { BY = h; if (fits(x - 6.5, x + 6.5, z - 6.5, z + 6.5, 2)) spire(x, z); BY = 0; } // 높은 건물
    for (const t of towns) for (let k = 0; k < 2; k++) { BY = t[4]; const a = R() * 6.283, d = rnd(10, t[2] - 10), x = t[0] + Math.cos(a) * d, z = t[1] + Math.sin(a) * d; if (fits(x - 6.5, x + 6.5, z - 6.5, z + 6.5, 3) && !onRoad(x - 7, x + 7, z - 7, z + 7)) spire(x, z); BY = 0; } // 마을마다 높은 빌딩 최대 2채

    // ---------- 7. 바위, 나무, 밭 ----------
    for (let a = 0; a < 500 && rocks.length < 260; a++) {
      const x = rnd(-1900, 1900), z = rnd(-1900, 1900), w = rnd(2.5, 8), d = rnd(2.5, 7), h = rnd(1.2, 4.5);
      if (!fits(x - w / 2, x + w / 2, z - d / 2, z + d / 2, 2) || onRoad(x - w / 2, x + w / 2, z - d / 2, z + d / 2)) continue;
      foot.push([x - w / 2, x + w / 2, z - d / 2, z + d / 2]); rocks.push([f2(x), f2(z), f2(w), f2(d), f2(h), f2(hAt(x, z) - 0.3)]);
    }
    for (let a = 0; a < 9000 && trees.length < 3200; a++) {
      const x = rnd(-1940, 1940), z = rnd(-1940, 1940), y = hAt(x, z);
      if (y > 175 || y < 2.2 || towns.some(t => Math.hypot(t[0] - x, t[1] - z) < t[2] * 0.85) || onRoad(x - 1, x + 1, z - 1, z + 1) || !fits(x - 0.5, x + 0.5, z - 0.5, z + 0.5, 1)) continue;
      trees.push([f2(x), f2(z), R() < (y > 90 ? 0.75 : 0.35) ? 0 : 1, f2(y - 0.2)]); // 높은 곳일수록 소나무
    }
    for (let i = 0; i < 60; i++) fields.push([f2(rnd(-1850, 1850)), f2(rnd(-1850, 1850)), ri(40, 110), R() < 0.6 ? 'dirt' : 'sand']);
    // ---------- 8. 차량: 도로 위 (마을 근처 양 끝 + 가운데) ----------
    const vehicles = [];
    for (const rd of roads) {
      const ax = rd[1] - rd[0] > rd[3] - rd[2], L = ax ? rd[1] - rd[0] : rd[3] - rd[2]; if (L < 40) continue;
      for (const t of [0.1, 0.5, 0.9]) {
        if (R() > (t === 0.5 ? 0.45 : 0.65)) continue;
        const off = R() < 0.5 ? -1.8 : 1.8, x = ax ? rd[0] + L * t : (rd[0] + rd[1]) / 2 + off, z = ax ? (rd[2] + rd[3]) / 2 + off : rd[2] + L * t;
        if (Math.abs(x) > S - 30 || Math.abs(z) > S - 30 || vehicles.some(v => Math.hypot(v[0] - x, v[1] - z) < 12)) continue;
        vehicles.push([f2(x), f2(z), f2((ax ? Math.PI / 2 : 0) + (R() < 0.5 ? Math.PI : 0)), R() < 0.6 ? 'jeep' : 'buggy']);
      }
    }
    return { S, N, H, boxes, loot, trees, rocks, towns, roads, fields, spawns, peaks, vehicles, tall, marks, lmBoxes, water: WATER, castles: castles.map(c => [f2(c[0]), f2(c[1])]), camps: camps.map(c => [f2(c[0]), f2(c[1])]) };
  }
  // 개인전·팀전 지형: 강 · 좁은 협곡 · 낮은 언덕 (산은 없음). 건물 밑과 주변은 평평하게 둠
  function genArenaTerrain(seed, S, occ) {
    const R = rng((seed ^ 0x5bd1e995) >>> 0), rnd = (a, b) => a + R() * (b - a), N = 128, W = N + 1, seg = 2 * S / N, H = new Float32Array(W * W);
    const dist = new Float32Array(W * W).fill(1e9); // 건물까지 거리 (칸 단위)
    for (const q of occ) { if (q.miny > 0.5) continue; for (let iz = Math.max(0, Math.floor((q.minz + S) / seg)); iz <= Math.min(N, Math.ceil((q.maxz + S) / seg)); iz++) for (let ix = Math.max(0, Math.floor((q.minx + S) / seg)); ix <= Math.min(N, Math.ceil((q.maxx + S) / seg)); ix++) dist[iz * W + ix] = 0; }
    for (let pass = 0; pass < 2; pass++) for (let k = 0; k < W * W; k++) { const i = pass ? W * W - 1 - k : k, ix = i % W, iz = (i / W) | 0, s = pass ? 1 : -1; let d = dist[i];
      for (const [dx, dz, c] of [[s, 0, 1], [0, s, 1], [s, s, 1.414], [-s, s, 1.414]]) { const x = ix + dx, z = iz + dz; if (x >= 0 && x < W && z >= 0 && z < W) d = Math.min(d, dist[z * W + x] + c); } dist[i] = d; }
    const hills = []; for (let i = 0; i < 14; i++) hills.push([rnd(-S + 20, S - 20), rnd(-S + 20, S - 20), rnd(12, 32), rnd(1.5, 4.5)]);
    const line = (n, step, x, z, dir, wob) => { const p = []; for (let i = 0; i < n; i++) { p.push([x, z]); dir += rnd(-wob, wob); x += Math.cos(dir) * step; z += Math.sin(dir) * step; } return p; };
    const a = rnd(0, 6.283), cuts = [
      { pts: line(36, 14, Math.cos(a) * (S + 10), Math.sin(a) * (S + 10), a + Math.PI + rnd(-0.3, 0.3), 0.35), w: 4.5, bed: -1.8, bank: 4.5 }, // 강
      { pts: line(11, 13, rnd(-S * 0.6, S * 0.6), rnd(-S * 0.6, S * 0.6), rnd(0, 6.283), 0.3), w: 2.6, bed: -5, bank: 1.6 },              // 좁은 협곡 (깊고 가파름)
    ];
    const pd = (pts, x, z) => { let best = 1e9; for (let i = 1; i < pts.length; i++) { const [ax, az] = pts[i - 1], [bx, bz] = pts[i], dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz; let t = l2 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t; const ex = ax + dx * t - x, ez = az + dz * t - z; best = Math.min(best, ex * ex + ez * ez); } return Math.sqrt(best); };
    for (let iz = 0; iz < W; iz++) for (let ix = 0; ix < W; ix++) {
      const x = ix * seg - S, z = iz * seg - S; let h = 0;
      for (const [hx, hz, hr, hh] of hills) { const d = Math.hypot(x - hx, z - hz) / hr; if (d < 2) h += hh * Math.exp(-d * d * 2); }
      for (const c of cuts) { const d = pd(c.pts, x, z); if (d <= c.w) h = Math.min(h, c.bed); else if (d < c.w + c.bank) { const t = (d - c.w) / c.bank, s = t * t * (3 - 2 * t); h = Math.min(h, c.bed * (1 - s) + h * s); } }
      const db = dist[iz * W + ix] * seg, sb = Math.max(0, Math.min(1, (db - 2.5) / 7)), se = Math.max(0, Math.min(1, (S - Math.max(Math.abs(x), Math.abs(z)) - 5) / 10));
      H[iz * W + ix] = Math.round(h * sb * sb * (3 - 2 * sb) * se * 100) / 100; // 건물·벽 근처는 0으로
    }
    return { S, N, H, water: -0.6, roads: [], small: true };
  }
  // 개인전·팀전 맵: 빈 자리에 높이 10~100m 높은 건물 (서버가 준 시드로 모두 같은 모양)
  function genTowers(seed, S, occ, count) {
    const R = rng(seed), rnd = (a, b) => a + R() * (b - a), pick = a => a[Math.floor(R() * a.length)], T = 0.35, f2 = v => Math.round(v * 100) / 100;
    const boxes = [], loot = [], tall = [], foot = []; let BY = 0;
    const B = (x0, x1, y0, y1, z0, z1, c, k) => { if (x1 - x0 < 0.05 || y1 - y0 < 0.05 || z1 - z0 < 0.05) return; boxes.push([f2(x0), f2(x1), f2(y0 + BY), f2(y1 + BY), f2(z0), f2(z1), c, k]); };
    const addLoot = (x, y, z) => loot.push([f2(x), f2(y + BY), f2(z)]);
    function wall(alongX, fixed, a, b, base, h, opens, c, k) {
      const seg2 = (p0, p1, y0, y1) => alongX ? B(p0, p1, base + y0, base + y1, fixed - T / 2, fixed + T / 2, c, k) : B(fixed - T / 2, fixed + T / 2, base + y0, base + y1, p0, p1, c, k);
      opens.sort((u, v) => u[0] - v[0]); let cur = a;
      for (const [o0, o1, y0, y1] of opens) { if (o0 > cur) seg2(cur, o0, 0, h); if (y0 > 0) seg2(o0, o1, 0, y0); if (y1 < h) seg2(o0, o1, y1, h); cur = o1; }
      if (cur < b) seg2(cur, b, 0, h);
    }
    function openings(a, b, door) {
      const L = b - a, res = []; if (L < 3) return res;
      if (door) { const c = rnd(a + 1.4, b - 1.4); res.push([c - 0.8, c + 0.8, 0, 2.3]); }
      const nWin = Math.floor(L / 4.5);
      for (let i = 0; i < nWin; i++) { const c = a + (i + 0.5) * L / nWin; if (res.some(o => c + 0.7 > o[0] - 0.4 && c - 0.7 < o[1] + 0.4)) continue; res.push([c - 0.7, c + 0.7, 1.1, 2.3]); }
      return res;
    }
    function spire(cx, cz) { // 높은 건물: 높이 10~100m 랜덤, 층마다 계단(지그재그)으로 옥상까지 올라감
      const hTot = rnd(10, 100), NF = Math.max(2, Math.round(hTot / 4)), FH = hTot / NF, s = 7.2 + Math.min(4.8, hTot * 0.05), x0 = cx - s / 2, x1 = cx + s / 2, z0 = cz - s / 2, z1 = cz + s / 2, c = pick([0x9a958a, 0xa89a82, 0x8a8d90]), k = 'concrete';
      foot.push([x0, x1, z0, z1]); tall.push([f2(cx), f2(cz), f2(s), NF, f2(FH), f2(BY)]);
      for (let f = 0; f < NF; f++) {
        const base = f * FH, door = i => f === 0 && i === 0;
        wall(true, z0 + T / 2, x0, x1, base, FH, openings(x0, x1, door(0)), c, k); wall(true, z1 - T / 2, x0, x1, base, FH, openings(x0, x1, false), c, k);
        wall(false, x0 + T / 2, z0 + T, z1 - T, base, FH, openings(z0 + T, z1 - T, false), c, k); wall(false, x1 - T / 2, z0 + T, z1 - T, base, FH, openings(z0 + T, z1 - T, false), c, k);
        const n = 8, rise = FH / n, run = 0.68, sw = 1.3, west = f % 2 === 0;
        const sx0 = west ? x0 + T : x1 - T - sw, sx1 = sx0 + sw, sStart = west ? z0 + T + 1.2 : z1 - T - 1.2;
        for (let i = 0; i < n; i++) { const a = west ? sStart + i * run : sStart - (i + 1) * run; B(sx0, sx1, base, base + (i + 1) * rise, a, a + run, 0x8a8478, 'concrete'); }
        const L = base + FH, sEnd = west ? sStart + n * run : sStart - n * run; // 위층 바닥 (올라오는 계단 자리는 비움)
        if (west) { B(sx1, x1 - T, L - 0.25, L, z0 + T, z1 - T, 0x7a7468, 'wood'); B(sx0, sx1, L - 0.25, L, sEnd, z1 - T, 0x7a7468, 'wood'); }
        else { B(x0 + T, sx0, L - 0.25, L, z0 + T, z1 - T, 0x7a7468, 'wood'); B(sx0, sx1, L - 0.25, L, z0 + T, sEnd, 0x7a7468, 'wood'); }
        if (NF <= 6 || f % 3 === 0) addLoot(west ? rnd(sx1 + 0.7, x1 - T - 0.7) : rnd(x0 + T + 0.7, sx0 - 0.7), base, rnd(z0 + T + 0.8, z1 - T - 0.8)); // 높은 건물은 3층마다
      }
      const top = NF * FH; // 옥상 난간 (총을 쏠 수 있는 높이)
      B(x0 - 0.2, x1 + 0.2, top, top + 1.1, z0 - 0.2, z0 + 0.2, c, k); B(x0 - 0.2, x1 + 0.2, top, top + 1.1, z1 - 0.2, z1 + 0.2, c, k);
      B(x0 - 0.2, x0 + 0.2, top, top + 1.1, z0 + 0.2, z1 - 0.2, c, k); B(x1 - 0.2, x1 + 0.2, top, top + 1.1, z0 + 0.2, z1 - 0.2, c, k);
      addLoot(cx - 1.2, top, cz); addLoot(cx + 1.2, top, cz - 1);
    }
    const free = (x0, x1, z0, z1) => !occ.some(q => q.miny < 4 && x0 < q.maxx && x1 > q.minx && z0 < q.maxz && z1 > q.minz) && !foot.some(f => x0 < f[1] + 6 && x1 > f[0] - 6 && z0 < f[3] + 6 && z1 > f[2] - 6);
    for (let tries = 0; tall.length < count && tries < 800; tries++) {
      const x = rnd(-S + 14, S - 14), z = rnd(-S + 14, S - 14), m = 8.5; // 건물 최대 폭 12m + 문 앞 여유
      if (free(x - m, x + m, z - m, z + m)) spire(x, z);
    }
    return { boxes, tall };
  }
  // 차량 종류: 좌석(차 기준 x=왼쪽, y=엉덩이 높이, z=앞), 최고 속도(m/s), 가속, 내구도, 길이, 폭
  const VEH = {
    jeep: { n: '지프', seats: [[0.5, 1.5, 0.25], [-0.5, 1.5, 0.25], [0.5, 1.5, -0.95], [-0.5, 1.5, -0.95]], max: 25, acc: 8, hp: 600, len: 4.4, wid: 2.1 },
    buggy: { n: '버기', seats: [[0.42, 1.0, -0.1], [-0.42, 1.0, -0.1]], max: 31, acc: 10, hp: 320, len: 3.6, wid: 1.8 },
  };
  const API = { genBR, heightAt, VEH, genTowers, genArenaTerrain, genLandmarks, LM };
  g.BRMAP = API;
  if (typeof module !== 'undefined') module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
