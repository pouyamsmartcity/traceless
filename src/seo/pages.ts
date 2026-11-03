import { DEFAULT_SITE_URL, REPO_URL } from '../site.ts';
import { ICONS } from '../ui/dom.ts';
import { LANGS, LANG_NAMES, STRINGS, isRtl, type Lang } from '../ui/i18n.ts';

/**
 * One page per language (/, /fa/, /tr/), made at build time from the built index.html, so search engines find the
 * app in English, Persian and Turkish. Each page carries its own title, description, links to the other languages
 * (hreflang), sharing previews, structured data and a short readable text inside #app. The app replaces that text
 * when it starts; without JavaScript it stays readable. Everything here is static: nothing is loaded from elsewhere.
 */

export { DEFAULT_SITE_URL, REPO_URL };

/** Where each language's page lives, relative to the site root. English is the main page. */
export const PAGE_PATH: Record<Lang, string> = { en: '', fa: 'fa/', tr: 'tr/' };

const OG_LOCALE: Record<Lang, string> = { en: 'en_US', fa: 'fa_IR', tr: 'tr_TR' };

/** The name in each language, for people who search for it in their own words. */
export const ALTERNATE_NAMES = ['بی‌ردپا', 'İzsiz'];

interface PageText {
  headline: string;
  intro: string;
  featuresTitle: string;
  features: string[];
  faqTitle: string;
  faq: { q: string; a: string }[];
  open: string;
  otherLanguages: string;
  ogAlt: string;
}

