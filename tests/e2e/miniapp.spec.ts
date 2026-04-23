import { expect, test } from '@playwright/test';
import { attachShot, bootstrap } from './support/miniapp';

test.setTimeout(60_000);
const isMocked = process.env.PLAYWRIGHT_MOCK_API !== 'false';

test('shows feed, paginates, and switches batches', async ({ page }, info) => {
  test.skip(!isMocked, 'Mocked API routes required for deterministic dataset');
  await bootstrap(page);
  await page.goto('/');

  await expect(page.getByTestId('brand-mark')).toBeVisible();
  await expect(page.getByTestId('batch-pill')).toHaveCount(2);
  await expect(page.getByTestId('photo-card')).toHaveCount(4);
  await attachShot(page, info, 'feed-initial.png');

  const previewModal = page.getByTestId('preview-modal');
  await page.getByTestId('photo-card').first().getByTestId('preview-button').click();
  await expect(previewModal).toBeVisible();
  await page.getByTestId('preview-close').click();
  await expect(previewModal).toBeHidden();

  const batch2Response = page.waitForResponse(
    (resp) => resp.url().includes('/api/photos') && resp.request().url().includes('batchId=2')
  );
  await page.getByTestId('batch-pill').nth(1).click();
  await batch2Response;
  await expect(page.getByTestId('photo-card')).toHaveCount(4, { timeout: 15000 });
  await attachShot(page, info, 'feed-second-batch.png');
});

test('likes a photo and surfaces updated counter', async ({ page }, info) => {
  test.skip(!isMocked, 'Mocked API routes required for deterministic dataset');
  await bootstrap(page);
  await page.goto('/');

  const firstCard = page.getByTestId('photo-card').first();
  await expect(firstCard).toBeVisible();
  const likeButton = firstCard.getByTestId('like-button');
  const likesBefore = Number((await likeButton.locator('strong').textContent()) || 0);

  await likeButton.click();
  await expect(likeButton).toHaveClass(/active/);

  const likesAfter = Number((await likeButton.locator('strong').textContent()) || likesBefore);
  expect(likesAfter).toBe(likesBefore + 1);
  await attachShot(page, info, 'like-updated.png');
});
