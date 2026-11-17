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
    const raw = (x, z) => {
      let h = fbm(x / 650 + 3.1, z / 650 + 7.7) * 70 + fbm(x / 170 + 11, z / 170 + 5) * 10;
      for (const [px, pz, pr, ph] of peaks) { const d = Math.hypot(x - px, z - pz) / pr; if (d < 2.2) h += ph * Math.exp(-d * d * 2.2); }
      const e = Math.max(0, Math.min(1, (S - Math.max(Math.abs(x), Math.abs(z))) / 380)); // 가장자리는 낮게
      return h * e * e * (3 - 2 * e);
    };
    const slope = (x, z) => Math.max(Math.abs(raw(x + 25, z) - raw(x - 25, z)), Math.abs(raw(x, z + 25) - raw(x, z - 25)));

    // ---------- 2. 마을 터와 외딴집 터 고르기 (낮고 완만한 곳) ----------
    for (let tries = 0; towns.length < 24 && tries < 4000; tries++) {
      const x = rnd(-1700, 1700), z = rnd(-1700, 1700), h = raw(x, z);
      if (h > 75 || slope(x, z) > 9 || towns.some(t => Math.hypot(t[0] - x, t[1] - z) < 520)) continue;
      const r = ri(45, 72); towns.push([f2(x), f2(z), r, TOWN_NAMES[towns.length], f2(h)]); sites.push([x, z, r, 70, h]);
    }
    const lone = [];
    for (let tries = 0; lone.length < 70 && tries < 3000; tries++) {
      const x = rnd(-1800, 1800), z = rnd(-1800, 1800), h = raw(x, z);
      if (h > 110 || slope(x, z) > 7 || towns.some(t => Math.hypot(t[0] - x, t[1] - z) < t[2] + 90) || lone.some(l => Math.hypot(l[0] - x, l[1] - z) < 60)) continue;
      lone.push([x, z, h]); sites.push([x, z, 14, 26, h]);
    }

    // ---------- 3. 높이맵 (터는 평평하게 다지고 주변과 부드럽게 이음) ----------
    const W = N + 1, seg = 2 * S / N, H = new Float32Array(W * W);
    for (let iz = 0; iz < W; iz++) for (let ix = 0; ix < W; ix++) {
      const x = ix * seg - S, z = iz * seg - S; let h = raw(x, z);
      for (const [sx, sz, sr, fall, base] of sites) {
        const d = Math.hypot(x - sx, z - sz), fr = sr + seg * 1.6; if (d >= fr + fall) continue; // 높이맵 칸 크기만큼 더 넓게 평평하게 (건물 바닥이 기울지 않게)
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
        const sw = 1.3, run = 0.72, n = 7, rise = SH / n, sx0 = x0 + T, sx1 = sx0 + sw, sz0 = z0 + T + 0.3, sz1 = sz0 + run * n;
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

    // ---------- 7. 바위, 나무, 밭 ----------
    for (let a = 0; a < 500 && rocks.length < 260; a++) {
      const x = rnd(-1900, 1900), z = rnd(-1900, 1900), w = rnd(2.5, 8), d = rnd(2.5, 7), h = rnd(1.2, 4.5);
      if (!fits(x - w / 2, x + w / 2, z - d / 2, z + d / 2, 2) || onRoad(x - w / 2, x + w / 2, z - d / 2, z + d / 2)) continue;
      foot.push([x - w / 2, x + w / 2, z - d / 2, z + d / 2]); rocks.push([f2(x), f2(z), f2(w), f2(d), f2(h), f2(hAt(x, z) - 0.3)]);
    }
    for (let a = 0; a < 9000 && trees.length < 3200; a++) {
      const x = rnd(-1940, 1940), z = rnd(-1940, 1940), y = hAt(x, z);
      if (y > 175 || towns.some(t => Math.hypot(t[0] - x, t[1] - z) < t[2] * 0.85) || onRoad(x - 1, x + 1, z - 1, z + 1) || !fits(x - 0.5, x + 0.5, z - 0.5, z + 0.5, 1)) continue;
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
    return { S, N, H, boxes, loot, trees, rocks, towns, roads, fields, spawns, peaks, vehicles };
  }
  // 차량 종류: 좌석(차 기준 x=왼쪽, y=엉덩이 높이, z=앞), 최고 속도(m/s), 가속, 내구도, 길이, 폭
  const VEH = {
    jeep: { n: '지프', seats: [[0.5, 1.5, 0.25], [-0.5, 1.5, 0.25], [0.5, 1.5, -0.95], [-0.5, 1.5, -0.95]], max: 25, acc: 8, hp: 600, len: 4.4, wid: 2.1 },
    buggy: { n: '버기', seats: [[0.42, 1.0, -0.1], [-0.42, 1.0, -0.1]], max: 31, acc: 10, hp: 320, len: 3.6, wid: 1.8 },
  };
  const API = { genBR, heightAt, VEH };
  g.BRMAP = API;
  if (typeof module !== 'undefined') module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