export const PAGE_TEXT: Record<Lang, PageText> = {
  en: {
    headline: 'Remove hidden data from photos, videos and voice notes, and cover faces',
    intro:
      'Photos and videos carry more than the picture: the exact place, the phone model and its serial number, the time, and sometimes a hidden copy of what you cropped out. Traceless removes all of that and covers faces, licence plates and text with solid colour before you send a file. It runs in your browser, works without internet and never uploads anything.',
    featuresTitle: 'What it does',
    features: [
      'Removes EXIF, GPS location, XMP, IPTC, camera serial numbers, hidden thumbnails and Content Credentials (C2PA): the picture is redrawn into a brand-new file, which is checked again.',
      'Finds and covers faces (also small faces in crowds), licence plates, text and whole people, in photos and in videos. Covers are solid, not blur, because blur can sometimes be undone.',
      'Cleans videos (location and device tags, GPS tracks) and voice notes, and can make voices deeper or remove the sound.',
      'Works offline after the first visit and can be installed on Android, iPhone and computers. No account, no tracking.',
      'Free and open source (MIT). A command-line tool and an MCP server let AI agents use it too.',
      'In English, Persian (فارسی) and Turkish (Türkçe).',
    ],
    faqTitle: 'Questions',
    faq: [
      { q: 'How do I remove the location from a photo?', a: 'Open Traceless, choose the photo, and save or send the safe copy. The GPS location and every other hidden detail are not in the new file. Nothing leaves your device.' },
      { q: 'Are my files uploaded?', a: 'No. The page is not allowed to connect to any server, and it keeps working without internet. Still, no tool can make a file 100% safe: what is visible in the picture, such as signs, reflections or tattoos, stays unless you cover it.' },
      { q: 'Why solid covers instead of blur?', a: 'Blur and pixelation can sometimes be reversed or matched. A solid cover leaves nothing of the face or plate underneath.' },
      { q: 'Does it work on iPhone and Android?', a: 'Yes, in an up-to-date browser. Add it to the home screen and it works like an app, also offline.' },
      { q: 'Is it free?', a: 'Yes. Traceless is free, open-source software, without ads, accounts or paid features.' },
    ],
    open: 'Open Traceless',
    otherLanguages: 'Also in',
    ogAlt: 'Traceless: remove hidden data from photos and videos and cover faces, offline',
  },
  fa: {
    headline: 'اطلاعات پنهان عکس، ویدیو و پیام صوتی را پاک کنید و صورت‌ها را بپوشانید',
    intro:
      'هر عکس و ویدیو چیزهایی بیشتر از خود تصویر با خودش دارد: جای دقیق، مدل و شمارهٔ سریال گوشی، زمان، و گاهی نسخهٔ پنهانی از قسمتی که بریده‌اید. Traceless (بی‌ردپا) پیش از فرستادن، همهٔ این‌ها را پاک می‌کند و صورت، پلاک و نوشته را با رنگ یکدست می‌پوشاند. در خود مرورگر کار می‌کند، بدون اینترنت هم کار می‌کند و هیچ چیزی را جایی نمی‌فرستد.',
    featuresTitle: 'چه کار می‌کند',
    features: [
      'EXIF، لوکیشن GPS، XMP، IPTC، شمارهٔ سریال دوربین، تصویر کوچک پنهان و اعتبارنامهٔ محتوا (C2PA) را حذف می‌کند: عکس از نو در یک فایل کاملاً تازه کشیده و دوباره بررسی می‌شود.',
      'صورت‌ها (حتی صورت‌های کوچک در شلوغی)، پلاک ماشین، نوشته و کل بدن آدم‌ها را در عکس و ویدیو پیدا می‌کند و می‌پوشاند. پوشش یکدست است، نه محو یا شطرنجی، چون محو و شطرنجی را گاهی می‌شود برگرداند.',
      'ویدیو (برچسب جا و دستگاه، مسیر GPS) و پیام صوتی را پاک می‌کند و می‌تواند صدا را بم‌تر کند یا کامل حذف کند.',
      'بعد از بار اول بدون اینترنت کار می‌کند و روی اندروید، آیفون و کامپیوتر نصب می‌شود. بدون حساب کاربری، بدون ردیابی.',
      'رایگان و متن‌باز (MIT). ابزار خط فرمان و سرور MCP هم دارد تا دستیارهای هوش مصنوعی هم بتوانند از آن استفاده کنند.',
      'به فارسی، انگلیسی (English) و ترکی (Türkçe).',
    ],
    faqTitle: 'پرسش‌ها',
    faq: [
      { q: 'چطور لوکیشن عکس را پاک کنم؟', a: 'Traceless را باز کنید، عکس را انتخاب کنید و نسخهٔ امن را ذخیره کنید یا بفرستید. موقعیت مکانی (GPS) و همهٔ اطلاعات پنهان دیگر در فایل تازه نیست. هیچ چیزی از دستگاه شما بیرون نمی‌رود.' },
      { q: 'فایل‌هایم جایی آپلود می‌شوند؟', a: 'نه. این صفحه اجازهٔ وصل شدن به هیچ سروری را ندارد و بدون اینترنت هم کار می‌کند. با این حال هیچ ابزاری نمی‌تواند فایل را صددرصد امن کند: چیزهایی که در خود تصویر دیده می‌شوند، مثل تابلو، بازتاب یا خالکوبی، می‌مانند مگر این‌که آن‌ها را بپوشانید.' },
      { q: 'چرا پوشش یکدست، و نه محو کردن یا شطرنجی؟', a: 'محو و شطرنجی را گاهی می‌شود برگرداند یا با عکس‌های دیگر تطبیق داد. پوشش یکدست هیچ چیزی از صورت یا پلاکِ زیرش باقی نمی‌گذارد.' },
      { q: 'روی آیفون و اندروید کار می‌کند؟', a: 'بله، در هر مرورگر به‌روز. آن را به صفحهٔ اصلی گوشی اضافه کنید تا مثل یک برنامه، بدون اینترنت هم کار کند.' },
      { q: 'رایگان است؟', a: 'بله. Traceless نرم‌افزاری رایگان و متن‌باز است؛ بدون تبلیغ، بدون حساب کاربری و بدون بخش پولی.' },
    ],
    open: 'باز کردن Traceless',
    otherLanguages: 'زبان‌های دیگر',
    ogAlt: 'Traceless (بی‌ردپا): حذف اطلاعات پنهان عکس و ویدیو و پوشاندن صورت، بدون اینترنت',
  },
  tr: {
    headline: 'Fotoğraf, video ve sesli mesajlardaki gizli bilgileri silin, yüzleri kapatın',
    intro:
      'Fotoğraflar ve videolar görüntüden fazlasını taşır: tam konum, telefon modeli ve seri numarası, zaman ve bazen kırptığınız kısmın gizli bir kopyası. Traceless (İzsiz), bir dosyayı göndermeden önce bunların hepsini siler ve yüzleri, plakaları ve yazıları düz renkle kapatır. Tarayıcınızda çalışır, internetsiz de çalışır ve hiçbir şeyi hiçbir yere yüklemez.',
    featuresTitle: 'Ne yapar',
    features: [
      'EXIF, GPS konumu, XMP, IPTC, kamera seri numaraları, gizli küçük resimler ve İçerik Kimlik Bilgileri (C2PA) silinir: resim yepyeni bir dosyaya yeniden çizilir ve yeniden kontrol edilir.',
      'Yüzleri (kalabalıktaki küçük yüzler dahil), araç plakalarını, yazıları ve insanları fotoğraflarda ve videolarda bulup kapatır. Kapatmalar bulanıklaştırma değil düz renktir; çünkü bulanıklık bazen geri alınabilir.',
      'Videoları (konum ve cihaz etiketleri, GPS izleri) ve sesli mesajları temizler; sesleri kalınlaştırabilir veya sesi tamamen kaldırabilir.',
      'İlk ziyaretten sonra internetsiz çalışır; Android, iPhone ve bilgisayarlara yüklenebilir. Hesap yok, takip yok.',
      'Ücretsiz ve açık kaynak (MIT). Komut satırı aracı ve MCP sunucusu sayesinde yapay zekâ ajanları da kullanabilir.',
      'Türkçe, İngilizce (English) ve Farsça (فارسی).',
    ],
    faqTitle: 'Sorular',
    faq: [
      { q: 'Bir fotoğraftan konum bilgisini nasıl silerim?', a: 'Traceless’i açın, fotoğrafı seçin ve güvenli kopyayı kaydedin veya gönderin. GPS konumu ve diğer tüm gizli bilgiler yeni dosyada yoktur. Hiçbir şey cihazınızdan çıkmaz.' },
      { q: 'Dosyalarım bir yere yükleniyor mu?', a: 'Hayır. Sayfanın hiçbir sunucuya bağlanmasına izin verilmez ve internetsiz de çalışır. Yine de hiçbir araç bir dosyayı %100 güvenli yapamaz: tabelalar, yansımalar veya dövmeler gibi resimde görünenler, siz kapatmadıkça kalır.' },
      { q: 'Neden bulanıklaştırma değil de düz kapatma?', a: 'Bulanıklaştırma ve pikselleştirme bazen geri alınabilir veya eşleştirilebilir. Düz kapatma, altındaki yüzden veya plakadan hiçbir şey bırakmaz.' },
      { q: 'iPhone ve Android’de çalışır mı?', a: 'Evet, güncel bir tarayıcıda. Ana ekrana ekleyin; bir uygulama gibi, internetsiz de çalışır.' },
      { q: 'Ücretsiz mi?', a: 'Evet. Traceless ücretsiz ve açık kaynaklı bir yazılımdır; reklam, hesap veya ücretli özellik yoktur.' },
    ],
    open: 'Traceless’i aç',
    otherLanguages: 'Diğer diller',
    ogAlt: 'Traceless (İzsiz): fotoğraf ve videolardaki gizli bilgileri silin, yüzleri kapatın, internetsiz',
  },
};

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** JSON inside a <script> data block: "<" is escaped so the text can never close the element. */
function jsonBlock(data: unknown): string {
  return `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;
}

export function pageUrl(site: string, lang: Lang): string {
  return new URL(PAGE_PATH[lang], site).href;
}

export function ogImage(lang: Lang): string {
  return `og-${lang}.jpg`;
}

function head(lang: Lang, site: string): string {
  const t = STRINGS[lang];
  const p = PAGE_TEXT[lang];
  const url = pageUrl(site, lang);
  const image = new URL(ogImage(lang), site).href;
  const alternates = [
    ...LANGS.map((l) => `<link rel="alternate" hreflang="${l}" href="${esc(pageUrl(site, l))}" />`),
    `<link rel="alternate" hreflang="x-default" href="${esc(pageUrl(site, 'en'))}" />`,
  ];
  const app = {
    '@context': 'https://schema.org',
    '@type': 'WebApplication',
    name: 'Traceless',
    alternateName: ALTERNATE_NAMES,
    url,
    description: t.pageDescription,
    inLanguage: lang,
    availableLanguage: LANGS,
    applicationCategory: 'MultimediaApplication',
    applicationSubCategory: 'Privacy',
    operatingSystem: 'Android, iOS, Windows, macOS, Linux (web browser)',
    browserRequirements: 'Requires JavaScript and WebAssembly',
    isAccessibleForFree: true,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    license: 'https://opensource.org/licenses/MIT',
    sameAs: [REPO_URL],
    image,
    author: { '@type': 'Organization', name: 'Pouyam', url: 'https://www.pouyam.com' },
  };
  const faq = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    inLanguage: lang,
    mainEntity: p.faq.map(({ q, a }) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })),
  };
  return [
    `<title>${esc(t.pageTitle)}</title>`,
    `<meta name="description" content="${esc(t.pageDescription)}" />`,
    `<link rel="canonical" href="${esc(url)}" />`,
    ...alternates,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="Traceless" />`,
    `<meta property="og:title" content="${esc(t.pageTitle)}" />`,
    `<meta property="og:description" content="${esc(t.pageDescription)}" />`,
    `<meta property="og:url" content="${esc(url)}" />`,
    `<meta property="og:image" content="${esc(image)}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta property="og:image:alt" content="${esc(p.ogAlt)}" />`,
    `<meta property="og:locale" content="${OG_LOCALE[lang]}" />`,
    ...LANGS.filter((l) => l !== lang).map((l) => `<meta property="og:locale:alternate" content="${OG_LOCALE[l]}" />`),
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${esc(t.pageTitle)}" />`,
    `<meta name="twitter:description" content="${esc(t.pageDescription)}" />`,
    `<meta name="twitter:image" content="${esc(image)}" />`,
    `<meta name="twitter:image:alt" content="${esc(p.ogAlt)}" />`,
    jsonBlock(app),
    jsonBlock(faq),
  ].join('\n    ');
}

