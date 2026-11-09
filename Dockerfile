# 构建：Node 22 + 前端产物 + API 运行时（tsx 直接跑 TypeScript 服务）
# 运行：docker compose up --build，浏览器访问 http://127.0.0.1:8080

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM nginx:1.27-alpine AS web
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

FROM node:22-bookworm-slim AS api
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY tsconfig.json tsconfig.server.json ./
COPY server ./server
COPY shared ./shared
COPY scripts ./scripts
RUN mkdir -p data generated
EXPOSE 8787
CMD ["npx", "tsx", "server/index.ts"]
