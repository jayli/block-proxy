# 构建阶段
FROM node:18-alpine AS builder

WORKDIR /app

# 安装 pnpm
RUN npm install -g pnpm --registry=https://registry.npmmirror.com

# 复制依赖文件（利用 Docker 缓存）
COPY package.json pnpm-lock.yaml ./
COPY start.js ./

# 安装依赖
RUN pnpm install --force --registry=https://registry.npmmirror.com && \
    pnpm store prune && \
    rm -rf /root/.pnpm-store

# 复制应用代码
COPY . ./

# 修复权限
RUN chown -R 1001:1001 /app

# 生产阶段
FROM node:18-alpine

# 创建非 root 用户
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodeuser -u 1001

WORKDIR /app

# 从构建阶段复制文件
COPY --from=builder --chown=nodeuser:nodejs /app /app

# 复制证书
COPY cert/rootCA.key /home/nodeuser/.anyproxy/certificates/
COPY cert/rootCA.crt /home/nodeuser/.anyproxy/certificates/


USER nodeuser

EXPOSE 8001 8002 8003

CMD ["npm", "run", "start"]
