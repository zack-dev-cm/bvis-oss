import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import { StoryRing } from './components/StoryRing';

type TelegramThemeParams = {
  bg_color?: string;
  text_color?: string;
};

type TelegramInitData = {
  rawData?: string;
  [key: string]: unknown;
};

type TelegramWebApp = {
  initData?: string;
  initDataUnsafe?: TelegramInitData;
  themeParams?: TelegramThemeParams;
  ready: () => void;
  expand?: () => void;
  disableVerticalSwipes?: () => void;
  onEvent?: (event: string, handler: () => void) => void;
  offEvent?: (event: string, handler: () => void) => void;
};

type TelegramGlobal = {
  WebApp?: TelegramWebApp;
};

declare global {
  interface Window {
    Telegram?: TelegramGlobal;
  }
}

type Batch = {
  id: number;
  label: string;
  publishedAt: string;
  photoCount: number;
};

type Photo = {
  id: number;
  fileId: string;
  caption?: string | null;
  publishedAt: string;
  batchId?: number | null;
  likes: number;
  storyCount?: number | null;
  likedByMe?: boolean;
};

type HighlightFace = {
  id: number;
  src: string;
  caption: string;
  label: string;
  storyCount: number;
};

const API_BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/$/, '');
const FALLBACK_IMAGE = '/branding/demo-nail-tiles.svg';
const FEED_CACHE_KEY = 'bvis-feed-cache';
const STORY_VISIBILITY_KEY = 'bvis-story-visibility';
const FEED_CACHE_TTL = 1000 * 60 * 5;
const STORY_DURATION_MS = 2600;
const STORY_LABEL_MAX = 26;

const dateFormatter = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' });
const timeFormatter = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });

const formatDate = (value: string) => dateFormatter.format(new Date(value));
const formatTime = (value: string) => timeFormatter.format(new Date(value));

