FROM node:20-slim AS base
WORKDIR /app

RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl python3 python3-pip \
  && pip3 install --no-cache-dir --break-system-packages google-genai \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY apps/api/package*.json apps/api/
COPY apps/mini-app/package*.json apps/mini-app/
COPY apps/api/prisma apps/api/prisma

RUN npm ci --workspaces

COPY . .

RUN npm run build && npm run prisma:generate --workspace api

ENV NODE_ENV=production
ENV PORT=8080
WORKDIR /app/apps/api

CMD ["sh", "-c", "npx prisma migrate deploy --schema prisma/schema.prisma && node dist/index.js"]
