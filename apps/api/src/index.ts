import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import type { Server } from 'http';
import {
  PrismaClient,
  Prisma,
  PhotoStatus,
  NotificationStatus,
  AppointmentStatus,
  FeedbackChoice,
  Company,
  ClientUser,
} from '@prisma/client';
import { Telegraf, Markup, session, Context } from 'telegraf';
import { Message, PhotoSize, InputMediaPhoto } from 'telegraf/typings/core/types/typegram';
import crypto from 'crypto';
import pino from 'pino';
import pinoHttp from 'pino-http';
import axios from 'axios';
import { getMockBatches, getMockPhotos, incrementMockLike } from './mockFeed.js';

const prisma = new PrismaClient();
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const {
  ADMIN_BOT_TOKEN,
  CLIENT_BOT_TOKEN,
  WEB_APP_BASE_URL,
  ADMIN_WEBHOOK_SECRET = 'admin-webhook',
  CLIENT_WEBHOOK_SECRET = 'client-webhook',
  PORT = '8080',
  CORS_ORIGIN = '*',
  USE_POLLING = 'true',
  WEBHOOK_BASE_URL,
  NOTIFICATION_POLL_MS = '10000',
  NOTIFICATION_BATCH_SIZE = '25',
  USE_MOCK_MEDIA_FEED,
  SKIP_BOT_BOOTSTRAP,
  SKIP_NOTIFICATION_DISPATCHER,
  CLEAR_FEED_ON_BOOT = 'false',
} = process.env;

const useMockFeed =
  USE_MOCK_MEDIA_FEED === 'true' || (!process.env.DATABASE_URL && USE_MOCK_MEDIA_FEED !== 'false');
const allowMockFallback = useMockFeed || USE_MOCK_MEDIA_FEED === 'fallback';
const usingMockDueToMissingDb = useMockFeed && !process.env.DATABASE_URL && USE_MOCK_MEDIA_FEED !== 'true';
const DB_CONNECT_MAX_ATTEMPTS = Math.max(1, Number(process.env.DB_CONNECT_MAX_ATTEMPTS) || 5);
const DB_CONNECT_RETRY_MS = Math.max(500, Number(process.env.DB_CONNECT_RETRY_MS) || 2000);
const skipBotBootstrap = SKIP_BOT_BOOTSTRAP === 'true';
const skipNotificationDispatcher = SKIP_NOTIFICATION_DISPATCHER === 'true';
const databaseState: {
  ready: boolean;
  lastError: string | null;
  lastReadyTs?: number;
  attempts: number;
} = {
  ready: useMockFeed,
  lastError: null,
  lastReadyTs: useMockFeed ? Date.now() : undefined,
  attempts: 0,
};

const notificationPollMs = Math.max(5000, Number(NOTIFICATION_POLL_MS) || 10000);
const notificationBatchSize = Math.min(200, Math.max(1, Number(NOTIFICATION_BATCH_SIZE) || 25));
let notificationTimer: NodeJS.Timeout | null = null;
let notificationLoopActive = false;
const generatedMedia = new Map<string, { fileName: string; filePath: string; caption: string; createdAt: number; companyId: number }>();
const DEFAULT_COMPANY_SLUG = 'default';
const DEFAULT_COMPANY_NAME = 'Beauty Visuals';
const DEFAULT_INVITE_CODE = 'default-invite';
const INVITE_CODE_BYTES = 5;
let clientBotUsername: string | null = null;

if (!ADMIN_BOT_TOKEN || !CLIENT_BOT_TOKEN || !WEB_APP_BASE_URL) {
  logger.warn('Missing ADMIN_BOT_TOKEN, CLIENT_BOT_TOKEN or WEB_APP_BASE_URL. Bots and mini-app auth will not work properly.');
}

if (useMockFeed) {
  logger.info({ mockMediaDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'mock-media') }, 'Using mock media feed');
}
if (usingMockDueToMissingDb) {
  logger.warn(
    'DATABASE_URL is not defined; running in mock media mode. Set USE_MOCK_MEDIA_FEED=true explicitly to silence this warning.'
  );
}

const app = express();
const cspDirectives = helmet.contentSecurityPolicy.getDefaultDirectives();
cspDirectives['script-src'] = ["'self'", 'https://telegram.org', 'https://web.telegram.org'];
cspDirectives['connect-src'] = [
  ...(cspDirectives['connect-src'] || ["'self'"]),
  'https://telegram.org',
  'https://web.telegram.org',
  'https://api.telegram.org',
];
cspDirectives['img-src'] = ["'self'", 'data:', 'https://api.telegram.org'];

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: cspDirectives,
    },
  })
);
app.use(express.json({ limit: '10mb' }));
app.use(cors({ origin: CORS_ORIGIN === '*' ? '*' : CORS_ORIGIN.split(','), credentials: false }));
app.use(pinoHttp({ logger }));
app.use(morgan('tiny'));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const staticDir = path.resolve(__dirname, '..', '..', 'mini-app', 'dist');
const mockMediaDir = path.resolve(__dirname, '..', 'mock-media');
app.use(express.static(staticDir));
app.use('/mock-media', express.static(mockMediaDir));
type TelegramBotKind = 'client' | 'admin';
const fileCache = new Map<string, { path: string; expiresAt: number; bot: TelegramBotKind }>();

const shortId = (value?: string | null, len = 12) => {
  if (!value) return '';
  return value.length <= len ? value : `${value.slice(0, len)}…`;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const baseWebAppUrl = WEB_APP_BASE_URL?.replace(/\/$/, '') || '';

function slugify(value: string, fallback = 'studio') {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\\s-]/g, '')
    .replace(/\\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized || fallback;
}

async function generateUniqueCompanySlug(source: string) {
  const base = slugify(source || DEFAULT_COMPANY_NAME);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const suffix = attempt === 0 ? '' : `-${attempt}`;
    const slug = `${base}${suffix}`;
    const existing = await prisma.company.findUnique({ where: { slug } });
    if (!existing) return slug;
  }
  return `${base}-${crypto.randomBytes(3).toString('hex')}`;
}

async function generateInviteCode() {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = crypto.randomBytes(INVITE_CODE_BYTES).toString('hex');
    const existing = await prisma.company.findUnique({ where: { inviteCode: candidate } });
    if (!existing) return candidate;
  }
  return crypto.randomBytes(8).toString('hex');
}

async function ensureDefaultCompany() {
  return prisma.company.upsert({
    where: { slug: DEFAULT_COMPANY_SLUG },
    update: {},
    create: {
      name: DEFAULT_COMPANY_NAME,
      brandText: DEFAULT_COMPANY_NAME,
      slug: DEFAULT_COMPANY_SLUG,
      inviteCode: DEFAULT_INVITE_CODE,
    },
  });
}

function buildWebAppUrl(company?: { slug?: string | null } | null) {
  if (!baseWebAppUrl) return null;
  if (company?.slug) {
    const url = new URL(baseWebAppUrl, 'http://localhost');
    url.searchParams.set('company', company.slug);
    return baseWebAppUrl.includes('http') ? url.toString().replace('http://localhost', '') : url.toString();
  }
  return baseWebAppUrl;
}

function miniAppReplyMarkupForCompany(company?: Company | null) {
  const url = buildWebAppUrl(company);
  if (!url) return undefined;
  return {
    reply_markup: {
      inline_keyboard: [[{ text: 'Открыть мини-апп', web_app: { url } }]],
    },
  };
}

const DEMO_PROFILE = {
  brandName: 'Demo Beauty Studio',
  address: 'Demo street, 15',
  hours: 'пн.-вс. 10:00-19:00',
  phones: ['+1 555 0100', '+1 555 0101'],
  bookingUrl: 'https://example.com/booking',
  instagram: 'https://example.com/instagram',
  vk: 'https://example.com/social',
  email: 'hello@example.com',
};

const DEMO_ABOUT_TEXT =
  'Demo Beauty Studio shows how a salon can present services, published photo batches, and client-friendly contact actions inside a Telegram bot and mini app.';

const DEMO_SERVICES_TEXT =
  '▫️Макияж\n▫️Брови\n▫️Укладки и причёски\n▫️Уходы / окрашивание волос\n▫️Маникюр\n▫️Педикюр\n▫️Обучение';

const formatTelUrl = (phone: string) => `tel:${phone.replace(/[^\d+]/g, '')}`;

function formatInviteLink(inviteCode: string) {
  const username = clientBotUsername || process.env.CLIENT_BOT_USERNAME || 'example_client_bot';
  return `https://t.me/${username}?start=${inviteCode}`;
}

type LookbookPreset = { keyword: string; title: string; description: string; aliases?: string[] };
const LOOKBOOK_PRESETS: LookbookPreset[] = [
  {
    keyword: 'chrome',
    title: 'Хром и зеркальные покрытия',
    description: 'Подборка сияющих зеркальных дизайнов и металлических акцентов.',
    aliases: ['зеркало', 'металл'],
  },
  {
    keyword: 'wedding',
    title: 'Свадебная классика',
    description: 'Нежные нюдовые тона, молочные омбре и аккуратные акценты для торжества.',
    aliases: ['свадьба', 'невеста'],
  },
  {
    keyword: 'minimal',
    title: 'Минимализм и нюд',
    description: 'Чистые формы, спокойные оттенки и тонкие линии для ежедневного образа.',
    aliases: ['нюд', 'офис', 'минимал'],
  },
  {
    keyword: 'bold',
    title: 'Яркие акценты',
    description: 'Неон, графика и смелые цветовые блоки для смарт-стрита.',
    aliases: ['неон', 'яркий', 'bold'],
  },
];

const LOOKBOOK_MEDIA_LIMIT = 5;
const CARE_TIP_DELAY_HOURS = 12;
const FEEDBACK_DELAY_HOURS = 6;
const LOYALTY_REWARD_THRESHOLD = 10;
const LOYALTY_POINTS: Record<'visit' | 'like' | 'photo' | 'appointment', number> = {
  visit: 1,
  like: 2,
  photo: 3,
  appointment: 4,
};

function normalizeKeyword(keyword?: string | null) {
  if (!keyword) return '';
  return keyword.trim().toLowerCase();
}

function resolvePreset(keyword: string) {
  const normalized = normalizeKeyword(keyword);
  if (!normalized) return null;
  return LOOKBOOK_PRESETS.find(
    (preset) =>
      preset.keyword === normalized || preset.aliases?.some((alias) => normalizeKeyword(alias) === normalized)
  );
}

type LookbookTopicInfo = {
  keyword: string;
  title: string;
  description?: string | null;
  batchId?: number | null;
  heroPhotoFileId?: string | null;
   companyId?: number | null;
};

async function findLookbookTopic(keyword: string, companyId?: number): Promise<LookbookTopicInfo | null> {
  const normalized = normalizeKeyword(keyword);
  if (!normalized) return null;
  if (useMockFeed) {
    const presetOnly = resolvePreset(normalized);
    return presetOnly ? { keyword: presetOnly.keyword, title: presetOnly.title, description: presetOnly.description } : null;
  }
  try {
    const topic = await prisma.lookbookTopic.findFirst({
      where: { keyword: normalized, ...(companyId ? { companyId } : {}) },
      select: { keyword: true, title: true, description: true, batchId: true, heroPhotoFileId: true, companyId: true },
    });
    if (topic) return topic;
    if (companyId) {
      const fallbackTopic = await prisma.lookbookTopic.findFirst({
        where: { keyword: normalized, companyId: null },
        select: { keyword: true, title: true, description: true, batchId: true, heroPhotoFileId: true, companyId: true },
      });
      if (fallbackTopic) return fallbackTopic;
    }
  } catch (err) {
    logger.warn({ err, keyword: normalized, companyId }, 'Failed to fetch lookbook topic');
  }
  const preset = resolvePreset(normalized);
  if (preset) {
    return { keyword: preset.keyword, title: preset.title, description: preset.description };
  }
  return null;
}

