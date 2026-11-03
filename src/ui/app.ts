import { Detector } from '../lib/detect/detector';
import { MASK_STYLES, type MaskStyle } from '../lib/masks';
import { minutesLeft, secondsLeft } from '../lib/eta';
import type { Rect } from '../lib/detect/geometry';
import type { Finding, FindingId } from '../lib/findings';
import { loadPlaces, nearest, type Place } from '../lib/places';
import { ICONS, append, clear, h, icon, openViews } from './dom';
import { openEditor } from './editor';
import { MAX_SEAL_BYTES, looksSealed, openSealed, sealOriginal, type OpenResult } from './seal-ui';
import { STRINGS, countryName, formatNumber, type Lang, type Strings } from './i18n';
import { ensurePeople, ensureText, locationRisks, lookForText, newItem, processItem, randomName, renderImage, sameOptions, upToDate, type Item, type Options } from './pipeline';

type Theme = 'system' | 'light' | 'dark';

interface Settings extends Options {
  lang: Lang;
  theme: Theme;
  /** Forget everything a while after the app goes to the background. */
  autoWipe: boolean;
}

/** The switches set by a protection level (cover look, file size and auto-forget stay as chosen). */
const PRESETS = {
  standard: { faces: true, plates: true, text: false, people: false, voice: false, mute: false, extra: false },
  strong: { faces: true, plates: true, text: true, people: false, voice: true, mute: false, extra: true },
  max: { faces: true, plates: true, text: true, people: true, voice: false, mute: true, extra: true },
} as const;

type Preset = keyof typeof PRESETS | 'custom';

function presetOf(s: Options): Preset {
  for (const [name, p] of Object.entries(PRESETS) as [keyof typeof PRESETS, (typeof PRESETS)[keyof typeof PRESETS]][]) {
    if ((Object.keys(p) as (keyof typeof p)[]).every((k) => s[k] === p[k])) return name;
  }
  return 'custom';
}

/** Switches listed in the one-line summary, in this order. */
const SUMMARY_KEYS = ['faces', 'plates', 'text', 'people', 'voice', 'mute', 'extra', 'light', 'autoWipe'] as const;

/** How long the app may stay in the background before "auto-forget" wipes it. */
const AUTO_WIPE_MS = 5 * 60 * 1000;

function loadSettings(): Settings {
  const defaults: Settings = { lang: 'fa', faces: true, plates: true, extra: false, text: false, mute: false, voice: false, people: false, maskStyle: 'smart', light: false, theme: 'system', autoWipe: false };
  try {
    const raw = localStorage.getItem('pakkon-settings');
    if (raw) {
      const s = JSON.parse(raw) as Partial<Settings>;
      return {
        lang: s.lang === 'en' ? 'en' : 'fa',
        faces: s.faces !== false,
        plates: s.plates !== false,
        extra: s.extra === true,
        text: s.text === true,
        mute: s.mute === true,
        voice: s.voice === true,
        people: s.people === true,
        light: s.light === true,
        theme: s.theme === 'light' || s.theme === 'dark' ? s.theme : 'system',
        autoWipe: s.autoWipe === true,
        maskStyle: MASK_STYLES.includes(s.maskStyle as MaskStyle) ? (s.maskStyle as MaskStyle) : 'smart',
      };
    }
  } catch {
    // Private mode or blocked storage: use defaults.
  }
  return defaults;
}

function saveSettings(s: Settings): void {
  try {
    localStorage.setItem('pakkon-settings', JSON.stringify(s));
  } catch {
    // Not important if it cannot be saved.
  }
}

