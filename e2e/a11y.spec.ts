import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const fixture = (p: string) => fileURLToPath(new URL(`../test/fixtures/${p}`, import.meta.url));
const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

/** Runs the axe accessibility checks (WCAG 2.1 A and AA) and returns the problems found. */
async function audit(page: Page, label: string): Promise<string[]> {
  await page.evaluate(axeSource);
  const result = await page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: { id: string; impact: string; help: string; nodes: { target: string[] }[] }[] }> } }).axe;
    return axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }, resultTypes: ['violations'] });
  });
  // The checker really ran (it reports the rules it passed as well).
  expect((result as unknown as { passes: unknown[] }).passes.length, label).toBeGreaterThan(10);
  return result.violations.map((v) => `${label}: [${v.impact}] ${v.id} ${v.help} -> ${v.nodes.slice(0, 4).map((n) => n.target.join(' ')).join(' | ')}`);
}

test.describe('accessibility (WCAG 2.1 AA)', () => {

  for (const theme of ['light', 'dark'] as const) {
    test(`the whole app passes the automatic checks (${theme})`, async ({ page }) => {
      test.skip(test.info().project.name !== 'phone', 'one size is enough');
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      await page.goto('/');
      const problems: string[] = [];
      problems.push(...(await audit(page, 'home with welcome')));
      await page.getByTestId('intro-done').click();
      await page.getByTestId('open-settings').click();
      problems.push(...(await audit(page, 'settings')));
      await page.getByTestId('settings-done').click();
      await page.getByTestId('file-input').setInputFiles([fixture('leaky/photo-everything.jpg'), fixture('leaky/voice-note.ogg')]);
      for (const n of [0, 1]) await expect(page.getByTestId('item').nth(n).getByTestId('item-status')).toHaveAttribute('class', /ready/, { timeout: 90_000 });
      await page.getByTestId('item').nth(1).getByTestId('more-actions').click();
      problems.push(...(await audit(page, 'cards')));
      await page.getByTestId('lang').selectOption('en');
      problems.push(...(await audit(page, 'english')));
      await page.getByTestId('lang').selectOption('tr');
      problems.push(...(await audit(page, 'turkish')));
      expect(problems).toEqual([]);
    });
  }
});
