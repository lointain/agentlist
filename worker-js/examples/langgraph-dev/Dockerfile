# 基于worker-js的Dockerfile，用于运行langgraph-dev项目
FROM node:18-alpine

# 设置工作目录
WORKDIR /app

# 安装系统依赖
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    && rm -rf /var/cache/apk/*

# 复制worker-js的package.json和package-lock.json
COPY ../../package*.json ./

# 安装Node.js依赖
RUN npm ci && npm cache clean --force

# 复制worker-js源代码
COPY ../../src ./src
COPY ../../tsconfig.json ./

# 复制langgraph-dev项目（假设它在外部文件夹中，这里模拟复制）
COPY . /app/graphs/langgraph-dev

# 构建应用
RUN npm run build

# 创建非root用户
RUN addgroup -g 1001 -S nodejs && \
    adduser -S worker -u 1001

# 设置目录权限
RUN chown -R worker:nodejs /app
USER worker

# 暴露端口
EXPOSE 3001

# 健康检查
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3001/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) })"

# 启动应用（通过环境变量配置）
CMD ["node", "dist/main.mjs"]