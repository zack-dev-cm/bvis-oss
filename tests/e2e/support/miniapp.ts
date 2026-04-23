import fs from 'fs';
import path from 'path';
import type { Page, TestInfo } from '@playwright/test';

export type Batch = { id: number; label: string; publishedAt: string; photoCount: number };
export type Photo = {
  id: number;
  fileId: string;
  caption: string;
  publishedAt: string;
  batchId: number;
  likes: number;
  likedByMe?: boolean;
};

export const demoBatches: Batch[] = [
  { id: 1, label: 'Декабрь · теплый свет', publishedAt: '2024-12-04T14:00:00Z', photoCount: 4 },
  { id: 2, label: 'Поздняя осень · крупные планы', publishedAt: '2024-11-18T11:00:00Z', photoCount: 4 },
];

export const demoPhotos: Photo[] = [
  { id: 101, batchId: 1, fileId: 'nano-nail-close-05_0.jpg', caption: 'Молочный мрамор с золотом.', publishedAt: '2024-12-04T14:05:00Z', likes: 18 },
  { id: 102, batchId: 1, fileId: 'nano-nail-close-06_0.jpg', caption: 'Лавандовые линии на нюде.', publishedAt: '2024-12-04T14:20:00Z', likes: 12 },
  { id: 103, batchId: 1, fileId: 'nano-nail-close-07_0.jpg', caption: 'Мокко глянец с медным хромом.', publishedAt: '2024-12-04T14:35:00Z', likes: 15 },
  { id: 104, batchId: 1, fileId: 'nano-nail-close-08_0.jpg', caption: 'Розовый глянец с кристаллами.', publishedAt: '2024-12-04T14:50:00Z', likes: 9 },
  { id: 201, batchId: 2, fileId: 'nano-nail-close-01_0.jpg', caption: 'Нежный нюд с золотыми хлопьями.', publishedAt: '2024-11-18T11:20:00Z', likes: 11 },
  { id: 202, batchId: 2, fileId: 'nano-nail-close-02_0.jpg', caption: 'Хромовый френч в крупном плане.', publishedAt: '2024-11-18T11:35:00Z', likes: 10 },
  { id: 203, batchId: 2, fileId: 'nano-nail-close-03_0.jpg', caption: 'Персиковый омбре с искрами.', publishedAt: '2024-11-18T11:50:00Z', likes: 8 },
  { id: 204, batchId: 2, fileId: 'nano-nail-close-04_0.jpg', caption: 'Бордовый кэт-ай с бархатом.', publishedAt: '2024-11-18T12:05:00Z', likes: 12 },
];

export const mediaDir = path.join(process.cwd(), 'apps', 'api', 'mock-media');
export const fallbackMediaPath = path.join(process.cwd(), 'apps', 'mini-app', 'public', 'branding', 'nano-banano-sticker.svg');

export const photosByBatch = demoPhotos.reduce<Record<number, Photo[]>>((acc, photo) => {
  acc[photo.batchId] ??= [];
  acc[photo.batchId].push(photo);
  return acc;
}, {});

Object.keys(photosByBatch).forEach((batchId) => {
  photosByBatch[Number(batchId)] = photosByBatch[Number(batchId)].sort(
    (a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()
  );
});

type WireMockOptions = {
  batches?: Batch[];
  photos?: Photo[];
  likeDelayMs?: number;
  forceMedia404?: boolean;
};

export async function attachShot(page: Page, info: TestInfo, name: string) {
  const shot = await page.screenshot({ fullPage: true });
  await info.attach(name, { body: shot, contentType: 'image/png' });
}

export async function stubTelegram(page: Page) {
  const injectedInitData =
    process.env.PLAYWRIGHT_INIT_DATA ||
    'user=%7B%22id%22%3A501%2C%22first_name%22%3A%22%D0%A2%D0%B5%D1%81%D1%82%22%7D&hash=stub';

  await page.addInitScript((initData: string) => {
    const webAppStub = {
      initData,
      initDataUnsafe: { rawData: initData },
      ready: () => {},
      expand: () => {},
      disableVerticalSwipes: () => {},
      onEvent: () => {},
      offEvent: () => {},
      themeParams: { bg_color: '#05060c', text_color: '#e8ecf8' },
    };
    const telegramStub = { WebApp: webAppStub };
    Object.defineProperty(window, 'Telegram', {
      value: telegramStub,
      writable: false,
      configurable: false,
    });
    Object.freeze(webAppStub);
    Object.freeze(telegramStub);
  }, injectedInitData);
}

export async function wireMockApi(page: Page, options: WireMockOptions = {}) {
  const batches = options.batches ?? demoBatches;
  const photos = options.photos ?? demoPhotos;
  const mapped = options.photos ? options.photos.reduce<Record<number, Photo[]>>((acc, photo) => {
    acc[photo.batchId] ??= [];
    acc[photo.batchId].push(photo);
    return acc;
  }, {}) : photosByBatch;

  Object.keys(mapped).forEach((batchId) => {
    mapped[Number(batchId)] = mapped[Number(batchId)].sort(
      (a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()
    );
  });

  await page.route('**/api/batches', async (route) => {
    await route.fulfill({ json: batches });
  });

  await page.route('**/api/photos**', async (route) => {
    const url = new URL(route.request().url());
    const batchId = Number(url.searchParams.get('batchId') || 1);
    const take = Number(url.searchParams.get('take') || 12);
    const cursor = url.searchParams.get('cursor');
    const pool = mapped[batchId] || [];
    let start = 0;
    if (cursor) {
      const idx = pool.findIndex((p) => p.id === Number(cursor));
      start = idx >= 0 ? idx + 1 : 0;
    }
    const slice = pool.slice(start, start + take);
    const nextCursor = start + take < pool.length ? slice[slice.length - 1]?.id ?? null : null;
    await route.fulfill({
      json: {
        photos: slice,
        nextCursor,
      },
    });
  });

  await page.route('**/api/like', async (route) => {
    const payload = (await route.request().postDataJSON()) as { photoId?: number };
    const pool = options.photos ?? demoPhotos;
    const photo = payload.photoId ? pool.find((p) => p.id === payload.photoId) : null;
    if (photo) photo.likes += 1;
    if (options.likeDelayMs) await new Promise((resolve) => setTimeout(resolve, options.likeDelayMs));
    await route.fulfill({ json: { ok: true, created: true } });
  });

  await page.route('**/api/miniapp/visit', async (route) => {
    await route.fulfill({ json: { ok: true } });
  });

  await page.route('**/api/media/**', async (route) => {
    if (options.forceMedia404) {
      await route.fulfill({ status: 404 });
      return;
    }
    const url = new URL(route.request().url());
    const fileId = path.basename(url.pathname);
    const filePath = path.join(mediaDir, fileId);
    const assetPath = fs.existsSync(filePath) ? filePath : fallbackMediaPath;
    const contentType = assetPath.endsWith('.svg') ? 'image/svg+xml' : 'image/jpeg';
    await route.fulfill({ path: assetPath, headers: { 'content-type': contentType } });
  });
}

export async function bootstrap(page: Page, options: WireMockOptions = {}, viewport = { width: 1400, height: 900 }) {
  await stubTelegram(page);
  if (process.env.PLAYWRIGHT_MOCK_API !== 'false') {
    await wireMockApi(page, options);
  } else {
    console.info('[e2e] PLAYWRIGHT_MOCK_API=false → hitting real API backend');
  }
  await page.setViewportSize(viewport);
}
