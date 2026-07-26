import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { insertArtifact, insertUser, updateVisibility } from "../../src/db";

/**
 * `GET /_auth/view` — the Access-protected owner view (T018).
 *
 * ENVIRONMENT is "test" here, so the requester is always DEV_OWNER_EMAIL, i.e.
 * OWNER_UID. That is the same position a real request is in after Access has
 * verified the identity, which is what this endpoint assumes.
 */

const OWNER_UID = "aaaaaaaaaa";
const OTHER_UID = "bbbbbbbbbb";
const ORIGIN = "https://artifacts.example.test";

const PRIVATE_HTML = "<!doctype html><html><body>OWNER ONLY</body></html>";

const db = env.DB;

const worker = (exports as unknown as {
  default: { fetch: (request: Request) => Promise<Response> };
}).default;

const viewRequest = (target: string | null): Request =>
  new Request(
    target === null
      ? `${ORIGIN}/_auth/view`
      : `${ORIGIN}/_auth/view?target=${encodeURIComponent(target)}`,
  );

beforeEach(async () => {
  await db.batch([db.prepare("DELETE FROM artifacts"), db.prepare("DELETE FROM users")]);
  await insertUser(db, OWNER_UID, "owner@example.test", "2026-07-01T00:00:00.000Z");
  await insertUser(db, OTHER_UID, "other@example.test", "2026-07-01T00:00:00.000Z");

  await insertArtifact(db, OWNER_UID, "report.html", PRIVATE_HTML.length, "2026-07-02T00:00:00.000Z");
  await env.ARTIFACTS.put(`${OWNER_UID}/report.html`, PRIVATE_HTML);

  await insertArtifact(db, OTHER_UID, "report.html", 10, "2026-07-02T00:00:00.000Z");
  await env.ARTIFACTS.put(`${OTHER_UID}/report.html`, "<!doctype html><html></html>");
});

describe("所有者は自分の非公開アーティファクトを開ける", () => {
  it("本文をそのまま返す", async () => {
    const response = await worker.fetch(viewRequest(`/${OWNER_UID}/report.html`));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(PRIVATE_HTML);
  });

  it("アーティファクト配信と同じヘッダを付ける (FR-028)", async () => {
    const response = await worker.fetch(viewRequest(`/${OWNER_UID}/report.html`));

    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Security-Policy")).toContain("sandbox");
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  });

  it("パーセントエンコードされた名前も解決する", async () => {
    await insertArtifact(db, OWNER_UID, "a-b_c.html", 5, "2026-07-03T00:00:00.000Z");
    await env.ARTIFACTS.put(`${OWNER_UID}/a-b_c.html`, "<html></html>");

    const response = await worker.fetch(viewRequest(`/${OWNER_UID}/${encodeURIComponent("a-b_c.html")}`));

    expect(response.status).toBe(200);
  });
});

describe("それ以外はすべて404で揃える (FR-017, FR-024)", () => {
  const cases: ReadonlyArray<{ label: string; target: string | null }> = [
    { label: "target が無い", target: null },
    { label: "他uidのアーティファクト", target: `/${OTHER_UID}/report.html` },
    { label: "存在しない名前", target: `/${OWNER_UID}/nonexistent.html` },
    { label: "uid の形式が不正", target: "/SHORT/report.html" },
    { label: "名前の形式が不正", target: `/${OWNER_UID}/report.txt` },
    { label: "パストラバーサル", target: `/${OWNER_UID}/../${OTHER_UID}/report.html` },
    { label: "プロトコル相対URL", target: "//evil.example.com/steal.html" },
    { label: "スキーム付きURL", target: "https://evil.example.com/steal.html" },
    { label: "階層が深すぎる", target: `/${OWNER_UID}/sub/report.html` },
    { label: "空文字", target: "" },
  ];

  for (const { label, target } of cases) {
    it(`${label} は404になる`, async () => {
      const response = await worker.fetch(viewRequest(target));

      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("OWNER ONLY");
    });
  }

  it("404の応答は配信パスの404と完全に一致する", async () => {
    const viaOwnerView = await worker.fetch(viewRequest(`/${OWNER_UID}/nonexistent.html`));
    const viaDelivery = await worker.fetch(new Request(`${ORIGIN}/${OWNER_UID}/nonexistent.html`));

    expect(viaOwnerView.status).toBe(viaDelivery.status);
    expect(await viaOwnerView.text()).toBe(await viaDelivery.text());
    expect([...viaOwnerView.headers].sort()).toEqual([...viaDelivery.headers].sort());
  });

  it("公開アーティファクトでも所有者以外には404を返す", async () => {
    await updateVisibility(db, OTHER_UID, "report.html", "public", "2026-07-04T00:00:00.000Z");

    const response = await worker.fetch(viewRequest(`/${OTHER_UID}/report.html`));

    // 公開物は正規URLで読めるため、この経路は所有者専用のままにしている。
    expect(response.status).toBe(404);
  });
});
