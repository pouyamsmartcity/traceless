// Draws the link previews (1200 x 630) shown when the site is shared: public/og-en.jpg, og-fa.jpg, og-tr.jpg.
// Run after changing the texts or the look: node scripts/og-images.mjs (uses the preinstalled Playwright Chromium).
// The pictures are drawn from scratch here, so they hold no camera data.
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const font = readFileSync(new URL('../node_modules/vazirmatn/fonts/webfonts/Vazirmatn[wght].woff2', import.meta.url)).toString('base64');

const TEXT = {
  en: {
    dir: 'ltr',
    names: 'Traceless',
    title: 'Remove hidden data from photos and videos. Cover faces and plates.',
    chips: ['Works offline', 'Nothing is uploaded', 'Free & open source'],
  },
  fa: {
    dir: 'rtl',
    names: 'Traceless · بی‌ردپا',
    title: 'اطلاعات پنهان عکس و ویدیو را پاک کنید. صورت و پلاک را بپوشانید.',
    chips: ['بدون اینترنت', 'بدون آپلود', 'رایگان و متن‌باز'],
  },
  tr: {
    dir: 'ltr',
    names: 'Traceless · İzsiz',
    title: 'Fotoğraf ve videolardaki gizli bilgileri silin. Yüzleri ve plakaları kapatın.',
    chips: ['İnternetsiz çalışır', 'Hiçbir şey yüklenmez', 'Ücretsiz ve açık kaynak'],
  },
};

const eraser = '<path d="M20 20H9L4 15a2 2 0 0 1 0-3l9-9a2 2 0 0 1 3 0l5 5a2 2 0 0 1 0 3l-8 8"/><path d="M7 9l8 8"/>';

function page(lang) {
  const t = TEXT[lang];
  return `<!doctype html><html lang="${lang}" dir="${t.dir}"><head><meta charset="utf-8"><style>
@font-face { font-family: V; src: url(data:font/woff2;base64,${font}) format('woff2'); font-weight: 100 900; }
* { box-sizing: border-box; margin: 0; }
body { width: 1200px; height: 630px; overflow: hidden; font-family: V, sans-serif; color: #fff;
  background: radial-gradient(900px 500px at ${t.dir === 'rtl' ? '85%' : '15%'} 0%, #1f9a7e 0%, transparent 70%), linear-gradient(135deg, #0b4d40, #0f6b59 55%, #13201b); }
.wrap { display: flex; align-items: center; gap: 56px; height: 100%; padding: 64px 72px; }
.text { flex: 1; min-width: 0; }
.brand { display: flex; align-items: center; gap: 20px; }
.logo { display: grid; place-items: center; width: 84px; height: 84px; border-radius: 26px; background: #fff; color: #0f6b59; box-shadow: 0 12px 40px rgba(0,0,0,.25); }
.names { font-size: 46px; font-weight: 800; letter-spacing: -0.01em; }
h1 { margin-top: 34px; font-size: ${lang === 'en' ? 54 : 50}px; line-height: 1.25; font-weight: 800; text-wrap: balance; }
.chips { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 34px; }
.chip { padding: 10px 20px; border-radius: 999px; background: rgba(255,255,255,.14); border: 1px solid rgba(255,255,255,.28); font-size: 24px; font-weight: 600; }
.art { flex: none; width: 330px; height: 420px; border-radius: 34px; overflow: hidden; position: relative; transform: rotate(${t.dir === 'rtl' ? '-' : ''}3deg);
  background: linear-gradient(180deg, #8fd3f4 0%, #c9ecf7 55%, #e9d6b8 56%, #d9bf95 100%); box-shadow: 0 30px 80px rgba(0,0,0,.35); border: 6px solid #fff; }
.tag { position: absolute; top: 18px; inset-inline-start: 18px; padding: 8px 14px; border-radius: 12px; background: #13201b; color: #fff; font-size: 20px; font-weight: 700; direction: ltr; }
.tag s { color: #ffb4a8; }
</style></head><body><div class="wrap">
<div class="text">
  <div class="brand"><span class="logo"><svg viewBox="0 0 24 24" width="50" height="50" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${eraser}</svg></span><span class="names">${t.names}</span></div>
  <h1>${t.title}</h1>
  <div class="chips">${t.chips.map((c) => `<span class="chip">${c}</span>`).join('')}</div>
</div>
<div class="art" aria-hidden="true">
  <svg viewBox="0 0 330 420" width="330" height="420" style="position:absolute;inset:0">
    <path d="M40 420 C40 330 95 290 165 290 C235 290 290 330 290 420Z" fill="#2f5d8a"/>
    <rect x="148" y="250" width="34" height="50" rx="12" fill="#c98f6b"/>
    <ellipse cx="165" cy="200" rx="66" ry="80" fill="#ffc400"/>
    <circle cx="140" cy="190" r="9" fill="#13201b"/><circle cx="190" cy="190" r="9" fill="#13201b"/>
    <path d="M132 228 Q165 254 198 228" stroke="#13201b" stroke-width="9" fill="none" stroke-linecap="round"/>
  </svg>
  <span class="tag">GPS <s>35.69, 51.33</s> ✕</span>
</div>
</div></body></html>`;
}

const browser = await chromium.launch();
const tab = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
for (const lang of Object.keys(TEXT)) {
  await tab.setContent(page(lang));
  await tab.evaluate(() => document.fonts.ready);
  await tab.screenshot({ path: new URL(`../public/og-${lang}.jpg`, import.meta.url).pathname, type: 'jpeg', quality: 88 });
  console.log(`public/og-${lang}.jpg`);
}
await browser.close();