async function fetchLookbookPhotos(topic: LookbookTopicInfo, companyId?: number): Promise<InputMediaPhoto[]> {
  const keyword = normalizeKeyword(topic.keyword);
  if (!keyword) return [];
  if (useMockFeed) return [];
  const scopeCompanyId = topic.companyId ?? companyId;
  try {
    const photos = await prisma.photo.findMany({
      where: {
        status: PhotoStatus.published,
        ...(scopeCompanyId ? { companyId: scopeCompanyId } : {}),
        ...(topic.batchId ? { batchId: topic.batchId } : { caption: { contains: keyword, mode: 'insensitive' } }),
      },
      orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
      take: LOOKBOOK_MEDIA_LIMIT,
    });
    if (!photos.length && topic.batchId) {
      // fallback to recent published photos
      const fallback = await prisma.photo.findMany({
        where: { status: PhotoStatus.published, ...(scopeCompanyId ? { companyId: scopeCompanyId } : {}) },
        orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
        take: LOOKBOOK_MEDIA_LIMIT,
      });
      return fallback.map((photo, index) => ({
        type: 'photo',
        media: photo.fileId,
        caption: index === 0 ? photo.caption ?? undefined : undefined,
      }));
    }
    return photos.map((photo, index) => ({
      type: 'photo',
      media: photo.fileId,
      caption: index === 0 ? photo.caption ?? undefined : undefined,
    }));
  } catch (err) {
    logger.error({ err, keyword, companyId: scopeCompanyId }, 'Failed to load lookbook photos');
    return [];
  }
}

type LoyaltyEvent = keyof typeof LOYALTY_POINTS;

async function applyLoyaltyProgress(user: ClientWithCompany, event: LoyaltyEvent) {
  if (useMockFeed) return user;
  const points = LOYALTY_POINTS[event] ?? 0;
  if (!points) return user;
  try {
    const now = new Date();
    let streak = 1;
    if (user.lastActivityAt) {
      const diffDays = (now.getTime() - new Date(user.lastActivityAt).getTime()) / (24 * 60 * 60 * 1000);
      streak = diffDays < 1.5 ? Math.min(user.streakCount + 1, 365) : 1;
    }
    const updated = await prisma.clientUser.update({
      where: { id: user.id },
      data: {
        loyaltyPoints: { increment: points },
        streakCount: streak,
        lastActivityAt: now,
      },
      select: { id: true, telegramId: true, loyaltyPoints: true, streakCount: true, companyId: true },
    });
    await maybeIssueLoyaltyReward(updated);
  } catch (err) {
    logger.warn({ err, userId: user.id, event }, 'Failed to apply loyalty progress');
  }
}

async function maybeIssueLoyaltyReward(user: { id: number; loyaltyPoints: number; telegramId?: string | null; companyId: number }) {
  if (useMockFeed) return;
  if (user.loyaltyPoints < LOYALTY_REWARD_THRESHOLD) return;
  const tier = Math.floor(user.loyaltyPoints / LOYALTY_REWARD_THRESHOLD);
  if (tier < 1) return;
  try {
    const existingRewards = await prisma.loyaltyReward.count({ where: { userId: user.id } });
    if (existingRewards >= tier) return;
    const label = `Бейдж #${tier}`;
    await prisma.loyaltyReward.create({
      data: {
        userId: user.id,
        companyId: user.companyId,
        type: 'badge',
        label,
        payload: { tier, issuedAt: new Date().toISOString() },
      },
    });
    await prisma.clientUser.update({
      where: { id: user.id },
      data: { lastRewardedAt: new Date() },
    });
    if (clientBot && user.telegramId) {
      let companyForMarkup: Company | null = null;
      try {
        companyForMarkup = await prisma.company.findUnique({ where: { id: user.companyId } });
      } catch {
        /* ignore */
      }
      await clientBot.telegram
        .sendMessage(
          user.telegramId,
          `🎉 Вы получили ${label}! Спасибо, что активно делитесь и поддерживаете мастеров.`,
          miniAppReplyMarkupForCompany(companyForMarkup ?? undefined)
        )
        .catch((err) => logger.warn({ err, userId: user.id }, 'Failed to send loyalty reward message'));
    }
  } catch (err) {
    logger.warn({ err, userId: user.id }, 'Failed to issue loyalty reward');
  }
}

async function scheduleCareTipReminder(userId: number, companyId: number, appointmentId: number, desiredAt: Date) {
  if (useMockFeed) return;
  const deliverAt = new Date(desiredAt.getTime() + CARE_TIP_DELAY_HOURS * 60 * 60 * 1000);
  const text =
    '🧴 Спасибо за визит! Через пару дней увлажните кутикулу и используйте масло — так глянец продержится дольше.';
  try {
    await prisma.notification.create({
      data: {
        userId,
        companyId,
        type: 'care_tip',
        payload: { text, appointmentId, tag: 'after_appointment' },
        deliverAt,
      },
    });
  } catch (err) {
    logger.warn({ err, appointmentId }, 'Failed to schedule care tip reminder');
  }
}

async function scheduleFeedbackPoll(userId: number, companyId: number, appointmentId: number, desiredAt: Date) {
  if (useMockFeed) return;
  const deliverAt = new Date(desiredAt.getTime() + FEEDBACK_DELAY_HOURS * 60 * 60 * 1000);
  const text = 'Как вам свежий маникюр? Поделитесь впечатлением:';
  try {
    await prisma.notification.create({
      data: {
        userId,
        companyId,
        type: 'feedback_poll',
        payload: { text, appointmentId, context: `appointment:${appointmentId}` },
        deliverAt,
      },
    });
  } catch (err) {
    logger.warn({ err, appointmentId }, 'Failed to schedule feedback poll');
  }
}

async function notifyAdminsAboutAppointment(details: { id: number; desiredAt: Date; note?: string | null }, user: ClientWithCompany) {
  if (!adminBot) return;
  try {
    const admins = await prisma.adminInfo.findMany({
      where: { companyId: user.companyId },
      select: { userId: true, clinicName: true },
    });
    if (!admins.length) return;
    const text = [
      '📅 Новая заявка на запись',
      `Клиент: ${formatName(user)}`,
      `Дата/время: ${details.desiredAt.toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}`,
      details.note ? `Комментарий: ${details.note}` : null,
      `ID заявки: ${details.id}`,
    ]
      .filter(Boolean)
      .join('\n');
    await Promise.all(
      admins.map((admin) =>
        adminBot.telegram.sendMessage(admin.userId, text).catch((err) => {
          logger.warn({ err, adminUserId: admin.userId }, 'Failed to send appointment notification');
        })
      )
    );
  } catch (err) {
    logger.warn({ err }, 'Failed to notify admins about appointment');
  }
}

async function respondWithLookbook(ctx: BotContext, keywordOrTopic: string | LookbookTopicInfo, company?: Company | null) {
  const topic = typeof keywordOrTopic === 'string' ? await findLookbookTopic(keywordOrTopic, company?.id) : keywordOrTopic;
  if (!topic) {
    await ctx.reply('Не нашли такой подборки. Попробуйте ключевые слова вроде chrome, wedding, minimal.');
    return;
  }
  const photos = await fetchLookbookPhotos(topic, company?.id);
  if (photos.length) {
    await ctx
      .replyWithMediaGroup(
        photos.map((item, index) => ({
          ...item,
          caption: index === 0 ? item.caption ?? topic.title : item.caption,
        }))
      )
      .catch((err) => logger.warn({ err }, 'Failed to send lookbook media group'));
  }
  const lines = [
    `«${topic.title}»`,
    topic.description,
    WEB_APP_BASE_URL ? 'Откройте мини-апп, чтобы посмотреть порцию целиком.' : undefined,
    ]
    .filter(Boolean)
    .join('\n');
  await ctx.reply(lines || topic.title, miniAppReplyMarkupForCompany(company ?? undefined));
}

function parseDateInput(text: string): Date | null {
  const normalized = normalizeKeyword(text);
  if (!normalized) return null;
  const now = new Date();
  if (normalized.includes('сегодня')) return now;
  if (normalized.includes('завтра')) {
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    return tomorrow;
  }
  const match = normalized.match(/(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?/);
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]) - 1;
  const year = match[3] ? Number(match[3].length === 2 ? `20${match[3]}` : match[3]) : now.getFullYear();
  const result = new Date(year, month, day);
  return Number.isNaN(result.getTime()) ? null : result;
}

function parseTimeInput(text: string): { hours: number; minutes: number } | null {
  const match = text.match(/(\d{1,2})[:.](\d{2})/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return { hours, minutes };
}

function formatAppointmentDate(date: Date) {
  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

async function tryHandleLookbook(ctx: BotContext, text: string, company?: Company | null) {
  const normalized = normalizeKeyword(text);
  if (!normalized || normalized.length < 3) return false;
  const attempt = await findLookbookTopic(normalized, company?.id);
  if (attempt) {
    await respondWithLookbook(ctx, attempt, company);
    return true;
  }
  const tokens = normalized.split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    if (token === normalized) continue;
    const topic = await findLookbookTopic(token, company?.id);
    if (topic) {
      await respondWithLookbook(ctx, topic, company);
      return true;
    }
  }
  return false;
}

async function resolveTelegramFilePath(fileId: string) {
  const cached = fileCache.get(fileId);
  if (cached && cached.expiresAt > Date.now()) {
    logger.debug({ fileId: shortId(fileId), bot: cached.bot, source: 'cache' }, 'Using cached Telegram file path');
    return cached;
  }

  const attempts: { token: string | undefined; bot: TelegramBotKind }[] = [];
  if (CLIENT_BOT_TOKEN) attempts.push({ token: CLIENT_BOT_TOKEN, bot: 'client' });
  if (ADMIN_BOT_TOKEN && ADMIN_BOT_TOKEN !== CLIENT_BOT_TOKEN) attempts.push({ token: ADMIN_BOT_TOKEN, bot: 'admin' });

  let lastError: unknown = null;
  for (const attempt of attempts) {
    try {
      const response = await axios.get(`https://api.telegram.org/bot${attempt.token}/getFile`, {
        params: { file_id: fileId },
      });
      const filePath = response.data.result?.file_path as string | undefined;
      if (!filePath) {
        throw new Error('file_path missing in getFile response');
      }
      const resolved = { path: filePath, expiresAt: Date.now() + 15 * 60 * 1000, bot: attempt.bot };
      fileCache.set(fileId, resolved);
      logger.info({ fileId: shortId(fileId), bot: attempt.bot, cacheTtlMs: 15 * 60 * 1000 }, 'Resolved Telegram file path');
      return resolved;
    } catch (err) {
      lastError = err;
      const errInfo =
        err && typeof err === 'object'
          ? {
              message: (err as any).message,
              status: (err as any)?.response?.status,
              description: (err as any)?.response?.data?.description,
              code: (err as any)?.code,
            }
          : { message: String(err) };
      logger.warn({ ...errInfo, fileId: shortId(fileId), bot: attempt.bot }, 'Telegram getFile failed');
    }
  }

  throw lastError ?? new Error('Could not resolve Telegram file path');
}

// Session state
interface SessionState {
  mode?:
    | 'admin-register'
    | 'admin-photo-broadcast'
    | 'admin-text-broadcast'
    | 'admin-reminder'
    | 'admin-nano-generate'
    | 'admin-add-content'
    | 'admin-upload-logo'
    | 'admin-brand-text'
    | 'client-await-photo'
    | 'client-booking';
  step?: string;
  payload?: Record<string, unknown>;
  previewInFlightAt?: number;
}

type BotContext = Context & { session: SessionState };
type AdminWithCompany = Prisma.AdminInfoGetPayload<{ include: { company: true } }>;
type ClientWithCompany = Prisma.ClientUserGetPayload<{ include: { company: true } }>;

const adminBot = ADMIN_BOT_TOKEN ? new Telegraf<BotContext>(ADMIN_BOT_TOKEN) : null;
const clientBot = CLIENT_BOT_TOKEN ? new Telegraf<BotContext>(CLIENT_BOT_TOKEN) : null;

adminBot?.use(session());
clientBot?.use(session());
adminBot?.use((ctx, next) => {
  ctx.session ??= {};
  return next();
});
clientBot?.use((ctx, next) => {
  ctx.session ??= {};
  return next();
});

const interactionLocks = new Set<string>();
const getInteractionKey = (ctx: BotContext) => String(ctx.chat?.id ?? ctx.from?.id ?? 'global');

function attachCallbackGuard(bot: Telegraf<BotContext>) {
  bot.use(async (ctx, next) => {
    if (!ctx.callbackQuery) return next();
    const key = getInteractionKey(ctx);
    if (interactionLocks.has(key)) {
      await ctx.answerCbQuery('Заканчиваем предыдущий шаг…').catch(() => undefined);
      return;
    }
    interactionLocks.add(key);
    await ctx.answerCbQuery().catch(() => undefined);
    try {
      await next();
    } finally {
      interactionLocks.delete(key);
    }
  });
}

if (adminBot) attachCallbackGuard(adminBot);
if (clientBot) attachCallbackGuard(clientBot);

const adminMenu = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('➕ Добавить новый контент', 'admin_add_content')],
    [Markup.button.callback('🪄 Сгенерировать фото', 'admin_generate_nano')],
    [Markup.button.callback('👀 Предпросмотр рассылки', 'admin_preview')],
    [Markup.button.callback('📢 Рассылка', 'admin_broadcast_menu')],
    [Markup.button.callback('🔔 Напоминание', 'admin_reminder_menu')],
    [Markup.button.callback('🎟 Ссылка для клиентов', 'admin_invite_link')],
    [Markup.button.callback('✏️ Текст рядом с логотипом', 'admin_brand_text')],
    [Markup.button.callback('🖼️ Логотип', 'admin_upload_logo')],
    [Markup.button.callback('📈 Статистика', 'admin_stats')],
  ]);

