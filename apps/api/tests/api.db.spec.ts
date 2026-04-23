import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn, spawnSync } from 'child_process';
import request from 'supertest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

type ApiModule = typeof import('../src/index.ts');

const apiDir = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

function runCommand(cmd: string, args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: apiDir,
      env,
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`));
    });
  });
}

const buildInitData = (user: Record<string, unknown>, token: string) => {
  const params = new URLSearchParams();
  params.set('user', JSON.stringify(user));
  params.set('auth_date', String(Math.floor(Date.now() / 1000)));
  params.set('query_id', 'test-query');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  params.set('hash', hash);
  return params.toString();
};

const dockerProbe = spawnSync('docker', ['info'], { stdio: 'ignore' });
const canRunContainers = dockerProbe.status === 0;
if (!canRunContainers) {
  console.warn('[vitest] Docker runtime is not available; skipping Postgres integration suite.');
}
const suite = canRunContainers ? describe : describe.skip;

suite('API + Postgres integration', () => {
  let container: StartedPostgreSqlContainer;
  let mod: ApiModule;
  let initData: string;

  beforeAll(async () => {
    if (!canRunContainers) return;
    container = await new PostgreSqlContainer('postgres:15-alpine')
      .withDatabase('bvis')
      .withUsername('bvis_user')
      .withPassword('secret123')
      .start();

    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = container.getConnectionUri();
    process.env.USE_MOCK_MEDIA_FEED = 'false';
    process.env.CLIENT_BOT_TOKEN = '123456:testbot';
    process.env.ADMIN_BOT_TOKEN = '123456:adminbot';
    process.env.SKIP_BOT_BOOTSTRAP = 'true';
    process.env.SKIP_NOTIFICATION_DISPATCHER = 'true';
    process.env.SEED_WITH_DEMO_CONTENT = 'true';

    await runCommand('npx', ['prisma', 'migrate', 'deploy'], process.env);
    await runCommand('npx', ['tsx', 'prisma/seed.ts'], process.env);

    mod = await import('../src/index.ts');
    await mod.ensureDatabaseConnection({ silent: true });

    const user = { id: 999001, first_name: 'Integration', last_name: 'Tester' };
    initData = buildInitData(user, process.env.CLIENT_BOT_TOKEN || '');
  }, 120_000);

  afterAll(async () => {
    if (!canRunContainers) return;
    await mod?.prisma.$disconnect();
    await container?.stop();
  });

  test('reports healthy database via healthz', async () => {
    if (!canRunContainers) {
      test.skip();
      return;
    }
    const response = await request(mod.app).get('/healthz').expect(200);
    expect(response.body.db).toMatchObject({ ok: true });
  });

  test('returns batches and photos from the real database', async () => {
    if (!canRunContainers) {
      test.skip();
      return;
    }
    const batchRes = await request(mod.app).get('/api/batches').set('X-Telegram-Init-Data', initData).expect(200);
    expect(Array.isArray(batchRes.body)).toBe(true);
    expect(batchRes.body.length).toBeGreaterThanOrEqual(2);

    const firstBatchId = batchRes.body[0].id;
    const photoRes = await request(mod.app)
      .get(`/api/photos?batchId=${firstBatchId}&take=4`)
      .set('X-Telegram-Init-Data', initData)
      .expect(200);
    expect(Array.isArray(photoRes.body.photos)).toBe(true);
    expect(photoRes.body.photos.length).toBeGreaterThan(0);
  });

  test('creates visits and likes when sent valid initData payloads', async () => {
    if (!canRunContainers) {
      test.skip();
      return;
    }
    const user = { id: 999001, first_name: 'Integration', last_name: 'Tester' };
    const initData = buildInitData(user, process.env.CLIENT_BOT_TOKEN || '');
    const visitRes = await request(mod.app).post('/api/miniapp/visit').send({ initData });
    expect(visitRes.status).toBe(200);

    const createdUser = await mod.prisma.clientUser.findUnique({ where: { telegramId: String(user.id) } });
    expect(createdUser).toBeTruthy();
    expect(createdUser?.miniAppOpens).toBe(1);

    const photo = await mod.prisma.photo.findFirst({ orderBy: { id: 'asc' } });
    expect(photo).toBeTruthy();
    const likeRes = await request(mod.app).post('/api/like').send({ photoId: photo?.id, initData });
    expect(likeRes.status).toBe(200);
    expect(likeRes.body.ok).toBe(true);
    const likes = await mod.prisma.like.count({ where: { photoId: photo?.id } });
    expect(likes).toBeGreaterThan(0);
  });
});
