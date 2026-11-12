// 홈 화면 설치용 최소 서비스워커. 멀티플레이 게임이라 캐시 없이 항상 서버에서 최신 버전을 받아옵니다.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => { /* 네트워크 그대로 사용 */ });