const broadcastMenu = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('🚀 В мини-апп', 'admin_broadcast_publish')],
    [Markup.button.callback('🖼️ Фото + текст', 'admin_broadcast_photo')],
    [Markup.button.callback('💬 Только текст', 'admin_broadcast_text')],
  ]);

const reminderOptions = [
  { key: 'now', label: 'Сразу', getDelayMinutes: () => 0 },
  { key: 'in60', label: 'Через 1 час', getDelayMinutes: () => 60 },
  {
    key: 'tomorrow9',
    label: 'Завтра в 09:00',
    getDelayMinutes: () => {
      const now = new Date();
      const target = new Date(now);
      target.setDate(now.getDate() + 1);
      target.setHours(9, 0, 0, 0);
      const diffMinutes = Math.max(0, Math.round((target.getTime() - now.getTime()) / 60000));
      return diffMinutes || 60; // fallback 1h
    },
  },
];

const reminderKeyboard = () =>
  Markup.inlineKeyboard([
    ...reminderOptions.map((opt) => [Markup.button.callback(opt.label, `admin_reminder_${opt.key}`)]),
    [Markup.button.callback('Отмена', 'admin_reminder_cancel')],
  ]);

// Helpers
function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  const computed = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(computed, 'hex'));
}

function formatName(user: { firstName?: string | null; lastName?: string | null; username?: string | null }) {
  if (user.firstName || user.lastName) {
    return [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  }
  if (user.username) return `@${user.username}`;
  return 'Пользователь';
}

// Telegram initData validation for WebApp
function parseInitData(initData?: string) {
  if (!initData || !CLIENT_BOT_TOKEN) return null;
  const urlParams = new URLSearchParams(initData);
  const hash = urlParams.get('hash');
  urlParams.delete('hash');
  const dataCheckString = [...urlParams.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secret = crypto.createHmac('sha256', 'WebAppData').update(CLIENT_BOT_TOKEN).digest();
  const hmac = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  if (hmac !== hash) {
    logger.warn({
      msg: 'Invalid initData hash',
      initDataLen: initData.length,
      userId: urlParams.get('user') ? 'present' : 'missing',
      firstParam: urlParams.entries().next().value?.[0],
    });
    return null;
  }

  const userJson = urlParams.get('user');
  if (!userJson) return null;
  try {
    const parsed = JSON.parse(userJson);
    const startParam = urlParams.get('start_param');
    if (startParam) {
      parsed.start_param = startParam;
    }
    return parsed;
  } catch (err) {
    logger.error({ err }, 'Failed to parse initData user');
    return null;
  }
}

// Shared DB helpers
async function findCompanyByInvite(inviteCode?: string | null) {
  if (!inviteCode) return null;
  const normalized = inviteCode.trim();
  if (!normalized) return null;
  return prisma.company.findFirst({ where: { OR: [{ inviteCode: normalized }, { slug: normalized }] } });
}

async function requireAdmin(ctx: BotContext): Promise<AdminWithCompany | null> {
  if (!ctx.from?.id) return null;
  const admin = await prisma.adminInfo.findUnique({
    where: { userId: String(ctx.from.id) },
    include: { company: true },
  });
  if (!admin) {
    await ctx.reply('Вы не зарегистрированы как администратор. Нажмите /start, чтобы пройти регистрацию.');
    return null;
  }
  if (!admin.company) {
    const fallbackCompany = await ensureDefaultCompany();
    const hydrated = await prisma.adminInfo.update({
      where: { id: admin.id },
      data: { companyId: fallbackCompany.id },
      include: { company: true },
    });
    return hydrated;
  }
  return admin;
}

async function getOrCreateClient(
  telegramUser: any,
  options: { companyHint?: Company | null; allowCrossCompany?: boolean } = {}
): Promise<ClientWithCompany> {
  if (!telegramUser?.id) throw new Error('No telegram user');
  const telegramId = String(telegramUser.id);
  const inviteCode = typeof telegramUser?.start_param === 'string' ? telegramUser.start_param : undefined;
  const invitedCompany = options.companyHint || (inviteCode ? await findCompanyByInvite(inviteCode) : null);
  const existing = await prisma.clientUser.findUnique({ where: { telegramId }, include: { company: true } });
  if (existing) {
    if (invitedCompany && existing.companyId !== invitedCompany.id && !options.allowCrossCompany) {
      return existing;
    }
    if (!existing.company) {
      const fallback = invitedCompany ?? (await ensureDefaultCompany());
      const updated = await prisma.clientUser.update({
        where: { id: existing.id },
        data: { companyId: fallback.id },
        include: { company: true },
      });
      return updated;
    }
    return existing;
  }
  const company = invitedCompany ?? (await ensureDefaultCompany());
  const created = await prisma.clientUser.create({
    data: {
      telegramId,
      firstName: telegramUser.first_name,
      lastName: telegramUser.last_name,
      username: telegramUser.username,
      companyId: company.id,
    },
    include: { company: true },
  });
  logger.info({ telegramId, username: telegramUser.username, company: company.slug }, 'Registered new client user');
  return created;
}

async function sendMiniAppNotification(message: string, company: Company) {
  if (!clientBot) return;
  const users = await prisma.clientUser.findMany({ where: { companyId: company.id }, select: { telegramId: true } });
  if (!users.length) return;
  const markup = miniAppReplyMarkupForCompany(company);
  for (const user of users) {
    try {
      const text = markup ? message : `${message}${WEB_APP_BASE_URL ? `\n${WEB_APP_BASE_URL}` : ''}`;
      await clientBot.telegram.sendMessage(user.telegramId, text, markup);
    } catch (err) {
      logger.warn({ err }, `Failed to notify user ${user.telegramId}`);
    }
  }
}

async function sendBroadcastText(companyId: number, text: string) {
  if (!clientBot) return { sent: 0, failed: 0, total: 0 };
  const users = await prisma.clientUser.findMany({ where: { companyId }, select: { telegramId: true } });
  let sent = 0;
  let failed = 0;
  for (const user of users) {
    try {
      await clientBot.telegram.sendMessage(user.telegramId, text);
      sent++;
    } catch (err) {
      failed++;
      logger.warn({ err }, `Failed to broadcast to ${user.telegramId}`);
    }
  }
  return { sent, failed, total: users.length };
}

async function sendBroadcastPhoto(companyId: number, file: string | { source: string | Buffer }, caption?: string) {
  if (!clientBot)
    return { sent: 0, failed: 0, total: 0, errors: [] as string[], fileId: null as string | null, fileUniqueId: null as string | null };
  const users = await prisma.clientUser.findMany({ where: { companyId }, select: { telegramId: true } });
  let sent = 0;
  let failed = 0;
  const errors: string[] = [];
  let canonicalFileId: string | null = null;
  let canonicalFileUniqueId: string | null = null;
  let fileToSend: string | { source: string | Buffer } = file;
  logger.info(
    {
      totalTargets: users.length,
      captionLength: caption?.length || 0,
      fileKind: typeof file === 'string' ? 'id-or-url' : 'upload',
    },
    'Starting broadcast photo delivery'
  );
  for (const user of users) {
    try {
      const message = await clientBot.telegram.sendPhoto(user.telegramId, fileToSend as any, { caption });
      sent++;
      if (!canonicalFileId && message.photo?.length) {
        const best = message.photo[message.photo.length - 1];
        canonicalFileId = best.file_id;
        canonicalFileUniqueId = best.file_unique_id;
        fileToSend = canonicalFileId;
      }
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : 'unknown error';
      if (errors.length < 5) errors.push(`user ${user.telegramId}: ${message}`);
      const warnPayload =
        err && typeof err === 'object'
          ? {
              message: (err as any).message,
              status: (err as any)?.response?.status,
              description: (err as any)?.response?.data?.description,
              code: (err as any)?.code,
            }
          : { message };
      logger.warn({ ...warnPayload, telegramId: user.telegramId }, 'Failed to broadcast photo to user');
    }
  }
  logger.info(
    { sent, failed, total: users.length, fileId: shortId(canonicalFileId), fileUniqueId: shortId(canonicalFileUniqueId) },
    'Completed photo broadcast'
  );
  return { sent, failed, total: users.length, errors, fileId: canonicalFileId, fileUniqueId: canonicalFileUniqueId };
}

async function getOrCreateLiveBatch(prefix: string, companyId: number) {
  const label = `${prefix} ${new Date().toISOString().slice(0, 10)}`;
  let batch = await prisma.photoBatch.findFirst({ where: { label, companyId } });
  if (!batch) {
    batch = await prisma.photoBatch.create({ data: { label, publishedAt: new Date(), companyId } });
    logger.info({ batchId: batch.id, label, companyId }, 'Created live photo batch');
  }
  return batch;
}

const NANO_SYSTEM_PROMPT =
  'Generate a single, photorealistic, high-resolution beauty shot. Focus on hands, nails, or feet with salon-quality manicures or pedicures. Use natural skin tones, clean backgrounds, soft studio light, 50mm/85mm lens feel, no text overlays, no watermarks, no extra fingers, no artifacts. Showcase the design clearly, with crisp focus and subtle depth of field.';

async function cloneFallbackNanoAsset(prefixBase: string) {
  const files = await fs.readdir(mockMediaDir);
  const fallbackCandidates = files.filter((file) => /^(nano-|mock-).*\.(png|jpe?g)$/i.test(file));
  if (!fallbackCandidates.length) {
    throw new Error('Fallback nano assets are missing in mock-media.');
  }
  const sourceFile = fallbackCandidates[Math.floor(Math.random() * fallbackCandidates.length)];
  const ext = path.extname(sourceFile) || '.jpg';
  const fallbackFileName = `${prefixBase}_fallback${ext}`;
  const sourcePath = path.join(mockMediaDir, sourceFile);
  const targetPath = path.join(mockMediaDir, fallbackFileName);
  await fs.copyFile(sourcePath, targetPath);
  logger.warn({ sourceFile, fallbackFileName }, 'Using fallback nano asset');
  return { fileName: fallbackFileName, filePath: targetPath };
}

async function generateNanoBananoAsset(userPrompt: string) {
  const scriptPath = path.resolve(__dirname, '..', '..', '..', 'scripts', 'generate_nano_banano_assets.py');
  const prefixBase = `nano-gen-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const prefix = path.join(mockMediaDir, prefixBase);
  const finalPrompt = `${NANO_SYSTEM_PROMPT}\nUser prompt: ${userPrompt}\nReturn a single photo-realistic image.`;

  if (!process.env.GOOGLE_API_KEY) {
    logger.warn('GOOGLE_API_KEY is missing; using fallback nano asset.');
    return cloneFallbackNanoAsset(prefixBase);
  }

  try {
    await fs.access(scriptPath);
  } catch (err) {
    logger.error({ err, scriptPath }, 'Nano-banano script is unavailable; using fallback asset.');
    return cloneFallbackNanoAsset(prefixBase);
  }

  const args = ['--prompt', finalPrompt, '--prefix', prefix, '--size', '2K'];
  logger.info({ scriptPath, prefix, args }, 'Starting nano-banano generation');
  try {
    const result = await new Promise<{ fileName: string; filePath: string }>((resolve, reject) => {
      const child = spawn('python3', [scriptPath, ...args], { env: process.env });
      let stderr = '';
      let stdout = '';
      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });
      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      child.on('close', async (code) => {
        if (code !== 0) {
          logger.error({ code, stderr }, 'nano-banano generator failed');
          reject(new Error(stderr || `Generator exited with code ${code}`));
          return;
        }
        try {
          const files = await fs.readdir(mockMediaDir);
          const matches = files.filter((f) => f.startsWith(`${prefixBase}_`));
          if (!matches.length) throw new Error('Generation completed but produced no files');
          matches.sort();
          const fileName = matches[matches.length - 1];
          const filePath = path.join(mockMediaDir, fileName);
          logger.info({ fileName }, 'nano-banano generated file');
          resolve({ fileName, filePath });
        } catch (err) {
          reject(err);
        }
      });
    });

    return result;
  } catch (err) {
    logger.error({ err }, 'nano-banano generator crashed; falling back to mock asset.');
    return cloneFallbackNanoAsset(prefixBase);
  }
}

type DbConnectOptions = {
  maxAttempts?: number;
  retryDelayMs?: number;
  silent?: boolean;
};

export async function ensureDatabaseConnection(options: DbConnectOptions = {}) {
  if (useMockFeed) {
    databaseState.ready = true;
    databaseState.lastError = null;
    databaseState.lastReadyTs = Date.now();
    return { ok: true as const, mock: true as const };
  }
  const maxAttempts = Math.max(1, options.maxAttempts ?? DB_CONNECT_MAX_ATTEMPTS);
  const retryDelayMs = Math.max(200, options.retryDelayMs ?? DB_CONNECT_RETRY_MS);
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    databaseState.attempts = attempt;
    try {
      await prisma.$connect();
      databaseState.ready = true;
      databaseState.lastError = null;
      databaseState.lastReadyTs = Date.now();
      if (!options.silent) {
        logger.info({ attempt }, 'Connected to database');
      }
      return { ok: true as const };
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : 'unknown error';
      databaseState.ready = false;
      databaseState.lastError = message;
      const logPayload = { err, attempt, maxAttempts };
      if (options.silent) {
        logger.debug(logPayload, 'Database connection attempt failed');
      } else {
        logger.error(logPayload, 'Database connection attempt failed');
      }
      if (attempt < maxAttempts) {
        await sleep(retryDelayMs);
      }
    }
  }
  throw lastError ?? new Error('Unable to establish database connection');
}

async function checkDatabaseHealth() {
  if (useMockFeed) {
    return { ok: true as const, mock: true as const, lastReadyTs: databaseState.lastReadyTs };
  }
  try {
    await prisma.$queryRaw`SELECT 1`;
    databaseState.ready = true;
    databaseState.lastError = null;
    databaseState.lastReadyTs = Date.now();
    return { ok: true as const, lastReadyTs: databaseState.lastReadyTs };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    databaseState.ready = false;
    databaseState.lastError = message;
    logger.error({ err }, 'Database health check failed');
    return { ok: false as const, error: message, lastError: message, lastReadyTs: databaseState.lastReadyTs };
  }
}

async function clearFeedContent() {
  if (useMockFeed) return;
  const cleared = await prisma.$transaction([
    prisma.notification.deleteMany(),
    prisma.like.deleteMany(),
    prisma.photo.deleteMany(),
    prisma.photoBatch.deleteMany(),
    prisma.lookbookTopic.updateMany({ data: { batchId: null, heroPhotoFileId: null } }),
  ]);
  logger.info(
    {
      notifications: cleared[0].count,
      likes: cleared[1].count,
      photos: cleared[2].count,
      batches: cleared[3].count,
      lookbooksReset: cleared[4].count,
    },
    'Feed content cleared on boot'
  );
}

async function createNotificationsForAllClients(
  companyId: number,
  text: string,
  deliverAt: Date,
  payloadMeta: Record<string, unknown> = {},
  type = 'manual_broadcast'
) {
  const users = await prisma.clientUser.findMany({ where: { companyId }, select: { id: true } });
  if (!users.length) return 0;

  const payload: Prisma.InputJsonValue = { text, ...payloadMeta };
  const entries = users.map((user) => ({
    userId: user.id,
    companyId,
    type,
    payload,
    deliverAt,
  }));

  let created = 0;
  for (let i = 0; i < entries.length; i += 500) {
    const batch = entries.slice(i, i + 500);
    const result = await prisma.notification.createMany({ data: batch });
    created += result.count;
  }
  logger.info(
    { created, deliverAt, payloadKeys: Object.keys(payloadMeta), type, companyId, targets: users.length },
    'Created notifications for clients'
  );
  return created;
}

async function scheduleBatchFeedback(batchId: number, label: string, company: Company) {
  const text = `Как вам новая подборка «${label}»?`;
  await createNotificationsForAllClients(company.id, text, new Date(), { context: `batch:${batchId}`, batchId }, 'feedback_poll');
}

async function dispatchPendingNotifications() {
  if (notificationLoopActive) return;
  if (!clientBot) return;
  notificationLoopActive = true;
  try {
    logger.debug({ batchSize: notificationBatchSize }, 'Checking pending notifications');
    const pending = await prisma.notification.findMany({
      where: { status: NotificationStatus.pending, deliverAt: { lte: new Date() } },
      orderBy: [{ deliverAt: 'asc' }, { id: 'asc' }],
      take: notificationBatchSize,
      include: { user: true, company: true },
    });

    for (const notif of pending) {
      let status: NotificationStatus = NotificationStatus.sent;
      let sentAt: Date | null = new Date();
      let error: string | null = null;
      try {
        if (!notif.user?.telegramId) {
          throw new Error('User telegramId missing');
        }
        if (notif.user.companyId !== notif.companyId) {
          throw new Error('Notification/company mismatch');
        }
        const markup = miniAppReplyMarkupForCompany(notif.company ?? undefined);
        const payload = notif.payload as any;
        if (notif.type === 'feedback_poll') {
          const text = payload?.text ?? 'Как вам подборка?';
          const keyboard = [
            [
              { text: '🔥 Love it', callback_data: `feedback_vote_${notif.id}_love` },
              { text: 'Need tweaks', callback_data: `feedback_vote_${notif.id}_tweak` },
            ],
          ];
          await clientBot.telegram.sendMessage(notif.user.telegramId, text, {
            reply_markup: { inline_keyboard: keyboard },
          });
        } else if (notif.type === 'care_tip') {
          const text = payload?.text ?? 'Совет по уходу';
          await clientBot.telegram.sendMessage(notif.user.telegramId, text, markup);
        } else {
          const text = payload?.text ?? 'Уведомление';
          await clientBot.telegram.sendMessage(notif.user.telegramId, String(text), markup);
        }
      } catch (err) {
        status = NotificationStatus.failed;
        sentAt = null;
        error = err instanceof Error ? err.message.slice(0, 240) : 'unknown error';
        logger.warn({ err, notificationId: notif.id }, 'Failed to deliver notification');
      }

      await prisma.notification.update({
        where: { id: notif.id },
        data: { status, sentAt, error },
      });
    }
    logger.info({ checked: pending.length }, 'Notification dispatch iteration completed');
  } catch (err) {
    logger.error({ err }, 'Notification dispatch loop failed');
  } finally {
    notificationLoopActive = false;
  }
}

function startNotificationDispatcher() {
  if (notificationTimer) return;
  if (useMockFeed) {
    logger.info('Notification dispatcher disabled in mock mode');
    return;
  }
  if (!clientBot) {
    logger.warn('Client bot is not configured; notification dispatcher disabled');
    return;
  }
  notificationTimer = setInterval(dispatchPendingNotifications, notificationPollMs);
  dispatchPendingNotifications().catch((err) => logger.error({ err }, 'Initial notification dispatch failed'));
}

async function scheduleReminder(ctx: BotContext, delayMinutes: number) {
  const admin = await requireAdmin(ctx);
  if (!admin) return;
  const message = (ctx.session.payload as { reminderText?: string } | undefined)?.reminderText;
  if (!message) {
    await ctx.reply('Сначала отправьте текст уведомления.');
    return;
  }
  const deliverAt = new Date(Date.now() + delayMinutes * 60 * 1000);
  let created = 0;
  try {
    created = await createNotificationsForAllClients(admin.companyId, message, deliverAt, {
      requestedBy: admin.login,
      delayMinutes,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to create notifications');
    await ctx.reply('Не удалось создать уведомления, попробуйте еще раз.', adminMenu());
    return;
  }

  ctx.session.mode = undefined;
  ctx.session.step = undefined;
  ctx.session.payload = undefined;

  if (!created) {
    await ctx.reply('Клиентов пока нет, уведомлять некого.', adminMenu());
    return;
  }

  const ts = deliverAt.toLocaleString('ru-RU', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' });
  const timing = delayMinutes === 0 ? 'Отправляем прямо сейчас.' : `Запланировано на ${ts}.`;
  await ctx.reply(`Запланировано ${created} уведомлений. ${timing}`, adminMenu());
}

// Admin bot handlers
adminBot?.start(async (ctx) => {
  const telegramId = String(ctx.from?.id);
  const admin = await prisma.adminInfo.findUnique({ where: { userId: telegramId }, include: { company: true } });
  if (admin) {
    const inviteTail = admin.company?.inviteCode ? `\nСсылка для клиентов: ${formatInviteLink(admin.company.inviteCode)}` : '';
    await ctx.reply(`Привет, ${admin.clinicName}!${inviteTail}`, adminMenu());
    return;
  }
  ctx.session.mode = 'admin-register';
  ctx.session.step = 'policy';
  ctx.session.payload = undefined;
  await ctx.reply('Для регистрации администратора подтвердите согласие с политикой конфиденциальности.', {
    reply_markup: {
      inline_keyboard: [[{ text: 'Согласен', callback_data: 'admin_policy_yes' }]],
    },
  });
});

adminBot?.action('admin_policy_yes', async (ctx) => {
  if (ctx.session.mode !== 'admin-register') return;
  ctx.session.payload = {};
  ctx.session.step = 'login';
  await ctx.editMessageText('Придумайте логин администратора:');
});

adminBot?.on('text', async (ctx) => {
  if (ctx.session.mode === 'admin-register') {
    if (ctx.session.step === 'login') {
      ctx.session.payload = { ...ctx.session.payload, login: ctx.message.text.trim() };
      ctx.session.step = 'password';
      await ctx.reply('Введите пароль (он сохраняется только в боте):');
      return;
    }
    if (ctx.session.step === 'password') {
      ctx.session.payload = { ...ctx.session.payload, password: ctx.message.text };
      ctx.session.step = 'clinic';
      await ctx.reply('Укажите название своего салона:');
      return;
    }
    if (ctx.session.step === 'clinic') {
      const payload = ctx.session.payload as { clinicName?: string; login?: string; password?: string };
      const adminLogin = (payload?.login || '').trim();
      if (!adminLogin || !payload?.password) {
        await ctx.reply('Что-то пошло не так, начните заново /start');
        return;
      }
      const passwordHash = hashPassword(payload.password);
      const clinicName = ctx.message.text?.trim() || DEFAULT_COMPANY_NAME;
      try {
        const slugSource = clinicName || adminLogin || DEFAULT_COMPANY_NAME;
        const slug = await generateUniqueCompanySlug(slugSource);
        const inviteCode = await generateInviteCode();
        const company = await prisma.$transaction(async (tx) => {
          const createdCompany = await tx.company.create({
            data: { name: clinicName, brandText: clinicName, slug, inviteCode },
          });
          await tx.adminInfo.create({
            data: {
              userId: String(ctx.from?.id),
              clinicName,
              login: adminLogin,
              passwordHash,
              companyId: createdCompany.id,
            },
          });
          return createdCompany;
        });
        ctx.session.mode = undefined;
        ctx.session.step = undefined;
        ctx.session.payload = undefined;
        await ctx.reply(
          `Регистрация завершена! Ссылка для ваших клиентов:\n${formatInviteLink(company.inviteCode)}`,
          adminMenu()
        );
      } catch (err) {
        logger.error({ err }, 'Failed to create admin');
        await ctx.reply('Не удалось сохранить. Возможно логин уже используется. Попробуйте другой логин.');
        ctx.session.step = 'login';
        ctx.session.payload = {};
      }
      return;
    }
  }

  if (ctx.session.mode === 'admin-brand-text') {
    const admin = await requireAdmin(ctx);
    if (!admin) return;
    const incoming = ctx.message.text?.trim() ?? '';
    if (!incoming) {
      await ctx.reply('Введите текст, например «Demo Beauty Studio».');
      return;
    }
    const normalized = incoming.slice(0, 500).trim();
    const lowered = normalized.toLowerCase();
    const shouldReset = lowered === 'сброс' || lowered === 'reset' || lowered === 'очистить';
    if (!shouldReset && normalized.length > 50) {
      await ctx.reply('Текст слишком длинный. Сократите до 50 символов.');
      return;
    }
    try {
      const updatedCompany = await prisma.company.update({
        where: { id: admin.companyId },
        data: { brandText: shouldReset ? null : normalized },
      });
      ctx.session.mode = undefined;
      ctx.session.step = undefined;
      ctx.session.payload = undefined;
      const appliedText = shouldReset ? updatedCompany.name : normalized;
      const statusLine = shouldReset
        ? 'Текст сброшен до названия салона.'
        : 'Обновили текст рядом с логотипом.';
      await ctx.reply(
        `${statusLine}\n${appliedText}\n\nОткройте мини-апп снова, чтобы увидеть изменение.`,
        miniAppReplyMarkupForCompany(updatedCompany)
      );
    } catch (err) {
      logger.error({ err }, 'Failed to update company brand text');
      await ctx.reply('Не получилось сохранить текст. Попробуйте еще раз.');
    }
    return;
  }

  if (ctx.session.mode === 'admin-add-content') {
    const admin = await requireAdmin(ctx);
    if (!admin) return;
    const text = ctx.message.text?.trim().toLowerCase();
    if (text === 'готово' || text === 'стоп') {
      ctx.session.mode = undefined;
      ctx.session.step = undefined;
      ctx.session.payload = undefined;
      await ctx.reply(
        'Готово. Фотографии уже опубликованы в мини-аппе.',
        adminMenu()
      );
      return;
    }
    const latestPhotoId = (ctx.session.payload as { latestPhotoId?: number } | undefined)?.latestPhotoId;
    if (!latestPhotoId) {
      await ctx.reply('Сначала отправьте фото. Затем текстом можно обновить подпись последнего фото.');
      return;
    }
    const newCaption = ctx.message.text?.trim();
    try {
      const ownedPhoto = await prisma.photo.findFirst({ where: { id: latestPhotoId, companyId: admin.companyId } });
      if (!ownedPhoto) {
        await ctx.reply('Не нашли фото в вашей ленте. Отправьте новое фото и попробуйте снова.');
        return;
      }
      await prisma.photo.update({ where: { id: ownedPhoto.id }, data: { caption: newCaption } });
      await ctx.reply('Обновили подпись последнего фото. Добавьте еще фото или напишите «готово».');
    } catch (err) {
      logger.error({ err }, 'Failed to update caption for admin upload');
      await ctx.reply('Не удалось обновить подпись, попробуйте еще раз.');
    }
    return;
  }

  if (ctx.session.mode === 'admin-nano-generate') {
    const admin = await requireAdmin(ctx);
    if (!admin) return;
    const prompt = ctx.message.text.trim();
    if (!prompt) {
      await ctx.reply('Введите описание дизайна для генерации.');
      return;
    }
    await ctx.reply('Генерируем фотореалистичное фото (2K)...');
    try {
      const { fileName, filePath } = await generateNanoBananoAsset(prompt);
      const fileUniqueId = crypto.createHash('sha1').update(fileName + prompt).digest('hex');
      const createdPhoto = await prisma.photo.create({
        data: {
          fileId: fileName,
          fileUniqueId,
          caption: prompt,
          uploaderId: null,
          companyId: admin.companyId,
        },
      });
      const token = crypto.randomBytes(6).toString('hex');
      generatedMedia.set(token, { fileName, filePath, caption: prompt, createdAt: Date.now(), companyId: admin.companyId });
      setTimeout(() => generatedMedia.delete(token), 30 * 60 * 1000);
      const previewMessage = await ctx.replyWithPhoto(
        { source: filePath },
        {
          caption: `Добавили в черновики: ${fileName}`,
          reply_markup: {
            inline_keyboard: [
              [{ text: '📨 Разослать фото + текст', callback_data: `admin_send_gen_${token}` }],
            ],
          },
        }
      );
      const previewPhoto = (previewMessage as Message.PhotoMessage).photo?.at(-1);
      if (previewPhoto?.file_id) {
        await prisma.photo.update({
          where: { id: createdPhoto.id },
          data: {
            fileId: previewPhoto.file_id,
            fileUniqueId: previewPhoto.file_unique_id ?? fileUniqueId,
          },
        });
      }
    } catch (err) {
      logger.error({ err }, 'nano-banano generation failed');
      const hint =
        err instanceof Error && err.message.includes('GOOGLE_API_KEY')
          ? 'Задайте GOOGLE_API_KEY в переменных окружения.'
          : 'Попробуйте еще раз или скорректируйте запрос.';
      await ctx.reply(`Не удалось сгенерировать фото. ${hint}`);
    } finally {
      ctx.session.mode = undefined;
      ctx.session.step = undefined;
      ctx.session.payload = undefined;
    }
    return;
  }

  if (ctx.session.mode === 'admin-reminder') {
    const text = ctx.message.text.trim();
    if (!text) {
      await ctx.reply('Введите текст уведомления.');
      return;
    }
    ctx.session.payload = { ...ctx.session.payload, reminderText: text };
    ctx.session.step = 'reminder-schedule';
    await ctx.reply(
      'Когда отправить уведомление? Выберите слот ниже или отмените.',
      reminderKeyboard()
    );
    return;
  }

  if (ctx.session.mode === 'admin-text-broadcast') {
    const admin = await requireAdmin(ctx);
    if (!admin) return;
    const text = ctx.message.text;
    ctx.session.mode = undefined;
    const result = await sendBroadcastText(admin.companyId, text);
    const summary =
      result.total === 0
        ? 'Нет зарегистрированных клиентов для рассылки.'
        : `Текст отправлен: ${result.sent}/${result.total}${result.failed ? `, ошибок: ${result.failed}` : ''}.`;
    await ctx.reply(summary);
    return;
  }
});

adminBot?.action('admin_add_content', async (ctx) => {
  await ctx.answerCbQuery().catch(() => undefined);
  const admin = await requireAdmin(ctx);
  if (!admin) return;
  ctx.session.mode = 'admin-add-content';
  ctx.session.step = 'await-photo';
  ctx.session.payload = {};
  await ctx.reply(
    'Отправьте фото (с подписью или без), мы сразу опубликуем его в мини-аппе в подборке «Админ-публикация». Можно отправить несколько подряд. Текстом после фото можно поправить его подпись. Напишите «готово», когда закончите.',
    adminMenu()
  );
});

adminBot?.action('admin_generate_nano', async (ctx) => {
  await ctx.answerCbQuery().catch(() => undefined);
  const admin = await requireAdmin(ctx);
  if (!admin) return;
  ctx.session.mode = 'admin-nano-generate';
  ctx.session.step = 'nano-prompt';
  ctx.session.payload = {};
  const example =
    'пример: «крупный план, нюдовые ногти с золотыми хлопьями, мягкий рассеянный свет, минимализм»';
  await ctx.reply(`Опишите, что нужно сгенерировать (руки/ноги/маникюр). ${example}`);
});

adminBot?.action('admin_preview', async (ctx) => {
  await ctx.answerCbQuery().catch(() => undefined);
  const admin = await requireAdmin(ctx);
  if (!admin) return;
  const now = Date.now();
  if (ctx.session.previewInFlightAt && now - ctx.session.previewInFlightAt < 5000) {
    await ctx.reply('Предпросмотр уже отправляется, подождите немного.');
    return;
  }
  ctx.session.previewInFlightAt = now;
  const drafts = await prisma.photo.findMany({
    where: { status: PhotoStatus.draft, companyId: admin.companyId },
    orderBy: { createdAt: 'desc' },
  });
  if (!drafts.length) {
    await ctx.reply('Нет нового контента для предпросмотра.');
    ctx.session.previewInFlightAt = undefined;
    return;
  }
  await ctx.reply('Так выглядит сообщение у клиентов:', miniAppReplyMarkupForCompany(admin.company));
  await ctx.reply('Черновики, которые уйдут в мини-апп:');
  for (const photo of drafts) {
    await ctx.replyWithPhoto(photo.fileId, { caption: photo.caption ?? 'Без подписи' });
  }
  ctx.session.previewInFlightAt = undefined;
});

adminBot?.action('admin_broadcast_menu', async (ctx) => {
  await ctx.answerCbQuery().catch(() => undefined);
  const admin = await requireAdmin(ctx);
  if (!admin) return;
  await ctx.reply('Выберите тип рассылки:', broadcastMenu());
});

adminBot?.action('admin_reminder_menu', async (ctx) => {
  await ctx.answerCbQuery().catch(() => undefined);
  const admin = await requireAdmin(ctx);
  if (!admin) return;
  ctx.session.mode = 'admin-reminder';
  ctx.session.step = 'reminder-message';
  ctx.session.payload = {};
  await ctx.reply('Введите текст уведомления, оно уйдет всем клиентам.', {
    reply_markup: {
      inline_keyboard: [[{ text: 'Отмена', callback_data: 'admin_reminder_cancel' }]],
    },
  });
});

adminBot?.action('admin_invite_link', async (ctx) => {
  await ctx.answerCbQuery().catch(() => undefined);
  const admin = await requireAdmin(ctx);
  if (!admin) return;
  const inviteLink = formatInviteLink(admin.company.inviteCode);
  const text = [
    'Пригласите клиентов через ссылку ниже, чтобы они видели только ваш контент и получали ваши уведомления:',
    inviteLink,
    '',
    'Ссылка закрепляет пользователя за вашим кабинетом.',
  ].join('\n');
  await ctx.reply(text, adminMenu());
});

adminBot?.action('admin_brand_text', async (ctx) => {
  await ctx.answerCbQuery().catch(() => undefined);
  const admin = await requireAdmin(ctx);
  if (!admin) return;
  ctx.session.mode = 'admin-brand-text';
  ctx.session.step = 'await-brand-text';
  ctx.session.payload = {};
  const current = admin.company.brandText || admin.company.name;
  await ctx.reply(
    `Текущий текст рядом с логотипом:\n${current}\n\nОтправьте новый текст (до 50 символов). Напишите «сброс», чтобы вернуть название салона.`,
    adminMenu()
  );
});

adminBot?.action('admin_upload_logo', async (ctx) => {
  await ctx.answerCbQuery().catch(() => undefined);
  const admin = await requireAdmin(ctx);
  if (!admin) return;
  ctx.session.mode = 'admin-upload-logo';
  ctx.session.step = 'await-logo';
  ctx.session.payload = {};
  await ctx.reply(
    'Отправьте логотип в PNG (лучше квадрат 512x512). Можно отправить как фото или файл-документ — мы обновим бренд в мини-аппе без выката.',
    adminMenu()
  );
});

adminBot?.action('admin_broadcast_publish', async (ctx) => {
  await ctx.answerCbQuery().catch(() => undefined);
  const admin = await requireAdmin(ctx);
  if (!admin) return;
  const drafts = await prisma.photo.findMany({ where: { status: PhotoStatus.draft, companyId: admin.companyId } });
  if (!drafts.length) {
    await ctx.reply('Нет новых фото для публикации.');
    return;
  }
  const label = new Date().toISOString().slice(0, 10);
  const batch = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const createdBatch = await tx.photoBatch.create({ data: { label, companyId: admin.companyId } });
    await tx.photo.updateMany({
      where: { status: PhotoStatus.draft, companyId: admin.companyId },
      data: { status: PhotoStatus.published, publishedAt: new Date(), batchId: createdBatch.id },
    });
    return createdBatch;
  });
  await sendMiniAppNotification('Пришла новая порция фотографий в мини-апп!', admin.company);
  if (batch) {
    await scheduleBatchFeedback(batch.id, batch.label, admin.company);
  }
  await ctx.reply('Фотографии опубликованы и уведомления отправлены.');
});

adminBot?.action('admin_broadcast_photo', async (ctx) => {
  await ctx.answerCbQuery().catch(() => undefined);
  const admin = await requireAdmin(ctx);
  if (!admin) return;
  ctx.session.mode = 'admin-photo-broadcast';
  await ctx.reply('Отправьте фото с подписью, мы разошлем всем клиентам.');
});

adminBot?.action('admin_broadcast_text', async (ctx) => {
  await ctx.answerCbQuery().catch(() => undefined);
  const admin = await requireAdmin(ctx);
  if (!admin) return;
  ctx.session.mode = 'admin-text-broadcast';
  await ctx.reply('Введите текст рассылки:');
});

reminderOptions.forEach((opt) => {
  adminBot?.action(`admin_reminder_${opt.key}`, async (ctx) => {
    await ctx.answerCbQuery().catch(() => undefined);
    const minutes = opt.getDelayMinutes();
    await scheduleReminder(ctx, minutes);
  });
});

adminBot?.action(/admin_send_gen_(.+)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => undefined);
  const admin = await requireAdmin(ctx);
  if (!admin) return;
  const token = ctx.match?.[1];
  if (!token) return;
  const media = generatedMedia.get(token);
  if (!media) {
    await ctx.reply('Не нашли сгенерированное фото или оно устарело. Сгенерируйте заново.');
    return;
  }
  if (media.companyId !== admin.companyId) {
    await ctx.reply('Эта заготовка принадлежит другой команде. Сгенерируйте новое фото.');
    return;
  }
  try {
    const batch = await getOrCreateLiveBatch('Админ-публикация', admin.companyId);
    const result = await sendBroadcastPhoto(admin.companyId, { source: media.filePath }, media.caption);
    const existing = await prisma.photo.findFirst({ where: { fileId: media.fileName, companyId: admin.companyId } });
    const fallbackUniqueId = crypto.createHash('sha1').update(media.fileName + media.caption).digest('hex');
    const fileIdToPersist = result.fileId ?? existing?.fileId ?? media.fileName;
    const fileUniqueIdToPersist = result.fileUniqueId ?? existing?.fileUniqueId ?? fallbackUniqueId;

    if (existing) {
      await prisma.photo.update({
        where: { id: existing.id },
        data: {
          status: PhotoStatus.published,
          publishedAt: new Date(),
          batchId: batch.id,
          fileId: fileIdToPersist,
          fileUniqueId: fileUniqueIdToPersist,
          companyId: admin.companyId,
        },
      });
    } else {
      await prisma.photo.create({
        data: {
          fileId: fileIdToPersist,
          fileUniqueId: fileUniqueIdToPersist,
          caption: media.caption,
          status: PhotoStatus.published,
          publishedAt: new Date(),
          batchId: batch.id,
          companyId: admin.companyId,
        },
      });
    }
    logger.info(
      {
        generatedFile: media.fileName,
        storedFileId: shortId(fileIdToPersist),
        storedUniqueId: shortId(fileUniqueIdToPersist),
        broadcast: { sent: result.sent, failed: result.failed, total: result.total },
      },
      'Generated photo published'
    );
    const summary =
      result.total === 0
        ? 'Нет зарегистрированных клиентов для рассылки.'
        : `Фото отправлено: ${result.sent}/${result.total}${result.failed ? `, ошибок: ${result.failed}` : ''}.`;
    await ctx.reply(summary);
    if (result.errors?.length) {
      await ctx.reply(`Первые ошибки:\n${result.errors.join('\n')}`.slice(0, 800));
    }
  } catch (err) {
    logger.error({ err }, 'Failed to broadcast generated photo');
    await ctx.reply('Не удалось отправить рассылку. Попробуйте снова.');
  }
});

adminBot?.action('admin_reminder_cancel', async (ctx) => {
  await ctx.answerCbQuery().catch(() => undefined);
  ctx.session.mode = undefined;
  ctx.session.step = undefined;
  ctx.session.payload = undefined;
  try {
    await ctx.editMessageText('Рассылка уведомлений отменена.');
  } catch {
    await ctx.reply('Рассылка уведомлений отменена.', adminMenu());
  }
});

adminBot?.action('admin_stats', async (ctx) => {
  const admin = await requireAdmin(ctx);
  if (!admin) return;
  const totalUsers = await prisma.clientUser.count({ where: { companyId: admin.companyId } });
  const miniAppOpeners = await prisma.clientUser.count({
    where: { companyId: admin.companyId, miniAppOpens: { gt: 0 } },
  });
  const likedUsers = await prisma.like.findMany({
    where: { user: { companyId: admin.companyId } },
    distinct: ['userId'],
    select: { userId: true },
  });
  const statsMessage = [
    `Пользователей в боте: ${totalUsers}`,
    `Перешли в мини-апп: ${miniAppOpeners}`,
    `Поставили хотя бы один лайк: ${likedUsers.length}`,
  ].join('\n');
  await ctx.reply(statsMessage);
});

adminBot?.on('photo', async (ctx) => {
  if (ctx.session.mode === 'admin-upload-logo') {
    const admin = await requireAdmin(ctx);
    if (!admin) return;
    const photoSizes = (ctx.message as Message.PhotoMessage).photo;
    const file = photoSizes[photoSizes.length - 1];
    try {
      await prisma.company.update({
        where: { id: admin.companyId },
        data: { logoFileId: file.file_id, logoFileUniqueId: file.file_unique_id },
      });
      ctx.session.mode = undefined;
      ctx.session.step = undefined;
      ctx.session.payload = undefined;
      await ctx.reply(
        'Логотип обновлен. Если нужен PNG без сжатия, отправьте файл как документ. Обновление появится в мини-аппе в течение минуты.',
        miniAppReplyMarkupForCompany(admin.company)
      );
    } catch (err) {
      logger.error({ err }, 'Failed to save logo from photo');
      await ctx.reply('Не удалось сохранить логотип. Попробуйте еще раз или отправьте как файл PNG.');
    }
    return;
  }

  if (ctx.session.mode === 'admin-add-content') {
    const admin = await requireAdmin(ctx);
    if (!admin) return;
    const photoSizes = (ctx.message as Message.PhotoMessage).photo;
    const file = photoSizes[photoSizes.length - 1];
    const caption = (ctx.message as Message.PhotoMessage).caption;
    logger.info(
      { adminId: ctx.from?.id, adminLogin: admin.login, fileId: shortId(file.file_id), captionLength: caption?.length || 0 },
      'Admin photo received for instant publish'
    );
    try {
      const batch = await getOrCreateLiveBatch('Админ-публикация', admin.companyId);
      const created = await prisma.photo.create({
        data: {
          fileId: file.file_id,
          fileUniqueId: file.file_unique_id,
          caption,
          status: PhotoStatus.published,
          publishedAt: new Date(),
          uploaderId: null,
          companyId: admin.companyId,
          batchId: batch.id,
        },
      });
      ctx.session.payload = { ...(ctx.session.payload || {}), latestPhotoId: created.id };
      await ctx.reply('Опубликовали в мини-аппе. Отправьте еще фото или текстом обновите подпись последнего, либо напишите «готово».');
    } catch (err) {
      logger.error({ err }, 'Failed to store admin published photo');
      await ctx.reply('Не удалось опубликовать фото, попробуйте снова.');
    }
    return;
  }

  if (ctx.session.mode === 'admin-photo-broadcast') {
    const admin = await requireAdmin(ctx);
    if (!admin) return;
    const photoSizes = (ctx.message as Message.PhotoMessage).photo;
    const file = photoSizes[photoSizes.length - 1];
    logger.info(
      { adminId: ctx.from?.id, adminLogin: admin.login, fileId: shortId(file.file_id), captionLength: (ctx.message as Message.PhotoMessage).caption?.length || 0 },
      'Admin photo received for broadcast'
    );
    let fileSource: string | { source: Buffer } = file.file_id;
    try {
      const link = await ctx.telegram.getFileLink(file.file_id);
      const resp = await axios.get(link.href, { responseType: 'arraybuffer' });
      fileSource = { source: Buffer.from(resp.data) };
    } catch (err) {
      logger.warn({ err }, 'Falling back to file_id broadcast (could not download file)');
    }
    const result = await sendBroadcastPhoto(admin.companyId, fileSource, ctx.message.caption);
    const fileIdToPersist = result.fileId ?? file.file_id;
    const fileUniqueIdToPersist = result.fileUniqueId ?? file.file_unique_id;
    try {
      const batch = await getOrCreateLiveBatch('Админ-публикация', admin.companyId);
      await prisma.photo.create({
        data: {
          fileId: fileIdToPersist,
          fileUniqueId: fileUniqueIdToPersist,
          caption: (ctx.message as Message.PhotoMessage).caption,
          uploaderId: null,
          status: PhotoStatus.published,
          publishedAt: new Date(),
          companyId: admin.companyId,
          batchId: batch.id,
        },
      });
      logger.info(
        {
          adminId: ctx.from?.id,
          adminLogin: admin.login,
          dbFileId: shortId(fileIdToPersist),
          broadcast: { sent: result.sent, failed: result.failed, total: result.total },
        },
        'Admin broadcast persisted'
      );
    } catch (err) {
      logger.warn({ err }, 'Failed to store admin broadcast photo to feed');
    }
    ctx.session.mode = undefined;
    const summary =
      result.total === 0
        ? 'Нет зарегистрированных клиентов для рассылки.'
        : `Фото отправлено: ${result.sent}/${result.total}${result.failed ? `, ошибок: ${result.failed}` : ''}.`;
    const errorTail = result.errors?.length ? `\nПервые ошибки:\n${result.errors.join('\n')}` : '';
    await ctx.reply(summary);
    if (errorTail) {
      await ctx.reply(errorTail.slice(0, 800));
    }
  }
});

adminBot?.on('document', async (ctx) => {
  if (ctx.session.mode !== 'admin-upload-logo') return;
  const admin = await requireAdmin(ctx);
  if (!admin) return;
  const doc = (ctx.message as Message.DocumentMessage).document;
  if (!doc) return;
  if (!doc.mime_type?.startsWith('image/')) {
    await ctx.reply('Пришлите логотип как изображение (лучше PNG).');
    return;
  }
  if (doc.mime_type !== 'image/png') {
    await ctx.reply('Лучше использовать PNG без сжатия. Отправьте файл в формате PNG, если нужно сохранить прозрачность.');
  }
  try {
    await prisma.company.update({
      where: { id: admin.companyId },
      data: { logoFileId: doc.file_id, logoFileUniqueId: doc.file_unique_id },
    });
    ctx.session.mode = undefined;
    ctx.session.step = undefined;
    ctx.session.payload = undefined;
    await ctx.reply(
      'Логотип обновлен! Обновление появится в мини-аппе в течение минуты.',
      miniAppReplyMarkupForCompany(admin.company)
    );
  } catch (err) {
    logger.error({ err }, 'Failed to save logo from document');
    await ctx.reply('Не удалось сохранить логотип. Попробуйте снова.');
  }
});

// Client bot handlers
clientBot?.start(async (ctx) => {
  if (!ctx.from) return;
  const companyHint = ctx.startPayload ? await findCompanyByInvite(ctx.startPayload) : null;
  const user = await getOrCreateClient(ctx.from, { companyHint });
  const alreadyLinkedToAnother = companyHint && user.companyId !== companyHint.id;
  const companyLabel = user.company?.name || DEMO_PROFILE.brandName;
  const greeting = alreadyLinkedToAnother
    ? 'Вы уже привязаны к другому салону. Используйте текущий мини-апп или свяжитесь с администратором.'
    : `Вы в боте салона «${companyLabel}». Здесь можно посмотреть контакты, узнать о студии и записаться онлайн.`;
  await ctx.reply(
    greeting,
    Markup.keyboard([
      ['Контакты', 'Конт информация'],
      ['Онлайн запись', 'Акции'],
      ['О нас', 'Позвонить'],
      [Markup.button.webApp('Открыть мини-апп', buildWebAppUrl(user.company) || WEB_APP_BASE_URL || '#')],
    ]).resize()
  );
});

clientBot?.hears('Контакты', async (ctx) => {
  const lines = [
    DEMO_PROFILE.brandName,
    DEMO_PROFILE.address,
    DEMO_PROFILE.hours,
    '',
    ...DEMO_PROFILE.phones,
    `Instagram: ${DEMO_PROFILE.instagram}`,
    `VK: ${DEMO_PROFILE.vk}`,
  ];
  await ctx.reply(
    lines.join('\n'),
    Markup.inlineKeyboard([
      [Markup.button.url('Онлайн запись', DEMO_PROFILE.bookingUrl)],
      [
        Markup.button.url('Instagram', DEMO_PROFILE.instagram),
        Markup.button.url('VK', DEMO_PROFILE.vk),
      ],
    ])
  );
});

clientBot?.hears('Конт информация', async (ctx) => {
  const lines = [
    'Записаться к нам:',
    `- По телефону ${DEMO_PROFILE.phones[0]}`,
    `- Instagram DIRECT ${DEMO_PROFILE.instagram}`,
    `- Online запись ${DEMO_PROFILE.bookingUrl}`,
    '',
    'Почта для сотрудничества:',
    DEMO_PROFILE.email,
  ];
  await ctx.reply(
    lines.join('\n'),
    Markup.inlineKeyboard([
      [Markup.button.url('Онлайн запись', DEMO_PROFILE.bookingUrl)],
      [Markup.button.url('Позвонить', formatTelUrl(DEMO_PROFILE.phones[1]))],
      [Markup.button.url('Instagram', DEMO_PROFILE.instagram)],
    ])
  );
});

clientBot?.hears('Онлайн запись', async (ctx) => {
  await ctx.reply(
    `Онлайн запись: выберите услугу и удобное время.\n${DEMO_PROFILE.bookingUrl}`,
    Markup.inlineKeyboard([
      [Markup.button.url('Открыть онлайн-запись', DEMO_PROFILE.bookingUrl)],
      [Markup.button.url('Instagram DIRECT', DEMO_PROFILE.instagram)],
    ])
  );
});

clientBot?.hears('Акции', async (ctx) => {
  await ctx.reply(
    'Актуальные акции подскажет администратор — напишите нам или свяжитесь любым удобным способом.',
    Markup.inlineKeyboard([
      [Markup.button.url('Позвонить', formatTelUrl(DEMO_PROFILE.phones[1]))],
      [
        Markup.button.url('Instagram', DEMO_PROFILE.instagram),
        Markup.button.url('VK', DEMO_PROFILE.vk),
      ],
    ])
  );
});

clientBot?.hears('О нас', async (ctx) => {
  await ctx.reply(
    `${DEMO_ABOUT_TEXT}\n\nБудь неотразима!\nКоманда Demo Beauty.\n${DEMO_SERVICES_TEXT}`
  );
});

clientBot?.hears('Позвонить', async (ctx) => {
  await ctx.reply(
    'Свяжитесь с администратором:',
    Markup.inlineKeyboard([
      [Markup.button.url(DEMO_PROFILE.phones[0], formatTelUrl(DEMO_PROFILE.phones[0]))],
      [Markup.button.url(DEMO_PROFILE.phones[1], formatTelUrl(DEMO_PROFILE.phones[1]))],
    ])
  );
});

clientBot?.hears('Отправить фото', async (ctx) => {
  ctx.session.mode = 'client-await-photo';
  await ctx.reply('Пришлите фото, мы добавим его в драфт-контент.');
});

clientBot?.hears('Записаться', async (ctx) => {
  if (!ctx.from) return;
  if (useMockFeed) {
    await ctx.reply('Запись недоступна в демо-режиме. Подключите базу данных, чтобы включить бронирование.');
    return;
  }
  ctx.session.mode = 'client-booking';
  ctx.session.step = 'booking-date';
  ctx.session.payload = {};
  await ctx.reply('На какую дату хотите записаться? Напишите «сегодня», «завтра» или формат 12.05.');
});

clientBot?.hears('Мои награды', async (ctx) => {
  if (!ctx.from) return;
  if (useMockFeed) {
    await ctx.reply('Награды появятся после подключения базы данных.');
    return;
  }
  const user = await getOrCreateClient(ctx.from);
  const rewards = await prisma.loyaltyReward.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
  });
  if (!rewards.length) {
    await ctx.reply('Пока без бейджей, но каждая активность приносит баллы. Делитесь лайками и фото!');
    return;
  }
  const remainder = user.loyaltyPoints % LOYALTY_REWARD_THRESHOLD;
  const nextTier = remainder === 0 ? LOYALTY_REWARD_THRESHOLD : LOYALTY_REWARD_THRESHOLD - remainder;
  const lines = rewards.map((reward) => `• ${reward.label} (${reward.createdAt.toLocaleDateString('ru-RU')})`);
  lines.push(`До следующего подарка осталось ${nextTier} баллов.`);
  await ctx.reply(lines.join('\n'));
});

clientBot?.on('text', async (ctx) => {
  if (!ctx.from || !ctx.message?.text) return;
  const text = ctx.message.text.trim();
  if (!text) return;
  if (text.startsWith('/')) return;
  const quickActions = [
    'Отправить фото',
    'Записаться',
    'Мои награды',
    'Контакты',
    'Конт информация',
    'Онлайн запись',
    'Акции',
    'О нас',
    'Позвонить',
  ];
  if (quickActions.includes(text)) return;

  if (ctx.session.mode === 'client-await-photo') {
    await ctx.reply('Ждем фото. Нажмите «Отправить фото» и пришлите изображение, чтобы мы добавили его в ленту.');
    return;
  }

  if (ctx.session.mode === 'client-booking') {
    if (useMockFeed) {
      await ctx.reply('Запись временно недоступна в демо-режиме.');
      ctx.session.mode = undefined;
      ctx.session.step = undefined;
      ctx.session.payload = undefined;
      return;
    }
    const payload = (ctx.session.payload as Record<string, unknown>) || {};
    if (ctx.session.step === 'booking-date') {
      const date = parseDateInput(text);
      if (!date) {
        await ctx.reply('Не удалось распознать дату. Попробуйте формат 12.05 или напишите «завтра».');
        return;
      }
      payload.desiredDate = date.toISOString();
      ctx.session.payload = payload;
      ctx.session.step = 'booking-time';
      await ctx.reply('Во сколько вам удобно? Например, 15:30.');
      return;
    }
    if (ctx.session.step === 'booking-time') {
      const time = parseTimeInput(text);
      if (!time) {
        await ctx.reply('Укажите время в формате 10:30.');
        return;
      }
      payload.desiredTime = time;
      ctx.session.payload = payload;
      ctx.session.step = 'booking-note';
      await ctx.reply('Оставьте комментарий (цвет, покрытие, пожелания) или «-», чтобы пропустить.');
      return;
    }
    if (ctx.session.step === 'booking-note') {
      const note = text === '-' ? null : text;
      const desiredDateIso = payload.desiredDate as string | undefined;
      const desiredTime = payload.desiredTime as { hours: number; minutes: number } | undefined;
      if (!desiredDateIso || !desiredTime) {
        await ctx.reply('Что-то пошло не так. Начните запись заново командой «Записаться».');
        ctx.session.mode = undefined;
        ctx.session.step = undefined;
        ctx.session.payload = undefined;
        return;
      }
      const desiredDate = new Date(desiredDateIso);
      desiredDate.setHours(desiredTime.hours, desiredTime.minutes, 0, 0);
      const user = await getOrCreateClient(ctx.from);
      try {
        const appointment = await prisma.appointmentRequest.create({
          data: {
            userId: user.id,
            desiredAt: desiredDate,
            note,
            status: AppointmentStatus.requested,
            companyId: user.companyId,
          },
        });
        await ctx.reply(
          `Запрос отправлен! Мы держим слот ${formatAppointmentDate(desiredDate)} и подтвердим его в ближайшее время.`,
          miniAppReplyMarkupForCompany(user.company)
        );
        await notifyAdminsAboutAppointment(appointment, user);
        await scheduleCareTipReminder(user.id, user.companyId, appointment.id, desiredDate);
        await scheduleFeedbackPoll(user.id, user.companyId, appointment.id, desiredDate);
        await applyLoyaltyProgress(user, 'appointment');
      } catch (err) {
        logger.error({ err }, 'Failed to create appointment request');
        await ctx.reply('Не удалось зафиксировать запись. Попробуйте снова позже.');
      }
      ctx.session.mode = undefined;
      ctx.session.step = undefined;
      ctx.session.payload = undefined;
      return;
    }
  }

  const user = await getOrCreateClient(ctx.from);
  const handled = await tryHandleLookbook(ctx, text, user.company);
  if (!handled) {
    await ctx.reply('Можете отправить фото, записаться или написать ключевое слово (chrome, wedding, нюд), чтобы получить подборку.');
  }
});

clientBot?.on('photo', async (ctx) => {
  if (!ctx.from) return;
  const photoSizes = (ctx.message as Message.PhotoMessage).photo as PhotoSize[];
  const file = photoSizes[photoSizes.length - 1];
  logger.info(
    { userId: ctx.from.id, fileId: shortId(file.file_id), captionLength: (ctx.message as Message.PhotoMessage).caption?.length || 0 },
    'Client sent photo'
  );
  const user = await getOrCreateClient(ctx.from);
  const batch = await getOrCreateLiveBatch('Поток клиентов', user.companyId);
  await prisma.photo.create({
    data: {
      fileId: file.file_id,
      fileUniqueId: file.file_unique_id,
      caption: (ctx.message as Message.PhotoMessage).caption,
      uploaderId: user.id,
      status: PhotoStatus.published,
      publishedAt: new Date(),
      companyId: user.companyId,
      batchId: batch.id,
    },
  });
  logger.info({ userId: ctx.from.id, dbPhotoFileId: shortId(file.file_id), batchId: batch.id }, 'Client photo stored and published');
  await applyLoyaltyProgress(user, 'photo');
  ctx.session.mode = undefined;
  await ctx.reply('Фото опубликовано в мини-апп! Спасибо.', miniAppReplyMarkupForCompany(user.company));
});

clientBot?.action(/feedback_vote_(\d+)_(love|tweak)/, async (ctx) => {
  if (!ctx.from) return;
  const notifId = Number(ctx.match?.[1] ?? '0');
  const choiceRaw = ctx.match?.[2];
  if (!notifId || !choiceRaw) {
    await ctx.answerCbQuery('Не удалось обработать ответ.');
    return;
  }
  const user = await getOrCreateClient(ctx.from);
  if (useMockFeed) {
    await ctx.answerCbQuery('Ответ записан!');
    try {
      await ctx.editMessageReplyMarkup(undefined);
    } catch {
      // ignore
    }
    return;
  }
  try {
    const notif = await prisma.notification.findUnique({
      where: { id: notifId },
      select: { payload: true, userId: true, type: true, companyId: true },
    });
    if (!notif || notif.userId !== user.id || notif.type !== 'feedback_poll' || notif.companyId !== user.companyId) {
      await ctx.answerCbQuery('Эта кнопка больше не активна.');
      return;
    }
    const payload = notif.payload as Record<string, unknown> | null;
    const appointmentId = payload?.appointmentId ? Number(payload.appointmentId) : undefined;
    const context = typeof payload?.context === 'string' ? payload.context : undefined;
    const existing = await prisma.feedbackResponse.findFirst({
      where: {
        userId: user.id,
        companyId: user.companyId,
        ...(appointmentId ? { appointmentId } : context ? { context } : {}),
      },
    });
    if (existing) {
      await ctx.answerCbQuery('Мы уже сохранили ваш ответ.');
      return;
    }
    await prisma.feedbackResponse.create({
      data: {
        userId: user.id,
        appointmentId: appointmentId ?? null,
        context,
        choice: choiceRaw === 'love' ? FeedbackChoice.love : FeedbackChoice.tweak,
        companyId: user.companyId,
      },
    });
    await ctx.answerCbQuery('Спасибо, учли ваш ответ!');
    try {
      await ctx.editMessageReplyMarkup(undefined);
    } catch {
      // ignore
    }
  } catch (err) {
    logger.error({ err }, 'Failed to store feedback response');
    await ctx.answerCbQuery('Не удалось сохранить ответ, попробуйте позже.');
  }
});

// Webhook configuration or polling
async function initBots() {
  if (!adminBot || !clientBot) return;

  try {
    const me = await clientBot.telegram.getMe();
    clientBotUsername = me.username ?? clientBotUsername;
    logger.info({ clientBotUsername }, 'Client bot username resolved');
  } catch (err) {
    logger.warn({ err }, 'Failed to fetch client bot username');
  }

  if (USE_POLLING === 'true') {
    await adminBot.launch();
    await clientBot.launch();
    logger.info('Bots launched in polling mode');
    return;
  }

  if (!WEBHOOK_BASE_URL) {
    logger.warn('WEBHOOK_BASE_URL is missing, falling back to polling');
    await adminBot.launch();
    await clientBot.launch();
    return;
  }

  const adminWebhookPath = `/admin/${ADMIN_WEBHOOK_SECRET}`;
  const clientWebhookPath = `/client/${CLIENT_WEBHOOK_SECRET}`;

  app.post(adminWebhookPath, async (req, res) => {
    try {
      await adminBot.handleUpdate(req.body);
      res.sendStatus(200);
    } catch (err) {
      logger.error({ err }, 'Admin webhook failed');
      res.sendStatus(500);
    }
  });
  app.post(clientWebhookPath, async (req, res) => {
    try {
      await clientBot.handleUpdate(req.body);
      res.sendStatus(200);
    } catch (err) {
      logger.error({ err }, 'Client webhook failed');
      res.sendStatus(500);
    }
  });

  await adminBot.telegram.setWebhook(`${WEBHOOK_BASE_URL}/admin/${ADMIN_WEBHOOK_SECRET}`);
  await clientBot.telegram.setWebhook(`${WEBHOOK_BASE_URL}/client/${CLIENT_WEBHOOK_SECRET}`);
  logger.info('Bots configured with webhooks');
}

// API routes
app.get('/healthz', async (_req, res) => {
  const db = await checkDatabaseHealth();
  res.status(db.ok ? 200 : 503).json({
    ok: db.ok,
    mode: useMockFeed ? 'mock' : 'database',
    db: {
      ...db,
      ready: databaseState.ready,
      lastError: databaseState.lastError,
      lastReadyTs: databaseState.lastReadyTs,
      attempts: databaseState.attempts,
      hasDatabaseUrl: Boolean(process.env.DATABASE_URL),
      allowMockFallback,
      usingMockDueToMissingDb,
    },
    uptimeSeconds: Math.round(process.uptime()),
  });
});

app.get('/api/media/:fileId', async (req, res) => {
  const fileId = path.basename(req.params.fileId);
  logger.info({ fileId: shortId(fileId) }, 'Incoming media request');

  // Serve bundled mock assets for demos without hitting Telegram.
  try {
    const localPath = path.join(mockMediaDir, fileId);
    await fs.access(localPath);
    logger.debug({ fileId: shortId(fileId), localPath }, 'Serving media from mock-media');
    res.sendFile(localPath);
    return;
  } catch {
    // Not a local file, fall through to Telegram proxy.
  }

  if (!CLIENT_BOT_TOKEN && !ADMIN_BOT_TOKEN) {
    res.status(503).send('Bot token missing');
    return;
  }
  try {
    const resolved = await resolveTelegramFilePath(fileId);
    const token = resolved.bot === 'admin' ? ADMIN_BOT_TOKEN : CLIENT_BOT_TOKEN;
    if (!token) {
      throw new Error(`Missing token for ${resolved.bot} bot while fetching media`);
    }
    const tgUrl = `https://api.telegram.org/file/bot${token}/${resolved.path}`;
    logger.debug({ fileId: shortId(fileId), bot: resolved.bot, tgUrl }, 'Proxying media from Telegram');
    res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
    res.redirect(302, tgUrl);
  } catch (err) {
    const errInfo =
      err && typeof err === 'object'
        ? {
            message: (err as any).message,
            status: (err as any)?.response?.status,
            description: (err as any)?.response?.data?.description,
            code: (err as any)?.code,
          }
        : { message: String(err) };
    logger.error({ ...errInfo, fileId: shortId(fileId) }, 'Failed to fetch Telegram file');
    res.status(500).send('Cannot fetch media');
  }
});

