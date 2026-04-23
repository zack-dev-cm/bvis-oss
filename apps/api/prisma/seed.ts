import crypto from 'crypto';
import { PrismaClient, PhotoStatus } from '@prisma/client';

const prisma = new PrismaClient();
const shouldSeedDemoContent = process.env.SEED_WITH_DEMO_CONTENT === 'true';
const DEFAULT_COMPANY = { name: 'Beauty Visuals', slug: 'default', inviteCode: 'default-invite' };

const hashPassword = (password: string): string => {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
};

type UserKey = 'marina' | 'sergey' | 'alina';
type BatchKey = 'lateFall' | 'holiday';
type PhotoKey =
  | 'blushFoil'
  | 'chromeClose'
  | 'peachOmbre'
  | 'velvetBurgundy'
  | 'marbleGold'
  | 'lilacLines'
  | 'mochaChrome'
  | 'rosyCrystals';

async function resetDatabase() {
  await prisma.$transaction([
    prisma.feedbackResponse.deleteMany(),
    prisma.appointmentRequest.deleteMany(),
    prisma.loyaltyReward.deleteMany(),
    prisma.like.deleteMany(),
    prisma.notification.deleteMany(),
    prisma.photo.deleteMany(),
    prisma.photoBatch.deleteMany(),
    prisma.clientUser.deleteMany(),
    prisma.adminInfo.deleteMany(),
    prisma.company.deleteMany(),
  ]);
}

async function seed() {
  await resetDatabase();

  if (!shouldSeedDemoContent) {
    console.log('Database cleared. Demo feed not inserted (set SEED_WITH_DEMO_CONTENT=true to load sample photos).');
    return;
  }

  const company = await prisma.company.create({ data: DEFAULT_COMPANY });

  const users = await Promise.all([
    prisma.clientUser.create({
      data: {
        telegramId: '90001',
        firstName: 'Марина',
        lastName: 'Смирнова',
        username: 'marina_nails',
        miniAppOpens: 7,
        companyId: company.id,
      },
    }),
    prisma.clientUser.create({
      data: {
        telegramId: '90002',
        firstName: 'Сергей',
        lastName: 'Зотов',
        username: 'sergey_looks',
        miniAppOpens: 5,
        companyId: company.id,
      },
    }),
    prisma.clientUser.create({
      data: {
        telegramId: '90003',
        firstName: 'Алина',
        lastName: 'Орлова',
        username: 'alina.glow',
        miniAppOpens: 3,
        companyId: company.id,
      },
    }),
  ]);

  const userByKey: Record<UserKey, number> = {
    marina: users[0].id,
    sergey: users[1].id,
    alina: users[2].id,
  };

  const batches = await Promise.all([
    prisma.photoBatch.create({
      data: { label: 'Поздняя осень · крупные планы', publishedAt: new Date('2024-11-18T11:00:00Z'), companyId: company.id },
    }),
    prisma.photoBatch.create({
      data: { label: 'Декабрь · теплый свет', publishedAt: new Date('2024-12-04T14:00:00Z'), companyId: company.id },
    }),
  ]);

  const batchByKey: Record<BatchKey, number> = {
    lateFall: batches[0].id,
    holiday: batches[1].id,
  };

  const photoPlan: Record<
    PhotoKey,
    { fileId: string; caption: string; publishedAt: string; batch: BatchKey; uploader: UserKey }
  > = {
    blushFoil: {
      fileId: 'nano-nail-close-01_0.jpg',
      caption: 'Нежный нюд с золотыми хлопьями.',
      publishedAt: '2024-11-18T11:20:00Z',
      batch: 'lateFall',
      uploader: 'marina',
    },
    chromeClose: {
      fileId: 'nano-nail-close-02_0.jpg',
      caption: 'Хромовый френч в крупном плане.',
      publishedAt: '2024-11-18T11:40:00Z',
      batch: 'lateFall',
      uploader: 'alina',
    },
    peachOmbre: {
      fileId: 'nano-nail-close-03_0.jpg',
      caption: 'Персиковый омбре с искрами.',
      publishedAt: '2024-11-18T12:05:00Z',
      batch: 'lateFall',
      uploader: 'sergey',
    },
    velvetBurgundy: {
      fileId: 'nano-nail-close-04_0.jpg',
      caption: 'Бордовый кэт-ай с бархатом.',
      publishedAt: '2024-11-18T12:20:00Z',
      batch: 'lateFall',
      uploader: 'marina',
    },
    marbleGold: {
      fileId: 'nano-nail-close-05_0.jpg',
      caption: 'Молочный мрамор с золотом.',
      publishedAt: '2024-12-04T14:05:00Z',
      batch: 'holiday',
      uploader: 'sergey',
    },
    lilacLines: {
      fileId: 'nano-nail-close-06_0.jpg',
      caption: 'Лавандовые линии на нюде.',
      publishedAt: '2024-12-04T14:20:00Z',
      batch: 'holiday',
      uploader: 'alina',
    },
    mochaChrome: {
      fileId: 'nano-nail-close-07_0.jpg',
      caption: 'Мокко глянец с медным хромом.',
      publishedAt: '2024-12-04T14:35:00Z',
      batch: 'holiday',
      uploader: 'marina',
    },
    rosyCrystals: {
      fileId: 'nano-nail-close-08_0.jpg',
      caption: 'Розовый глянец с кристаллами.',
      publishedAt: '2024-12-04T14:50:00Z',
      batch: 'holiday',
      uploader: 'alina',
    },
  };

  const photos: Record<PhotoKey, number> = {};
  for (const [key, plan] of Object.entries(photoPlan) as [PhotoKey, (typeof photoPlan)[PhotoKey]][]) {
    const created = await prisma.photo.create({
      data: {
        fileId: plan.fileId,
        fileUniqueId: crypto.createHash('sha1').update(plan.fileId + plan.publishedAt).digest('hex'),
        caption: plan.caption,
        status: PhotoStatus.published,
        publishedAt: new Date(plan.publishedAt),
        batchId: batchByKey[plan.batch],
        uploaderId: userByKey[plan.uploader],
        companyId: company.id,
      },
    });
    photos[key] = created.id;
  }

  const likesPlan: Array<{ user: UserKey; photos: PhotoKey[] }> = [
    { user: 'sergey', photos: ['blushFoil', 'chromeClose', 'marbleGold'] },
    { user: 'marina', photos: ['velvetBurgundy', 'lilacLines'] },
    { user: 'alina', photos: ['peachOmbre', 'mochaChrome', 'rosyCrystals'] },
  ];

  for (const like of likesPlan) {
    for (const photoKey of like.photos) {
      await prisma.like.create({
        data: { userId: userByKey[like.user], photoId: photos[photoKey] },
      });
    }
  }

  await prisma.adminInfo.create({
    data: {
      userId: 'admin-demo',
      clinicName: 'Demo Салон',
      login: 'demo-admin',
      passwordHash: hashPassword('demo1234'),
      companyId: company.id,
    },
  });

  console.log('Seed completed:');
  console.log(`  Users: ${users.length}`);
  console.log(`  Batches: ${batches.length}`);
  console.log(`  Photos: ${Object.keys(photos).length}`);
  console.log(`  Likes: ${likesPlan.reduce((acc, l) => acc + l.photos.length, 0)}`);
}

seed()
  .catch((err) => {
    console.error('Seed failed', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
