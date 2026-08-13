# syntax=docker/dockerfile:1

# --- Build ------------------------------------------------------------------
# Dev dependencies (vite, tsc) are needed to build, so the build happens in a
# throwaway stage and only the compiled output reaches the runtime image.
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY client/ ./client/
COPY server/ ./server/
RUN npm run build

# Leaves only runtime dependencies behind for the next stage to copy.
RUN npm prune --omit=dev

# --- Runtime ----------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./

# The image carries no configuration: every secret arrives at run time through
# env_file, so the image itself is safe to rebuild and discard.
USER node

CMD ["node", "dist/server/index.js"]
