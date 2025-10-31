import { z } from "zod";

import * as uuid from "uuid";
import type { AssistantsRepo } from "../storage/types.mjs";
import type {
  BaseCheckpointSaver,
  BaseStore,
  CompiledGraph,
  LangGraphRunnableConfig,
} from "@langchain/langgraph";
import { HTTPException } from "hono/http-exception";
import { type CompiledGraphFactory, resolveGraph } from "./load.utils.mjs";
import type { GraphSchema, GraphSpec } from "./parser/index.mjs";
import { getStaticGraphSchema } from "./parser/index.mjs";
// 移除文件系统 checkpointer，改由 worker-js 执行时基于数据库实现
import { storeDb } from "../storage/store.db.mjs";
import { logger } from "../logging.mjs";

export const GRAPHS: Record<
  string,
  CompiledGraph<string> | CompiledGraphFactory<string>
> = {};
export const GRAPH_SPEC: Record<string, GraphSpec> = {};
export const GRAPH_SCHEMA: Record<string, Record<string, GraphSchema>> = {};

export const NAMESPACE_GRAPH = uuid.parse(
  "6ba7b821-9dad-11d1-80b4-00c04fd430c8"
);

const ConfigSchema = z.record(z.record(z.unknown()));

export const getAssistantId = (graphId: string) => {
  if (graphId in GRAPHS) return uuid.v5(graphId, NAMESPACE_GRAPH);
  return graphId;
};

export async function registerFromEnv(
  assistants: AssistantsRepo,
  specs: Record<string, string>,
  options: { cwd: string }
) {
  const envConfig = process.env.LANGGRAPH_CONFIG
    ? ConfigSchema.parse(JSON.parse(process.env.LANGGRAPH_CONFIG))
    : undefined;

  return await Promise.all(
    Object.entries(specs).map(async ([graphId, rawSpec]) => {
      logger.info(`Registering graph with id '${graphId}'`, {
        graph_id: graphId,
      });

      const { context, ...config } = envConfig?.[graphId] ?? {};
      const { resolved, ...spec } = await resolveGraph(rawSpec, {
        cwd: options.cwd,
      });

      // registering the graph runtime
      GRAPHS[graphId] = resolved;
      GRAPH_SPEC[graphId] = spec;

      await assistants.put(
        uuid.v5(graphId, NAMESPACE_GRAPH),
        {
          graph_id: graphId,
          metadata: { created_by: "system" },
          config,
          context,
          if_exists: "do_nothing",
          name: graphId,
        },
        undefined
      );

      return resolved;
    })
  );
}

export async function getGraph(
  graphId: string,
  config: LangGraphRunnableConfig | undefined,
  options?: {
    checkpointer?: BaseCheckpointSaver | null;
    store?: BaseStore;
  }
) {
  assertGraphExists(graphId);

  const compiled =
    typeof GRAPHS[graphId] === "function"
      ? await GRAPHS[graphId](config ?? { configurable: {} })
      : GRAPHS[graphId];

  // server 不再默认提供 checkpointer，交由 worker-js 侧实现
  compiled.checkpointer =
    typeof options?.checkpointer !== "undefined"
      ? options?.checkpointer ?? undefined
      : undefined;

  // 默认使用 Postgres 版 store（如未配置数据库则为 undefined）
  compiled.store =
    typeof options?.store !== "undefined"
      ? options?.store ?? undefined
      : storeDb;

  return compiled;
}

export function assertGraphExists(graphId: string) {
  if (!GRAPHS[graphId])
    throw new HTTPException(404, {
      message: `Graph "${graphId}" not found`,
    });
}

export function getGraphKeys() {
  return Object.keys(GRAPHS);
}

export async function getCachedStaticGraphSchema(graphId: string) {
  if (!GRAPH_SPEC[graphId])
    throw new HTTPException(404, {
      message: `Spec for "${graphId}" not found`,
    });

  if (!GRAPH_SCHEMA[graphId]) {
    let timeoutMs = 30_000;
    try {
      const envTimeout = Number.parseInt(
        process.env.LANGGRAPH_SCHEMA_RESOLVE_TIMEOUT_MS ?? "0",
        10
      );
      if (!Number.isNaN(envTimeout) && envTimeout > 0) {
        timeoutMs = envTimeout;
      }
    } catch {
      // ignore
    }

    try {
      GRAPH_SCHEMA[graphId] = await getStaticGraphSchema(GRAPH_SPEC[graphId], {
        timeoutMs,
      });
    } catch (error) {
      throw new Error(`Failed to extract schema for "${graphId}"`, {
        cause: error,
      });
    }
  }

  return GRAPH_SCHEMA[graphId];
}
