# 构建阶段
# 使用与目标平台一致的基础镜像进行构建
FROM --platform=$TARGETPLATFORM node:18-alpine AS builder

WORKDIR /app

# 安装 pnpm
RUN npm install -g pnpm --registry=https://registry.npmmirror.com

# 复制依赖文件（利用 Docker 缓存）
COPY package.json pnpm-lock.yaml ./
#COPY start.js ./

# 安装依赖 - 这一步现在会在目标架构 (e.g., arm64) 的容器中执行
# 这样生成的 node_modules 中的 native addons 就是为正确的架构编译的
RUN pnpm install --force --registry=https://registry.npmmirror.com && \
    pnpm store prune && \
    rm -rf /root/.pnpm-store

# 复制应用代码
COPY . ./

# 修复权限
RUN chown -R 1001:1001 /app

# 生产阶段
# 同样使用与目标平台一致的基础镜像
FROM --platform=$TARGETPLATFORM node:18-alpine

# 创建非 root 用户
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodeuser -u 1001

WORKDIR /app

# 从构建阶段复制文件 (现在复制的是为正确架构构建的 node_modules)
COPY --from=builder --chown=nodeuser:nodejs /app /app

# 复制证书
COPY cert/rootCA.key /root/.anyproxy/certificates/
COPY cert/rootCA.crt /root/.anyproxy/certificates/
# COPY init_permissions.sh /app/
# RUN chmod +x /app/init_permissions.sh
#COPY start.js /app/start.js

USER nodeuser

EXPOSE 8001 8002 8003

# 使用 node 启动脚本作为 CMD
CMD ["npm", "run", "start"]
