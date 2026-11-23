# 信令服务器镜像。构建上下文是仓库根目录：
#   docker build -f deploy/Dockerfile -t remote-claude-signaling .
# 配置文件不打进镜像，运行时挂载到 /app/server/config.json；
# 账号数据库在 /app/data，要挂载成持久目录。
# 需要 Node 22.13 以上（用到内置的 node:sqlite）。
FROM node:24-alpine

WORKDIR /app
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev && npm cache clean --force
COPY server/server.js ./server/
COPY server/lib ./server/lib
COPY web ./web
RUN mkdir -p /app/data && chown node:node /app/data

ENV RC_DATA_DIR=/app/data
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/healthz >/dev/null || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server/server.js"]
