/* Traceless service worker: keeps the whole app on the device so it works without internet,
 * and receives files from the system share sheet. It never sends anything anywhere. */
const VERSION = '__VERSION__';
const PRECACHE = __FILES__;
const CACHE = `traceless-${VERSION}`;
/** The language pages in their own folders ("fa/", "tr/"); every other address shows the main page. */
const PAGES = __PAGES__;

/** Stores every app file. Files that did not change since the last version are copied from the old
 * cache instead of downloaded again (helps on slow or expensive connections). Files are stored one by one,
 * so when the connection drops during the first visit, what was already downloaded is kept and the next
 * try only fetches the rest. */
/** Downloads one app file and checks it against its fingerprint, so a wrong page (a network filter or captive
 * portal page, or a half-updated server) is never stored in place of an app file. */
async function download(url) {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  const body = await response.arrayBuffer();
  const want = new URL(url, self.location.href).searchParams.get('v');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', body));
  const got = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('').slice(0, want ? want.length : 0);
  if (want && got !== want) throw new Error(`${url}: content does not match`);
  // Only the type is kept: the body is already decoded, so an encoding header would be wrong.
  const type = response.headers.get('Content-Type');
  return new Response(body, { status: 200, statusText: 'OK', headers: type ? { 'Content-Type': type } : {} });
}

async function precache() {
  const cache = await caches.open(CACHE);
  const old = (await caches.keys()).filter((k) => k.startsWith('traceless-') && k !== CACHE && k !== 'traceless-shared');
  const queue = [...PRECACHE];
  async function next() {
    for (let url; (url = queue.shift()) !== undefined; ) {
      // Every entry ends in ?v=<content fingerprint>: an exact match is the same file.
      if (await cache.match(url)) continue; // kept from an earlier, interrupted try
      let hit;
      for (const name of old) if ((hit = await (await caches.open(name)).match(url))) break;
      if (hit) await cache.put(url, hit);
      else await cache.put(url, await download(url));
    }
  }
  // A few downloads at a time; any failure fails the install, which the browser retries on a later visit.
  await Promise.all([next(), next(), next(), next()]);
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      // Older versions are removed, except the one just before this: a tab still open on it keeps finding the
      // parts it loads later (video, voice notes, ZIP), until it is reloaded. Cache names come back oldest first.
      .then((keys) => {
        const ours = keys.filter((k) => k.startsWith('traceless-') && k !== CACHE);
        const keep = ours.filter((k) => k !== 'traceless-shared').slice(-1);
        return Promise.all(ours.filter((k) => !keep.includes(k)).map((k) => caches.delete(k)));
      })
      .then(() => self.clients.claim()),
  );
});

/** Our file for a request: from this version's copy first, then from the version before (see activate). */
async function stored(request) {
  const opts = { ignoreSearch: true, ignoreVary: true };
  return (await caches.match(request, { cacheName: CACHE, ...opts })) || (await caches.match(request, opts));
}

/** Files received from the share sheet, held in memory only (never written to storage) until the page takes them. */
let sharedFiles = [];

async function receiveShare(request) {
  const data = await request.formData();
  sharedFiles = data.getAll('media').filter((f) => f instanceof File);
  return Response.redirect('./?shared=1', 303);
}

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'take-shared' && event.source) {
    const files = sharedFiles;
    sharedFiles = [];
    event.source.postMessage({ type: 'shared-files', files });
  }
});

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
  // No other site may show Traceless inside a frame (a page cannot say this about itself in a meta tag).
  headers.set('Content-Security-Policy', "frame-ancestors 'none'");
  headers.set('X-Frame-Options', 'DENY');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** The address inside the app ("", "fa/", "tr/"...), or undefined for an address outside it. */
function appPath(url) {
  const scope = new URL(self.registration.scope).pathname;
  return url.pathname.startsWith(scope) ? url.pathname.slice(scope.length) : undefined;
}

/** The stored page for a visit: the language page for its folder, the main page for everything else. */
function pageFor(url) {
  const path = appPath(url)?.replace(/index\.html$/, '');
  return path && PAGES.includes(path) ? `./${path}index.html` : './index.html';
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
    // "…/fa" without the slash: the page's own links are relative to its folder, so go to "…/fa/" first.
    const path = appPath(url);
    if (path && PAGES.includes(`${path}/`)) {
      event.respondWith(Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 301));
      return;
    }
    event.respondWith(caches.match(pageFor(url), { cacheName: CACHE, ignoreSearch: true, ignoreVary: true }).then((r) => r || fetch(request)).then(isolated));
    return;
  }
  event.respondWith(stored(request).then((r) => r || fetch(request)).then(isolated));
});