app.get('/api/batches', async (req, res) => {
  if (useMockFeed) {
    res.json(getMockBatches());
    return;
  }
  const initDataHeader = (req.headers['x-telegram-init-data'] as string | undefined) ?? (req.query.initData as string | undefined);
  const userData = parseInitData(initDataHeader);
  if (!userData) {
    res.status(401).json({ error: 'invalid initData' });
    return;
  }
  const user = await getOrCreateClient(userData);
  try {
    const batches = await prisma.photoBatch.findMany({
      where: { companyId: user.companyId },
      orderBy: { publishedAt: 'desc' },
      include: { _count: { select: { photos: true } } },
    });
    res.json(
      batches.map((b) => ({ id: b.id, label: b.label, publishedAt: b.publishedAt, photoCount: b._count.photos }))
    );
  } catch (err) {
    logger.error({ err }, 'Failed to fetch batches');
    if (allowMockFallback) {
      res.json(getMockBatches());
      return;
    }
    res.status(503).json({ error: 'database_unavailable' });
  }
});

app.get('/api/photos', async (req, res) => {
  const take = Math.min(Number(req.query.take) || 20, 50);
  const cursor = req.query.cursor ? Number(req.query.cursor) : undefined;
  const batchId = req.query.batchId ? Number(req.query.batchId) : undefined;
  const initDataHeader = (req.headers['x-telegram-init-data'] as string | undefined) ?? (req.query.initData as string | undefined);
  const userData = parseInitData(initDataHeader);
  if (!useMockFeed && !userData) {
    res.status(401).json({ error: 'invalid initData' });
    return;
  }
  const user = useMockFeed ? null : await getOrCreateClient(userData);
  logger.info({ take, cursor, batchId, companyId: user?.companyId }, 'Fetching photos for feed');

  if (useMockFeed) {
    const { photos, nextCursor } = getMockPhotos(batchId, take, cursor);
    res.json({
      photos: photos.map((photo) => ({ ...photo, likedByMe: false })),
      nextCursor,
    });
    return;
  }

  try {
    const photos = await prisma.photo.findMany({
      where: {
        status: PhotoStatus.published,
        ...(batchId ? { batchId } : {}),
        ...(user ? { companyId: user.companyId } : {}),
      },
      orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
      take,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      include: { _count: { select: { likes: true } } },
    });

    const likedPhotoIds =
      user && photos.length
        ? await prisma.like.findMany({
            where: { userId: user.id, photoId: { in: photos.map((p) => p.id) } },
            select: { photoId: true },
          })
        : [];
    const likedSet = new Set(likedPhotoIds.map((like) => like.photoId));

    const nextCursor = photos.length === take ? photos[photos.length - 1].id : null;
    res.json({
      photos: photos.map((p) => ({
        id: p.id,
        fileId: p.fileId,
        caption: p.caption,
        publishedAt: p.publishedAt ?? p.createdAt,
        batchId: p.batchId,
        likes: p._count.likes,
        storyCount: p.storyCount ?? 1,
        likedByMe: likedSet.has(p.id),
      })),
      nextCursor,
    });
    logger.debug({ returned: photos.length, nextCursor }, 'Photos response ready');
  } catch (err) {
    logger.error({ err }, 'Failed to fetch photos');
    if (allowMockFallback) {
      const { photos, nextCursor } = getMockPhotos(batchId, take, cursor);
      res.json({
        photos: photos.map((photo) => ({ ...photo, likedByMe: false })),
        nextCursor,
      });
      return;
    }
    res.status(503).json({ error: 'database_unavailable' });
  }
});

