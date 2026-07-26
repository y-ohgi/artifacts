import { rm } from "node:fs/promises";

import type { TestProject } from "vitest/node";

import { OTHER, OWNER } from "./fixtures";
import { STATE_DIR, applyMigrations, executeSql, startDevServer, type DevServer } from "./wrangler";

/**
 * E2Eの前提を用意する。
 *
 * 実際の `wrangler dev` を3つ立て、同じローカルstateを共有させる。1つは所有者、
 * 1つは2人目の利用者、1つは認証情報を持たない訪問者。Cloudflare Access 自体は
 * ローカルで再現できないため、Accessが解決した後の識別情報を `DEV_OWNER_EMAIL`
 * で与える形にしている(この分岐は `ENVIRONMENT` が local/test のときだけ有効で、
 * デプロイ環境には存在しない)。
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  // 前回の残骸を持ち込まない。件数や公開状態を前提にする検証があるため、
  // 毎回まっさらなstateから始める。
  await rm(STATE_DIR, { recursive: true, force: true });

  await applyMigrations();
  await executeSql(
    "INSERT INTO users (uid, email, created_at) VALUES " +
      `('${OWNER.uid}', '${OWNER.email}', '2026-07-27T00:00:00.000Z'), ` +
      `('${OTHER.uid}', '${OTHER.email}', '2026-07-27T00:00:00.000Z')`,
  );

  const servers: DevServer[] = [];

  /** 起動できたサーバは即座に控える。後続が失敗しても取り残さないため */
  const start = async (vars: Record<string, string>): Promise<DevServer> => {
    const server = await startDevServer(vars);
    servers.push(server);
    return server;
  };

  try {
    // 同じstateディレクトリのSQLiteを掴み合わないよう、逐次で起動する。
    const owner = await start({ ENVIRONMENT: "local", DEV_OWNER_EMAIL: OWNER.email });
    const other = await start({ ENVIRONMENT: "local", DEV_OWNER_EMAIL: OTHER.email });
    // DEV_OWNER_EMAIL を渡さないため、所有者を解決できない訪問者になる。
    const anonymous = await start({ ENVIRONMENT: "local" });

    project.provide("ownerBaseUrl", owner.baseUrl);
    project.provide("otherBaseUrl", other.baseUrl);
    project.provide("anonymousBaseUrl", anonymous.baseUrl);
  } catch (error) {
    await Promise.all(servers.map((server) => server.stop()));
    throw error;
  }

  return async () => {
    await Promise.all(servers.map((server) => server.stop()));
  };
}

declare module "vitest" {
  interface ProvidedContext {
    /** 所有者として振る舞うWorkerのURL */
    ownerBaseUrl: string;
    /** 2人目の利用者として振る舞うWorkerのURL */
    otherBaseUrl: string;
    /** 認証情報を持たない訪問者から見たWorkerのURL */
    anonymousBaseUrl: string;
  }
}
