export type MockBatch = { id: number; label: string; publishedAt: string; photoCount: number };
export type MockPhoto = {
  id: number;
  batchId: number;
  fileId: string;
  caption: string;
  publishedAt: string;
  likes: number;
  storyCount: number;
};

const mockPhotos: MockPhoto[] = [];

const batchMeta: Array<Omit<MockBatch, 'photoCount'>> = [];

export function getMockBatches(): MockBatch[] {
  const batches: MockBatch[] = batchMeta.map((batch) => ({
    ...batch,
    photoCount: mockPhotos.filter((p) => p.batchId === batch.id).length,
  }));
  return batches.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
}

export function getMockPhotos(batchId: number | undefined, take: number, cursor?: number | null) {
  const filtered = mockPhotos.filter((photo) => (batchId ? photo.batchId === batchId : true));
  const sorted = filtered.sort((a, b) => {
    const timeDiff = new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime();
    if (timeDiff !== 0) return timeDiff;
    return b.id - a.id;
  });

  let start = 0;
  if (cursor) {
    const cursorIdx = sorted.findIndex((p) => p.id === cursor);
    start = cursorIdx >= 0 ? cursorIdx + 1 : 0;
  }

  const slice = sorted.slice(start, start + take);
  const nextCursor = start + take < sorted.length ? slice[slice.length - 1]?.id ?? null : null;

  return { photos: slice, nextCursor };
}

export function incrementMockLike(photoId: number) {
  const target = mockPhotos.find((photo) => photo.id === photoId);
  if (!target) return null;
  target.likes += 1;
  return { ok: true as const, likes: target.likes };
}
