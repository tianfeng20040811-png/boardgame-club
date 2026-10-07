/* 离线缓存
 * 页面：先走网络（2.5 秒内有响应就用最新版），超时或离线再用缓存——服务器休眠时也能秒开，重新部署后第一次打开就是新版
 * 静态资源（带版本号）：先用缓存，后台更新
 * 接口数据不缓存（由页面自行处理） */
const CACHE = "bgc-__V__";
const CORE = ["/", "/games", "/signup", "/me", "/assets/me.js?v=__V__", "/assets/base.css?v=__V__", "/assets/site.css?v=__V__", "/assets/signup.css?v=__V__", "/assets/core.js?v=__V__", "/assets/home.js?v=__V__", "/assets/games.js?v=__V__", "/assets/signup.js?v=__V__", "/assets/fx.js?v=__V__", "/favicon.svg"];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(c => Promise.all(CORE.map(u => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

function pageKey(url) {
  let p = url.pathname;
  if (p.endsWith(".html")) p = p.slice(0, -5);
  if (p === "/index") p = "/";
  return p || "/";
}

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.startsWith("/api/") || url.pathname.startsWith("/admin") || url.pathname === "/healthz") return;
  if (req.mode === "navigate") {
    const key = pageKey(url);
    event.respondWith(
      caches.open(CACHE).then(async cache => {
        const network = fetch(req).then(res => {
          if (res && res.ok && res.type === "basic") cache.put(key, res.clone());
          return res;
        });
        const cached = await cache.match(key);
        if (!cached) return network;
        event.waitUntil(network.catch(() => {}));
        const timeout = new Promise(resolve => setTimeout(() => resolve(cached), 2500));
        return Promise.race([network.catch(() => cached), timeout]);
      }),
    );
    return;
  }
  event.respondWith(
    caches.open(CACHE).then(async cache => {
      const cached = await cache.match(req);
      const network = fetch(req)
        .then(res => {
          if (res && res.ok && res.type === "basic") cache.put(req, res.clone());
          return res;
        })
        .catch(() => cached);
      if (cached) {
        event.waitUntil(network.catch(() => {}));
        return cached;
      }
      return network;
    }),
  );
});
