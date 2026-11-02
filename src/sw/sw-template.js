/* Pakkon service worker: keeps the whole app on the device so it works without internet,
 * and receives files from the system share sheet. It never sends anything anywhere. */
const VERSION = '__VERSION__';
const PRECACHE = __FILES__;
const CACHE = `pakkon-${VERSION}`;
const SHARE_CACHE = 'pakkon-shared';

/** Stores every app file. Files that did not change since the last version are copied from the old
 * cache instead of downloaded again (helps on slow or expensive connections). */
async function precache() {
  const cache = await caches.open(CACHE);
  const old = (await caches.keys()).filter((k) => k.startsWith('pakkon-') && k !== CACHE && k !== SHARE_CACHE);
  const missing = [];
  for (const url of PRECACHE) {
    // Every entry ends in ?v=<content fingerprint>: an exact match in an old cache is the same file.
    let hit;
    for (const name of old) if ((hit = await (await caches.open(name)).match(url))) break;
    if (hit) await cache.put(url, hit);
    else missing.push(url);
  }
  await cache.addAll(missing);
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('pakkon-') && k !== CACHE && k !== SHARE_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function receiveShare(request) {
  const data = await request.formData();
  const cache = await caches.open(SHARE_CACHE);
  let i = 0;
  for (const file of data.getAll('media')) {
    if (!(file instanceof File)) continue;
    const headers = { 'content-type': file.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name || 'shared') };
    await cache.put(new Request(`./shared/${Date.now()}-${i++}`), new Response(file, { headers }));
  }
  return Response.redirect('./?shared=1', 303);
}

/**
 * Adds cross-origin isolation headers to our own responses. This lets the detector use several
 * processor cores (it needs SharedArrayBuffer). It only restricts the page further: nothing from
 * other sites may be embedded, which the page never does anyway.
 */
function isolated(response) {
  if (!response || response.status !== 200 || response.type === 'opaque') return response;
  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith(receiveShare(request));
    return;
  }
  if (request.method !== 'GET') return;
  if (request.mode === 'navigate') {
    event.respondWith(caches.match('./index.html', { cacheName: CACHE, ignoreSearch: true, ignoreVary: true }).then((r) => r || fetch(request)).then(isolated));
    return;
  }
  event.respondWith(caches.match(request, { cacheName: CACHE, ignoreSearch: true, ignoreVary: true }).then((r) => r || fetch(request)).then(isolated));
});
