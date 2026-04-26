# 우리 반 책장 — Railway/Docker 빌드
# better-sqlite3 네이티브 모듈을 안전하게 빌드하기 위해 빌드 도구를 포함
FROM node:20-bookworm-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 build-essential ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# ---- 런타임 단계 ----
FROM node:20-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data

COPY --from=build /app /app
RUN mkdir -p /data

EXPOSE 3000
CMD ["node", "server.js"]