export class App {
  private settings = loadSettings();
  private readonly items: Item[] = [];
  private readonly cards = new Map<number, HTMLElement>();
  private readonly previews = new Map<number, { key: string; el: HTMLElement; release: () => void; update?: (item: Item) => void }>();
  private readonly detector: Detector;
  private queue: Promise<void> = Promise.resolve();
  private places: Place[] | undefined;
  private listEl!: HTMLElement;
  private bulkEl!: HTMLElement;
  private installPrompt: (Event & { prompt?: () => Promise<void> }) | undefined;
  private offlineReady = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly base: string,
  ) {
    this.detector = new Detector(base);
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.installPrompt = e;
      this.render();
    });
  }

  private get t(): Strings {
    return STRINGS[this.settings.lang];
  }

  start(): void {
    this.render();
    this.watchBackground();
    // Prepare the detectors in the background so the first photo is quick.
    const idle = (cb: () => void) => ('requestIdleCallback' in window ? requestIdleCallback(cb, { timeout: 3000 }) : setTimeout(cb, 1500));
    idle(() => {
      // On the very first visit the offline worker is still storing the models: loading them here as well
      // would download them twice (slow and costly on a weak connection), so wait until it is done.
      if (!this.waitsForOfflineCopy()) this.detector.warmUp();
      loadPlaces(this.base)
        .then((p) => {
          this.places = p;
          for (const item of this.items) this.updateCard(item);
        })
        .catch(() => undefined);
    });
  }

  setOfflineReady(): void {
    this.offlineReady = true;
    // Only the badge changes (a full redraw could interrupt what the user is doing).
    const badge = this.root.querySelector('[data-testid="offline-badge"] > span');
    if (badge && !badge.querySelector('.ready')) badge.appendChild(h('span', { className: 'ready' }, ` · ${this.t.offlineReady}`));
    // Now the models come from the stored copy (once this page is served by the worker).
    const sw = 'serviceWorker' in navigator ? navigator.serviceWorker : undefined;
    if (!sw || sw.controller) this.detector.warmUp();
    else {
      const go = () => this.detector.warmUp();
      sw.addEventListener('controllerchange', go, { once: true });
      setTimeout(go, 10_000);
    }
  }

  /** The offline copy could not be made (private browsing, old browser): load the models straight away. */
  setOfflineUnavailable(): void {
    this.detector.warmUp();
  }

  /** True while the offline worker is being installed for the first time (this page is not served by it yet). */
  private waitsForOfflineCopy(): boolean {
    return import.meta.env.PROD && 'serviceWorker' in navigator && !navigator.serviceWorker.controller && !this.offlineReady;
  }

  /** Adds files from the picker, drag and drop, paste or the system share sheet. */
  addFiles(files: Iterable<File>): void {
    for (const file of files) {
      // A sealed original (.pakkon) is opened, not cleaned.
      if (/\.pakkon$/i.test(file.name)) {
        void this.openSealedFile(file);
        continue;
      }
      const item = newItem(file);
      this.items.unshift(item);
      this.listEl.prepend(this.cardFor(item));
      this.updateCard(item);
      this.enqueue(item);
    }
    this.updateBulk();
  }

  /** Opened sealed files, kept in the app's state so they survive a language switch and can be forgotten. */
  private readonly opened: { id: number; result: OpenResult; url?: string }[] = [];
  private openedSeq = 1;

  private async openSealedFile(file: File): Promise<void> {
    try {
      if (!(await looksSealed(file))) return;
      const result = await openSealed(file, this.t);
      if (!result.ok && result.reason === 'cancelled') return;
      const entry: { id: number; result: OpenResult; url?: string } = { id: this.openedSeq++, result };
      if (result.ok) entry.url = URL.createObjectURL(result.original);
      this.opened.unshift(entry);
      this.listEl.prepend(this.sealedCard(entry));
    } catch (e) {
      console.error('could not open sealed file', e);
    }
  }

  private sealedCard(entry: { id: number; result: OpenResult; url?: string }): HTMLElement {
    const t = this.t;
    const r = entry.result;
    const card = h('article', { className: 'card sealed-card', 'data-testid': 'sealed-card' });
    const body = h('div', { className: 'card-body' });
    card.appendChild(body);
    if (!r.ok) {
      body.appendChild(h('p', { className: 'error', role: 'alert' }, r.reason === 'wrongPassphrase' ? t.errWrongPass : t.errSealDamaged));
    } else {
      body.appendChild(h('p', { className: 'status ready' }, icon(ICONS.check, 18), t.openedTitle));
      const row = (k: string, v: string) => h('li', {}, h('span', { className: 'label' }, k), h('span', { className: 'value', dir: 'ltr' }, v));
      body.appendChild(
        h('ul', { className: 'facts' }, row(t.openedName, r.header.name), row(t.openedWhen, r.header.sealedAt.replace('T', ' ').replace(/\.\d+Z$/, ' UTC')), row(t.sealCode, r.header.code)),
      );
      body.appendChild(h('p', { className: 'note' }, t.openedExplain));
      const save = h('a', { className: 'btn', href: entry.url ?? '#', download: r.original.name, 'data-testid': 'save-original' }, icon(ICONS.save), t.saveOriginal);
      const safe = h('button', { type: 'button', className: 'btn primary' }, t.makeSafeFromOriginal);
      safe.addEventListener('click', () => this.addFiles([r.original]));
      body.appendChild(h('div', { className: 'actions' }, safe, save));
    }
    const rm = h('button', { type: 'button', className: 'link' }, t.forgetOpened);
    rm.addEventListener('click', () => {
      // Forget the decrypted original: release its memory and remove the card.
      if (entry.url) URL.revokeObjectURL(entry.url);
      const i = this.opened.indexOf(entry);
      if (i >= 0) this.opened.splice(i, 1);
      card.remove();
    });
    body.appendChild(rm);
    return card;
  }

  private enqueue(item: Item): void {
    this.queue = this.queue
      .then(async () => {
        if (!this.items.includes(item)) return;
        await processItem(item, this.settings, this.detector, () => this.updateCard(item));
        // Wiped or removed meanwhile: forget what was made.
        if (!this.items.includes(item)) {
          if (item.output) URL.revokeObjectURL(item.output.url);
          if (item.decoded) URL.revokeObjectURL(item.decoded.url);
          delete item.output;
          delete item.decoded;
        }
      })
      .then(() => this.refresh(item))
      .then(async () => {
        if (item.media !== 'image' || item.status !== 'ready' || this.settings.text) return;
        await lookForText(item, this.detector);
        if (this.items.includes(item)) this.updateCard(item);
      })
      .catch((e: unknown) => console.error(e));
  }

  private render(): void {
    // A redraw (language, theme, install prompt) keeps the settings sheet open if it was.
    const sheetWasOpen = this.settingsEl?.open === true;
    this.settingsEl?.close();
    const t = this.t;
    document.documentElement.lang = this.settings.lang;
    document.documentElement.dir = this.settings.lang === 'fa' ? 'rtl' : 'ltr';
    if (this.settings.theme === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = this.settings.theme;
    document.title = `${t.appName} · ${t.tagline}`;
    clear(this.root);

    const input = h('input', {
      type: 'file',
      accept: 'image/*,video/*,audio/*',
      multiple: true,
      className: 'visually-hidden',
      'data-testid': 'file-input',
    });
    input.addEventListener('change', () => {
      if (input.files?.length) this.addFiles(Array.from(input.files));
      input.value = '';
    });

    // Any file type: phones' photo pickers do not offer .pakkon files.
    const sealedInput = h('input', { type: 'file', className: 'visually-hidden', 'data-testid': 'sealed-input' });
    sealedInput.addEventListener('change', () => {
      const f = sealedInput.files?.[0];
      if (f) void this.openSealedFile(f);
      sealedInput.value = '';
    });

    // On phones: take a photo or video inside Pakkon, so the original never lands in the gallery.
    const camera = h('input', {
      type: 'file',
      accept: 'image/*,video/*',
      capture: 'environment',
      className: 'visually-hidden',
      'data-testid': 'camera-input',
    });
    camera.addEventListener('change', () => {
      if (camera.files?.length) this.addFiles(Array.from(camera.files));
      camera.value = '';
    });
    const touch = window.matchMedia?.('(pointer: coarse)').matches ?? false;

    /** An option as a chip: icon, label and a check mark when on. The real checkbox covers the chip. */
    const chip = (key: 'faces' | 'plates' | 'text' | 'extra' | 'mute' | 'voice' | 'people' | 'light' | 'autoWipe', label: string, ic: string[]) => {
      const box = h('input', { type: 'checkbox', checked: this.settings[key], 'data-testid': `opt-${key}` });
      box.addEventListener('change', () => {
        this.settings[key] = box.checked;
        saveSettings(this.settings);
        this.refreshProtection();
        if (key === 'autoWipe') return;
        for (const it of this.items) if (it.media !== 'image' && it.status === 'ready') this.updateCard(it);
        void this.rerenderAll();
      });
      return h('label', { className: 'chip' }, box, h('span', { className: 'chip-icon' }, icon(ic, 18)), h('span', { className: 'chip-label' }, label), h('span', { className: 'chip-check' }, icon(ICONS.check, 14)));
    };

    const langBtn = h('button', { type: 'button', className: 'icon-btn text', lang: this.settings.lang === 'fa' ? 'en' : 'fa' }, t.langSwitch);
    langBtn.addEventListener('click', () => {
      this.settings.lang = this.settings.lang === 'fa' ? 'en' : 'fa';
      saveSettings(this.settings);
      this.cards.clear();
      for (const p of this.previews.values()) p.release();
      this.previews.clear();
      this.render();
    });

    const themes: Theme[] = ['system', 'light', 'dark'];
    const themeIcon = { system: ICONS.auto, light: ICONS.sun, dark: ICONS.moon }[this.settings.theme];
    const themeBtn = h('button', { type: 'button', className: 'icon-btn', title: t.themeNames[this.settings.theme], 'aria-label': t.themeNames[this.settings.theme], 'data-testid': 'theme' }, icon(themeIcon, 20));
    themeBtn.addEventListener('click', () => {
      this.settings.theme = themes[(themes.indexOf(this.settings.theme) + 1) % themes.length]!;
      saveSettings(this.settings);
      this.render();
    });

    const wipeBtn = h('button', { type: 'button', className: 'icon-btn danger', title: t.wipe, 'aria-label': t.wipe, 'data-testid': 'wipe' }, icon(ICONS.wipe, 20));
    wipeBtn.addEventListener('click', () => this.wipeAll());

    const standalone = window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
    let installEl: HTMLElement | null = null;
    if (!standalone && this.installPrompt) {
      installEl = h('button', { type: 'button', className: 'btn ghost small install' }, icon(ICONS.save, 18), t.install);
      installEl.addEventListener('click', () => {
        void this.installPrompt?.prompt?.();
        this.installPrompt = undefined;
        this.render();
      });
    }

    this.listEl = h('section', { className: 'items', 'aria-live': 'polite' });
    for (const entry of this.opened) this.listEl.appendChild(this.sealedCard(entry));
    for (const item of this.items) {
      this.listEl.appendChild(this.cardFor(item));
      this.updateCard(item);
    }
    this.bulkEl = h('div', { className: 'bulk' });
    this.toastEl = h('div', { className: 'toast', role: 'status', 'aria-live': 'polite', 'data-testid': 'toast' });

    const hero = h(
      'section',
      { className: 'hero picker' },
      h('div', { className: 'hero-art', 'aria-hidden': 'true' }, icon(ICONS.shield, 40)),
      h('h2', { className: 'hero-title' }, t.heroTitle),
      h('p', { className: 'hero-text' }, t.heroText),
      h('label', { className: 'pick-btn' }, input, icon(ICONS.plus, 26), h('span', {}, t.pickAny)),
      touch ? h('label', { className: 'pick-btn secondary', 'data-testid': 'camera-button' }, camera, icon(ICONS.camera, 22), h('span', {}, t.takePhoto)) : null,
      touch ? h('p', { className: 'hint small' }, t.takePhotoHint) : h('p', { className: 'hint' }, t.pickHint),
    );
    this.bindDrop(hero);

    // All switches live in a sheet; the page shows only the protection level and what is on.
    const settings = h(
      'dialog',
      { className: 'settings-sheet', 'data-testid': 'settings', 'aria-labelledby': 'settings-title' },
      h(
        'div',
        { className: 'sheet-head' },
        h('h2', { id: 'settings-title' }, t.settingsTitle),
        h('button', { type: 'button', className: 'btn primary small', 'data-testid': 'settings-done', onclick: () => settings.close() }, t.settingsDone),
      ),
      h(
        'div',
        { className: 'options' },
        h('p', { className: 'group' }, t.protectTitle),
        this.presetPicker(),
        h('p', { className: 'group' }, t.groupCover),
        h(
          'div',
          { className: 'chips' },
          chip('faces', t.optFaces, ICONS.face),
          chip('plates', t.optPlates, ICONS.car),
          chip('text', t.optText, ICONS.text),
          chip('people', t.optPeople, ICONS.person),
        ),
        h('p', { className: 'group' }, t.groupStyle),
        this.stylePicker(),
        h('p', { className: 'group' }, t.groupSoundAll),
        h('div', { className: 'chips' }, chip('voice', t.optVoice, ICONS.mic), chip('mute', t.optMute, ICONS.muteIcon)),
        h('p', { className: 'group' }, t.groupMore),
        h('div', { className: 'chips' }, chip('light', t.optLight, ICONS.feather), chip('extra', t.optExtra, ICONS.shield), chip('autoWipe', t.optAutoWipe, ICONS.timer)),
        h('p', { className: 'hint small' }, t.extraHint),
      ),
    );
    // Tapping the dimmed area outside the sheet closes it.
    settings.addEventListener('click', (e) => {
      if (e.target === settings) settings.close();
    });
    settings.addEventListener('close', () => this.refreshProtection());
    this.settingsEl = settings;
    const openSettings = h('button', { type: 'button', className: 'btn small', 'data-testid': 'open-settings' }, icon(ICONS.edit, 16), t.openSettings);
    openSettings.addEventListener('click', () => {
      // Each switch reflects the current settings (a preset may have changed several).
      this.syncSettingsSheet();
      settings.showModal();
    });
    this.protectEl = h('div', { className: 'protect-summary', 'data-testid': 'protect-summary' });
    const protect = h(
      'section',
      { className: 'protect' },
      h('div', { className: 'protect-head' }, h('span', { className: 'protect-icon' }, icon(ICONS.shield, 20)), h('p', { className: 'protect-title' }, t.protectTitle), openSettings),
      this.protectEl,
    );
    this.refreshProtection();

    append(
      this.root,
      h(
        'header',
        { className: 'top' },
        h('div', { className: 'brand' }, h('span', { className: 'logo' }, icon(ICONS.eraser, 24)), h('div', {}, h('h1', {}, t.appName), h('p', {}, t.tagline))),
        h('div', { className: 'top-actions' }, themeBtn, wipeBtn, langBtn),
      ),
      h(
        'p',
        { className: 'badge', 'data-testid': 'offline-badge' },
        icon(ICONS.lock, 16),
        h('span', {}, t.offlineBadge, this.offlineReady ? h('span', { className: 'ready' }, ` · ${t.offlineReady}`) : null),
      ),
      this.introCard(standalone),
      hero,
      protect,
      this.bulkEl,
      this.listEl,
      settings,
      h('details', { className: 'info' }, h('summary', {}, t.howTitle), h('ul', {}, ...t.how.map((x) => h('li', {}, x)))),
      h('details', { className: 'info' }, h('summary', {}, t.limitsTitle), h('ul', {}, ...t.limits.map((x) => h('li', {}, x)))),
      h('label', { className: 'link open-sealed' }, sealedInput, t.openSealedLink),
      installEl,
      h(
        'footer',
        {},
        h('p', {}, t.footer, ' · ', h('a', { href: 'https://www.pouyam.com', rel: 'noopener', target: '_blank' }, 'pouyam.com')),
        h('p', { className: 'small' }, t.dataCredit),
      ),
      this.toastEl,
    );
    this.updateBulk();
    if (sheetWasOpen) {
      this.syncSettingsSheet();
      settings.showModal();
    }
  }

  private toastEl: HTMLElement | undefined;

  private toast(message: string): void {
    const el = this.toastEl;
    if (!el) return;
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
  }

  private toastTimer: ReturnType<typeof setTimeout> | undefined;

  /** First visit: three short steps, and how to install the app on this phone. Dismissed for good. */
  private introCard(standalone: boolean): HTMLElement | null {
    let done = false;
    try {
      done = localStorage.getItem('pakkon-intro') === 'done';
    } catch {
      // Storage blocked: show it (it can be closed for this visit).
    }
    if (done || this.introClosed) return null;
    const t = this.t;
    const isIos = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const isAndroid = /Android/.test(navigator.userAgent);
    const close = h('button', { type: 'button', className: 'btn primary small', 'data-testid': 'intro-done' }, t.introDone);
    const card = h(
      'section',
      { className: 'intro', 'data-testid': 'intro' },
      h('h2', {}, icon(ICONS.sparkle, 20), t.introTitle),
      h('ol', { className: 'steps' }, ...t.introSteps.map((x, i) => h('li', {}, h('span', { className: 'step-n' }, formatNumber(this.settings.lang, i + 1)), h('span', {}, x)))),
      !standalone && isIos ? h('p', { className: 'hint small' }, t.introInstallIos) : null,
      !standalone && isAndroid ? h('p', { className: 'hint small' }, t.introInstallAndroid) : null,
      close,
    );
    close.addEventListener('click', () => {
      this.introClosed = true;
      try {
        localStorage.setItem('pakkon-intro', 'done');
      } catch {
        // Not important.
      }
      card.classList.add('leaving');
      setTimeout(() => card.remove(), 250);
    });
    return card;
  }

  private introClosed = false;

  /**
   * Forgets everything in this tab at once: originals, safe copies, opened sealed files and previews.
   * For when the phone may be taken; also run by "auto-forget".
   */
  wipeAll(): void {
    // Close anything showing an original first (the cover editor, passphrase sheets, settings).
    for (const close of [...openViews]) close();
    this.settingsEl?.close();
    for (const item of this.items) {
      item.abort?.abort();
      if (item.output) URL.revokeObjectURL(item.output.url);
      if (item.decoded) URL.revokeObjectURL(item.decoded.url);
    }
    this.items.length = 0;
    for (const p of this.previews.values()) p.release();
    this.previews.clear();
    this.cards.clear();
    for (const o of this.opened) if (o.url) URL.revokeObjectURL(o.url);
    this.opened.length = 0;
    clear(this.listEl);
    this.updateBulk();
    this.toast(this.t.wiped);
  }

  /** Auto-forget: wipe when the app has been in the background for a while. */
  watchBackground(): void {
    let hiddenAt: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        if (!this.settings.autoWipe) return;
        hiddenAt = Date.now();
        timer = setTimeout(() => this.settings.autoWipe && this.wipeAll(), AUTO_WIPE_MS);
      } else {
        clearTimeout(timer);
        if (hiddenAt !== undefined && this.settings.autoWipe && Date.now() - hiddenAt >= AUTO_WIPE_MS) this.wipeAll();
        hiddenAt = undefined;
      }
    });
  }

  private settingsEl: HTMLDialogElement | undefined;
  /** Cards whose "More" actions are shown, and whose list of leaks was opened or closed by the user. */
  private readonly moreOpen = new Set<number>();
  private readonly findingsOpen = new Map<number, boolean>();
  private protectEl: HTMLElement | undefined;

  /** The protection level and the switches that are on, in one line under the picker. */
  private refreshProtection(): void {
    const el = this.protectEl;
    if (!el) return;
    const t = this.t;
    clear(el);
    const preset = presetOf(this.settings);
    el.appendChild(h('p', { className: 'protect-level', 'data-preset': preset }, h('strong', {}, t.presets[preset].name), ' · ', t.presets[preset].text));
    const on = SUMMARY_KEYS.filter((k) => this.settings[k]).map((k) => t.summaryNames[k]);
    el.appendChild(h('p', { className: 'protect-on' }, t.summaryOn(on.join(t.listJoin)), ' · ', t.styleNames[this.settings.maskStyle]));
    for (const r of this.settingsEl?.querySelectorAll<HTMLInputElement>('input[name="preset"]') ?? []) r.checked = r.value === preset;
  }

  /** Makes every switch in the settings sheet show the current settings. */
  private syncSettingsSheet(): void {
    for (const box of this.settingsEl?.querySelectorAll<HTMLInputElement>('input[data-testid^="opt-"]') ?? []) {
      const key = box.dataset.testid!.slice(4) as keyof Settings;
      box.checked = this.settings[key] === true;
    }
    this.refreshProtection();
  }

  /** Standard, strong or maximum: sets the cover and sound switches at once. */
  private presetPicker(): HTMLElement {
    const t = this.t;
    const row = h('div', { className: 'presets', role: 'radiogroup', 'aria-label': t.protectTitle });
    for (const p of ['standard', 'strong', 'max'] as const) {
      const input = h('input', { type: 'radio', name: 'preset', value: p, checked: presetOf(this.settings) === p, 'data-testid': `preset-${p}` });
      input.addEventListener('change', () => {
        if (!input.checked) return;
        Object.assign(this.settings, PRESETS[p]);
        saveSettings(this.settings);
        this.syncSettingsSheet();
        for (const it of this.items) if (it.media !== 'image' && it.status === 'ready') this.updateCard(it);
        void this.rerenderAll();
      });
      row.appendChild(h('label', { className: `preset preset-${p}` }, input, h('span', { className: 'preset-name' }, t.presets[p].name), h('span', { className: 'preset-text' }, t.presets[p].text)));
    }
    return row;
  }

  /** Three small swatches to choose how covers look. */
  private stylePicker(): HTMLElement {
    const t = this.t;
    const row = h('div', { className: 'styles', role: 'radiogroup', 'aria-label': t.groupStyle });
    for (const style of MASK_STYLES) {
      const input = h('input', { type: 'radio', name: 'mask-style', value: style, checked: this.settings.maskStyle === style, 'data-testid': `style-${style}` });
      input.addEventListener('change', () => {
        if (!input.checked) return;
        this.settings.maskStyle = style;
        saveSettings(this.settings);
        this.refreshProtection();
        for (const it of this.items) if (it.media === 'video' && it.status === 'ready') this.updateCard(it);
        void this.rerenderAll();
      });
      row.appendChild(h('label', { className: `style-option style-${style}` }, input, h('span', { className: 'swatch', 'aria-hidden': 'true' }), h('span', {}, t.styleNames[style])));
    }
    return row;
  }

  private bindDrop(zone: HTMLElement): void {
    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      zone.classList.add('drag');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('drag');
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length) this.addFiles(files);
    });
  }

  private cardFor(item: Item): HTMLElement {
    let card = this.cards.get(item.id);
    if (!card) {
      card = h('article', { className: 'card', 'data-testid': 'item' });
      this.cards.set(item.id, card);
    }
    return card;
  }

  private async rerenderAll(): Promise<void> {
    // Loop over a copy: the list may change while we work.
    for (const item of [...this.items]) await this.refresh(item);
  }

  /**
   * Makes sure a photo's safe copy matches the current options. If the options change while a copy is being
   * made, it is made again, so what is shown, summarised and shared always matches the switches.
   */
  private async refresh(item: Item, force = false): Promise<void> {
    if (item.media !== 'image' || !item.decoded) return;
    if (item.busy) {
      item.stale = true;
      return;
    }
    if (item.status !== 'ready' || (!force && sameOptions(item.renderedWith, this.settings))) return;
    item.busy = true;
    try {
      do {
        item.stale = false;
        await this.rerender(item);
      } while (item.status === 'ready' && (item.stale || !sameOptions(item.renderedWith, this.settings)));
    } finally {
      item.busy = false;
    }
  }

  private async rerender(item: Item): Promise<void> {
    try {
      if (this.settings.text && !item.textDetected) {
        item.status = 'detecting';
        this.updateCard(item);
        await ensureText(item, this.detector);
      }
      if (this.settings.people && !item.peopleDetected) {
        item.status = 'detecting';
        this.updateCard(item);
        await ensurePeople(item, this.detector);
      }
      item.status = 'cleaning';
      this.updateCard(item);
      await renderImage(item, this.settings);
      if (!this.items.includes(item)) {
        // Wiped or removed while this copy was being made: forget it.
        if (item.output) URL.revokeObjectURL(item.output.url);
        delete item.output;
        return;
      }
      item.status = 'ready';
    } catch (e) {
      console.error(e);
      item.status = 'error';
      item.error = 'generic';
      item.errorDetail = (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 300);
    }
    if (!this.items.includes(item)) return;
    this.updateCard(item);
  }

  private statusText(item: Item): string {
    const t = this.t;
    switch (item.status) {
      case 'queued':
      case 'reading':
        return t.statusReading;
      case 'detecting':
        return item.progress === 0 ? `${t.statusDetecting} ${t.statusLoadingModels}` : t.statusDetecting;
      case 'cleaning':
        return t.statusCleaning;
      case 'ready':
        return t.statusReady;
      case 'error':
        return '';
    }
  }

  private updateCard(item: Item): void {
    if (!this.items.includes(item)) return;
    const t = this.t;
    const lang = this.settings.lang;
    const card = this.cardFor(item);
    clear(card);
    card.dataset.status = item.status;

    // Preview: always the safe copy once it exists, so the user checks exactly what will be sent.
    // While the copy stays the same, the same preview (and its compare button) is kept, so a card refresh
    // (for example when a background check finishes) never interrupts a press or reloads the picture.
    const key = `${item.status}|${item.output?.url ?? ''}|${this.settings.lang}`;
    const cached = this.previews.get(item.id);
    if (cached && cached.key === key) {
      cached.update?.(item);
      card.appendChild(cached.el);
    } else {
      if (cached) cached.release();
      const built = this.buildPreview(item);
      this.previews.set(item.id, { key, ...built });
      card.appendChild(built.el);
    }

    const body = h('div', { className: 'card-body' });
    card.appendChild(body);

    if (item.status === 'error') {
      const msg = {
        unsupported: t.errUnsupported,
        tooLarge: t.errTooLarge,
        leftovers: t.errLeftovers,
        video: t.errVideo,
        audio: t.errAudio,
        videoMask: t.errVideoMask,
        voice: t.errVoice,
        cancelled: t.errCancelled,
        generic: t.errGeneric,
      }[item.error ?? 'generic'];
      body.appendChild(h('p', { className: 'error', role: 'alert', 'data-testid': 'item-error' }, msg));
      if (item.error === 'voice') {
        const choose = (o: 'mute' | 'keep', label: string, id: string) => {
          const b = h('button', { type: 'button', className: 'btn', 'data-testid': id }, label);
          b.addEventListener('click', () => {
            item.soundOverride = o;
            item.status = 'queued';
            delete item.error;
            this.updateCard(item);
            this.enqueue(item);
          });
          return b;
        };
        body.appendChild(
          h('div', { className: 'actions' }, item.media === 'audio' ? null : choose('mute', t.voiceInsteadMute, 'voice-mute'), choose('keep', t.voiceKeep, 'voice-keep')),
        );
      }
      if (item.error === 'videoMask') {
        const go = h('button', { type: 'button', className: 'btn', 'data-testid': 'continue-without' }, t.continueWithout);
        go.addEventListener('click', () => {
          item.skipVideoMasks = true;
          item.status = 'queued';
          delete item.error;
          this.updateCard(item);
          this.enqueue(item);
        });
        body.appendChild(go);
      }
      if (item.errorDetail) {
        body.appendChild(h('details', { className: 'detail' }, h('summary', {}, t.errorDetails), h('code', { dir: 'ltr' }, item.errorDetail)));
      }
    } else {
      const n = item.progress !== undefined && item.status !== 'ready' ? Math.round(item.progress * 100) : undefined;
      const pct = n === undefined ? '' : ` ${formatNumber(lang, n)}${lang === 'fa' ? '٪' : '%'}`;
      const left = item.progress !== undefined && item.status !== 'ready' ? secondsLeft(item.clock, item.progress, Date.now()) : undefined;
      body.appendChild(
        h('p', { className: `status ${item.status}`, 'data-testid': 'item-status' }, item.status === 'ready' ? icon(ICONS.check, 18) : null, this.statusText(item) + pct),
      );
      if (left !== undefined) {
        const m = minutesLeft(left);
        body.appendChild(h('p', { className: 'note eta', 'data-testid': 'time-left' }, m === 0 ? t.etaSoon : t.etaMinutes(formatNumber(lang, m))));
      }
      if (item.abort) {
        const cancel = h('button', { type: 'button', className: 'btn ghost small', 'data-testid': 'cancel' }, t.cancel);
        cancel.addEventListener('click', () => item.abort?.abort());
        body.appendChild(cancel);
      }
    }

    if (item.status === 'ready' && item.output) {
      body.appendChild(this.reportChips(item));
      body.appendChild(
        h('p', { className: 'size-line', 'data-testid': 'size-line' }, icon(ICONS.data, 15), t.sizeLine(formatSize(lang, item.file.size, t), formatSize(lang, item.output.blob.size, t))),
      );
      if (item.media === 'audio') {
        body.appendChild(h('p', { className: 'note', 'data-testid': 'audio-voice-note' }, item.audioVoiced ? t.audioVoiced : t.audioKeptVoice));
        if (item.audioVoiced && this.settings.mute && !this.settings.voice) body.appendChild(h('p', { className: 'note', 'data-testid': 'audio-mute-note' }, t.audioMuteMeansVoice));
        if (item.droppedPicture) body.appendChild(h('p', { className: 'warn', 'data-testid': 'audio-picture-note' }, t.audioPictureDropped));
        if (!upToDate(item, this.settings)) body.appendChild(this.rebuildButton(item, t.rebuildAudio));
      } else if (item.media === 'image') {
        // Count from the options this copy was really made with.
        const used = item.renderedWith ?? this.settings;
        const count = (kind: 'face' | 'plate' | 'text' | 'person') => item.detections.filter((d, i) => d.kind === kind && !item.removed.has(i)).length;
        const faces = used.faces ? count('face') : 0;
        const plates = used.plates ? count('plate') : 0;
        const texts = used.text ? count('text') : undefined;
        const people = used.people ? count('person') : undefined;
        body.appendChild(h('p', { className: 'masks', 'data-testid': 'mask-summary' }, t.masksSummary(faces, plates, item.manual.length, texts, people)));
        const crowd = Math.max(count('face'), item.peopleDetected ? count('person') : 0);
        if (crowd >= 10) body.appendChild(h('p', { className: 'note', 'data-testid': 'crowd' }, t.crowdCount(formatNumber(lang, crowd))));
        const risks = locationRisks(item, used);
        if (risks.length) {
          body.appendChild(h('p', { className: 'warn', 'data-testid': 'location-risk' }, risks.map((r) => (r === 'text' ? t.riskText : r === 'plates' ? t.riskPlates : t.riskUnchecked)).join(' ')));
        }
        if (item.detectFailed) body.appendChild(h('p', { className: 'warn' }, t.errDetect));
        if (used.extra) body.appendChild(h('p', { className: 'note', 'data-testid': 'extra-note' }, t.extraApplied));
        body.appendChild(h('p', { className: 'note' }, t.checkShort));
      } else {
        // Say exactly what this video was made with.
        const made = item.videoMadeWith;
        const kinds = (['faces', 'plates', 'text', 'people'] as const).filter((k) => made?.[k]);
        const off = (['faces', 'plates'] as const).filter((k) => !made?.[k]);
        const videoNote =
          item.videoMasks === 'covered'
            ? t.videoCovered(kinds.map((k) => t.kindNames[k]).join(t.listJoin))
            : item.videoMasks === 'unavailable'
              ? t.videoMasksUnavailable
              : t.videoMasksOff;
        body.appendChild(h('p', { className: item.videoMasks === 'covered' ? 'note' : 'warn', 'data-testid': 'video-masks', 'data-state': item.videoMasks ?? 'off' }, videoNote));
        if (item.videoMasks === 'covered' && off.length) {
          body.appendChild(h('p', { className: 'warn', 'data-testid': 'video-uncovered' }, t.videoUncovered(off.map((k) => t.kindNames[k]).join(t.listJoin))));
        }
        if (item.droppedTracks > 0) body.appendChild(h('p', { className: 'note' }, t.videoDropped(item.droppedTracks)));
        if (item.videoMadeWith?.mute) body.appendChild(h('p', { className: 'note', 'data-testid': 'muted-note' }, t.videoMuted));
        if (item.videoMadeWith?.voice && item.audioKept) body.appendChild(h('p', { className: 'note', 'data-testid': 'voice-note' }, t.videoVoiced));
        if (!item.videoMadeWith?.mute && item.audioKept === false) body.appendChild(h('p', { className: 'note', 'data-testid': 'no-sound-note' }, t.videoNoSound));
        if (item.videoMadeWith?.light && item.lightApplied === false) body.appendChild(h('p', { className: 'note', 'data-testid': 'light-unavailable' }, t.lightUnavailable));
        if (!upToDate(item, this.settings)) body.appendChild(this.rebuildButton(item, t.rebuildVideo));
      }
      if (item.needsReview) body.appendChild(this.reviewGate(item));
      else body.appendChild(this.actions(item));
    }

    if (item.sealCode) {
      body.appendChild(h('p', { className: 'note', 'data-testid': 'sealed-note' }, t.sealedDone, ' ', h('code', { dir: 'ltr', className: 'hash' }, item.sealCode)));
    }
    if (item.findings.length || item.status === 'ready') body.appendChild(this.findingsView(item));
    if (item.status === 'ready') {
      body.appendChild(
        h('details', { className: 'checklist', 'data-testid': 'checklist' }, h('summary', {}, t.checklistTitle), h('ul', {}, ...t.checklist.map((c) => h('li', {}, c)))),
      );
    }

    if (item.status === 'ready' || item.status === 'error') {
      const rm = h('button', { type: 'button', className: 'link' }, t.remove);
      rm.addEventListener('click', () => this.removeItem(item));
      body.appendChild(rm);
    }
    this.updateBulk();
  }

  private rebuildButton(item: Item, label: string): HTMLElement {
    const again = h('button', { type: 'button', className: 'btn ghost small', 'data-testid': 'rebuild' }, label);
    again.addEventListener('click', () => {
      if (item.output) URL.revokeObjectURL(item.output.url);
      delete item.output;
      item.status = 'queued';
      this.updateCard(item);
      this.enqueue(item);
    });
    return again;
  }

  /** At a glance: which kinds of hidden data were removed, and what was covered or changed. */
  private reportChips(item: Item): HTMLElement {
    const t = this.t;
    const lang = this.settings.lang;
    const row = h('div', { className: 'report', 'data-testid': 'report' });
    const add = (kind: string, ic: string[], label: string) => row.appendChild(h('span', { className: `report-chip ${kind}`, 'data-kind': kind }, icon(ic, 15), label));
    const ids = new Set(item.findings.map((f) => f.id));
    const has = (...xs: FindingId[]) => xs.some((x) => ids.has(x));
    if (has('gps', 'videoLocation', 'cityName')) add('location', ICONS.pin, t.report.location);
    if (has('deviceModel', 'serialNumber', 'lens', 'software', 'uniqueId', 'makerNotes', 'owner')) add('device', ICONS.phone, t.report.device);
    if (has('dateTaken', 'timeZone')) add('time', ICONS.clock, t.report.time);
    const others = item.findings.filter(
      (f) => !['gps', 'videoLocation', 'cityName', 'deviceModel', 'serialNumber', 'lens', 'software', 'uniqueId', 'makerNotes', 'owner', 'dateTaken', 'timeZone'].includes(f.id),
    );
    if (others.length) add('other', ICONS.data, t.report.other);
    if (!item.findings.length) add('clean', ICONS.check, t.report.clean);
    const n = (x: number) => formatNumber(lang, x);
    if (item.media === 'image') {
      const used = item.renderedWith ?? this.settings;
      const count = (kind: 'face' | 'plate' | 'text' | 'person') => item.detections.filter((d, i) => d.kind === kind && !item.removed.has(i)).length;
      const faces = used.faces ? count('face') : 0;
      const plates = used.plates ? count('plate') : 0;
      const texts = used.text ? count('text') : 0;
      const people = used.people ? count('person') : 0;
      if (faces) add('cover', ICONS.face, t.report.faces(n(faces)));
      if (plates) add('cover', ICONS.car, t.report.plates(n(plates)));
      if (texts) add('cover', ICONS.text, t.report.texts(n(texts)));
      if (people) add('cover', ICONS.person, t.report.people(n(people)));
    } else if (item.media === 'video') {
      if (item.videoMadeWith?.mute) add('sound', ICONS.muteIcon, t.report.muted);
      else if (item.videoMadeWith?.voice && item.audioKept) add('sound', ICONS.mic, t.report.voice);
    } else if (item.audioVoiced) {
      add('sound', ICONS.mic, t.report.voice);
    }
    return row;
  }

  /** Shown instead of Share/Save when automatic covering failed: cover by hand, or confirm. */
  private reviewGate(item: Item): HTMLElement {
    const t = this.t;
    const row = h('div', { className: 'actions' });
    const edit = h('button', { type: 'button', className: 'btn primary', 'data-testid': 'edit' }, icon(ICONS.edit), t.editMasks);
    edit.addEventListener('click', async () => {
      if (await openEditor(item, this.settings, t)) {
        item.needsReview = false;
        await this.refresh(item, true);
      }
    });
    const anyway = h('button', { type: 'button', className: 'btn ghost', 'data-testid': 'use-anyway' }, t.useAnyway);
    anyway.addEventListener('click', () => {
      item.needsReview = false;
      this.updateCard(item);
    });
    row.append(edit, anyway);
    return h('div', { className: 'review', role: 'alert' }, h('p', { className: 'warn' }, t.reviewNeeded), row);
  }

  private buildPreview(item: Item): { el: HTMLElement; release: () => void; update?: (item: Item) => void } {
    const t = this.t;
    const wrap = h('div', { className: 'preview-wrap' });
    if (item.output && item.media === 'image') {
      const img = h('img', { src: item.output.url, alt: t.statusReady, className: 'preview', 'data-testid': 'output-image' });
      wrap.appendChild(img);
      // Drag across the picture to see the original beside the safe copy; letting go slides it away again.
      // The original is only ever on this screen; the safe copy's link never changes.
      if (item.status === 'ready' && item.decoded) return { el: this.compareSlider(wrap, item.decoded.url), release: () => wrap.removeAttribute('data-revealing') };
      return { el: wrap, release: () => undefined };
    }
    if (item.output && item.media === 'video') {
      const video = h('video', { src: item.output.url, controls: true, playsinline: true, preload: 'metadata', className: 'preview' });
      wrap.appendChild(video);
      const strip = h('div', { className: 'filmstrip', 'data-testid': 'filmstrip', 'aria-label': t.filmstripTitle });
      const box = h('div', { className: 'filmstrip-box' }, h('p', { className: 'hint small' }, t.filmstripTitle), strip);
      let cancelled = false;
      void buildFilmstrip(item.output.url, strip, video, () => cancelled);
      return { el: h('div', {}, wrap, box), release: () => (cancelled = true) };
    }
    if (item.output && item.media === 'audio') {
      const canvas = h('canvas', { className: 'waveform', width: 640, height: 120, 'aria-hidden': 'true', 'data-testid': 'waveform' });
      const audio = h('audio', { src: item.output.url, controls: true, preload: 'metadata', className: 'audio-player' });
      const box = h('div', { className: 'audio-preview' }, h('span', { className: 'audio-icon' }, icon(ICONS.mic, 28)), canvas, audio);
      wrap.appendChild(box);
      void drawWaveform(item.output.blob, canvas);
      return { el: wrap, release: () => undefined };
    }
    // While working: a ring that fills with the progress (or a spinner before progress is known).
    const ph = h('div', { className: 'preview placeholder' });
    wrap.appendChild(ph);
    const update = (it: Item) => {
      clear(ph);
      if (it.status === 'error') ph.appendChild(icon(ICONS.alert, 32));
      else if (it.progress !== undefined && it.progress > 0) ph.appendChild(progressRing(it.progress, this.settings.lang));
      else ph.appendChild(h('div', { className: 'spinner' }));
    };
    update(item);
    return { el: wrap, release: () => undefined, update };
  }

  /** Before/after: the original appears on one side of a divider that follows the finger, then slides away. */
  private compareSlider(wrap: HTMLElement, originalUrl: string): HTMLElement {
    const t = this.t;
    const orig = h('img', { src: originalUrl, alt: '', className: 'original-layer', 'aria-hidden': 'true', draggable: 'false' });
    const handle = h('button', { type: 'button', className: 'compare-handle', 'data-testid': 'compare', 'aria-label': t.dragToCompare }, h('span', { className: 'grip' }), h('span', { className: 'compare-label' }, t.dragToCompare));
    wrap.classList.add('compare');
    wrap.append(orig, h('div', { className: 'divider', 'aria-hidden': 'true' }), handle);
    const setAt = (clientX: number) => {
      const r = wrap.getBoundingClientRect();
      const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
      wrap.style.setProperty('--reveal', `${(f * 100).toFixed(2)}%`);
    };
    const end = () => {
      wrap.removeAttribute('data-revealing');
      wrap.style.setProperty('--reveal', '0%');
    };
    const begin = (e: PointerEvent) => {
      e.preventDefault();
      wrap.setAttribute('data-revealing', 'true');
      setAt(e.clientX);
      const move = (ev: PointerEvent) => setAt(ev.clientX);
      window.addEventListener('pointermove', move);
      const stop = () => {
        window.removeEventListener('pointermove', move);
        end();
      };
      // Letting go anywhere (or the browser taking the gesture) shows the safe copy again.
      window.addEventListener('pointerup', stop, { once: true });
      window.addEventListener('pointercancel', stop, { once: true });
    };
    handle.addEventListener('pointerdown', begin);
    wrap.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (e.target === handle || handle.contains(e.target as Node)) return;
      begin(e);
    });
    handle.addEventListener('keydown', (e) => {
      if (e.key !== ' ' && e.key !== 'Enter') return;
      e.preventDefault();
      wrap.setAttribute('data-revealing', 'true');
      wrap.style.setProperty('--reveal', '50%');
    });
    handle.addEventListener('keyup', end);
    handle.addEventListener('blur', end);
    return wrap;
  }

  private actions(item: Item): HTMLElement {
    const t = this.t;
    const out = item.output!;
    const file = () => new File([out.blob], out.name, { type: out.blob.type, lastModified: Date.now() });
    const row = h('div', { className: 'actions' });
    if (canShareFiles([file()])) {
      const share = h('button', { type: 'button', className: 'btn primary', 'data-testid': 'share' }, icon(ICONS.share), t.share);
      share.addEventListener('click', () => void shareOrSave([file()]));
      row.appendChild(share);
    }
    const save = h('a', { className: 'btn', href: out.url, download: out.name, 'data-testid': 'save' }, icon(ICONS.save), t.save);
    row.appendChild(save);
    // Less frequent actions wait behind "More", so the card stays calm.
    // Stays open across card refreshes (a background check may redraw the card at any time).
    const isOpen = this.moreOpen.has(item.id);
    const more = h('div', { className: 'more-row', hidden: !isOpen });
    const moreBtn = h('button', { type: 'button', className: `btn ghost${isOpen ? ' open' : ''}`, 'data-testid': 'more-actions', 'aria-expanded': String(isOpen) }, t.moreActions);
    moreBtn.addEventListener('click', () => {
      more.hidden = !more.hidden;
      if (more.hidden) this.moreOpen.delete(item.id);
      else this.moreOpen.add(item.id);
      moreBtn.setAttribute('aria-expanded', String(!more.hidden));
      moreBtn.classList.toggle('open', !more.hidden);
    });
    const sealBtn = h('button', { type: 'button', className: 'btn ghost', 'data-testid': 'seal' }, icon(ICONS.lock), t.sealOriginal);
    sealBtn.addEventListener('click', async () => {
      if (item.file.size > MAX_SEAL_BYTES) {
        alert(t.errSealTooLarge);
        return;
      }
      const r = await sealOriginal(item.file, t).catch((e: unknown) => {
        console.error(e);
        return null;
      });
      if (!r) return;
      item.sealCode = r.header.code;
      this.updateCard(item);
      await shareOrSave([r.file], true);
    });
    more.appendChild(sealBtn);
    if (item.media === 'image' && item.decoded) {
      const edit = h('button', { type: 'button', className: 'btn ghost', 'data-testid': 'edit' }, icon(ICONS.edit), t.editMasks);
      edit.addEventListener('click', async () => {
        if (await openEditor(item, this.settings, t)) await this.refresh(item, true);
      });
      row.appendChild(edit);
      // Phone screenshots: one tap covers the status bar, or the whole chat header with the contact's name and picture.
      const tops: [Rect | undefined, string, string][] = [
        [statusBarRect(item), t.coverStatusBar, 'cover-status-bar'],
        [chatHeaderRect(item), t.coverChatHeader, 'cover-chat-header'],
      ];
      for (const [rect, label, id] of tops) {
        if (!rect || item.manual.some((m) => m.x === 0 && m.y === 0 && m.w === rect.w && m.h >= rect.h)) continue;
        const cover = h('button', { type: 'button', className: 'btn ghost', 'data-testid': id }, label);
        cover.addEventListener('click', async () => {
          item.manual.push(rect);
          await this.refresh(item, true);
        });
        // A phone screenshot: these are likely needed, so they stay in view.
        row.appendChild(cover);
      }
    }
    row.appendChild(moreBtn);
    return h('div', {}, row, more);
  }

  private findingsView(item: Item): HTMLElement {
    const t = this.t;
    const lang = this.settings.lang;
    const box = h('div', { className: 'findings', 'data-testid': 'findings' });
    if (!item.findings.length) {
      box.appendChild(h('p', { className: 'note' }, t.revealedNone));
      return box;
    }
    const order = { high: 0, medium: 1, low: 2 } as const;
    const sorted = [...item.findings].sort((a, b) => order[a.severity] - order[b.severity]);
    // Folded: one line says how much the file was revealing and the most serious thing; details on a tap.
    const kinds = new Set(sorted.map((f) => f.id));
    const top = sorted[0]?.severity === 'high' ? t.findings[sorted[0].id] : '';
    // Opened by itself when there are signs of editing: for a received photo, that is the point of looking.
    const details = h('details', { className: 'findings-details', 'data-testid': 'findings-details', open: this.findingsOpen.get(item.id) ?? item.hints.length > 0 });
    details.addEventListener('toggle', () => this.findingsOpen.set(item.id, details.open));
    details.appendChild(h('summary', { className: 'findings-title', 'data-testid': 'findings-toggle' }, t.findingsSummary(formatNumber(lang, kinds.size), top)));
    box.appendChild(details);
    const inner = h('div', {});
    details.appendChild(inner);
    const list = h('ul', {});
    // One row per kind of leak; several values of the same kind are shown together.
    const groups = new Map<string, Finding[]>();
    for (const f of sorted) groups.set(f.id, [...(groups.get(f.id) ?? []), f]);
    for (const fs of groups.values()) {
      const withGeo = fs.filter((f) => f.geo);
      if (withGeo.length) {
        for (const f of withGeo) list.appendChild(this.findingRow(f, lang));
        continue;
      }
      const values = [...new Set(fs.map((f) => f.value).filter((v): v is string => Boolean(v)))];
      const merged: Finding = { id: fs[0]!.id, severity: fs[0]!.severity };
      if (values.length) merged.value = values.join(' · ');
      list.appendChild(this.findingRow(merged, lang));
    }
    inner.appendChild(list);
    if (item.hints.length) {
      inner.appendChild(h('p', { className: 'findings-title hints-title' }, t.hintsTitle));
      const hl = h('ul', { 'data-testid': 'hints' });
      for (const x of item.hints) {
        const li = h('li', { className: 'sev-low', 'data-hint': x.id }, h('span', { className: 'label' }, t.hints[x.id]));
        if (x.value) li.appendChild(h('span', { className: 'value', dir: 'auto' }, x.value));
        hl.appendChild(li);
      }
      inner.appendChild(hl);
    }
    if (item.partial) box.appendChild(h('p', { className: 'note' }, t.partialNote));
    if (item.status === 'ready') box.appendChild(h('p', { className: 'removed' }, icon(ICONS.check, 16), t.removedNote));
    return box;
  }

  private findingRow(f: Finding, lang: Lang): HTMLElement {
    const t = this.t;
    const li = h('li', { className: `sev-${f.severity}`, 'data-finding': f.id }, h('span', { className: 'label' }, t.findings[f.id]));
    if (f.geo) {
      const coords = `${f.geo.lat.toFixed(5)}, ${f.geo.lon.toFixed(5)}`;
      const near = this.places ? nearest(this.places, f.geo.lat, f.geo.lon) : undefined;
      li.appendChild(h('span', { className: 'value', dir: 'ltr' }, coords));
      if (near) {
        const place = `${near.name}${lang === 'fa' ? '، ' : ', '}${countryName(lang, near.country)}`;
        li.appendChild(h('span', { className: 'value place' }, t.nearPlace(place, formatNumber(lang, Math.max(1, Math.round(near.km))))));
      }
    } else if (f.value) {
      li.appendChild(h('span', { className: 'value', dir: 'auto' }, f.value));
    }
    return li;
  }

  private removeItem(item: Item): void {
    const i = this.items.indexOf(item);
    if (i >= 0) this.items.splice(i, 1);
    if (item.output) URL.revokeObjectURL(item.output.url);
    if (item.decoded) URL.revokeObjectURL(item.decoded.url);
    this.cards.get(item.id)?.remove();
    this.cards.delete(item.id);
    this.previews.get(item.id)?.release();
    this.previews.delete(item.id);
    this.updateBulk();
  }

  private updateBulk(): void {
    if (!this.bulkEl) return;
    clear(this.bulkEl);
    // Only copies that are ready to send: not waiting for a check, not made with outdated switches.
    const ready = this.items.filter((i) => i.status === 'ready' && i.output && !i.needsReview && upToDate(i, this.settings));
    if (ready.length < 2) return;
    const files = ready.map((i) => new File([i.output!.blob], i.output!.name, { type: i.output!.blob.type }));
    const n = formatNumber(this.settings.lang, ready.length);
    if (canShareFiles(files)) {
      const btn = h('button', { type: 'button', className: 'btn primary wide', 'data-testid': 'share-all' }, icon(ICONS.share), `${this.t.shareAll} (${n})`);
      btn.addEventListener('click', () => void shareOrSave(files));
      this.bulkEl.appendChild(btn);
    }
    // One ZIP file with every safe copy (stored as is, no real dates inside).
    const zip = h('button', { type: 'button', className: 'btn wide', 'data-testid': 'save-zip' }, icon(ICONS.zip), `${this.t.saveZip} (${n})`);
    zip.addEventListener('click', async () => {
      const { makeZip } = await import('../lib/zip');
      let blob: Blob;
      try {
        blob = await makeZip(ready.map((i) => ({ name: i.output!.name, data: i.output!.blob })));
      } catch (e) {
        console.error(e);
        alert(this.t.errTooLarge);
        return;
      }
      saveBlob(blob, randomName('zip').replace(/^img-/, 'pakkon-'));
    });
    this.bulkEl.appendChild(zip);
  }
}

