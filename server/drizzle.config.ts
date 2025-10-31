import { defineConfig } from "drizzle-kit";
import * as dotenv from "dotenv";

dotenv.config({ path: __dirname.replace("server", "") + ".env" });

export default defineConfig({
  schema: "./src/storage/schema.mts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ||
      "postgres://postgres:postgres@localhost:5432/agentlist",
  },
  // 添加 tsconfigPath
  // tsconfigPath 属性在当前 drizzle-kit 版本中不被支持，已移除
});