const photoUrl = (fileId: string) => {
  if (/^https?:\/\//i.test(fileId)) return fileId;
  const prefix = API_BASE ? `${API_BASE}` : '';
  return `${prefix}/api/media/${encodeURIComponent(fileId)}`;
};

const formatStoryLabel = (value: string) => {
  const trimmed = (value || '').trim();
  if (!trimmed) return 'Фото';
  if (trimmed.length <= STORY_LABEL_MAX) return trimmed;
  return `${trimmed.slice(0, STORY_LABEL_MAX - 1).replace(/\s+$/, '')}…`;
};

type FeedCache = {
  batches: Batch[];
  activeBatchId: number | null;
  photos: Photo[];
  nextCursor: number | null;
  timestamp: number;
};

type Branding = {
  name: string;
  brandText?: string | null;
  slug?: string;
  logoUrl?: string | null;
};

function App() {
  const [initData, setInitData] = useState('');
  const [batches, setBatches] = useState<Batch[]>([]);
  const [activeBatchId, setActiveBatchId] = useState<number | null>(null);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [likedIds, setLikedIds] = useState<Set<number>>(new Set());
  const [pendingLikes, setPendingLikes] = useState<Set<number>>(new Set());
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [tgLinked, setTgLinked] = useState<boolean | null>(null);
  const [branding, setBranding] = useState<Branding>({
    name: 'beauty visuals',
    brandText: 'beauty visuals',
    slug: 'default',
    logoUrl: null,
  });
  const [previewId, setPreviewId] = useState<number | null>(null);
  const [storyPlayingId, setStoryPlayingId] = useState<number | null>(null);
  const [seenStoryIds, setSeenStoryIds] = useState<Set<number>>(new Set());
  const [storyPlaybackNonce, setStoryPlaybackNonce] = useState(0);
  const [storiesHidden, setStoriesHidden] = useState(true);
  const [logoHoldActive, setLogoHoldActive] = useState(false);
  const loaderRef = useRef<HTMLDivElement | null>(null);
  const storyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const logoHoldTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const storyVisibilityHydratedRef = useRef(false);
  const storyVisibilityReadyRef = useRef(false);
  const cacheHydratedRef = useRef(false);
  const cacheHasPhotosRef = useRef(false);
  const handleImageError = useCallback((event: React.SyntheticEvent<HTMLImageElement>) => {
    const img = event.currentTarget;
    if (img.dataset.fallbackApplied === 'true') return;
    img.dataset.fallbackApplied = 'true';
    img.src = FALLBACK_IMAGE;
    img.alt = 'Фото недоступно, показана заглушка.';
    img.classList.add('img-fallback');
  }, []);
  const handleLogoError = useCallback(() => {
    setBranding((prev) => ({ ...prev, logoUrl: null }));
  }, []);
  const authHeaders = useMemo(() => (initData ? { 'X-Telegram-Init-Data': initData } : undefined), [initData]);
  const mergeLikedFromPhotos = useCallback((list: Photo[]) => {
    const likedIdsFromList = list.filter((photo) => photo.likedByMe).map((photo) => photo.id);
    if (!likedIdsFromList.length) return;
    setLikedIds((prev) => {
      const next = new Set(prev);
      let changed = false;
      likedIdsFromList.forEach((id) => {
        if (!next.has(id)) {
          next.add(id);
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, []);

  // Early resource hints so network handshakes start before data fetches
  useEffect(() => {
    if (!API_BASE || API_BASE.startsWith('/')) return;
    if (typeof document === 'undefined') return;
    try {
      const origin = new URL(API_BASE, window.location.origin).origin;
      const preconnect = document.createElement('link');
      preconnect.rel = 'preconnect';
      preconnect.href = origin;
      preconnect.crossOrigin = 'anonymous';
      const dnsPrefetch = document.createElement('link');
      dnsPrefetch.rel = 'dns-prefetch';
      dnsPrefetch.href = origin;
      document.head.append(preconnect, dnsPrefetch);
      return () => {
        preconnect.remove();
        dnsPrefetch.remove();
      };
    } catch {
      /* ignore invalid base url */
    }
  }, []);

  // Telegram theme + initData
  useEffect(() => {
    const extractInitData = () => {
      const tg = window.Telegram?.WebApp;
      if (tg?.initData && tg.initData.length > 0) return tg.initData;
      if (tg?.initDataUnsafe?.rawData) return tg.initDataUnsafe.rawData;
      const hashPayload = new URLSearchParams(window.location.hash.replace(/^#/, ''));
      const hashData = hashPayload.get('tgWebAppData');
      if (hashData) return hashData;
      return '';
    };

    let applied = false;
    let pollTimer: number | null = null;
    let stopTimer: number | null = null;

    const applyTelegramContext = () => {
      const tg = window.Telegram?.WebApp;
      if (!tg) return false;
      applied = true;
      tg.ready();
      tg.expand?.();
      tg.disableVerticalSwipes?.();
      const rawInit = extractInitData();
      if (!rawInit) {
        console.warn('[bvis] Telegram WebApp detected but initData missing');
        setTgLinked(false);
      } else {
        setTgLinked(true);
      }
      setInitData(rawInit);
      const applyTheme = () => {
        const bg = tg.themeParams?.bg_color || '#05060c';
        const text = tg.themeParams?.text_color || '#e8ecf8';
        document.documentElement.style.setProperty('--tg-bg', bg);
        document.documentElement.style.setProperty('--tg-text', text);
      };
      applyTheme();
      tg.onEvent?.('themeChanged', applyTheme);
      return () => tg.offEvent?.('themeChanged', applyTheme);
    };

    const cleanup = applyTelegramContext();
    if (cleanup) return cleanup;

    pollTimer = window.setInterval(() => {
      const done = applyTelegramContext();
      if (done) {
        if (pollTimer) window.clearInterval(pollTimer);
        if (stopTimer) window.clearTimeout(stopTimer);
        return;
      }
    }, 200);

    stopTimer = window.setTimeout(() => {
      if (!applied) {
        setTgLinked(false);
      }
      if (pollTimer) window.clearInterval(pollTimer);
    }, 5000);

    return () => {
      if (pollTimer) window.clearInterval(pollTimer);
      if (stopTimer) window.clearTimeout(stopTimer);
    };
  }, []);

  // Track opening mini-app
  useEffect(() => {
    if (!initData) return;
    fetch(`${API_BASE}/api/miniapp/visit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData }),
    }).catch(() => undefined);
  }, [initData]);

  // Hydrate last viewed feed instantly if a recent cache exists
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const cached = sessionStorage.getItem(FEED_CACHE_KEY);
    if (!cached) return;
    try {
      const parsed = JSON.parse(cached) as FeedCache;
      if (Date.now() - parsed.timestamp > FEED_CACHE_TTL) return;
      setBatches(parsed.batches ?? []);
      setActiveBatchId(parsed.activeBatchId ?? null);
      setPhotos(parsed.photos ?? []);
      mergeLikedFromPhotos(parsed.photos ?? []);
      setNextCursor(parsed.nextCursor ?? null);
      cacheHydratedRef.current = true;
      cacheHasPhotosRef.current = (parsed.photos ?? []).length > 0;
      if (cacheHasPhotosRef.current) {
        setLoading(false);
      }
    } catch {
      sessionStorage.removeItem(FEED_CACHE_KEY);
    }
  }, [mergeLikedFromPhotos]);

  useEffect(() => {
    const loadBatches = async () => {
      setLoading(true);
      setError('');
      try {
        const res = await fetch(`${API_BASE}/api/batches`, { headers: authHeaders });
        if (!res.ok) {
          const message =
            res.status === 503
              ? 'База данных недоступна. Проверьте API и соединение с БД.'
              : res.status === 401 || res.status === 403
                ? 'Нет доступа к ленте. Откройте мини-апп из Telegram.'
                : 'Не удалось загрузить ленту. Обновите страницу.';
          throw new Error(message);
        }
        const data = (await res.json()) as Batch[];
        setBatches(data);
        setActiveBatchId((prev) => {
          if (prev && data.some((b) => b.id === prev)) return prev;
          return data[0]?.id ?? null;
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Не удалось загрузить ленту. Обновите страницу.');
      } finally {
        setLoading(false);
      }
    };
    loadBatches();
  }, [authHeaders]);

  useEffect(() => {
    if (!initData) return;
    const controller = new AbortController();
    const resolveLogoUrl = (value?: string | null) => {
      if (!value) return null;
      if (/^https?:\/\//i.test(value)) return value;
      return `${API_BASE}${value}`;
    };
    fetch(`${API_BASE}/api/company/branding`, {
      headers: authHeaders,
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`branding_${res.status}`);
        return (await res.json()) as { name?: string; brandText?: string | null; slug?: string; logoUrl?: string | null };
      })
      .then((data) => {
        const cleanedBrandText = data.brandText?.trim();
        setBranding((prev) => ({
          name: data.name || prev.name,
          brandText: cleanedBrandText || data.name || prev.brandText || prev.name,
          slug: data.slug || prev.slug,
          logoUrl: resolveLogoUrl(data.logoUrl) ?? null,
        }));
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        console.warn('[bvis] failed to load branding', err);
        setBranding((prev) => ({ ...prev, logoUrl: null }));
      });

    return () => controller.abort();
  }, [authHeaders, initData]);

  const fetchPhotos = useCallback(
    async (batchId: number, cursor?: number | null, reset = false) => {
      const params = new URLSearchParams();
      params.set('batchId', String(batchId));
      params.set('take', '12');
      if (cursor) params.set('cursor', String(cursor));
      if (!reset) setLoadingMore(true);
      try {
        const res = await fetch(`${API_BASE}/api/photos?${params.toString()}`, {
          headers: authHeaders,
        });
        if (!res.ok) {
          const message =
            res.status === 503
              ? 'База данных недоступна. Попробуйте обновить позже.'
              : res.status === 401 || res.status === 403
                ? 'Нет доступа к ленте. Откройте мини-апп из Telegram.'
                : 'Не удалось загрузить фото.';
          throw new Error(message);
        }
        const data = (await res.json()) as { photos: Photo[]; nextCursor: number | null };
        setPhotos((prev) => (reset ? data.photos : [...prev, ...data.photos]));
        mergeLikedFromPhotos(data.photos);
        setNextCursor(data.nextCursor);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Не удалось загрузить фото, попробуйте позже.');
      } finally {
        if (!reset) setLoadingMore(false);
      }
    },
    [authHeaders, mergeLikedFromPhotos]
  );

  useEffect(() => {
    if (!activeBatchId) return;
    const keepExisting = cacheHydratedRef.current && cacheHasPhotosRef.current;
    setError('');
    setLoadingMore(false);
    if (!keepExisting) {
      setPhotos([]);
      setNextCursor(null);
      setLoading(true);
    }
    fetchPhotos(activeBatchId, null, true).finally(() => {
      setLoading(false);
      cacheHydratedRef.current = false;
      cacheHasPhotosRef.current = false;
    });
  }, [activeBatchId, fetchPhotos]);

  useEffect(() => {
    if (!nextCursor || !activeBatchId) return;
    const observer = new IntersectionObserver((entries) => {
      const [entry] = entries;
      if (entry.isIntersecting && !loadingMore) {
        fetchPhotos(activeBatchId, nextCursor).catch(() => setError('Не удалось загрузить еще фото.'));
      }
    }, { rootMargin: '320px 0px 0px 0px' });
    const node = loaderRef.current;
    if (node) observer.observe(node);
    return () => observer.disconnect();
  }, [activeBatchId, fetchPhotos, loadingMore, nextCursor]);

  const likePhoto = async (photoId: number) => {
    if (pendingLikes.has(photoId)) return;
    let payloadInitData = initData;
    if (!payloadInitData) {
      setError('Откройте мини-апп из Telegram, чтобы лайкать фото.');
      setTgLinked(false);
      payloadInitData = 'offline-demo';
    }
    const newPending = new Set(pendingLikes);
    newPending.add(photoId);
    setPendingLikes(newPending);
    try {
      const res = await fetch(`${API_BASE}/api/like`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ photoId, initData: payloadInitData }),
      });
      if (!res.ok) throw new Error('failed');
      const data = (await res.json()) as { ok: boolean; created?: boolean; likes?: number };
      setLikedIds((prev) => new Set(prev).add(photoId));
      setPhotos((prev) =>
        prev.map((p) => {
          if (p.id !== photoId) return p;
          if (typeof data.likes === 'number') return { ...p, likes: data.likes, likedByMe: true };
          if (data.created) return { ...p, likes: p.likes + 1, likedByMe: true };
          return { ...p, likedByMe: true };
        })
      );
    } catch (err) {
      console.warn('[bvis] failed to like photo', err);
      setError('Не получилось отправить лайк. Попробуйте еще раз.');
    } finally {
      const cleared = new Set(newPending);
      cleared.delete(photoId);
      setPendingLikes(cleared);
    }
  };

  const ribbonLabel = useMemo(() => {
    if (!activeBatchId) return '';
    const batch = batches.find((b) => b.id === activeBatchId);
    if (!batch) return '';
    const date = formatDate(batch.publishedAt);
    return `${date} • ${batch.photoCount} фото`;
  }, [activeBatchId, batches]);
  const totalLikes = useMemo(() => photos.reduce((sum, photo) => sum + (photo.likes || 0), 0), [photos]);
  const highlightFaces: HighlightFace[] = useMemo(() => {
    if (!photos.length) return [];
    return photos.slice(0, 6).map((photo) => ({
      id: photo.id,
      src: photoUrl(photo.fileId),
      caption: photo.caption || 'Фото',
      label: formatStoryLabel(photo.caption || 'Фото'),
      storyCount: Math.max(1, Number(photo.storyCount) || 1),
    }));
  }, [photos]);
  useEffect(() => {
    setSeenStoryIds((prev) => {
      if (!prev.size) return prev;
      const activeIds = new Set(highlightFaces.map((face) => face.id));
      let mutated = false;
      const next = new Set<number>();
      prev.forEach((id) => {
        if (activeIds.has(id)) {
          next.add(id);
        } else {
          mutated = true;
        }
      });
      return mutated ? next : prev;
    });
  }, [highlightFaces]);
  const extraFaces = Math.max(0, photos.length - highlightFaces.length);
  const headerSubtitle = useMemo(() => {
    if (ribbonLabel) return ribbonLabel;
    if (photos.length || totalLikes) return `${photos.length || 0} кадров · ${totalLikes || 0} лайков`;
    return 'curated pastel stories';
  }, [photos, ribbonLabel, totalLikes]);
  const brandName = useMemo(() => {
    const custom = branding.brandText?.trim();
    if (custom) return custom;
    if (branding.name?.trim()) return branding.name.trim();
    return 'beauty visuals';
  }, [branding.brandText, branding.name]);
  const markStorySeen = useCallback((photoId: number) => {
    setSeenStoryIds((prev) => {
      if (prev.has(photoId)) return prev;
      const next = new Set(prev);
      next.add(photoId);
      return next;
    });
  }, []);

  const clearStoryTimer = useCallback(() => {
    if (storyTimerRef.current) {
      clearTimeout(storyTimerRef.current);
      storyTimerRef.current = null;
    }
  }, []);
  const clearLogoHoldTimer = useCallback(() => {
    if (logoHoldTimerRef.current) {
      clearTimeout(logoHoldTimerRef.current);
      logoHoldTimerRef.current = null;
    }
    setLogoHoldActive(false);
  }, []);
  const startStory = useCallback(
    (photoId: number) => {
      clearStoryTimer();
      setPreviewId(photoId);
      setStoryPlayingId(photoId);
      setStoryPlaybackNonce((nonce) => nonce + 1);
      markStorySeen(photoId);
    },
    [clearStoryTimer, markStorySeen]
  );

  const openPreview = useCallback(
    (photoId: number) => {
      clearStoryTimer();
      setStoryPlayingId(null);
      setPreviewId(photoId);
    },
    [clearStoryTimer]
  );
  const closePreview = useCallback(() => {
    clearStoryTimer();
    setStoryPlayingId(null);
    setPreviewId(null);
  }, [clearStoryTimer]);

  const goToStory = useCallback(
    (direction: 'next' | 'prev') => {
      if (!storyPlayingId) return;
      const currentIdx = highlightFaces.findIndex((face) => face.id === storyPlayingId);
      if (currentIdx === -1) return;
      const target =
        direction === 'next' ? highlightFaces[currentIdx + 1] ?? null : highlightFaces[currentIdx - 1] ?? null;
      clearStoryTimer();
      if (target) {
        setPreviewId(target.id);
        setStoryPlayingId(target.id);
        setStoryPlaybackNonce((nonce) => nonce + 1);
        markStorySeen(target.id);
      } else {
        setPreviewId(null);
        setStoryPlayingId(null);
      }
    },
    [clearStoryTimer, highlightFaces, markStorySeen, storyPlayingId]
  );

  const startLogoHold = useCallback(() => {
    clearLogoHoldTimer();
    setLogoHoldActive(true);
    logoHoldTimerRef.current = window.setTimeout(() => {
      setStoriesHidden((prev) => !prev);
      setLogoHoldActive(false);
      logoHoldTimerRef.current = null;
    }, 2000);
  }, [clearLogoHoldTimer]);

  const stopLogoHold = useCallback(() => {
    clearLogoHoldTimer();
  }, [clearLogoHoldTimer]);

  const handleLogoKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      startLogoHold();
    },
    [startLogoHold]
  );

  useEffect(() => {
    if (!storyPlayingId) return;
    clearStoryTimer();
    storyTimerRef.current = setTimeout(() => {
      goToStory('next');
    }, STORY_DURATION_MS);
    return () => clearStoryTimer();
  }, [clearStoryTimer, goToStory, storyPlayingId]);
  useEffect(() => {
    clearStoryTimer();
    setStoryPlayingId(null);
  }, [activeBatchId, clearStoryTimer]);
  useEffect(
    () => () => {
      clearStoryTimer();
      clearLogoHoldTimer();
    },
    [clearLogoHoldTimer, clearStoryTimer]
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = sessionStorage.getItem(STORY_VISIBILITY_KEY);
    if (stored === 'hidden') {
      setStoriesHidden(true);
    }
    storyVisibilityHydratedRef.current = true;
  }, []);

  useEffect(() => {
    if (!storyVisibilityHydratedRef.current) return;
    if (typeof window !== 'undefined') {
      sessionStorage.setItem(STORY_VISIBILITY_KEY, storiesHidden ? 'hidden' : 'visible');
    }
    if (storiesHidden) {
      clearStoryTimer();
      setStoryPlayingId(null);
    }
    if (!storyVisibilityReadyRef.current) {
      storyVisibilityReadyRef.current = true;
    }
  }, [clearStoryTimer, storiesHidden]);

  // Persist the latest feed snapshot for instant reopen speed
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!batches.length) return;
    if (loading) return;
    const payload: FeedCache = {
      batches,
      activeBatchId,
      photos,
      nextCursor,
      timestamp: Date.now(),
    };
    sessionStorage.setItem(FEED_CACHE_KEY, JSON.stringify(payload));
  }, [activeBatchId, batches, loading, nextCursor, photos]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closePreview();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closePreview]);

  const previewPhoto = useMemo(() => {
    if (!previewId) return null;
    return photos.find((p) => p.id === previewId) ?? null;
  }, [photos, previewId]);
  const isStoryPreview = previewPhoto ? storyPlayingId === previewPhoto.id : false;
  const shouldShowStories = highlightFaces.length > 0 && !storiesHidden;

  return (
    <div className="page" data-testid="page">
      <div className="grain" />
      <div className="gradient-wash" />

      <div className="chrome-bar">
        <button
          type="button"
          className={`logo-lockup ${storiesHidden ? 'stories-hidden' : ''} ${logoHoldActive ? 'holding' : ''}`}
          onPointerDown={startLogoHold}
          onPointerUp={stopLogoHold}
          onPointerLeave={stopLogoHold}
          onPointerCancel={stopLogoHold}
          onKeyDown={handleLogoKeyDown}
          onKeyUp={stopLogoHold}
          onBlur={stopLogoHold}
          aria-pressed={storiesHidden}
          aria-label={`${brandName} — удерживайте 2 секунды, чтобы спрятать или вернуть истории`}
          title="Удерживайте 2 секунды, чтобы спрятать или вернуть истории"
        >
          <div className={`logo-mark ${branding.logoUrl ? 'has-image' : ''}`} data-testid="brand-mark">
            {branding.logoUrl ? (
              <img src={branding.logoUrl} alt={`${brandName} logo`} onError={handleLogoError} />
            ) : (
              <>
                <span className="logo-mark-initial">b</span>
                <span className="logo-mark-tail">vis</span>
              </>
            )}
          </div>
          <div className="logo-copy">
            <span className="logo-title">{brandName}</span>
            <span className="logo-subtitle">{headerSubtitle}</span>
          </div>
        </button>
      </div>

      {shouldShowStories && (
        <section className="story-rail" data-testid="story-rail">
          {highlightFaces.map((face) => (
            <StoryRing
              key={face.id}
              count={face.storyCount}
              seen={seenStoryIds.has(face.id)}
              src={face.src}
              alt={face.caption}
              label={face.label}
              size={74}
              onClick={() => startStory(face.id)}
              className={storyPlayingId === face.id ? 'playing' : undefined}
              dataTestId="story-circle"
              progressDuration={STORY_DURATION_MS}
              progressKey={storyPlayingId === face.id ? `${face.id}-${storyPlaybackNonce}` : null}
              onImageError={handleImageError}
            />
          ))}
          {extraFaces > 0 && (
            <div className="story-extra">
              <div className="story-extra-ring">
                <span className="story-count">+{extraFaces}</span>
              </div>
              <span className="story-label">больше кадров</span>
            </div>
          )}
        </section>
      )}

      <section className="batch-row" data-testid="batch-row">
        {batches.map((batch) => (
          <button
            key={batch.id}
            data-testid="batch-pill"
            className={`batch-pill ${batch.id === activeBatchId ? 'active' : ''}`}
            onClick={() => setActiveBatchId(batch.id)}
          >
            <span>{formatDate(batch.publishedAt)}</span>
            <small>{batch.photoCount} фото</small>
          </button>
        ))}
        {!batches.length && !loading && <div className="hint">Еще нет опубликованных подборок.</div>}
      </section>

      {error && (
        <div className="error" data-testid="error-banner">
          {error}
        </div>
      )}
      {tgLinked === false && (
        <div className="error muted" data-testid="tg-warning">
          Нет подключения к Telegram. Откройте мини-апп из чата бота, чтобы лайкать и сохранять прогресс.
        </div>
      )}

      <section className="feed" data-testid="feed">
        {loading && (
          <div className="loader" data-testid="loader">
            Загружаем ленту...
          </div>
        )}
        {!loading &&
          photos.map((photo, idx) => (
            <article className="photo-card" key={photo.id} data-testid="photo-card" data-photo-id={photo.id}>
              <div
                className="img-shell"
                role="button"
                tabIndex={0}
                onClick={() => openPreview(photo.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    openPreview(photo.id);
                  }
                }}
            >
              <img
                src={photoUrl(photo.fileId)}
                alt={photo.caption ?? 'Фото'}
                loading={idx < 2 ? 'eager' : 'lazy'}
                  decoding="async"
                  fetchPriority={idx < 2 ? 'high' : 'auto'}
                  sizes="(max-width: 900px) 100vw, 720px"
                  onError={handleImageError}
                  data-testid="photo-img"
                />
                <div className="img-overlay">
                  <div className="overlay-bottom">
                    <button
                      className={`like-heart ${likedIds.has(photo.id) ? 'active' : ''}`}
                      data-testid="like-button"
                      onClick={(event) => {
                        event.stopPropagation();
                        likePhoto(photo.id);
                      }}
                      aria-label={likedIds.has(photo.id) ? 'Убрать лайк' : 'Поставить лайк'}
                      disabled={pendingLikes.has(photo.id)}
                    >
                      <span aria-hidden>♡</span>
                      <strong>{photo.likes}</strong>
                    </button>
                  </div>
                </div>
              </div>
              <div className="card-footer">
                <div className="meta-block">
                  <p className="caption">{photo.caption || 'Без подписи'}</p>
                  <span className="stamp">
                    {formatDate(photo.publishedAt)} · {formatTime(photo.publishedAt)}
                  </span>
                </div>
                <button className="ghost-link" onClick={() => openPreview(photo.id)} data-testid="preview-button">
                  Развернуть
                </button>
              </div>
            </article>
          ))}
        {!loading && !photos.length && <div className="hint">Пока нет фото в этой подборке.</div>}
        <div ref={loaderRef} className="sentinel" aria-hidden data-testid="sentinel" />
        {loadingMore && (
          <div className="loader" data-testid="loader-more">
            Еще немного фото...
          </div>
        )}
      </section>

      {previewPhoto && (
        <div className="lightbox" data-testid="preview-modal" onClick={closePreview} role="dialog" aria-modal="true">
          <div
            className="lightbox-inner"
            onClick={(event) => event.stopPropagation()}
            data-testid="preview-inner"
            data-photo-id={previewPhoto.id}
            role="document"
            data-story-mode={isStoryPreview ? 'true' : undefined}
          >
            {isStoryPreview && (
              <div className="lightbox-story-track" aria-hidden>
                <span
                  key={`story-progress-${storyPlaybackNonce}`}
                  className="lightbox-story-progress"
                  style={{ animationDuration: `${STORY_DURATION_MS}ms` }}
                />
              </div>
            )}
            <button
              className="lightbox-close"
              onClick={closePreview}
              aria-label="Закрыть предпросмотр"
              data-testid="preview-close"
            >
              ×
            </button>
            <div className="lightbox-img">
              {isStoryPreview && (
                <>
                  <button
                    type="button"
                    className="lightbox-story-nav lightbox-story-nav-prev"
                    aria-label="Предыдущее фото"
                    onClick={(event) => {
                      event.stopPropagation();
                      goToStory('prev');
                    }}
                  />
                  <button
                    type="button"
                    className="lightbox-story-nav lightbox-story-nav-next"
                    aria-label="Следующее фото"
                    onClick={(event) => {
                      event.stopPropagation();
                      goToStory('next');
                    }}
                  />
                </>
              )}
              <img src={photoUrl(previewPhoto.fileId)} alt={previewPhoto.caption ?? 'Фото'} />
            </div>
            <div className="lightbox-meta">
              <div>
                <p className="caption">{previewPhoto.caption || 'Без подписи'}</p>
                <span className="stamp">
                  {formatDate(previewPhoto.publishedAt)} · {formatTime(previewPhoto.publishedAt)}
                </span>
              </div>
              <button
                className={`like-heart compact ${likedIds.has(previewPhoto.id) ? 'active' : ''}`}
                onClick={(event) => {
                  event.stopPropagation();
                  likePhoto(previewPhoto.id);
                }}
                disabled={pendingLikes.has(previewPhoto.id)}
                aria-label={likedIds.has(previewPhoto.id) ? 'Убрать лайк' : 'Поставить лайк'}
              >
                <span aria-hidden>♡</span>
                <strong>{previewPhoto.likes}</strong>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
