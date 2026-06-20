import { defineConfig } from "drizzle-kit";
import path from "path";

const connectionString =
  process.env.DATABASE_ADMIN_URL
  ?? process.env.NEON_DATABASE_ADMIN_URL
  ?? process.env.DATABASE_RUNTIME_URL
  ?? process.env.NEON_DATABASE_URL
  ?? process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_ADMIN_URL or DATABASE_RUNTIME_URL must be set. Did you forget to configure the database?");
}

export default defineConfig({
  schema: path.join(__dirname, "./src/schema/index.ts"),
  out: "./db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: connectionString,
  },
});
