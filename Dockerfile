# 构建阶段
FROM --platform=$TARGETPLATFORM node:18-alpine AS builder

WORKDIR /app

# 安装 pnpm
RUN npm install -g pnpm --registry=https://registry.npmmirror.com

# 复制依赖文件（利用 Docker 缓存）
COPY package.json pnpm-lock.yaml ./

# 安装依赖 - 这一步现在会在目标架构 (e.g., arm64) 的容器中执行
# 这样生成的 node_modules 中的 native addons 就是为正确的架构编译的
RUN pnpm install --registry=https://registry.npmmirror.com && \
    pnpm store prune # && \
    # rm -rf /root/.pnpm-store # pnpm store prune 通常已足够

# 复制应用代码
COPY . ./

# 生产阶段
FROM --platform=$TARGETPLATFORM node:18-alpine

WORKDIR /app

# 从构建阶段复制文件 (现在复制的是为正确架构构建的 node_modules)
COPY --from=builder /app /app 
# 注意：因为没有 nodeuser，所以移除了 --chown

EXPOSE 8001 8002 8003

# 使用 node 启动脚本作为 CMD
CMD ["npm", "run", "start"]
# 注意：应用将以 root 用户运行