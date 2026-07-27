FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production

RUN apk add --no-cache poppler-utils \
    && apk add --no-cache --virtual .build-deps python3 make g++ \
    && mkdir -p /var/lib/mafusheets/database /var/lib/mafusheets/uploads \
       /var/lib/mafusheets/thumbnails /var/lib/mafusheets/staging \
       /var/lib/mafusheets/quarantine \
    && chown -R node:node /var/lib/mafusheets \
    && chmod 0700 /var/lib/mafusheets /var/lib/mafusheets/*

COPY --chown=root:root --chmod=0444 package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force \
    && apk del .build-deps \
    && chmod -R a-w /app/node_modules

COPY --chown=root:root --chmod=0444 server.js processing-worker.js search-indexer.js reindex.js ./
COPY --chown=root:root --chmod=0555 lib ./lib
COPY --chown=root:root --chmod=0444 Banner.png logo.png ./

USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/health || exit 1

CMD ["node", "server.js"]
