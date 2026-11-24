// 홈 화면에 추가한 앱이 인터넷이 약한 곳에서도 열리게 하는 서비스 워커.
//  - 공부 자료(study/*.json): 저장해 둔 것을 바로 보여 주고, 뒤에서 새 것으로 바꿔 둔다.
//  - 사이트 파일(html·js·css·아이콘): 늘 서버에서 새로 받고, 못 받을 때만 저장본을 쓴다
//    (배포한 새 코드가 늦게 반영되는 일이 없게).
//  - 다른 주소(로그인·면담 서버·음성 모델)는 건드리지 않는다. 면담은 인터넷이 있어야 한다.
const SHELL = "cpx-shell-v1";
const STUDY = "cpx-study-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("cpx-") && ![SHELL, STUDY].includes(k) && !k.startsWith("cpx-voice")).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith("/study/") && url.pathname.endsWith(".json")) {
    e.respondWith(
      caches.open(STUDY).then(async (cache) => {
        const hit = await cache.match(req, { ignoreSearch: true });
        const fresh = fetch(req)
          .then((res) => {
            if (res.ok) cache.put(req, res.clone());
            return res;
          })
          .catch(() => null);
        if (hit) {
          e.waitUntil(fresh);
          return hit;
        }
        return (await fresh) || new Response("{}", { status: 503, headers: { "Content-Type": "application/json" } });
      })
    );
    return;
  }

  if (req.mode === "navigate" || /\.(js|css|html|png|svg|webmanifest|pdf)$/.test(url.pathname) || url.pathname === "/") {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok && !url.pathname.endsWith(".pdf")) {
            const copy = res.clone();
            caches.open(SHELL).then((c) => c.put(req.mode === "navigate" ? "/" : req, copy));
          }
          return res;
        })
        .catch(async () => (await caches.match(req.mode === "navigate" ? "/" : req, { ignoreSearch: true })) || Response.error())
    );
  }
});