function svgIcon(paths: string[], size: number): string {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths.map((d) => `<path d="${esc(d)}"/>`).join('')}</svg>`;
}

/** The readable page inside #app before the app starts (and for anyone without JavaScript). */
function body(lang: Lang, fromRoot: string): string {
  const t = STRINGS[lang];
  const p = PAGE_TEXT[lang];
  const others = LANGS.filter((l) => l !== lang)
    .map((l) => `<a href="${fromRoot}${PAGE_PATH[l]}" hreflang="${l}" lang="${l}">${esc(LANG_NAMES[l])}</a>`)
    .join(' · ');
  return `
      <header class="top"><div class="brand"><span class="logo">${svgIcon(ICONS.eraser, 24)}</span><div><h1>${esc(t.appName)}</h1><p>${esc(t.tagline)}</p></div></div></header>
      <section class="hero">
        <div class="hero-art" aria-hidden="true">${svgIcon(ICONS.shield, 40)}</div>
        <h2 class="hero-title">${esc(p.headline)}</h2>
        <p class="hero-text">${esc(p.intro)}</p>
      </section>
      <section class="about">
        <h2>${esc(p.featuresTitle)}</h2>
        <ul>${p.features.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
        <h2>${esc(p.faqTitle)}</h2>
        <dl>${p.faq.map(({ q, a }) => `<dt>${esc(q)}</dt><dd>${esc(a)}</dd>`).join('')}</dl>
        <p>${esc(p.otherLanguages)}: ${others} · <a href="${REPO_URL}">${esc(t.sourceCode)}</a></p>
      </section>
      <noscript><p class="hint">${esc(noScript[lang])}</p></noscript>`;
}

const noScript: Record<Lang, string> = {
  en: 'Traceless needs JavaScript. It runs entirely on your device; nothing is uploaded.',
  fa: 'Traceless به جاوااسکریپت نیاز دارد. همه‌چیز روی دستگاه خود شما انجام می‌شود و چیزی آپلود نمی‌شود.',
  tr: 'Traceless için JavaScript gerekir. Tamamen cihazınızda çalışır; hiçbir şey yüklenmez.',
};

/**
 * Turns the built index.html into one language's page. Pages in a subfolder point to the app's files one level up
 * (a <base> element is not allowed by the page's security policy).
 */
export function renderPage(built: string, lang: Lang, site: string = DEFAULT_SITE_URL): string {
  const depth = PAGE_PATH[lang].split('/').filter(Boolean).length;
  const fromRoot = depth ? '../'.repeat(depth) : './';
  let html = built;
  const swap = (pattern: RegExp, replacement: string) => {
    if (!pattern.test(html)) throw new Error(`index.html: ${pattern} not found`);
    html = html.replace(pattern, replacement);
  };
  swap(/<html[^>]*>/, `<html lang="${lang}" dir="${isRtl(lang) ? 'rtl' : 'ltr'}"${depth ? ` data-page-lang="${lang}"` : ''}>`);
  swap(/<title>[\s\S]*?<\/title>\s*<meta name="description"[^>]*>/, head(lang, site));
  swap(/<main id="app">[\s\S]*?<\/main>/, `<main id="app">${body(lang, fromRoot)}\n    </main>`);
  if (depth) html = html.replace(/\b(src|href)="\.\/(?!\/)/g, `$1="${fromRoot}`);
  return html;
}

