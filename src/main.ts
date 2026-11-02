import 'vazirmatn/Vazirmatn-Variable-font-face.css';
import './ui/styles.css';
import { App } from './ui/app';

const SHARE_CACHE = 'pakkon-shared';

const base = new URL(import.meta.env.BASE_URL, location.href).href;
const root = document.getElementById('app')!;
const app = new App(root, base);
app.start();

/** Picks up files sent to Pakkon from another app's share sheet (Android, installed app). */
async function takeSharedFiles(): Promise<void> {
  const params = new URLSearchParams(location.search);
  if (!params.has('shared')) return;
  history.replaceState(null, '', location.pathname);
  if (!('caches' in window)) return;
  const cache = await caches.open(SHARE_CACHE);
  const files: File[] = [];
  for (const req of await cache.keys()) {
    const res = await cache.match(req);
    if (res) {
      const blob = await res.blob();
      const name = decodeURIComponent(res.headers.get('x-file-name') ?? 'shared');
      files.push(new File([blob], name, { type: blob.type }));
    }
    await cache.delete(req);
  }
  if (files.length) app.addFiles(files);
}

window.addEventListener('paste', (e) => {
  const files = Array.from(e.clipboardData?.files ?? []).filter((f) => /^(image|video)\//.test(f.type));
  if (files.length) app.addFiles(files);
});

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker
    .register('./sw.js', { scope: './' })
    .then(() => navigator.serviceWorker.ready)
    .then(() => app.setOfflineReady())
    .catch((e: unknown) => console.warn('offline mode unavailable', e));
}

takeSharedFiles().catch((e: unknown) => console.error('could not read shared files', e));
