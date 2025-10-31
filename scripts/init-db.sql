-- AgentList 数据库初始化脚本
-- 基于高并发优化报告的设计

-- 创建扩展
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- 助手表 (Assistants)
CREATE TABLE IF NOT EXISTS assistants (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    graph_id VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    config JSONB DEFAULT '{}',
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 线程表 (Threads)
CREATE TABLE IF NOT EXISTS threads (
    thread_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    status VARCHAR(50) DEFAULT 'idle',
    config JSONB DEFAULT '{}',
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 运行表 (Runs)
CREATE TABLE IF NOT EXISTS runs (
    run_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    thread_id UUID REFERENCES threads(thread_id) ON DELETE CASCADE,
    assistant_id UUID REFERENCES assistants(id) ON DELETE CASCADE,
    status VARCHAR(50) DEFAULT 'pending',
    kwargs JSONB DEFAULT '{}',
    metadata JSONB DEFAULT '{}',
    attempt INTEGER DEFAULT 1,
    max_attempts INTEGER DEFAULT 3,
    scheduled_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 检查点表 (Checkpoints) — 统一与 Drizzle schema
DROP TABLE IF EXISTS checkpoints CASCADE;
CREATE TABLE IF NOT EXISTS checkpoints (
    checkpoint_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    thread_id UUID NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
    run_id UUID NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    step_index INTEGER NOT NULL DEFAULT 0,
    data JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- 键值存储表 (Store)
CREATE TABLE IF NOT EXISTS store (
    namespace VARCHAR(255) NOT NULL,
    key VARCHAR(255) NOT NULL,
    value JSONB NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (namespace, key)
);

-- 事件表 (Events) — 统一与 Drizzle schema
DROP TABLE IF EXISTS events CASCADE;
CREATE TABLE IF NOT EXISTS events (
    event_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    run_id UUID NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    type VARCHAR(100) NOT NULL,
    data JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Worker 注册表
CREATE TABLE IF NOT EXISTS workers (
    worker_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    worker_type VARCHAR(50) NOT NULL, -- 'js' or 'python'
    endpoint_url VARCHAR(500) NOT NULL,
    status VARCHAR(50) DEFAULT 'active', -- 'active', 'inactive', 'unhealthy'
    capabilities JSONB DEFAULT '{}',
    last_heartbeat TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 创建索引以优化查询性能

-- Assistants 索引
CREATE INDEX IF NOT EXISTS idx_assistants_graph_id ON assistants(graph_id);
CREATE INDEX IF NOT EXISTS idx_assistants_metadata ON assistants USING GIN(metadata);

-- Threads 索引
CREATE INDEX IF NOT EXISTS idx_threads_status ON threads(status);
CREATE INDEX IF NOT EXISTS idx_threads_metadata ON threads USING GIN(metadata);

-- Runs 索引 - 关键的调度优化
CREATE INDEX IF NOT EXISTS idx_runs_status_scheduled ON runs(status, scheduled_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_runs_thread_status ON runs(thread_id, status);
CREATE INDEX IF NOT EXISTS idx_runs_assistant_id ON runs(assistant_id);
CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs(created_at);
CREATE INDEX IF NOT EXISTS idx_runs_metadata ON runs USING GIN(metadata);

-- Checkpoints 索引（用于快速查询与恢复）
CREATE INDEX IF NOT EXISTS idx_checkpoints_thread_run ON checkpoints(thread_id, run_id);

-- Store 表（统一为扁平 key 主键，与 Drizzle schema 一致）
DROP TABLE IF EXISTS store CASCADE;
CREATE TABLE IF NOT EXISTS store (
    key VARCHAR(255) PRIMARY KEY,
    value JSONB NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Users / Roles / Permissions / Sessions（统一与 Drizzle schema 一致）
DROP TABLE IF EXISTS role_permissions CASCADE;
DROP TABLE IF EXISTS user_roles CASCADE;
DROP TABLE IF EXISTS sessions CASCADE;
DROP TABLE IF EXISTS permissions CASCADE;
DROP TABLE IF EXISTS roles CASCADE;
DROP TABLE IF EXISTS users CASCADE;

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) NOT NULL,
    username VARCHAR(255),
    password_hash TEXT NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'active',
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

CREATE TABLE IF NOT EXISTS roles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_roles_name ON roles(name);

CREATE TABLE IF NOT EXISTS permissions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_permissions_name ON permissions(name);

CREATE TABLE IF NOT EXISTS user_roles (
    user_id UUID NOT NULL,
    role_id UUID NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_user_roles ON user_roles(user_id, role_id);

CREATE TABLE IF NOT EXISTS role_permissions (
    role_id UUID NOT NULL,
    permission_id UUID NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_role_permissions ON role_permissions(role_id, permission_id);

CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id UUID NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Events 索引（用于历史事件回放）
CREATE INDEX IF NOT EXISTS idx_events_run_id ON events(run_id);
CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);

-- 可选：为 Worker 创建受限角色，仅允许写入 checkpoints 与 events
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_roles WHERE rolname = 'agentlist_worker'
    ) THEN
        CREATE ROLE agentlist_worker;
    END IF;
END $$;

GRANT INSERT, UPDATE ON TABLE checkpoints TO agentlist_worker;
GRANT INSERT, UPDATE ON TABLE events TO agentlist_worker;
REVOKE ALL ON TABLE runs FROM agentlist_worker;
REVOKE ALL ON TABLE threads FROM agentlist_worker;
REVOKE ALL ON TABLE assistants FROM agentlist_worker;

-- Workers 索引
CREATE INDEX IF NOT EXISTS idx_workers_type_status ON workers(worker_type, status);
CREATE INDEX IF NOT EXISTS idx_workers_last_heartbeat ON workers(last_heartbeat);

-- 创建更新时间触发器函数
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- 为需要的表添加更新时间触发器
CREATE TRIGGER update_assistants_updated_at BEFORE UPDATE ON assistants FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_threads_updated_at BEFORE UPDATE ON threads FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_runs_updated_at BEFORE UPDATE ON runs FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_store_updated_at BEFORE UPDATE ON store FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_workers_updated_at BEFORE UPDATE ON workers FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 插入示例数据
INSERT INTO assistants (id, graph_id, name, description, config, metadata) VALUES
    ('550e8400-e29b-41d4-a716-446655440001', 'chat-assistant', 'Chat Assistant', 'A general purpose chat assistant', '{"temperature": 0.7}', '{"tenant_id": "default"}'),
    ('550e8400-e29b-41d4-a716-446655440002', 'code-assistant', 'Code Assistant', 'A coding assistant', '{"temperature": 0.3}', '{"tenant_id": "default"}')
ON CONFLICT (id) DO NOTHING;

-- 插入示例 Worker
INSERT INTO workers (worker_id, worker_type, endpoint_url, capabilities) VALUES
    ('660e8400-e29b-41d4-a716-446655440001', 'js', 'http://worker-js:3001', '{"graphs": ["chat-assistant", "code-assistant"]}'),
    ('660e8400-e29b-41d4-a716-446655440002', 'python', 'http://worker-python:3002', '{"graphs": ["chat-assistant"]}')
ON CONFLICT (worker_id) DO NOTHING;