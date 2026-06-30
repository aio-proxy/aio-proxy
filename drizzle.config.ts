import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./packages/core/src/db/schema/**/*.ts",
  out: "./packages/core/src/db/migrations",
  strict: true
});
