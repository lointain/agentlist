import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import * as schemas from "../schemas.mjs";
import { HTTPException } from "hono/http-exception";
// 替换为 Postgres 版 Store 适配器
import { storeDb } from "../storage/store.db.mjs";
import type { Item } from "@langchain/langgraph";
import { requirePermission } from "../middleware/auth.mjs";

const api = new Hono();

const validateNamespace = (namespace: string[]) => {
  if (!namespace || namespace.length === 0) {
    throw new HTTPException(400, { message: "Namespace is required" });
  }

  for (const label of namespace) {
    if (!label || label.includes(".")) {
      throw new HTTPException(422, {
        message:
          "Namespace labels cannot be empty or contain periods. Received: " +
          namespace.join("."),
      });
    }
  }
};

const mapItemsToApi = (item: Item | null) => {
  if (item == null) return null;

  const clonedItem: Record<string, unknown> = { ...item };
  delete clonedItem.createdAt;
  delete clonedItem.updatedAt;

  clonedItem.created_at = item.createdAt;
  clonedItem.updated_at = item.updatedAt;

  return clonedItem;
};

api.post(
  "/store/namespaces",
  zValidator("json", schemas.StoreListNamespaces),
  async (c) => {
    // List Namespaces
    const payload = c.req.valid("json");
    if (payload.prefix) validateNamespace(payload.prefix);
    if (payload.suffix) validateNamespace(payload.suffix);

    requirePermission(c, "store:list_namespaces");

    if (!storeDb) {
      throw new HTTPException(500, {
        message: "Store 未初始化（缺少 DATABASE_URL）",
      });
    }

    return c.json({
      namespaces: await storeDb.listNamespaces({
        limit: payload.limit ?? 100,
        offset: payload.offset ?? 0,
        prefix: payload.prefix,
        suffix: payload.suffix,
        maxDepth: payload.max_depth,
      }),
    });
  }
);

api.post(
  "/store/items/search",
  zValidator("json", schemas.StoreSearchItems),
  async (c) => {
    // Search Items
    const payload = c.req.valid("json");
    if (payload.namespace_prefix) validateNamespace(payload.namespace_prefix);

    requirePermission(c, "store:search");

    if (!storeDb) {
      throw new HTTPException(500, {
        message: "Store 未初始化（缺少 DATABASE_URL）",
      });
    }

    const items = await storeDb.search(payload.namespace_prefix, {
      filter: payload.filter,
      limit: payload.limit ?? 10,
      offset: payload.offset ?? 0,
      query: payload.query,
    });

    return c.json({ items: items.map(mapItemsToApi) });
  }
);

api.put("/store/items", zValidator("json", schemas.StorePutItem), async (c) => {
  // Put Item
  const payload = c.req.valid("json");
  if (payload.namespace) validateNamespace(payload.namespace);

  requirePermission(c, "store:put");
  if (!storeDb) {
    throw new HTTPException(500, {
      message: "Store 未初始化（缺少 DATABASE_URL）",
    });
  }
  await storeDb.put(payload.namespace, payload.key, payload.value);
  return c.body(null, 204);
});

api.delete(
  "/store/items",
  zValidator("json", schemas.StoreDeleteItem),
  async (c) => {
    // Delete Item
    const payload = c.req.valid("json");
    if (payload.namespace) validateNamespace(payload.namespace);

    requirePermission(c, "store:delete");
    if (!storeDb) {
      throw new HTTPException(500, {
        message: "Store 未初始化（缺少 DATABASE_URL）",
      });
    }
    await storeDb.delete(payload.namespace ?? [], payload.key);
    return c.body(null, 204);
  }
);

api.get(
  "/store/items",
  zValidator("query", schemas.StoreGetItem),
  async (c) => {
    // Get Item
    const payload = c.req.valid("query");

    requirePermission(c, "store:get");

    const key = payload.key;
    const namespace = payload.namespace;
    if (!storeDb) {
      throw new HTTPException(500, {
        message: "Store 未初始化（缺少 DATABASE_URL）",
      });
    }
    return c.json(mapItemsToApi(await storeDb.get(namespace, key)));
  }
);

export default api;
