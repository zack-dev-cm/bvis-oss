import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function run() {
  const likes = await prisma.like.deleteMany();
  const notifications = await prisma.notification.deleteMany();
  const photos = await prisma.photo.deleteMany();
  const batches = await prisma.photoBatch.deleteMany();
  const lookbooks = await prisma.lookbookTopic.updateMany({
    data: { batchId: null, heroPhotoFileId: null },
  });

  console.log(
    `Cleared content: likes=${likes.count}, notifications=${notifications.count}, photos=${photos.count}, batches=${batches.count}, lookbookTopics reset=${lookbooks.count}`
  );
}

run()
  .catch((err) => {
    console.error('Failed to clear feed content', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