app.get('/api/company/branding', async (req, res) => {
  if (useMockFeed) {
    res.json({
      name: DEFAULT_COMPANY_NAME,
      brandText: DEFAULT_COMPANY_NAME,
      slug: DEFAULT_COMPANY_SLUG,
      logoFileId: null,
      logoUrl: null,
    });
    return;
  }
  const initDataHeader = (req.headers['x-telegram-init-data'] as string | undefined) ?? (req.query.initData as string | undefined);
  const userData = parseInitData(initDataHeader);
  if (!userData) {
    res.status(401).json({ error: 'invalid initData' });
    return;
  }
  const user = await getOrCreateClient(userData);
  const company = await prisma.company.findUnique({ where: { id: user.companyId } });
  if (!company) {
    res.status(404).json({ error: 'company_not_found' });
    return;
  }
  const brandText = company.brandText?.trim();
  const logoUrl = company.logoFileId ? `/api/media/${encodeURIComponent(company.logoFileId)}` : null;
  res.json({
    name: company.name,
    brandText: brandText || company.name,
    slug: company.slug,
    logoFileId: company.logoFileId,
    logoUrl,
  });
});

app.post('/api/like', async (req, res) => {
  const { photoId, initData } = req.body as { photoId?: number; initData?: string };

  if (useMockFeed) {
    if (!photoId) return res.status(400).json({ error: 'photoId required' });
    const result = incrementMockLike(photoId);
    res.json({ ok: true, created: true, likes: result?.likes ?? 0 });
    return;
  }

  try {
    if (!photoId) return res.status(400).json({ error: 'photoId required' });
    const userData = parseInitData(initData);
    if (!userData) {
      logger.warn({ msg: 'like rejected', reason: 'invalid initData', initDataLen: initData?.length || 0, photoId });
      return res.status(401).json({ error: 'invalid initData' });
    }
    const user = await getOrCreateClient(userData);
    const photo = await prisma.photo.findUnique({ where: { id: photoId }, include: { uploader: true, company: true } });
    if (!photo) {
      return res.status(404).json({ error: 'photo_not_found' });
    }
    if (photo.companyId !== user.companyId) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const existing = await prisma.like.findUnique({ where: { userId_photoId: { userId: user.id, photoId } } });
    if (existing) {
      const likes = await prisma.like.count({ where: { photoId } });
      logger.info({ photoId, userId: user.id, created: false, likes }, 'Like already existed');
      return res.json({ ok: true, created: false, likes });
    }
    const like = await prisma.like.create({ data: { userId: user.id, photoId } });
    const likes = await prisma.like.count({ where: { photoId } });
    logger.info({ photoId, userId: user.id, likeId: like.id, likes }, 'Like stored');
    await applyLoyaltyProgress(user, 'like');

    if (photo?.uploader?.telegramId && clientBot) {
      const likerName = formatName(user);
      const text = user.firstName || user.lastName
        ? `Пользователь ${likerName} поставил(а) вам лайк!`
        : 'Вам поставили лайк!';
      const extra =
        miniAppReplyMarkupForCompany(photo.company ?? undefined) ||
        (WEB_APP_BASE_URL
          ? {
              reply_markup: {
                inline_keyboard: [[{ text: 'Открыть мини-апп', web_app: { url: WEB_APP_BASE_URL } }]],
              },
            }
          : undefined);
      try {
        await clientBot.telegram.sendMessage(photo.uploader.telegramId, extra ? `${text}` : text, extra);
      } catch (err) {
        logger.warn({ err }, 'Failed to send like notification');
      }
    }

    res.json({ ok: true, likeId: like.id, created: true, likes });
  } catch (err) {
    logger.error({ err }, 'like failed');
    if (allowMockFallback && photoId) {
      const result = incrementMockLike(photoId);
      res.json({ ok: true, created: true, likes: result?.likes ?? 0 });
      return;
    }
    res.status(500).json({ error: 'internal error' });
  }
});

