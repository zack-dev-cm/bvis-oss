import { expect, test } from '@playwright/test';
import { attachShot, bootstrap } from './support/miniapp';

test('falls back to branded placeholder when media fails', async ({ page }, info) => {
  await bootstrap(page, { forceMedia404: true });
  await page.goto('/');

  await expect(page.getByTestId('photo-card')).toHaveCount(4);
  const fallbackCount = await page.locator('[data-testid="photo-img"]').evaluateAll((imgs) =>
    imgs.filter((img) => img.dataset.fallbackApplied === 'true').length
  );
  expect(fallbackCount).toBeGreaterThan(0);
  await attachShot(page, info, 'fallback-media.png');
});

test('preserves readable layout on mobile viewport', async ({ page }, info) => {
  await bootstrap(page, {}, { width: 430, height: 900 });
  await page.goto('/');

  await expect(page.getByTestId('brand-mark')).toBeVisible();
  const layout = await page.evaluate(() => {
    const footer = document.querySelector('.card-footer');
    const footerStyles = footer ? window.getComputedStyle(footer) : null;
    return {
      footerDirection: footerStyles?.flexDirection,
      previewWidth:
        (footer?.querySelector('[data-testid=\"preview-button\"]') as HTMLElement | null)?.getBoundingClientRect()
          ?.width ?? 0,
      footerWidth: footer?.getBoundingClientRect().width ?? 0,
    };
  });

  expect(layout.footerDirection).toBe('column');
  expect(layout.previewWidth).toBeGreaterThan(0);
  expect(layout.previewWidth).toBeGreaterThanOrEqual(layout.footerWidth * 0.9);
  await attachShot(page, info, 'mobile-layout.png');
});

test('plays timed pastel story circles', async ({ page }, info) => {
  await bootstrap(page);
  await page.goto('/');

  const logo = page.locator('.logo-lockup');
  await logo.dispatchEvent('pointerdown');
  await page.waitForTimeout(2100);
  await logo.dispatchEvent('pointerup');

  const stories = page.getByTestId('story-circle');
  await expect(page.getByTestId('story-rail')).toBeVisible();
  await expect(stories.first()).toBeVisible();
  expect(await stories.count()).toBeGreaterThan(0);

  await stories.first().click();
  const preview = page.getByTestId('preview-modal');
  await expect(preview).toBeVisible();
  const firstId = Number((await page.getByTestId('preview-inner').getAttribute('data-photo-id')) || 0);

  await expect(stories.first()).toHaveClass(/playing/);
  await expect(page.getByTestId('preview-inner')).not.toHaveAttribute('data-photo-id', `${firstId}`, { timeout: 5000 });

  const currentId = Number((await page.getByTestId('preview-inner').getAttribute('data-photo-id')) || 0);
  expect(currentId).not.toBe(firstId);
  await expect(page.locator('[data-testid="story-circle"].playing')).toBeVisible();

  await page.getByTestId('preview-close').click();
  await expect(preview).toBeHidden();
  await attachShot(page, info, 'story-playback.png');
});
