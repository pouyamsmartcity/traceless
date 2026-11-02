import 'vazirmatn/Vazirmatn-Variable-font-face.css';
import './ui/styles.css';
import { App } from './ui/app';

const SHARE_CACHE = 'pakkon-shared';

const base = new URL(import.meta.env.BASE_URL, location.href).href;
const root = document.getElementById('app')!;
const app = new App(root, base);
app.start();

/**
 * Picks up files sent to Pakkon from another app's share sheet (Android, installed app).
 * The offline worker holds them in memory and hands them over by message; they are never stored.
 */
async function takeSharedFiles(): Promise<void> {
  // Older versions kept shared files in storage: make sure nothing is left there.
  if ('caches' in window) await caches.delete(SHARE_CACHE).catch(() => false);
  const params = new URLSearchParams(location.search);
  if (!params.has('shared') || !('serviceWorker' in navigator)) return;
  history.replaceState(null, '', location.pathname);
  const reg = await navigator.serviceWorker.ready;
  const worker = navigator.serviceWorker.controller ?? reg.active;
  if (!worker) return;
  const files = await new Promise<File[]>((resolve) => {
    const timer = setTimeout(() => resolve([]), 10_000);
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type !== 'shared-files') return;
      clearTimeout(timer);
      navigator.serviceWorker.removeEventListener('message', onMessage);
      resolve((e.data.files as unknown[]).filter((f): f is File => f instanceof File));
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    worker.postMessage({ type: 'take-shared' });
  });
  if (files.length) app.addFiles(files);
}

window.addEventListener('paste', (e) => {
  const files = Array.from(e.clipboardData?.files ?? []).filter((f) => /^(image|video|audio)\//.test(f.type));
  if (files.length) app.addFiles(files);
});

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker
    .register('./sw.js', { scope: './' })
    .then((reg) => {
      // If storing the offline copy fails (connection lost), the page loads the models itself right away.
      const installing = reg.installing;
      if (installing && !reg.active) {
        installing.addEventListener('statechange', () => {
          if (installing.state === 'redundant' && !navigator.serviceWorker.controller) app.setOfflineUnavailable();
        });
      }
      return navigator.serviceWorker.ready;
    })
    .then(() => app.setOfflineReady())
    .catch((e: unknown) => {
      console.warn('offline mode unavailable', e);
      app.setOfflineUnavailable();
    });
}

takeSharedFiles().catch((e: unknown) => console.error('could not read shared files', e));
