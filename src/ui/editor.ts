import type { Rect } from '../lib/detect/geometry';
import { ICONS, h, icon, openViews } from './dom';
import type { Strings } from './i18n';
import { coverContains, paintCovers, traceCover, type Cover } from '../lib/masks';
import { coverOf, kindEnabled, type Item, type Options } from './pipeline';

/**
 * Full-screen editor to add masks by dragging and to remove or restore masks by tapping.
 * Resolves true when the user pressed Done (and the item's masks were changed), false on Cancel.
 */
export function openEditor(item: Item, opts: Options, t: Strings): Promise<boolean> {
  const img = item.decoded;
  if (!img) return Promise.resolve(false);
  const removed = new Set(item.removed);
  const manual: Rect[] = item.manual.map((r) => ({ ...r }));
  // Crop: drag a frame to keep only that part of the picture.
  let crop: Rect | undefined = item.crop ? { ...item.crop } : undefined;
  let mode: 'cover' | 'crop' = 'cover';
  const history: (() => void)[] = [];

  const canvas = h('canvas', { className: 'editor-canvas', 'aria-label': t.editorHelp });
  const undoBtn = h('button', { type: 'button', className: 'btn ghost', disabled: true }, icon(ICONS.undo), t.editorUndo);
  const doneBtn = h('button', { type: 'button', className: 'btn primary', 'data-testid': 'editor-done' }, icon(ICONS.check), t.editorDone);
  const cancelBtn = h('button', { type: 'button', className: 'btn ghost' }, t.editorCancel);
  const cropBtn = h('button', { type: 'button', className: 'btn ghost', 'data-testid': 'editor-crop', 'aria-pressed': 'false' }, icon(ICONS.crop), t.editorCrop);
  const cropResetBtn = h('button', { type: 'button', className: 'btn ghost', 'data-testid': 'editor-crop-reset', hidden: !crop }, t.editorCropReset);
  const help = h('p', { className: 'editor-help' }, t.editorHelp);
  const dialog = h(
    'div',
    { className: 'editor', role: 'dialog', 'aria-modal': 'true', 'aria-label': t.editorTitle },
    h('div', { className: 'editor-bar' }, h('strong', {}, t.editorTitle), h('span', { className: 'spacer' }), cropBtn, cropResetBtn, undoBtn, cancelBtn, doneBtn),
    help,
    h('div', { className: 'editor-stage' }, canvas),
  );
  document.body.appendChild(dialog);
  document.body.classList.add('no-scroll');

  let scale = 1; // canvas pixels per image pixel
  const ctx = canvas.getContext('2d')!;
  let drag: { x0: number; y0: number; x1: number; y1: number } | undefined;

  const autoEnabled = (i: number) => {
    const d = item.detections[i]!;
    return kindEnabled(d.kind, opts);
  };

  function layout(): void {
    const stage = canvas.parentElement!;
    const maxW = stage.clientWidth;
    const maxH = stage.clientHeight;
    scale = Math.min(maxW / img!.width, maxH / img!.height, 1);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.style.width = `${Math.round(img!.width * scale)}px`;
    canvas.style.height = `${Math.round(img!.height * scale)}px`;
    canvas.width = Math.round(img!.width * scale * dpr);
    canvas.height = Math.round(img!.height * scale * dpr);
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
    draw();
  }

  function draw(): void {
    ctx.drawImage(img!.element, 0, 0, img!.width, img!.height);
    const lw = 2 / scale;
    const outline = (c: Cover, colour: string, dashed: boolean) => {
      ctx.setLineDash(dashed ? [6 / scale, 4 / scale] : []);
      ctx.strokeStyle = colour;
      ctx.lineWidth = lw;
      traceCover(ctx, c, 1);
      ctx.stroke();
      ctx.setLineDash([]);
    };
    // Covers are shown in their real shapes, a little see-through so the user can judge what is under them.
    item.detections.forEach((d, i) => {
      if (!autoEnabled(i)) return;
      const c = coverOf(d);
      if (removed.has(i)) outline(c, '#ffd400', true);
      else {
        ctx.globalAlpha = 0.82;
        paintCovers(ctx, [c], 'black', 1, img!.width, img!.height);
        ctx.globalAlpha = 1;
        outline(c, '#3ddc84', false);
      }
    });
    for (const m of manual) {
      const c: Cover = { ...m, shape: 'rounded' };
      ctx.globalAlpha = 0.82;
      paintCovers(ctx, [c], 'black', 1, img!.width, img!.height);
      ctx.globalAlpha = 1;
      outline(c, '#4da3ff', false);
    }
    // The part outside the crop is shaded; the frame itself is outlined.
    const frame = mode === 'crop' && drag ? norm(drag) : crop;
    if (frame) {
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.beginPath();
      ctx.rect(0, 0, img!.width, img!.height);
      ctx.rect(frame.x, frame.y, frame.w, frame.h);
      ctx.fill('evenodd');
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = lw;
      ctx.setLineDash([8 / scale, 6 / scale]);
      ctx.strokeRect(frame.x, frame.y, frame.w, frame.h);
      ctx.restore();
    }
    if (drag && mode === 'cover') {
      const c: Cover = { ...norm(drag), shape: 'rounded' };
      ctx.globalAlpha = 0.6;
      paintCovers(ctx, [c], 'black', 1, img!.width, img!.height);
      ctx.globalAlpha = 1;
      outline(c, '#4da3ff', false);
    }
  }

  const norm = (d: { x0: number; y0: number; x1: number; y1: number }): Rect => ({
    x: Math.max(0, Math.min(d.x0, d.x1)),
    y: Math.max(0, Math.min(d.y0, d.y1)),
    w: Math.min(img.width, Math.max(d.x0, d.x1)) - Math.max(0, Math.min(d.x0, d.x1)),
    h: Math.min(img.height, Math.max(d.y0, d.y1)) - Math.max(0, Math.min(d.y0, d.y1)),
  });

  const toImage = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
  };

  const inside = (r: Rect, p: { x: number; y: number }) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;

  function record(undo: () => void): void {
    history.push(undo);
    undoBtn.disabled = false;
  }

  function tap(p: { x: number; y: number }): void {
    // Hand-drawn masks first (top-most), newest first.
    for (let i = manual.length - 1; i >= 0; i--) {
      if (inside(manual[i]!, p)) {
        const [m] = manual.splice(i, 1);
        record(() => manual.splice(i, 0, m!));
        return;
      }
    }
    for (let i = item.detections.length - 1; i >= 0; i--) {
      if (!autoEnabled(i) || !coverContains(coverOf(item.detections[i]!), p.x, p.y)) continue;
      if (removed.has(i)) {
        removed.delete(i);
        record(() => removed.add(i));
      } else {
        removed.add(i);
        record(() => removed.delete(i));
      }
      return;
    }
  }

  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    const p = toImage(e);
    drag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = toImage(e);
    drag.x1 = p.x;
    drag.y1 = p.y;
    draw();
  });
  const finish = (e: PointerEvent) => {
    if (!drag) return;
    const r = norm(drag);
    const tapLimit = 10 / scale;
    drag = undefined;
    if (mode === 'crop') {
      // A tap does not crop; a frame of at least 16 x 16 pixels does.
      if (r.w >= 16 && r.h >= 16) {
        const before = crop;
        crop = r;
        cropResetBtn.hidden = false;
        record(() => {
          crop = before;
          cropResetBtn.hidden = !crop;
        });
      }
    } else if (r.w < tapLimit && r.h < tapLimit) tap(toImage(e));
    else if (r.w > 2 && r.h > 2) {
      manual.push(r);
      record(() => manual.pop());
    }
    draw();
  };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', () => {
    drag = undefined;
    draw();
  });

  undoBtn.addEventListener('click', () => {
    history.pop()?.();
    undoBtn.disabled = history.length === 0;
    draw();
  });

  const onResize = () => layout();
  window.addEventListener('resize', onResize);
  requestAnimationFrame(layout);

  return new Promise((resolve) => {
    const close = (save: boolean) => {
      openViews.delete(cancelView);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('keydown', onKey);
      dialog.remove();
      document.body.classList.remove('no-scroll');
      if (save) {
        item.removed = removed;
        item.manual = manual;
        if (crop) item.crop = crop;
        else delete item.crop;
      }
      resolve(save);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(false);
    };
    window.addEventListener('keydown', onKey);
    cropBtn.addEventListener('click', () => {
      mode = mode === 'crop' ? 'cover' : 'crop';
      cropBtn.setAttribute('aria-pressed', String(mode === 'crop'));
      cropBtn.classList.toggle('open', mode === 'crop');
      help.textContent = mode === 'crop' ? t.editorCropHelp : t.editorHelp;
      draw();
    });
    cropResetBtn.addEventListener('click', () => {
      const before = crop;
      crop = undefined;
      cropResetBtn.hidden = true;
      record(() => {
        crop = before;
        cropResetBtn.hidden = !crop;
      });
      draw();
    });
    const cancelView = () => close(false);
    openViews.add(cancelView);
    doneBtn.addEventListener('click', () => close(true));
    cancelBtn.addEventListener('click', () => close(false));
    doneBtn.focus();
  });
}