app.post('/api/miniapp/visit', async (req, res) => {
  if (useMockFeed) {
    res.json({ ok: true });
    return;
  }
  try {
    const { initData } = req.body as { initData?: string };
    const userData = parseInitData(initData);
    if (!userData) {
      logger.warn({ msg: 'miniapp visit rejected', reason: 'invalid initData', initDataLen: initData?.length || 0 });
      return res.status(401).json({ error: 'invalid initData' });
    }
    const user = await getOrCreateClient(userData);
    await prisma.clientUser.update({
      where: { id: user.id },
      data: { miniAppOpens: { increment: 1 } },
    });
    await applyLoyaltyProgress(user, 'visit');
    logger.info({ userId: user.id, telegramId: user.telegramId }, 'Mini-app visit tracked');
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, 'miniapp visit failed');
    if (allowMockFallback) {
      res.json({ ok: true });
      return;
    }
    res.status(500).json({ error: 'internal error' });
  }
});

async function bootstrapServices(options: { withBots?: boolean; withNotifications?: boolean } = {}) {
  const shouldStartBots = options.withBots ?? !skipBotBootstrap;
  const shouldStartNotifications = options.withNotifications ?? !skipNotificationDispatcher;
  if (!useMockFeed) {
    await ensureDatabaseConnection();
    if (CLEAR_FEED_ON_BOOT === 'true') {
      await clearFeedContent();
    }
  }
  if (shouldStartBots) {
    await initBots();
  } else {
    logger.debug('Bot bootstrap skipped');
  }
  if (shouldStartNotifications) {
    startNotificationDispatcher();
  } else {
    logger.debug('Notification dispatcher skipped');
  }
}

export async function startHttpServer(
  port = Number(PORT),
  options: { withBots?: boolean; withNotifications?: boolean } = {}
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, async () => {
      try {
        await bootstrapServices(options);
        const address = server.address();
        const boundPort = typeof address === 'object' && address ? address.port : port;
        logger.info({ port: boundPort }, 'API server started');
        resolve(server);
      } catch (err) {
        logger.error({ err }, 'Failed to bootstrap API server');
        server.close(() => reject(err));
      }
    });
    server.on('error', (err) => reject(err));
  });
}

if (process.env.NODE_ENV !== 'test') {
  startHttpServer().catch((err) => {
    logger.fatal({ err }, 'API server failed to start');
    process.exit(1);
  });
} else {
  logger.debug('API server loaded in test mode; HTTP listener not started automatically');
}

process.once('SIGINT', () => {
  adminBot?.stop('SIGINT');
  clientBot?.stop('SIGINT');
  if (notificationTimer) clearInterval(notificationTimer);
});

process.once('SIGTERM', () => {
  adminBot?.stop('SIGTERM');
  clientBot?.stop('SIGTERM');
  if (notificationTimer) clearInterval(notificationTimer);
});

export { app, prisma, checkDatabaseHealth };
