import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// @cloudflare/vitest-pool-workers 0.18 系では defineWorkersConfig は存在せず、
// cloudflareTest プラグイン + vitest/config の defineConfig を使う。
export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));

  return {
    plugins: [
      cloudflareTest({
        // wrangler.jsonc の env.dev のバインディングをテストへ引き継ぐ。
        wrangler: { configPath: "./wrangler.jsonc", environment: "dev" },
        miniflare: {
          bindings: {
            // setup ファイルからマイグレーションを適用するために渡す。
            TEST_MIGRATIONS: migrations,
            // ローカル/テストでは Access が介在しないため、所有者を固定する。
            // この値は .dev.vars とテストのみに存在し、デプロイ環境には渡らない。
            ENVIRONMENT: "test",
            DEV_OWNER_EMAIL: "owner@example.test",
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./tests/setup/apply-migrations.ts"],
    },
  };
});
