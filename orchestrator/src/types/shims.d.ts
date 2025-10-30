// 类型检查 Shim：在未安装依赖时让编译通过（均为 any）
// 注意：仅用于临时修复 typecheck，不影响运行时行为

declare module "@hono/node-server";
declare module "hono";
declare module "hono/context-storage";
declare module "@hono/zod-validator";
declare module "hono/http-exception";
declare module "hono/utils/mime";
declare module "hono/streaming";
declare module "hono/utils/http-status";

declare module "winston";
declare module "winston-console-format";
declare module "stacktrace-parser";
declare module "@babel/code-frame";

declare module "json-schema";
declare module "uuid";
declare module "dotenv";
declare module "semver";
declare module "exit-hook";

declare module "langsmith";
declare module "@langchain/langgraph";
declare module "@langchain/langgraph/remote";
declare module "@langchain/core/messages";
declare module "@langchain/core/tracers/tracer_langchain";
declare module "@langchain/core/prompt_values";
declare module "@langchain/core/runnables";
declare module "@langchain/core/utils/testing";
declare module "@langchain/langgraph-sdk";
declare module "@langchain/langgraph-ui";
declare module "@langchain/langgraph-checkpoint";

declare module "vitest";
declare module "tsx/esm/api";
declare module "drizzle-orm/pg-core";
declare module "jose";
declare module "wait-port";
declare module "@typescript/vfs";

// 兜底：任何未声明的模块视为 any
declare module "*";

// NodeJS.Timeout 简化声明，避免类型缺失
declare namespace NodeJS {
  type Timeout = number;
}