# AgentList Server

协调器服务，基于 LangGraph API 改造，实现高并发、多语言 Worker 调度的分布式执行平台。

## 功能特性

### 核心功能

- **API 管理**: 提供完整的 REST API 和 SSE 接口
- **任务调度**: 智能调度任务到不同语言的 Worker
- **状态管理**: 统一管理 Assistant、Thread、Run 的生命周期
- **事件转发**: 将 Worker 的 SSE 事件流转发给客户端

### 高并发优化

- **PostgreSQL 持久化**: 事务型数据库，支持 `FOR UPDATE SKIP LOCKED` 调度
- **Redis Streams**: 事件流持久化，支持断连重连和跨实例消费
- **动态 Worker 池**: 根据负载自动调整 Worker 数量
- **多租户限流**: 基于令牌桶的限流机制

### Worker 管理

- **服务发现**: 自动发现和注册 Worker 实例
- **健康检查**: 定期检查 Worker 健康状态
- **负载均衡**: 智能选择最优 Worker 执行任务
- **故障转移**: Worker 故障时自动重试和转移

## 架构设计

```
┌─────────────────────────────────────────────────────────────┐
│                    Server                                │
├─────────────────────────────────────────────────────────────┤
│  API Layer                                                  │
│  ├── REST API (Assistants, Threads, Runs, Store)          │
│  ├── SSE Streaming                                         │
│  └── Authentication & Authorization                        │
├─────────────────────────────────────────────────────────────┤
│  Scheduling Layer                                           │
│  ├── Task Queue (PostgreSQL + Redis)                      │
│  ├── Worker Registry & Health Check                       │
│  ├── Load Balancer                                        │
│  └── Rate Limiting & Priority                             │
├─────────────────────────────────────────────────────────────┤
│  Storage Layer                                              │
│  ├── PostgreSQL (Persistent State)                        │
│  ├── Redis Streams (Event Streaming)                      │
│  └── File System (Development)                            │
└─────────────────────────────────────────────────────────────┘
```

## 环境变量

```bash
# 数据库配置
DATABASE_URL=postgresql://agentlist:agentlist123@localhost:5432/agentlist

# Redis 配置
REDIS_URL=redis://localhost:6379

# Worker 配置
WORKER_JS_URL=http://localhost:3001
WORKER_PYTHON_URL=http://localhost:3002

# 服务配置
PORT=8080
NODE_ENV=development

# 认证配置 (可选)
JWT_SECRET=your-jwt-secret
AUTH_ENABLED=false
```

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 启动数据库

```bash
# 使用 Docker Compose 启动 PostgreSQL 和 Redis
docker-compose up -d postgres redis
```

### 3. 运行开发服务器

```bash
npm run dev
```

### 4. 访问服务

- API 文档: http://localhost:8080/docs
- Studio UI: http://localhost:8080/ui
- Health Check: http://localhost:8080/health

## API 接口

### Assistants

- `GET /assistants` - 获取助手列表
- `POST /assistants` - 创建助手
- `GET /assistants/{assistant_id}` - 获取助手详情
- `PATCH /assistants/{assistant_id}` - 更新助手
- `DELETE /assistants/{assistant_id}` - 删除助手

### Threads

- `GET /threads` - 获取线程列表
- `POST /threads` - 创建线程
- `GET /threads/{thread_id}` - 获取线程详情
- `PATCH /threads/{thread_id}` - 更新线程
- `DELETE /threads/{thread_id}` - 删除线程

### Runs

- `POST /threads/{thread_id}/runs` - 创建运行
- `GET /threads/{thread_id}/runs` - 获取运行列表
- `GET /threads/{thread_id}/runs/{run_id}` - 获取运行详情
- `GET /threads/{thread_id}/runs/{run_id}/stream` - SSE 事件流
- `POST /threads/{thread_id}/runs/{run_id}/cancel` - 取消运行

### Store

- `GET /store` - 获取存储项列表
- `PUT /store` - 批量更新存储项
- `DELETE /store` - 批量删除存储项

## 开发指南

### 项目结构

```
src/
├── api/           # API 路由和处理器
├── auth/          # 认证和授权
├── storage/       # 存储适配器 (PostgreSQL, Redis, FileSystem)
├── worker/        # Worker 管理和调度
├── middleware/    # 中间件 (限流、日志等)
├── utils/         # 工具函数
└── server.mts     # 服务器入口
```

### 添加新的存储适配器

1. 实现 `PersistenceAdapter` 接口
2. 在 `storage/` 目录下创建适配器文件
3. 在 `server.mts` 中注册适配器

### 添加新的 Worker 类型

1. 在 `worker/registry.mts` 中注册 Worker 类型
2. 实现 Worker 客户端接口
3. 添加健康检查逻辑

## 部署

### Docker 部署

```bash
# 构建镜像
docker build -t agentlist-server .

# 运行容器
docker run -p 8080:8080 \
  -e DATABASE_URL=postgresql://... \
  -e REDIS_URL=redis://... \
  agentlist-server
```

### 生产环境配置

- 启用 PostgreSQL 连接池
- 配置 Redis 集群
- 设置适当的日志级别
- 启用监控和告警

## 监控和调试

### 健康检查

```bash
curl http://localhost:8080/health
```

### 指标监控

- 队列深度: `/metrics/queue-depth`
- Worker 状态: `/metrics/workers`
- API 延迟: `/metrics/api-latency`

### 日志

日志输出到控制台，包含以下信息：

- 请求/响应日志
- Worker 调度日志
- 错误和异常日志
- 性能指标日志

## 故障排除

### 常见问题

1. **数据库连接失败**: 检查 `DATABASE_URL` 配置
2. **Redis 连接失败**: 检查 `REDIS_URL` 配置
3. **Worker 不可用**: 检查 Worker 服务状态和网络连接
4. **SSE 断连**: 检查客户端网络和 Redis Streams 配置

### 调试模式

```bash
DEBUG=agentlist:* npm run dev
```
