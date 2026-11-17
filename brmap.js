// 배틀로얄 섬 생성기 (서버와 브라우저가 같은 시드로 똑같은 섬을 만듦)
// 결과: 건물 상자, 바위, 나무, 아이템 자리, 출발 자리, 마을, 도로
(function (g) {
  function rng(seed) { // 시드로 항상 같은 난수열
    let a = seed >>> 0 || 1;
    return function () { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  const TOWN_NAMES = ['솔밭 마을', '붉은 지붕 마을', '공업 단지', '강변 마을', '언덕 마을', '중앙 시가지', '기차역', '농장'];
  const WALLC = [[0xb07a62, 'brick'], [0xc9b79c, 'concrete'], [0xa9a49a, 'concrete'], [0xe0d8c8, 'concrete'], [0x9c6b52, 'brick'], [0x8fa0a8, 'concrete']];
  const ROOFC = [0x5a5f68, 0x7a4a3a, 0x4a5a48, 0x6a6e76, 0x8a3a2a];
  const CONTC = [0xb4532a, 0x2f62b8, 0x2e8050, 0xc9a227, 0x8a3a3a];

  function genBR(seed) {
    const R = rng(seed), rnd = (a, b) => a + R() * (b - a), ri = (a, b) => Math.floor(a + R() * (b - a + 1)), pick = a => a[Math.floor(R() * a.length)];
    const S = 200, T = 0.35, SH = 3.2; // 섬 반 크기(400m x 400m), 벽 두께, 한 층 높이
    const boxes = [], loot = [], trees = [], rocks = [], towns = [], roads = [], fields = [], spawns = [], foot = [];
    const f2 = v => Math.round(v * 100) / 100;
    const B = (x0, x1, y0, y1, z0, z1, c, k) => { if (x1 - x0 < 0.05 || y1 - y0 < 0.05 || z1 - z0 < 0.05) return; boxes.push([f2(x0), f2(x1), f2(y0), f2(y1), f2(z0), f2(z1), c, k]); };
    const fits = (x0, x1, z0, z1, pad) => {
      if (x0 < -S + 6 || x1 > S - 6 || z0 < -S + 6 || z1 > S - 6) return false;
      for (const f of foot) if (x0 - pad < f[1] && x1 + pad > f[0] && z0 - pad < f[3] && z1 + pad > f[2]) return false;
      return true;
    };
    const onRoad = (x0, x1, z0, z1) => roads.some(r => x0 < r[1] && x1 > r[0] && z0 < r[3] && z1 > r[2]);
    const addLoot = (x, y, z) => loot.push([f2(x), f2(y), f2(z)]);

    // ---------- 벽 (문·창문 구멍 포함) ----------
    function wall(alongX, fixed, a, b, base, h, opens, c, k) {
      const seg = (p0, p1, y0, y1) => alongX ? B(p0, p1, base + y0, base + y1, fixed - T / 2, fixed + T / 2, c, k) : B(fixed - T / 2, fixed + T / 2, base + y0, base + y1, p0, p1, c, k);
      opens.sort((u, v) => u[0] - v[0]); let cur = a;
      for (const [o0, o1, y0, y1] of opens) { if (o0 > cur) seg(cur, o0, 0, h); if (y0 > 0) seg(o0, o1, 0, y0); if (y1 < h) seg(o0, o1, y1, h); cur = o1; }
      if (cur < b) seg(cur, b, 0, h);
    }
    function openings(a, b, door) {
      const L = b - a, res = []; if (L < 3) return res;
      if (door) { const c = rnd(a + 1.4, b - 1.4); res.push([c - 0.8, c + 0.8, 0, 2.3]); }
      const nWin = Math.floor(L / 4.5);
      for (let i = 0; i < nWin; i++) { const c = a + (i + 0.5) * L / nWin; if (res.some(o => c + 0.7 > o[0] - 0.4 && c - 0.7 < o[1] + 0.4)) continue; res.push([c - 0.7, c + 0.7, 1.1, 2.3]); }
      return res;
    }
    // ---------- 집 (1층 / 2층) ----------
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
      if (stories === 2) { // 서쪽 벽을 따라 계단, 계단 위만 뚫린 2층 바닥
        const sw = 1.3, run = 0.72, n = 7, rise = SH / n, sx0 = x0 + T, sx1 = sx0 + sw, sz0 = z0 + T + 0.3, sz1 = sz0 + run * n;
        for (let i = 0; i < n; i++) B(sx0, sx1, 0, (i + 1) * rise, sz0 + i * run, sz0 + (i + 1) * run, 0x9a9890, 'concrete');
        B(sx1, x1 - T, SH - 0.25, SH, z0 + T, z1 - T, 0x8a8478, 'wood');
        B(sx0, sx1, SH - 0.25, SH, sz1, z1 - T, 0x8a8478, 'wood');
        for (let i = 0; i < 2; i++) addLoot(rnd(sx1 + 0.8, x1 - T - 0.6), SH, rnd(z0 + T + 0.6, z1 - T - 0.6));
        lx0 = sx1 + 0.8;
      }
      B(x0 - 0.2, x1 + 0.2, stories * SH, stories * SH + 0.3, z0 - 0.2, z1 + 0.2, roof, 'roof');
      if (stories === 1 && w > 10.5) wall(false, cx + rnd(-1, 1), z0 + T, z1 - T, 0, SH, [[cz - 0.8, cz + 0.8, 0, 2.3]], c, k); // 칸막이와 안쪽 문
      const nL = stories === 2 ? 1 : ri(2, 3);
      for (let i = 0; i < nL; i++) addLoot(rnd(lx0, x1 - T - 0.7), 0, rnd(z0 + T + 0.7, z1 - T - 0.7));
    }
    // ---------- 창고 ----------
    function warehouse(cx, cz, w, d) {
      const x0 = cx - w / 2, x1 = cx + w / 2, z0 = cz - d / 2, z1 = cz + d / 2, H = 5.5, c = pick([0x8a9aa8, 0x9aa3ad, 0x7d8b78, 0xa89a7a]);
      foot.push([x0, x1, z0, z1]);
      const big = (a, b) => { const m = rnd(a + 3, b - 3); return [[m - 2, m + 2, 0, 4]]; };
      wall(true, z0 + T / 2, x0, x1, 0, H, R() < 0.6 ? big(x0, x1) : openings(x0, x1, true), c, 'metal');
      wall(true, z1 - T / 2, x0, x1, 0, H, R() < 0.6 ? big(x0, x1) : openings(x0, x1, false), c, 'metal');
      wall(false, x0 + T / 2, z0 + T, z1 - T, 0, H, openings(z0 + T, z1 - T, R() < 0.5), c, 'metal');
      wall(false, x1 - T / 2, z0 + T, z1 - T, 0, H, openings(z0 + T, z1 - T, R() < 0.5), c, 'metal');
      B(x0 - 0.3, x1 + 0.3, H, H + 0.35, z0 - 0.3, z1 + 0.3, 0x5a646e, 'roof');
      for (let i = ri(3, 6); i > 0; i--) { const s = rnd(1.2, 2), hx = rnd(x0 + 2, x1 - 2), hz = rnd(z0 + 2, z1 - 2); B(hx - s / 2, hx + s / 2, 0, rnd(1, 2.2), hz - s / 2, hz + s / 2, 0xb48c58, 'wood'); }
      for (let i = ri(3, 5); i > 0; i--) addLoot(rnd(x0 + 1.2, x1 - 1.2), 0, rnd(z0 + 1.2, z1 - 1.2));
    }
    // ---------- 망루 (계단으로 올라감, 위에 아이템) ----------
    function tower(cx, cz) {
      const s = 4, h = 6, n = 12, run = 0.9, x0 = cx - s / 2, x1 = cx + s / 2, z0 = cz - s / 2, z1 = cz + s / 2;
      if (!fits(x0, x1, z0, z1 + n * run, 3) || onRoad(x0, x1, z0, z1 + n * run)) return;
      foot.push([x0, x1, z0, z1 + n * run]);
      B(x0, x1, 0, h, z0, z1, 0x7a6a55, 'wood');
      for (let i = 0; i < n; i++) B(cx - 0.8, cx + 0.8, 0, (i + 1) * h / n, z1 + (n - 1 - i) * run, z1 + (n - i) * run, 0x8a8478, 'wood');
      B(x0, x1, h, h + 1, z0, z0 + 0.3, 0x6a5a45, 'wood'); B(x0, x0 + 0.3, h, h + 1, z0, z1, 0x6a5a45, 'wood'); B(x1 - 0.3, x1, h, h + 1, z0, z1, 0x6a5a45, 'wood');
      addLoot(cx - 0.8, h, cz - 0.6); addLoot(cx + 0.8, h, cz - 0.4);
    }
    // ---------- 컨테이너 ----------
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
    // ---------- 마을 위치 → 도로 → 건물 ----------
    for (let tries = 0; towns.length < 8 && tries < 600; tries++) {
      const x = rnd(-150, 150), z = rnd(-150, 150);
      if (towns.every(t => Math.hypot(t[0] - x, t[1] - z) > 85)) towns.push([f2(x), f2(z), ri(28, 40), TOWN_NAMES[towns.length]]);
    }
    const W = 3.2, road = (x0, z0, x1, z1) => { // 축에 나란한 도로 (L자로 마을을 이음)
      if (Math.abs(z1 - z0) < 0.1) roads.push([f2(Math.min(x0, x1) - W), f2(Math.max(x0, x1) + W), f2(z0 - W), f2(z0 + W)]);
      else roads.push([f2(x0 - W), f2(x0 + W), f2(Math.min(z0, z1) - W), f2(Math.max(z0, z1) + W)]);
    };
    const ord = towns.slice().sort((a, b) => Math.atan2(a[1], a[0]) - Math.atan2(b[1], b[0]));
    for (let i = 0; i < ord.length; i++) { const a = ord[i], b = ord[(i + 1) % ord.length]; road(a[0], a[1], b[0], a[1]); road(b[0], a[1], b[0], b[1]); }
    const building = (x, z, type) => {
      let w, d;
      if (type === 'wh') { w = rnd(16, 24); d = rnd(12, 16); } else if (type === 'h2') { w = rnd(8, 11); d = rnd(8.5, 11); } else { w = rnd(7, 12); d = rnd(6.5, 10); }
      if (R() < 0.5) [w, d] = [d, w];
      const x0 = x - w / 2, x1 = x + w / 2, z0 = z - d / 2, z1 = z + d / 2;
      if (!fits(x0, x1, z0, z1, 3) || onRoad(x0 - 1, x1 + 1, z0 - 1, z1 + 1)) return false;
      if (type === 'wh') warehouse(x, z, w, d); else house(x, z, w, d, type === 'h2' ? 2 : 1);
      return true;
    };
    for (const t of towns) {
      const ind = t[3] === '공업 단지';
      for (let a = 0; a < 26; a++) {
        const ang = R() * Math.PI * 2, dist = R() * t[2];
        building(t[0] + Math.cos(ang) * dist, t[1] + Math.sin(ang) * dist, ind ? (R() < 0.6 ? 'wh' : 'h1') : (R() < 0.62 ? 'h1' : R() < 0.7 ? 'h2' : 'wh'));
      }
      for (let i = 0; i < 4; i++) { const ang = R() * 6.283, dist = rnd(4, t[2]), x = t[0] + Math.cos(ang) * dist, z = t[1] + Math.sin(ang) * dist; if (fits(x - 2, x + 2, z - 0.4, z + 0.4, 1) && !onRoad(x - 2, x + 2, z - 0.4, z + 0.4)) { foot.push([x - 2, x + 2, z - 0.3, z + 0.3]); B(x - 2, x + 2, 0, 1.1, z - 0.3, z + 0.3, 0xc2b08a, 'sandbag'); } }
    }
    for (let a = 0; a < 40; a++) building(rnd(-185, 185), rnd(-185, 185), R() < 0.7 ? 'h1' : 'h2'); // 마을 밖 외딴집
    for (let a = 0; a < 6; a++) tower(rnd(-170, 170), rnd(-170, 170));
    for (let a = 0; a < 7; a++) containers(rnd(-170, 170), rnd(-170, 170));
    for (let a = 0; a < 45; a++) { // 엄폐용 모래주머니 / 콘크리트 벽
      const x = rnd(-185, 185), z = rnd(-185, 185), al = R() < 0.5, hw = rnd(1.5, 3), x0 = al ? x - hw : x - 0.3, x1 = al ? x + hw : x + 0.3, z0 = al ? z - 0.3 : z - hw, z1 = al ? z + 0.3 : z + hw;
      if (!fits(x0, x1, z0, z1, 1.5) || onRoad(x0, x1, z0, z1)) continue;
      foot.push([x0, x1, z0, z1]); const sb = R() < 0.6; B(x0, x1, 0, 1.1, z0, z1, sb ? 0xc2b08a : 0xb5b5b0, sb ? 'sandbag' : 'concrete');
      if (R() < 0.35) addLoot(al ? x : x + 1.2, 0, al ? z + 1.2 : z);
    }
    for (let a = 0; a < 70 && rocks.length < 45; a++) { // 바위
      const x = rnd(-188, 188), z = rnd(-188, 188), w = rnd(2.5, 7), d = rnd(2.5, 6), h = rnd(1.2, 4);
      if (!fits(x - w / 2, x + w / 2, z - d / 2, z + d / 2, 2) || onRoad(x - w / 2, x + w / 2, z - d / 2, z + d / 2)) continue;
      foot.push([x - w / 2, x + w / 2, z - d / 2, z + d / 2]); rocks.push([f2(x), f2(z), f2(w), f2(d), f2(h)]);
    }
    for (let a = 0; a < 700 && trees.length < 260; a++) { // 나무 (마을 한가운데는 덜)
      const x = rnd(-192, 192), z = rnd(-192, 192);
      if (!fits(x - 0.5, x + 0.5, z - 0.5, z + 0.5, 1) || onRoad(x - 1, x + 1, z - 1, z + 1)) continue;
      if (towns.some(t => Math.hypot(t[0] - x, t[1] - z) < t[2] * 0.6) && R() < 0.8) continue;
      trees.push([f2(x), f2(z), R() < 0.4 ? 0 : 1]);
    }
    for (let i = 0; i < 12; i++) fields.push([f2(rnd(-180, 180)), f2(rnd(-180, 180)), ri(14, 28), R() < 0.6 ? 'dirt' : 'sand']); // 밭·모래땅 (색만)
    for (let a = 0; a < 2000 && spawns.length < 150; a++) { // 출발 자리: 건물·바위·나무와 겹치지 않는 맨땅
      const x = rnd(-185, 185), z = rnd(-185, 185);
      if (!fits(x - 0.6, x + 0.6, z - 0.6, z + 0.6, 1.2) || trees.some(t => Math.abs(t[0] - x) < 1.5 && Math.abs(t[1] - z) < 1.5)) continue;
      spawns.push([f2(x), f2(z)]);
    }
    return { S, boxes, loot, trees, rocks, towns, roads, fields, spawns };
  }
  const API = { genBR };
  g.BRMAP = API;
  if (typeof module !== 'undefined') module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