/**
 * For a phone screenshot (a tall PNG), the area of the status bar at the top: time, carrier, battery and
 * notification icons can tell where and when, and which apps someone uses. Undefined for other pictures.
 */
export function statusBarRect(item: Item): { x: number; y: number; w: number; h: number } | undefined {
  const d = item.decoded;
  if (!d || item.outputType !== 'image/png') return undefined;
  if (d.height / d.width < 1.7) return undefined;
  // 12% of the width covers the tallest status bars (iPhones with a notch or Dynamic Island).
  return { x: 0, y: 0, w: d.width, h: Math.round(d.width * 0.12) };
}

/** For a phone screenshot, the top of the screen including a chat header (contact name and picture). */
export function chatHeaderRect(item: Item): Rect | undefined {
  const bar = statusBarRect(item);
  // Messenger headers end about 20-24% of the screen width from the top (status bar + title bar).
  return bar ? { x: 0, y: 0, w: bar.w, h: Math.round(bar.w * 0.25) } : undefined;
}

function canShareFiles(files: File[]): boolean {
  try {
    return typeof navigator.share === 'function' && typeof navigator.canShare === 'function' && navigator.canShare({ files });
  } catch {
    return false;
  }
}

async function shareOrSave(files: File[], saveOnly = false): Promise<void> {
  try {
    // A sealed original is saved, never offered to share to other apps by default.
    if (saveOnly) throw new DOMException('save', 'NotAllowedError');
    await navigator.share({ files });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return; // the user closed the share sheet
    // Sharing not allowed here (for example the click was too long ago): fall back to saving.
    for (const f of files) saveBlob(f, f.name);
  }
}

