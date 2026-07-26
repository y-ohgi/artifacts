import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { promisify } from "node:util";

import { DATABASE_NAME } from "./fixtures";

const execFileAsync = promisify(execFile);

/** ローカルにインストールされた wrangler。npx を挟まず直接呼ぶ */
const WRANGLER = path.join(process.cwd(), "node_modules", ".bin", "wrangler");

/** miniflare の永続化先。`.wrangler/` は gitignore 済み */
export const STATE_DIR = path.join(process.cwd(), ".wrangler", "e2e-state");

const COMMON_ARGS = ["--env", "dev", "--persist-to", STATE_DIR];

/** 起動待ちの上限。初回は workerd の展開が入るため長めに取る */
const READY_TIMEOUT_MS = 90_000;

export async function applyMigrations(): Promise<void> {
  await execFileAsync(WRANGLER, [
    "d1",
    "migrations",
    "apply",
    DATABASE_NAME,
    ...COMMON_ARGS,
    "--local",
  ]);
}

/** ローカルのD1へSQLを1つ実行する。E2Eの前提データの投入に使う */
export async function executeSql(sql: string): Promise<void> {
  await execFileAsync(
    WRANGLER,
    ["d1", "execute", DATABASE_NAME, ...COMMON_ARGS, "--local", "--command", sql],
    // 100件のINSERTを1文で流すため、既定より大きめのバッファを許す。
    { maxBuffer: 32 * 1024 * 1024 },
  );
}

export type DevServer = {
  readonly baseUrl: string;
  readonly stop: () => Promise<void>;
};

/** 空きポートをOSに選ばせる */
async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close(() => reject(new Error("could not determine a free port")));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function waitUntilReady(baseUrl: string, child: ChildProcess, log: () => string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`wrangler dev exited with ${child.exitCode}\n${log()}`);
    }

    try {
      // `/` は認証を必要とせず 302 を返すため、起動確認に使える。
      const response = await fetch(`${baseUrl}/`, { redirect: "manual" });
      if (response.status === 302) {
        return;
      }
    } catch {
      // まだ listen していない。
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`wrangler dev did not become ready within ${READY_TIMEOUT_MS}ms\n${log()}`);
}

/** 起動の再試行回数。SQLITE_BUSY は少し待てば解消する */
const START_ATTEMPTS = 3;

/**
 * `wrangler dev` を1つ起動する。
 *
 * `vars` で識別情報を渡す。`ENVIRONMENT=local` かつ `DEV_OWNER_EMAIL` があれば
 * その利用者として、`DEV_OWNER_EMAIL` が無ければ「認証情報を持たない訪問者」として
 * 振る舞う。同じ `--persist-to` を共有させることで、複数の立場から同一のデータを
 * 見る状況を再現している。
 *
 * 起動直後は miniflare が state のSQLiteを掴むため、同じディレクトリを使う
 * サーバを同時に立ち上げると `SQLITE_BUSY` で落ちる。呼び出し側は逐次起動し、
 * ここでも数回まで再試行する。
 */
export async function startDevServer(vars: Record<string, string>): Promise<DevServer> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= START_ATTEMPTS; attempt += 1) {
    try {
      return await spawnDevServer(vars);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1_000 * attempt));
    }
  }

  throw lastError;
}

async function spawnDevServer(vars: Record<string, string>): Promise<DevServer> {
  const port = await freePort();
  const inspectorPort = await freePort();

  const args = [
    "dev",
    ...COMMON_ARGS,
    "--port",
    String(port),
    "--inspector-port",
    String(inspectorPort),
    ...Object.entries(vars).flatMap(([key, value]) => ["--var", `${key}:${value}`]),
  ];

  const child = spawn(WRANGLER, args, { stdio: ["ignore", "pipe", "pipe"] });

  let output = "";
  const collect = (chunk: Buffer): void => {
    output += chunk.toString();
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);

  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await waitUntilReady(baseUrl, child, () => output);
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }

  return {
    baseUrl,
    stop: async () => {
      if (child.exitCode !== null) {
        return;
      }

      child.kill("SIGTERM");
      // SIGTERM を無視した場合に備え、少し待って強制終了する。
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 5_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}
