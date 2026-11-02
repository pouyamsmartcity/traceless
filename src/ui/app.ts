import { Detector } from '../lib/detect/detector';
import type { Rect } from '../lib/detect/geometry';
import type { Finding } from '../lib/findings';
import { loadPlaces, nearest, type Place } from '../lib/places';
import { ICONS, append, clear, h, icon } from './dom';
import { openEditor } from './editor';
import { MAX_SEAL_BYTES, looksSealed, openSealed, sealOriginal, type OpenResult } from './seal-ui';
import { STRINGS, countryName, formatNumber, type Lang, type Strings } from './i18n';
import { ensurePeople, ensureText, locationRisks, lookForText, newItem, processItem, renderImage, sameOptions, sameVideoOptions, type Item, type Options } from './pipeline';

interface Settings extends Options {
  lang: Lang;
}

function loadSettings(): Settings {
  const defaults: Settings = { lang: 'fa', faces: true, plates: true, extra: false, text: false, mute: false, voice: false, people: false, maskStyle: 'smart' };
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
        maskStyle: s.maskStyle === 'black' || s.maskStyle === 'brand' ? s.maskStyle : 'smart',
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
  private readonly previews = new Map<number, { key: string; el: HTMLElement; release: () => void }>();
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
    // Prepare the detectors in the background so the first photo is quick.
    const idle = (cb: () => void) => ('requestIdleCallback' in window ? requestIdleCallback(cb, { timeout: 3000 }) : setTimeout(cb, 1500));
    idle(() => {
      this.detector.warmUp();
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
    this.render();
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
      .then(() => processItem(item, this.settings, this.detector, () => this.updateCard(item)))
      .then(() => this.refresh(item))
      .then(async () => {
        if (item.media !== 'image' || item.status !== 'ready' || this.settings.text) return;
        await lookForText(item, this.detector);
        if (this.items.includes(item)) this.updateCard(item);
      })
      .catch((e: unknown) => console.error(e));
  }

  private render(): void {
    const t = this.t;
    document.documentElement.lang = this.settings.lang;
    document.documentElement.dir = this.settings.lang === 'fa' ? 'rtl' : 'ltr';
    document.title = `${t.appName} · ${t.tagline}`;
    clear(this.root);

    const input = h('input', {
      type: 'file',
      accept: 'image/*,video/*',
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

    const toggle = (key: 'faces' | 'plates' | 'text' | 'extra' | 'mute' | 'voice' | 'people', label: string) => {
      const box = h('input', { type: 'checkbox', checked: this.settings[key], 'data-testid': `opt-${key}` });
      box.addEventListener('change', () => {
        this.settings[key] = box.checked;
        saveSettings(this.settings);
        for (const it of this.items) if (it.media === 'video' && it.status === 'ready') this.updateCard(it);
        void this.rerenderAll();
      });
      return h('label', { className: 'switch' }, box, h('span', {}, label));
    };

    const langBtn = h('button', { type: 'button', className: 'btn ghost small', lang: this.settings.lang === 'fa' ? 'en' : 'fa' }, t.langSwitch);
    langBtn.addEventListener('click', () => {
      this.settings.lang = this.settings.lang === 'fa' ? 'en' : 'fa';
      saveSettings(this.settings);
      this.cards.clear();
      this.render();
    });

    const isIos = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const standalone = window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
    let installEl: HTMLElement | null = null;
    if (!standalone && this.installPrompt) {
      installEl = h('button', { type: 'button', className: 'btn ghost small' }, t.install);
      installEl.addEventListener('click', () => {
        void this.installPrompt?.prompt?.();
        this.installPrompt = undefined;
      });
    } else if (!standalone && isIos) {
      installEl = h('p', { className: 'hint' }, t.installIos);
    }

    this.listEl = h('section', { className: 'items', 'aria-live': 'polite' });
    for (const entry of this.opened) this.listEl.appendChild(this.sealedCard(entry));
    for (const item of this.items) {
      this.listEl.appendChild(this.cardFor(item));
      this.updateCard(item);
    }
    this.bulkEl = h('div', { className: 'bulk' });

    const dropZone = h(
      'section',
      { className: 'picker' },
      h('label', { className: 'pick-btn' }, input, icon(ICONS.plus, 28), h('span', {}, t.pick)),
      touch ? h('label', { className: 'pick-btn secondary', 'data-testid': 'camera-button' }, camera, icon(ICONS.camera, 24), h('span', {}, t.takePhoto)) : null,
      touch ? h('p', { className: 'hint small' }, t.takePhotoHint) : h('p', { className: 'hint' }, t.pickHint),
      h(
        'div',
        { className: 'options' },
        h('p', { className: 'group' }, t.groupCover),
        toggle('faces', t.optFaces),
        toggle('plates', t.optPlates),
        toggle('text', t.optText),
        toggle('people', t.optPeople),
        h('p', { className: 'group' }, t.groupStyle),
        this.stylePicker(),
        h('p', { className: 'group' }, t.groupSound),
        toggle('voice', t.optVoice),
        toggle('mute', t.optMute),
        h('p', { className: 'group' }, t.groupMore),
        toggle('extra', t.optExtra),
        h('p', { className: 'hint small' }, t.extraHint),
      ),
    );
    this.bindDrop(dropZone);

    append(
      this.root,
      h(
        'header',
        { className: 'top' },
        h('div', { className: 'brand' }, h('span', { className: 'logo' }, icon(ICONS.eraser, 26)), h('div', {}, h('h1', {}, t.appName), h('p', {}, t.tagline))),
        langBtn,
      ),
      h(
        'p',
        { className: 'badge', 'data-testid': 'offline-badge' },
        icon(ICONS.lock, 16),
        h('span', {}, t.offlineBadge, this.offlineReady ? h('span', { className: 'ready' }, ` · ${t.offlineReady}`) : null),
      ),
      dropZone,
      this.bulkEl,
      this.listEl,
      h('details', { className: 'info' }, h('summary', {}, t.howTitle), h('ul', {}, ...t.how.map((s) => h('li', {}, s)))),
      h('details', { className: 'info' }, h('summary', {}, t.limitsTitle), h('ul', {}, ...t.limits.map((s) => h('li', {}, s)))),
      h('label', { className: 'link open-sealed' }, sealedInput, t.openSealedLink),
      installEl,
      h(
        'footer',
        {},
        h('p', {}, t.footer, ' · ', h('a', { href: 'https://www.pouyam.com', rel: 'noopener', target: '_blank' }, 'pouyam.com')),
        h('p', { className: 'small' }, t.dataCredit),
      ),
    );
    this.updateBulk();
  }

  /** Three small swatches to choose how covers look. */
  private stylePicker(): HTMLElement {
    const t = this.t;
    const row = h('div', { className: 'styles', role: 'radiogroup', 'aria-label': t.groupStyle });
    for (const style of ['smart', 'black', 'brand'] as const) {
      const input = h('input', { type: 'radio', name: 'mask-style', value: style, checked: this.settings.maskStyle === style, 'data-testid': `style-${style}` });
      input.addEventListener('change', () => {
        if (!input.checked) return;
        this.settings.maskStyle = style;
        saveSettings(this.settings);
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
        body.appendChild(h('div', { className: 'actions' }, choose('mute', t.voiceInsteadMute, 'voice-mute'), choose('keep', t.voiceKeep, 'voice-keep')));
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
      body.appendChild(
        h('p', { className: `status ${item.status}`, 'data-testid': 'item-status' }, item.status === 'ready' ? icon(ICONS.check, 18) : null, this.statusText(item) + pct),
      );
      if (item.abort) {
        const cancel = h('button', { type: 'button', className: 'btn ghost small', 'data-testid': 'cancel' }, t.cancel);
        cancel.addEventListener('click', () => item.abort?.abort());
        body.appendChild(cancel);
      }
    }

    if (item.status === 'ready' && item.output) {
      if (item.media === 'image') {
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
        body.appendChild(h('p', { className: 'note' }, t.checkPicture));
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
        if (!sameVideoOptions(item, this.settings)) {
          const again = h('button', { type: 'button', className: 'btn ghost small', 'data-testid': 'rebuild' }, t.rebuildVideo);
          again.addEventListener('click', () => {
            if (item.output) URL.revokeObjectURL(item.output.url);
            delete item.output;
            item.status = 'queued';
            this.updateCard(item);
            this.enqueue(item);
          });
          body.appendChild(again);
        }
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

  private buildPreview(item: Item): { el: HTMLElement; release: () => void } {
    const t = this.t;
    const wrap = h('div', { className: 'preview-wrap' });
    let preview: HTMLElement;
    if (item.output && item.media === 'image') {
      preview = h('img', { src: item.output.url, alt: t.statusReady, className: 'preview', 'data-testid': 'output-image' });
    } else if (item.output && item.media === 'video') {
      preview = h('video', { src: item.output.url, controls: true, playsinline: true, preload: 'metadata', className: 'preview' });
    } else {
      preview = h('div', { className: 'preview placeholder' }, item.status === 'error' ? icon(ICONS.alert, 32) : h('div', { className: 'spinner' }));
    }
    wrap.appendChild(preview);
    let release = (): void => undefined;
    // Hold to see the original in place of the safe copy (only on this screen; it is never shared).
    if (item.status === 'ready' && item.output && item.media === 'image' && item.decoded && preview instanceof HTMLImageElement) {
      const img = preview;
      const safeUrl = item.output.url;
      const origUrl = item.decoded.url;
      const compare = h('button', { type: 'button', className: 'btn small compare', 'data-testid': 'compare' }, t.holdToCompare);
      const show = (orig: boolean) => {
        img.src = orig ? origUrl : safeUrl;
        compare.classList.toggle('active', orig);
      };
      compare.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        show(true);
        // Whatever happens to the button, letting go anywhere shows the safe copy again.
        window.addEventListener('pointerup', () => show(false), { once: true });
        window.addEventListener('pointercancel', () => show(false), { once: true });
      });
      for (const ev of ['pointerup', 'pointercancel']) compare.addEventListener(ev, () => show(false));
      compare.addEventListener('keydown', (e) => {
        if (e.key === ' ' || e.key === 'Enter') show(true);
      });
      compare.addEventListener('keyup', () => show(false));
      compare.addEventListener('blur', () => show(false));
      wrap.appendChild(h('div', { className: 'compare-row' }, compare));
      release = () => show(false);
    }
    return { el: wrap, release };
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
    row.appendChild(sealBtn);
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
        row.appendChild(cover);
      }
    }
    return row;
  }

  private findingsView(item: Item): HTMLElement {
    const t = this.t;
    const lang = this.settings.lang;
    const box = h('div', { className: 'findings', 'data-testid': 'findings' });
    if (!item.findings.length) {
      box.appendChild(h('p', { className: 'note' }, t.revealedNone));
      return box;
    }
    box.appendChild(h('p', { className: 'findings-title' }, t.revealedTitle));
    const order = { high: 0, medium: 1, low: 2 } as const;
    const sorted = [...item.findings].sort((a, b) => order[a.severity] - order[b.severity]);
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
    box.appendChild(list);
    if (item.hints.length) {
      box.appendChild(h('p', { className: 'findings-title hints-title' }, t.hintsTitle));
      const hl = h('ul', { 'data-testid': 'hints' });
      for (const x of item.hints) {
        const li = h('li', { className: 'sev-low', 'data-hint': x.id }, h('span', { className: 'label' }, t.hints[x.id]));
        if (x.value) li.appendChild(h('span', { className: 'value', dir: 'auto' }, x.value));
        hl.appendChild(li);
      }
      box.appendChild(hl);
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
    this.previews.delete(item.id);
    this.updateBulk();
  }

  private updateBulk(): void {
    if (!this.bulkEl) return;
    clear(this.bulkEl);
    // Only copies that are ready to send: not waiting for a check, not made with outdated switches.
    const ready = this.items.filter(
      (i) => i.status === 'ready' && i.output && !i.needsReview && (i.media === 'image' || sameVideoOptions(i, this.settings)),
    );
    if (ready.length < 2) return;
    const files = ready.map((i) => new File([i.output!.blob], i.output!.name, { type: i.output!.blob.type }));
    if (!canShareFiles(files)) return;
    const btn = h('button', { type: 'button', className: 'btn primary wide', 'data-testid': 'share-all' }, icon(ICONS.share), `${this.t.shareAll} (${formatNumber(this.settings.lang, ready.length)})`);
    btn.addEventListener('click', () => void shareOrSave(files));
    this.bulkEl.appendChild(btn);
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
    for (const f of files) {
      const url = URL.createObjectURL(f);
      const a = h('a', { href: url, download: f.name });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
  }
}
