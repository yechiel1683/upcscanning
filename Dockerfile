# syntax=docker/dockerfile:1

# The web app and the worker ship as the same image with different commands, so
# they can never drift apart on pipeline code.

FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# sharp needs libvips' runtime deps; openssl is required by Prisma.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate && npm run build

FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3000

# node_modules is kept whole rather than traced: the worker entry point runs
# through tsx, and both processes need the Prisma client and sharp binaries.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY package.json next.config.ts tsconfig.json ./
COPY prisma ./prisma
COPY src ./src
COPY scripts ./scripts
COPY examples ./examples

RUN mkdir -p /data/storage && chown -R node:node /data/storage /app
USER node

EXPOSE 3000

# The port is read at runtime: hosts like Railway inject their own PORT, and a
# healthcheck hardcoded to 3000 would fail against it and restart-loop a
# perfectly healthy container.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "const p=process.env.PORT||3000;fetch('http://127.0.0.1:'+p+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# `start` applies migrations before serving; see scripts/release.ts.
CMD ["npm", "run", "start"]
