import type { Rect } from '../lib/detect/geometry';
import { ICONS, h, icon } from './dom';
import type { Strings } from './i18n';
import { kindEnabled, type Item, type Options } from './pipeline';

/**
 * Full-screen editor to add masks by dragging and to remove or restore masks by tapping.
 * Resolves true when the user pressed Done (and the item's masks were changed), false on Cancel.
 */
export function openEditor(item: Item, opts: Options, t: Strings): Promise<boolean> {
  const img = item.decoded;
  if (!img) return Promise.resolve(false);
  const removed = new Set(item.removed);
  const manual: Rect[] = item.manual.map((r) => ({ ...r }));
  const history: (() => void)[] = [];

  const canvas = h('canvas', { className: 'editor-canvas', 'aria-label': t.editorHelp });
  const undoBtn = h('button', { type: 'button', className: 'btn ghost', disabled: true }, icon(ICONS.undo), t.editorUndo);
  const doneBtn = h('button', { type: 'button', className: 'btn primary', 'data-testid': 'editor-done' }, icon(ICONS.check), t.editorDone);
  const cancelBtn = h('button', { type: 'button', className: 'btn ghost' }, t.editorCancel);
  const dialog = h(
    'div',
    { className: 'editor', role: 'dialog', 'aria-modal': 'true', 'aria-label': t.editorTitle },
    h('div', { className: 'editor-bar' }, h('strong', {}, t.editorTitle), h('span', { className: 'spacer' }), undoBtn, cancelBtn, doneBtn),
    h('p', { className: 'editor-help' }, t.editorHelp),
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
    item.detections.forEach((d, i) => {
      if (!autoEnabled(i)) return;
      if (removed.has(i)) {
        ctx.setLineDash([6 / scale, 4 / scale]);
        ctx.strokeStyle = '#ffd400';
        ctx.lineWidth = lw;
        ctx.strokeRect(d.x, d.y, d.w, d.h);
        ctx.setLineDash([]);
      } else {
        ctx.fillStyle = 'rgba(0,0,0,0.85)';
        ctx.fillRect(d.x, d.y, d.w, d.h);
        ctx.strokeStyle = '#3ddc84';
        ctx.lineWidth = lw;
        ctx.strokeRect(d.x, d.y, d.w, d.h);
      }
    });
    for (const m of manual) {
      ctx.fillStyle = 'rgba(0,0,0,0.85)';
      ctx.fillRect(m.x, m.y, m.w, m.h);
      ctx.strokeStyle = '#4da3ff';
      ctx.lineWidth = lw;
      ctx.strokeRect(m.x, m.y, m.w, m.h);
    }
    if (drag) {
      const r = norm(drag);
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeStyle = '#4da3ff';
      ctx.lineWidth = lw;
      ctx.strokeRect(r.x, r.y, r.w, r.h);
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
      if (!autoEnabled(i) || !inside(item.detections[i]!, p)) continue;
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
    if (r.w < tapLimit && r.h < tapLimit) tap(toImage(e));
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
      window.removeEventListener('resize', onResize);
      window.removeEventListener('keydown', onKey);
      dialog.remove();
      document.body.classList.remove('no-scroll');
      if (save) {
        item.removed = removed;
        item.manual = manual;
      }
      resolve(save);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(false);
    };
    window.addEventListener('keydown', onKey);
    doneBtn.addEventListener('click', () => close(true));
    cancelBtn.addEventListener('click', () => close(false));
    doneBtn.focus();
  });
}

