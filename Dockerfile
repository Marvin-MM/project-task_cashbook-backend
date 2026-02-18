# ─────────────────────────────────────────────
# Multi-stage Dockerfile for cashbook-backend
# Optimized + Fixed
# ─────────────────────────────────────────────

# ── Stage 1: Install dependencies + generate Prisma ──────
FROM node:22-alpine AS deps
WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./

# Install ALL dependencies (including dev for build)
RUN npm ci

# Copy Prisma schema and generate client
COPY prisma ./prisma
RUN npx prisma generate


# ── Stage 2: Build TypeScript ────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

# Copy dependencies and package.json from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./

# Copy project files
COPY tsconfig.json ./
COPY src ./src
COPY prisma ./prisma

# Build the TypeScript project
RUN npm run build


# ── Stage 3: Production Image ───────────────────────────
FROM node:22-alpine AS runner

# Install tini (proper process manager for K8s)
RUN apk add --no-cache tini

# Create non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=5000

# Copy node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./

# Remove dev dependencies for production
RUN npm prune --omit=dev && npm cache clean --force

# Copy built JS output
COPY --from=builder /app/dist ./dist

# Copy Prisma engines (required at runtime)
COPY --from=deps /app/node_modules/.prisma ./node_modules/.prisma

EXPOSE 5000

USER appuser

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:5000/api/v1/health || exit 1

# Use tini as entrypoint
ENTRYPOINT ["/sbin/tini", "--"]

CMD ["node", "dist/server.js"]
