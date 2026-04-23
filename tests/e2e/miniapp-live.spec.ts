import { expect, test } from '@playwright/test';
import { attachShot, bootstrap } from './support/miniapp';

const isLive = process.env.PLAYWRIGHT_MOCK_API === 'false';

test.describe('live mini-app smoke', () => {
  test.skip(!isLive, 'Set PLAYWRIGHT_MOCK_API=false and PLAYWRIGHT_BASE_URL to run live checks');

  test('renders feed with real backend data', async ({ page }, info) => {
    await bootstrap(page);
    await page.goto('/');

    await expect(page.getByTestId('brand-mark')).toBeVisible();
    await expect(page.getByTestId('batch-pill').first()).toBeVisible({ timeout: 30_000 });
    const cards = page.getByTestId('photo-card');
    await expect(cards.first()).toBeVisible({ timeout: 30_000 });
    const cardCount = await cards.count();
    expect(cardCount).toBeGreaterThan(0);
    await attachShot(page, info, 'live-feed.png');
  });
});