/** sitemap.xml with every language page and its alternates. */
export function sitemap(site: string = DEFAULT_SITE_URL): string {
  const links = LANGS.map((l) => `    <xhtml:link rel="alternate" hreflang="${l}" href="${esc(pageUrl(site, l))}"/>`)
    .concat(`    <xhtml:link rel="alternate" hreflang="x-default" href="${esc(pageUrl(site, 'en'))}"/>`)
    .join('\n');
  const urls = LANGS.map((l) => `  <url>\n    <loc>${esc(pageUrl(site, l))}</loc>\n${links}\n  </url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls}\n</urlset>\n`;
}

const NOT_FOUND: Record<Lang, { title: string; text: string; link: string }> = {
  en: { title: 'Page not found', text: 'There is nothing at this address.', link: 'Open Traceless' },
  fa: { title: 'این صفحه پیدا نشد', text: 'در این نشانی چیزی نیست.', link: 'باز کردن Traceless' },
  tr: { title: 'Sayfa bulunamadı', text: 'Bu adreste bir şey yok.', link: 'Traceless’i aç' },
};

/**
 * 404.html for the host (GitHub Pages shows it at any missing address, so its links are absolute). It loads
 * nothing at all, not even a style sheet, and asks search engines not to list it.
 */
export function notFoundPage(site: string = DEFAULT_SITE_URL): string {
  const parts = LANGS.map((l) => {
    const t = NOT_FOUND[l];
    return `<section lang="${l}" dir="${isRtl(l) ? 'rtl' : 'ltr'}"><h2>${esc(t.title)}</h2><p>${esc(t.text)} <a href="${esc(pageUrl(site, l))}" hreflang="${l}">${esc(t.link)}</a></p></section>`;
  });
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'" />
    <meta name="referrer" content="no-referrer" />
    <meta name="robots" content="noindex" />
    <title>Traceless · ${esc(NOT_FOUND.en.title)}</title>
  </head>
  <body>
    <h1>Traceless</h1>
    ${parts.join('\n    ')}
  </body>
</html>
`;
}
