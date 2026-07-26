import { defineConfig } from "vitest/config";

/**
 * E2E専用の設定。
 *
 * 単体・統合テスト(`vitest.config.ts`)は vitest-pool-workers の中でWorkerを
 * 直接呼ぶが、E2Eは `wrangler dev` として起動した実物へHTTPで話す。両者は
 * 実行環境が異なるため設定を分け、`npm run test:e2e` から明示的に走らせる。
 */
export default defineConfig({
  test: {
    include: ["tests/e2e/**/*.test.ts"],
    globalSetup: ["./tests/e2e/global-setup.ts"],
    // Workerの起動と100件の投入を含むため、既定の5秒では足りない。
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // 3つのサーバが同一のローカルstateを共有するため、ファイル間の並列実行はしない。
    fileParallelism: false,
  },
});
