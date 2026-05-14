# ── Stage 1: dependency installer ────────────────────────────────────────────
# Full node image is needed here for npm. It never makes it into the final image.
FROM node:22-alpine AS deps
RUN apk upgrade --no-cache
WORKDIR /app
COPY package*.json ./
RUN npm ci --production

# ── Stage 2: lean runtime image ───────────────────────────────────────────────
# npm and its bundled sub-dependencies (e.g. picomatch) are not needed at
# runtime and inflate the CVE surface. We drop the entire npm toolchain and
# copy only what the application actually needs to run.
FROM node:22-alpine AS runtime
RUN apk upgrade --no-cache && \
    rm -rf \
      /usr/local/lib/node_modules \
      /usr/local/bin/npm \
      /usr/local/bin/npx \
      /usr/local/bin/corepack

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY server.js package.json ./
COPY public ./public
RUN chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node", "server.js"]
