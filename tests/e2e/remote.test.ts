import { beforeAll, describe, expect, it } from "vitest";

/**
 * デプロイ済み環境に対する未認証からのスモークテスト。
 *
 * ローカルのE2E(journeys.test.ts)はWorkerの振る舞いを網羅するが、実際にデプロイ
 * された環境で保護境界が期待どおりかまでは分からない。ここはその確認に限る。
 *
 * Accessの掛け方によって「正しい状態」が変わるため、まず境界の形を観測してから
 * 期待値を選ぶ。
 *
 * - `host`: workers.dev の One-click Access。ホスト全体が保護され、アーティファクト
 *   の配信パスも未認証では到達できない。公開アーティファクト(FR-026)は成立しない
 * - `path`: カスタムドメインで `/_app` と `/_auth` だけを保護した状態。契約
 *   (contracts/http-api.md)どおりの境界で、公開アーティファクトが未認証で読める
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

type Boundary = "host" | "path";

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

/** Accessのログイン画面へ送られているか */
const goesToAccessLogin = (response: Response): boolean =>
  response.status === 302 &&
  (response.headers.get("Location") ?? "").includes("cloudflareaccess.com");

describe.skipIf(baseUrl === undefined)("デプロイ済み環境 (未認証)", () => {
  const remote = baseUrl as string;
  let boundary: Boundary;

  beforeAll(async () => {
    // 配信パスがAccessに捕まるかどうかで境界の形が分かる。存在しない名前を使う
    // ので、どちらの形でもデータには触れない。
    const probe = await fetch(`${remote}/${uid ?? "0000000000"}/probe-by-e2e.html`, {
      redirect: "manual",
    });
    boundary = goesToAccessLogin(probe) ? "host" : "path";
    console.info(`[remote] protection boundary: ${boundary}`);
  });

  it("管理画面は未認証に内容を返さない (FR-020)", async () => {
    const response = await fetch(`${remote}/_app/`, {
      headers: { Accept: "text/html" },
      redirect: "manual",
    });

    // Accessが前段にあればログイン画面へのリダイレクト、無ければWorkerの401。
    expect([302, 401, 403]).toContain(response.status);

    if (response.status !== 401) {
      return;
    }

    // Workerが返した案内画面。アーティファクト名が載っていないことを見る
    // (共通スタイルにCSSクラス名が含まれるため、クラス名では判定できない)。
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

  it("ルートは入口として機能する", async () => {
    const response = await fetch(`${remote}/`, { redirect: "manual" });

    expect(response.status).toBe(302);
    const location = response.headers.get("Location") ?? "";

    // ホスト全体が保護されている場合はAccessのログインが先に立つ。
    expect(boundary === "host" ? location.includes("cloudflareaccess.com") : location).toBe(
      boundary === "host" ? true : "/_app/",
    );
  });

  it.skipIf(uid === undefined)("配信パスの扱いが境界の形と一致する", async () => {
    const response = await fetch(`${remote}/${uid}/nonexistent-by-e2e.html`, {
      redirect: "manual",
    });

    if (boundary === "host") {
      // ホスト全体が保護されているため、Workerまで到達しない。この構成では
      // 公開アーティファクト(FR-026)が成立しない。
      expect(goesToAccessLogin(response)).toBe(true);
      return;
    }

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it.skipIf(uid === undefined || privateName === undefined)(
    "非公開と不存在の応答が見分けられない (FR-017, FR-024)",
    async ({ skip }) => {
      skip(boundary === "host", "ホスト全体が保護されており、Workerまで到達しない");

      const privateOne = await fetch(`${remote}/${uid}/${privateName}`);
      const absent = await fetch(`${remote}/${uid}/nonexistent-by-e2e.html`);

      expect(privateOne.status).toBe(404);
      expect(await privateOne.text()).toBe(await absent.text());
      expect(stableHeaders(privateOne)).toEqual(stableHeaders(absent));
    },
  );

  it.skipIf(uid === undefined || publicName === undefined)(
    "公開アーティファクトは未認証でも配信され、sandboxが効く (FR-026, FR-028)",
    async ({ skip }) => {
      skip(
        boundary === "host",
        "workers.dev の One-click Access はホスト全体を保護するため、公開配信はカスタムドメインが必要",
      );

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