function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name, 'data-testid': 'download-link' });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** File size in KB or MB, in the interface language's digits. */
function formatSize(lang: Lang, bytes: number, t: Strings): string {
  const mb = bytes >= 1024 * 1024;
  const v = mb ? bytes / (1024 * 1024) : Math.max(1, Math.round(bytes / 1024));
  const num = new Intl.NumberFormat(lang === 'fa' ? 'fa-IR' : 'en-US', { maximumFractionDigits: mb ? 1 : 0 }).format(v);
  return `${num} ${mb ? t.units.mb : t.units.kb}`;
}

/** A ring that fills with progress, with the percentage in the middle. */
function progressRing(fraction: number, lang: Lang): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('class', 'ring');
  svg.setAttribute('data-testid', 'progress-ring');
  const r = 26;
  const len = 2 * Math.PI * r;
  const track = document.createElementNS(NS, 'circle');
  for (const [k, v] of Object.entries({ cx: '32', cy: '32', r: String(r), class: 'ring-track' })) track.setAttribute(k, v);
  const bar = document.createElementNS(NS, 'circle');
  for (const [k, v] of Object.entries({ cx: '32', cy: '32', r: String(r), class: 'ring-bar', 'stroke-dasharray': `${len}`, 'stroke-dashoffset': `${len * (1 - Math.min(1, Math.max(0, fraction)))}` })) {
    bar.setAttribute(k, v);
  }
  const text = document.createElementNS(NS, 'text');
  for (const [k, v] of Object.entries({ x: '32', y: '37', 'text-anchor': 'middle', class: 'ring-text' })) text.setAttribute(k, v);
  text.textContent = `${formatNumber(lang, Math.round(fraction * 100))}${lang === 'fa' ? '٪' : '%'}`;
  svg.append(track, bar, text);
  return svg;
}

