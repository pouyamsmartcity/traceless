import { expect, type Locator, type Page } from '@playwright/test';

/** Turns an option on or off the way a user does: open the settings sheet, tap, close. */
export async function setOpt(page: Page, key: string, on: boolean): Promise<void> {
  await page.getByTestId('open-settings').click();
  const box = page.getByTestId(`opt-${key}`);
  if (on) await box.check();
  else await box.uncheck();
  await page.getByTestId('settings-done').click();
  await expect(page.getByTestId('settings')).not.toBeVisible();
}

/** Chooses a cover look in the settings sheet. */
export async function setStyle(page: Page, style: string): Promise<void> {
  await page.getByTestId('open-settings').click();
  await page.locator(`label.style-${style}`).click();
  await page.getByTestId('settings-done').click();
}

/** Shows a card's less frequent actions (seal...). */
export async function openMore(item: Locator): Promise<void> {
  const more = item.getByTestId('more-actions');
  if ((await more.getAttribute('aria-expanded')) !== 'true') await more.click();
}

/** Unfolds the list of what a file was revealing. */
export async function openFindings(item: Locator): Promise<void> {
  const details = item.getByTestId('findings-details');
  if ((await details.getAttribute('open')) === null) await item.getByTestId('findings-toggle').click();
}
