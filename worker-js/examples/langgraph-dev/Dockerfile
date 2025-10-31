# 基于worker-js的Dockerfile，用于运行langgraph-dev项目
FROM node:18-alpine

# 安装系统依赖
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    git \
    && rm -rf /var/cache/apk/*

# 设置工作目录
WORKDIR /app

ARG GIT_REPO
RUN git clone ${GIT_REPO} .

# 安装worker-js的Node.js依赖
WORKDIR /app/worker-js
RUN npm ci && npm cache clean --force

# 安装langgraph-dev项目的依赖
WORKDIR /app/worker-js/examples/langgraph-dev
RUN npm install
    # 构建 langgraph-dev 项目
    RUN npm run build

# 回到worker-js目录并构建应用
WORKDIR /app/worker-js
RUN echo "Current directory: $(pwd)" && ls -la
# 查看TypeScript配置
RUN cat tsconfig.json
# 查看package.json中的构建脚本
RUN cat package.json | grep -A 10 "scripts"
# 检查源代码目录结构
RUN find ./src -type f | sort
# 构建 worker-js 项目
RUN npm run build

# 安装bash（在创建非root用户前）
RUN apk add --no-cache bash

# 创建非root用户
RUN addgroup -g 1001 -S nodejs && \
    adduser -S worker -u 1001

# 设置目录权限
RUN chown -R worker:nodejs /app
USER worker

# 确保.env文件存在（即使没挂载，也使用默认配置）
WORKDIR /app
RUN touch .env && \
    echo "# 默认环境变量配置" > .env && \
    echo "# 请确保在此文件中配置所有必要的环境变量" >> .env

# 返回worker-js目录
WORKDIR /app/worker-js

# 设置默认的图配置环境变量


# 暴露端口
EXPOSE 3001

# 健康检查
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:$PORT/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) })"
# 启动应用（运行编译后的 JavaScript 文件）
RUN echo "Final working directory: $(pwd)"
CMD ["node", "dist/main.js"]