/** Frames from across the safe video, to check the covers quickly; tapping one jumps the player there. */
async function buildFilmstrip(url: string, strip: HTMLElement, player: HTMLVideoElement, cancelled: () => boolean, frames = 8): Promise<void> {
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'auto';
  v.src = url;
  try {
    await new Promise<void>((resolve, reject) => {
      v.onloadeddata = () => resolve();
      v.onerror = () => reject(new Error('cannot read video'));
    });
    const d = v.duration;
    if (!Number.isFinite(d) || d <= 0) return;
    const w = 160;
    const hgt = Math.max(1, Math.round((w * v.videoHeight) / Math.max(1, v.videoWidth)));
    for (let i = 0; i < frames; i++) {
      if (cancelled()) return;
      const time = (d * (i + 0.5)) / frames;
      v.currentTime = time;
      await new Promise<void>((resolve) => (v.onseeked = () => resolve()));
      const c = document.createElement('canvas');
      c.width = w;
      c.height = hgt;
      c.getContext('2d')?.drawImage(v, 0, 0, w, hgt);
      const b = h('button', { type: 'button', className: 'frame', 'data-time': time.toFixed(2) }, c);
      b.addEventListener('click', () => {
        player.currentTime = time;
        player.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
      strip.appendChild(b);
    }
  } catch (e) {
    console.warn('filmstrip unavailable', e);
  } finally {
    v.removeAttribute('src');
    v.load();
  }
}

/** Bars showing the loudness of the recording over time (drawn from the safe copy). */
async function drawWaveform(blob: Blob, canvas: HTMLCanvasElement): Promise<void> {
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return;
  const ac = new Ctx();
  try {
    const buf = await ac.decodeAudioData(await blob.arrayBuffer());
    const data = buf.getChannelData(0);
    const bars = 64;
    const per = Math.max(1, Math.floor(data.length / bars));
    const levels: number[] = [];
    for (let b = 0; b < bars; b++) {
      let sum = 0;
      for (let i = b * per; i < Math.min(data.length, (b + 1) * per); i++) sum += data[i]! * data[i]!;
      levels.push(Math.sqrt(sum / per));
    }
    const max = Math.max(1e-6, ...levels);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const css = getComputedStyle(canvas);
    const grad = ctx.createLinearGradient(0, 0, canvas.width, 0);
    grad.addColorStop(0, css.getPropertyValue('--brand').trim() || '#126354');
    grad.addColorStop(1, css.getPropertyValue('--brand-2').trim() || '#2fa58c');
    ctx.fillStyle = grad;
    const bw = canvas.width / bars;
    levels.forEach((l, i) => {
      const bh = Math.max(4, (l / max) * (canvas.height - 8));
      const x = i * bw + bw * 0.2;
      const y = (canvas.height - bh) / 2;
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, bw * 0.6, bh, bw * 0.3);
      else ctx.rect(x, y, bw * 0.6, bh);
      ctx.fill();
    });
    canvas.dataset.drawn = 'true';
  } catch (e) {
    console.warn('waveform unavailable', e);
  } finally {
    void ac.close();
  }
}
