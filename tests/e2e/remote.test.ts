import { describe, expect, it } from "vitest";

/**
 * デプロイ済み環境に対する未認証からのスモークテスト。
 *
 * ローカルのE2E(journeys.test.ts)はWorkerの振る舞いを網羅するが、実際にデプロイ
 * された環境で「保護境界が期待どおりか」「公開アーティファクトが未認証で読めるか」
 * までは分からない。ここはその確認に限る。
 *
 * 環境変数が無ければスキップする(通常の `npm run test:e2e` では走らない)。
 *
 *   E2E_REMOTE_BASE_URL      例: https://artifacts-dev.example.workers.dev
 *   E2E_REMOTE_UID           デプロイ環境に存在する uid
 *   E2E_REMOTE_PUBLIC_NAME   公開状態のアーティファクト名(省略可)
 *   E2E_REMOTE_PRIVATE_NAME  非公開のアーティファクト名(省略可)
 */

const baseUrl = process.env["E2E_REMOTE_BASE_URL"];
const uid = process.env["E2E_REMOTE_UID"];
const publicName = process.env["E2E_REMOTE_PUBLIC_NAME"];
const privateName = process.env["E2E_REMOTE_PRIVATE_NAME"];

const stableHeaders = (response: Response): [string, string][] => {
  const volatile = new Set([
    "date",
    "cf-ray",
    "server",
    "report-to",
    "nel",
    "server-timing",
    "cf-cache-status",
    "age",
    "alt-svc",
  ]);
  return [...response.headers]
    .filter(([name]) => !volatile.has(name.toLowerCase()))
    .sort(([a], [b]) => a.localeCompare(b));
};

describe.skipIf(baseUrl === undefined)("デプロイ済み環境 (未認証)", () => {
  const remote = baseUrl as string;

  it("/ は /_app/ へリダイレクトする", async () => {
    const response = await fetch(`${remote}/`, { redirect: "manual" });

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/_app/");
  });

  it("管理画面は未認証に内容を返さない (FR-020)", async () => {
    const response = await fetch(`${remote}/_app/`, {
      headers: { Accept: "text/html" },
      redirect: "manual",
    });

    // Accessが前段に入っていればログイン画面へのリダイレクト、
    // 入っていなければWorker自身が401を返す。いずれも内容は返さない。
    expect([302, 401, 403]).toContain(response.status);

    if (response.status !== 401) {
      return;
    }

    // 401のときはWorkerが返した案内画面。アーティファクト名が載っていないことを
    // 見る(共通スタイルにCSSクラス名が含まれるため、クラス名では判定できない)。
    const html = await response.text();
    for (const name of [publicName, privateName]) {
      if (name !== undefined) {
        expect(html).not.toContain(name);
      }
    }
  });

  it("管理APIも未認証に一覧を返さない (FR-020)", async () => {
    const response = await fetch(`${remote}/_app/api/artifacts`, {
      headers: { Accept: "application/json" },
      redirect: "manual",
    });

    expect(response.status).not.toBe(200);
  });

  it.skipIf(uid === undefined)("存在しないアーティファクトは404を返す", async () => {
    const response = await fetch(`${remote}/${uid}/nonexistent-by-e2e.html`);

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it.skipIf(uid === undefined || privateName === undefined)(
    "非公開と不存在の応答が見分けられない (FR-017, FR-024)",
    async () => {
      const privateOne = await fetch(`${remote}/${uid}/${privateName}`);
      const absent = await fetch(`${remote}/${uid}/nonexistent-by-e2e.html`);

      expect(privateOne.status).toBe(404);
      expect(await privateOne.text()).toBe(await absent.text());
      expect(stableHeaders(privateOne)).toEqual(stableHeaders(absent));
    },
  );

  it.skipIf(uid === undefined || publicName === undefined)(
    "公開アーティファクトは未認証でも配信され、sandboxが効く (FR-026, FR-028)",
    async () => {
      const response = await fetch(`${remote}/${uid}/${publicName}`);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-security-policy")).toBe(
        "sandbox allow-scripts allow-popups allow-forms allow-modals",
      );
      expect(await response.text()).toContain("<");
    },
  );
});
