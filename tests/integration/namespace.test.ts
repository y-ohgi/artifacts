import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { insertArtifact, insertUser, updateVisibility } from "../../src/db";

/**
 * uid ごとの名前空間(T057, FR-038, FR-039)。
 *
 * 所有者は常に OWNER_UID(テスト環境の DEV_OWNER_EMAIL)。OTHER_UID の側は
 * D1 と R2 へ直接用意し、「2人目の利用者が既にいる」状態を作る。
 */

const OWNER_UID = "aaaaaaaaaa";
const OTHER_UID = "bbbbbbbbbb";
const ORIGIN = "https://artifacts.example.test";

const OWNER_HTML = "<!doctype html><html><body>OWNER COPY</body></html>";
const OTHER_HTML = "<!doctype html><html><body>OTHER COPY</body></html>";

const db = env.DB;

const worker = (exports as unknown as {
  default: { fetch: (request: Request) => Promise<Response> };
}).default;

function uploadRequest(name: string, body: string): Request {
  const form = new FormData();
  form.set("file", new File([body], name, { type: "text/html" }));
  form.set("name", name);

  return new Request(`${ORIGIN}/_app/api/artifacts`, {
    method: "POST",
    headers: { Accept: "application/json", "Sec-Fetch-Site": "same-origin" },
    body: form,
  });
}

beforeEach(async () => {
  await db.batch([db.prepare("DELETE FROM artifacts"), db.prepare("DELETE FROM users")]);
  await insertUser(db, OWNER_UID, "owner@example.test", "2026-07-01T00:00:00.000Z");
  await insertUser(db, OTHER_UID, "other@example.test", "2026-07-01T00:00:00.000Z");

  // 2人目の利用者が同じ名前のアーティファクトを既に持っている状態。
  await insertArtifact(db, OTHER_UID, "report.html", OTHER_HTML.length, "2026-07-05T00:00:00.000Z");
  await env.ARTIFACTS.put(`${OTHER_UID}/report.html`, OTHER_HTML);
});

describe("同じ名前が別のuidで共存できる (FR-039)", () => {
  it("他uidに同名があってもアップロードは成功する", async () => {
    const response = await worker.fetch(uploadRequest("report.html", OWNER_HTML));

    expect(response.status).toBe(201);
  });

  it("それぞれのURLがそれぞれの内容を返す", async () => {
    await worker.fetch(uploadRequest("report.html", OWNER_HTML));
    // 相手側は公開にしておき、両方が読める状態で内容を比べる。
    await updateVisibility(db, OTHER_UID, "report.html", "public", "2026-07-06T00:00:00.000Z");

    const mine = await worker.fetch(new Request(`${ORIGIN}/${OWNER_UID}/report.html`));
    const theirs = await worker.fetch(new Request(`${ORIGIN}/${OTHER_UID}/report.html`));

    expect(await mine.text()).toBe(OWNER_HTML);
    expect(await theirs.text()).toBe(OTHER_HTML);
  });

  it("片方を消しても他方は残る", async () => {
    await worker.fetch(uploadRequest("report.html", OWNER_HTML));

    await db.prepare("DELETE FROM artifacts WHERE uid = ? AND name = ?").bind(OWNER_UID, "report.html").run();

    await updateVisibility(db, OTHER_UID, "report.html", "public", "2026-07-06T00:00:00.000Z");
    const theirs = await worker.fetch(new Request(`${ORIGIN}/${OTHER_UID}/report.html`));

    expect(theirs.status).toBe(200);
    expect(await theirs.text()).toBe(OTHER_HTML);
  });
});

describe("一覧は自分のuidの分だけを返す (FR-038)", () => {
  it("他uidのアーティファクトは含まれない", async () => {
    await worker.fetch(uploadRequest("mine.html", OWNER_HTML));

    const response = await worker.fetch(
      new Request(`${ORIGIN}/_app/api/artifacts`, { headers: { Accept: "application/json" } }),
    );
    const body = (await response.json()) as { artifacts: { name: string; url: string }[] };

    expect(body.artifacts.map((item) => item.name)).toEqual(["mine.html"]);
    for (const item of body.artifacts) {
      expect(item.url).toContain(`/${OWNER_UID}/`);
      expect(item.url).not.toContain(OTHER_UID);
    }
  });

  it("一覧のURLは自分のuid配下に閉じている", async () => {
    await worker.fetch(uploadRequest("report.html", OWNER_HTML));

    const response = await worker.fetch(new Request(`${ORIGIN}/_app/`));
    const html = await response.text();

    expect(html).toContain(`/${OWNER_UID}/report.html`);
    expect(html).not.toContain(OTHER_UID);
  });

  it("uidはクエリパラメータで上書きできない (FR-038)", async () => {
    const response = await worker.fetch(
      new Request(`${ORIGIN}/_app/api/artifacts?uid=${OTHER_UID}`, {
        headers: { Accept: "application/json" },
      }),
    );
    const body = (await response.json()) as { artifacts: { url: string }[] };

    // 相手の1件が見えていないこと。自分のuidには何も無いので空になる。
    expect(body.artifacts).toEqual([]);
  });
});
