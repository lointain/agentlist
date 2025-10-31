# LangGraph Dev Worker 容器化部署指南

本文档提供将 `langgraph-dev` 项目作为 `worker-js` Docker 服务运行的详细步骤。

## 前置要求

- Docker 和 Docker Compose 已安装
- 基本的 Docker 和容器概念了解

## 配置说明

### 1. 核心配置文件

- `Dockerfile`: 自定义 Docker 镜像构建脚本
- `docker-compose.yml`: 服务编排和环境变量配置

### 2. 关键环境变量

在 `docker-compose.yml` 中，您可以配置以下关键参数：

- **SERVER_URL**: 配置 worker 连接到的服务器地址，例如 `http://server:3000`
  - 如需独立运行（不连接服务器），可以将其注释或留空
  - 如需连接到外部服务器，请修改为实际的服务器地址

- **WORKER_ID**: Worker 实例的唯一标识符

- **LANGGRAPH_CONFIG**: 指定要加载的图配置
  - 默认已配置为加载当前目录下的示例图: `{"graphs":{"examples-echo":"/app/graphs/langgraph-dev/index.ts:graph"}}`

- **其他可选配置**:
  - `DATABASE_URL`: 数据库连接字符串（用于检查点功能）
  - `HEARTBEAT_INTERVAL`: 心跳间隔（毫秒）

## 启动步骤

### 方法一：使用 Docker Compose（推荐）

1. 确保您在 `langgraph-dev` 目录下
2. 运行以下命令启动服务：

```bash
docker-compose up -d
```

### 方法二：直接使用 Docker 命令

1. 构建镜像：

```bash
docker build -t worker-js-langgraph-dev .
```

2. 运行容器：

```bash
docker run -d \
  --name worker-js-langgraph-dev \
  -p 3001:3001 \
  -e SERVER_URL=http://your-server-url:3000 \
  -e WORKER_ID=worker-js-langgraph-dev \
  worker-js-langgraph-dev
```

## 验证服务

启动服务后，可以通过以下方式验证：

1. 访问健康检查端点：

```bash
curl http://localhost:3001/health
```

2. 检查容器日志：

```bash
docker logs worker-js-langgraph-dev
```

## 自定义图配置

如果您有自己的 LangGraph 图要运行：

1. 修改您的 `index.ts` 文件，确保导出的图变量名称与 `langgraph.json` 中定义的一致
2. 更新 `LANGGRAPH_CONFIG` 环境变量以指向您的图文件

## 动态更新图代码

如需在不重建镜像的情况下更新图代码，可以：

1. 取消注释 `docker-compose.yml` 中的卷挂载配置：

```yaml
volumes:
  - ./:/app/graphs/langgraph-dev
```

2. 重启服务：

```bash
docker-compose up -d
```

## 故障排除

1. **无法连接到服务器**：确保 `SERVER_URL` 配置正确，服务器正在运行且网络可达
2. **图加载失败**：检查 `LANGGRAPH_CONFIG` 路径是否正确，确保图文件已正确导出
3. **权限问题**：检查目录和文件权限设置

## 注意事项

1. 本配置假设您的项目结构与示例类似，如果结构不同，可能需要调整 `Dockerfile` 中的复制路径
2. 对于生产环境，建议使用环境变量文件或密钥管理服务来存储敏感信息
3. 如需持久化存储或使用数据库功能，请确保正确配置 `DATABASE_URL`