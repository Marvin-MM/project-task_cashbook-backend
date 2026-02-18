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
COPY tsconfig.json ./
COPY src ./src
COPY prisma ./prisma

RUN npm run build


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

# Remove dev dependencies
# ⚠️ NOTE: If 'prisma' is in devDependencies, this removes the CLI.
# If your next error is "command not found", remove this prune line.
RUN npm prune --omit=dev && npm cache clean --force

# Copy built JS output
COPY --from=builder /app/dist ./dist

# Copy Prisma engines
COPY --from=deps /app/node_modules/.prisma ./node_modules/.prisma

# ✅ FIXED: Copy the schema so 'npx prisma db push' can find it
COPY prisma ./prisma

EXPOSE 5000

USER appuser

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:5000/api/v1/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]

CMD ["node", "dist/server.js"]