# AgentList - 多语言 LangGraph 分布式执行平台

基于 LangGraph 的高并发、多语言支持的分布式 Agent 执行平台，实现了管理服务与 Worker 的解耦架构。

## 架构概览

```
┌─────────────────┐    HTTP/SSE     ┌──────────────────┐
│   Server        │ ◄──────────────► │   Worker-JS      │
│   (协调器)       │                 │   (JS/TS Worker) │
│                 │                 └──────────────────┘
│  - API 管理     │    HTTP/SSE     ┌──────────────────┐
│  - 任务调度     │ ◄──────────────► │   Worker-Python  │
│  - 状态管理     │                 │   (Python Worker)│
│  - SSE 转发     │                 └──────────────────┘
└─────────────────┘
        │
        ▼
┌─────────────────┐    ┌──────────────────┐
│   PostgreSQL    │    │   Redis Streams  │
│   (持久化存储)   │    │   (事件流/队列)   │
└─────────────────┘    └──────────────────┘
```

## 项目结构

- **server/**: 协调器服务，基于 langgraph-api 改造
  - 提供统一的 REST API 和 SSE 接口
  - 管理 Assistant、Thread、Run 的生命周期
  - 调度任务到不同语言的 Worker
  - 集成 PostgreSQL 持久化和 Redis Streams 事件流

- **worker-js/**: JavaScript/TypeScript Worker
  - 实现 HTTP + SSE 协议
  - 执行 LangGraph 图的实际运行
  - 无状态设计，状态通过共享存储管理

- **worker-python/**: Python Worker
  - 实现 HTTP + SSE 协议
  - 支持 Python 版本的 LangGraph 执行
  - 与 JS Worker 保持协议一致

## 核心特性

### 高并发优化
- PostgreSQL 事务型持久化，支持 `FOR UPDATE SKIP LOCKED` 调度
- Redis Streams 事件流，支持断连重连和跨实例消费
- 动态 Worker 池和负载均衡
- 多租户限流和优先级队列

### 跨语言支持
- 统一的 HTTP + SSE 协议
- 语言无关的状态管理
- 一致的错误处理和事件格式

### 可扩展性
- Docker 容器化部署
- 水平扩展 Worker 实例
- 服务发现和健康检查

## 快速开始

### 1. 启动基础设施
```bash
# 启动 PostgreSQL 和 Redis
docker-compose up -d postgres redis
```

### 2. 启动协调器
```bash
cd server
npm install
npm run dev
```

### 3. 启动 Workers
```bash
# JS Worker
cd worker-js
npm install
npm start

# Python Worker
cd worker-python
pip install -r requirements.txt
python main.py
```

### 4. 访问服务
- API 文档: http://localhost:8080/docs
- Studio UI: http://localhost:8080/ui

## 开发指南

详细的开发指南请参考各子项目的 README 文件：
- [Server 开发指南](./server/README.md)
- [Worker-JS 开发指南](./worker-js/README.md)
- [Worker-Python 开发指南](./worker-python/README.md)

## 部署

支持多种部署方式：
- Docker Compose (开发/测试)
- Kubernetes (生产环境)
- 单机部署 (小规模场景)

详见 [部署文档](./docs/deployment.md)
