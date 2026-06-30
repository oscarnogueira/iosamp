# syntax=docker/dockerfile:1

# ---- builder: install all deps and compile TS -> dist ----
FROM node:22-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runner: production image ----
FROM node:22-slim AS runner
ENV NODE_ENV=production
WORKDIR /app
# Install production deps only. `tsx` is a runtime dependency (used by the
# migrate script via `node --import tsx`), and `sharp` pulls its native
# Debian binary here.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
# Compiled app code.
COPY --from=builder /app/dist ./dist
# migrate.ts reads ../migrations relative to scripts/, so both dirs must be
# present in the runtime image at /app/scripts and /app/migrations.
COPY migrations ./migrations
COPY scripts ./scripts
EXPOSE 8080
# fly.toml [processes] overrides this; default to the API for plain runs.
CMD ["node", "dist/server.js"]
