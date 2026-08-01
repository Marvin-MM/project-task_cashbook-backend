# ─────────────────────────────────────────────
# Multi-stage Dockerfile for cashbook-backend
# Fixed: Added missing schema copy to Stage 3
# ─────────────────────────────────────────────

# ── Stage 1: Install dependencies + generate Prisma ──────
FROM node:22-alpine AS deps
WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./

# Install ALL dependencies
RUN npm ci

# Copy Prisma schema and generate client
COPY prisma ./prisma
RUN npx prisma generate


# ── Stage 2: Build TypeScript ────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./
COPY tsconfig.json tsconfig.scripts.json ./
COPY src ./src
COPY scripts ./scripts
COPY prisma ./prisma

RUN npm run build && npm run build:scripts


# ── Stage 3: Production Image ───────────────────────────
FROM node:22-alpine AS runner

RUN apk add --no-cache tini
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=5000

# Copy node_modules from deps
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./

# Remove dev dependencies.
# 'prisma' is a runtime dependency (not a devDependency) because the entrypoint
# runs `prisma migrate deploy`, so the CLI must survive this prune.
RUN npm prune --omit=dev && npm cache clean --force

# Copy built JS output
COPY --from=builder /app/dist ./dist

# The operational scripts, compiled. They are built separately (see
# tsconfig.scripts.json) precisely so they can run HERE, with plain `node` and
# no dev dependencies: a backfill you cannot execute against production is not
# a backfill. Run one with
#   docker compose run --rm api node dist-scripts/scripts/backfill-ledger.js --apply
COPY --from=builder /app/dist-scripts ./dist-scripts

# Copy Prisma engines
COPY --from=deps /app/node_modules/.prisma ./node_modules/.prisma

# Schema + migration history, needed by `prisma migrate deploy` at startup.
COPY prisma ./prisma

EXPOSE 5000

USER appuser

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:5000/api/v1/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]

# `migrate deploy` takes a Postgres advisory lock, so concurrent replicas are safe:
# the first applies pending migrations, the rest wait and then no-op.
CMD ["sh", "-c", "npx prisma migrate deploy && exec node dist/server.js"]