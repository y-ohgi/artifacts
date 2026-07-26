import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";

// TEST_MIGRATIONS は vitest.config.ts が miniflare.bindings 経由で渡すテスト専用の
// バインディングで、`wrangler types` が生成する Cloudflare.Env には含まれない。
// グローバルな Env を汚さないため、この 1 箇所でだけ型を合成する。
const testEnv = env as Cloudflare.Env & { TEST_MIGRATIONS: D1Migration[] };

await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
