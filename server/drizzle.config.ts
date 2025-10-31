import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/storage/schema.mts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/agentlist",
  },
  // 添加 tsconfigPath
  tsconfigPath: "./tsconfig.json",
});
