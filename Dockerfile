FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN apk add --no-cache poppler-utils \
    && apk add --no-cache --virtual .build-deps python3 make g++ \
    && npm ci --omit=dev \
    && apk del .build-deps

COPY . .

EXPOSE 3000
CMD ["npm", "start"]
