// 서버와 브라우저가 함께 쓰는 총기 데이터
// dmg: 한 발(펠릿) 피해 / cd: 발사 간격(초) / reload: 재장전(초) / spread: 탄퍼짐 / zoom: 우클릭 줌 배율 / speed: 이동속도 배율
(function (g) {
  const W = (name, type, dmg, cd, mag, reload, o = {}) => Object.assign(
    { name, type, dmg, cd, mag, reload, pellets: 1, spread: 0.004, zoom: 1, speed: 1, len: 0.5, color: 0x222222, snd: 140 }, o);
  const L = [
    // 권총류
    W('Glock 17',        '권총',     22, 0.25, 12, 1.1, { len: 0.35, snd: 220 }),
    W('Colt Python',     '리볼버',   55, 0.70,  6, 2.0, { len: 0.38, snd: 110, color: 0x5a4a3a }),
    W('Desert Eagle',    '권총',     45, 0.50,  7, 1.6, { len: 0.42, snd: 90, color: 0x8a8a8a }),
    W('Glock 18',        '기관권총', 14, 0.09, 20, 1.4, { len: 0.38, spread: 0.012, snd: 260 }),
    // 기관단총
    W('MP5',             '기관단총', 16, 0.08, 30, 1.6, { len: 0.5, spread: 0.01, snd: 200, speed: 1.05 }),
    W('KRISS Vector',    '기관단총', 15, 0.06, 25, 1.3, { len: 0.45, spread: 0.014, snd: 230, speed: 1.05, color: 0x334455 }),
    // 돌격소총
    W('M4A1',            '돌격소총', 26, 0.12, 30, 2.0, { len: 0.62, spread: 0.006, snd: 130 }),
    W('AKS-74U',         '카빈',     22, 0.10, 30, 1.7, { len: 0.55, spread: 0.007, snd: 150, speed: 1.02 }),
    W('AK-47',           '돌격소총', 36, 0.22, 20, 2.2, { len: 0.66, spread: 0.004, snd: 105, color: 0x3a4a2a }),
    // 샷건
    W('Remington 870',   '샷건',     11, 0.90,  6, 2.4, { len: 0.6, pellets: 8, spread: 0.06, snd: 70, color: 0x5a3a22 }),
    W('Stoeger Coach Gun', '더블배럴 샷건', 14, 1.10, 2, 2.0, { len: 0.55, pellets: 10, spread: 0.08, snd: 60, color: 0x5a3a22 }),
    W('Benelli M4',      '샷건',     10, 0.50,  8, 2.6, { len: 0.6, pellets: 6, spread: 0.05, snd: 80 }),
    // 저격총
    W('Remington M700',  '볼트액션 저격총', 95, 1.40, 5, 2.6, { len: 0.8, zoom: 3, spread: 0.001, snd: 55, speed: 0.9, color: 0x2a3a2a }),
    W('M110 SASS',       '반자동 저격총', 60, 0.60, 10, 2.4, { len: 0.75, zoom: 2.5, spread: 0.002, snd: 70, speed: 0.92 }),
    W('Barrett M82A1',   '대물 저격총', 140, 2.00, 3, 3.0, { len: 0.9, zoom: 4, spread: 0.0005, snd: 45, speed: 0.8, color: 0x111111 }),
    // 기관총
    W('M249 SAW',        '경기관총', 20, 0.10, 60, 4.0, { len: 0.7, spread: 0.012, snd: 100, speed: 0.8 }),
    W('RPK',             '경기관총', 24, 0.13, 45, 3.5, { len: 0.68, spread: 0.01, snd: 110, speed: 0.85 }),
    W('M60',             '다목적 기관총', 32, 0.18, 40, 4.2, { len: 0.75, spread: 0.014, snd: 80, speed: 0.7, color: 0x3a3a3a }),
    // 기타
    W('Dragunov SVD',    '지정사수소총', 48, 0.35, 12, 2.2, { len: 0.7, zoom: 2, spread: 0.002, snd: 85 }),
    W('Barnett Ghost 410', '석궁',   85, 1.20,  1, 1.8, { len: 0.55, zoom: 1.5, spread: 0.001, snd: 400, color: 0x6a4a2a }),
    // 추가
    W('AWM',             '볼트액션 저격총', 110, 1.60, 5, 2.8, { len: 0.85, zoom: 3.5, spread: 0.0005, snd: 50, speed: 0.85, color: 0x2a4a3a }),
  ];
  L.forEach((w, i) => w.id = i);
  // 반동: 한 발당 시점이 위로 튀는 각도(라디안). 조준/엎드리면 줄어듦
  const R = { 'Glock 17': 0.012, 'Colt Python': 0.03, 'Desert Eagle': 0.04, 'Glock 18': 0.02,
    'MP5': 0.014, 'KRISS Vector': 0.012, 'M4A1': 0.02, 'AKS-74U': 0.024, 'AK-47': 0.032,
    'Remington 870': 0.06, 'Stoeger Coach Gun': 0.09, 'Benelli M4': 0.05,
    'Remington M700': 0.06, 'M110 SASS': 0.035, 'Barrett M82A1': 0.1, 'AWM': 0.07,
    'M249 SAW': 0.022, 'RPK': 0.026, 'M60': 0.034, 'Dragunov SVD': 0.03, 'Barnett Ghost 410': 0.015 };
  L.forEach(w => w.recoil = R[w.name] || 0.02);
  g.WEAPONS = L;
  if (typeof module !== 'undefined') module.exports = L;
})(typeof window !== 'undefined' ? window : globalThis);
