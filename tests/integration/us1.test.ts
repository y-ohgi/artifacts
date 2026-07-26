import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { insertUser } from "../../src/db";
import { MAX_SIZE_BYTES } from "../../src/artifacts/upload";

const db = env.DB;

/** Matches DEV_OWNER_EMAIL in vitest.config.ts, so resolveOwner maps to OWNER_UID. */
const OWNER_EMAIL = "owner@example.test";
const OWNER_UID = "aaaaaaaaaa";
const OTHER_UID = "bbbbbbbbbb";

const ORIGIN = "https://artifacts.example.test";

/**
 * `exports.default` is the Worker under test (equivalent to the deprecated
 * `SELF` from "cloudflare:test"). The `Exports` type does not describe the
 * default entrypoint, so the shape is asserted here.
 */
const worker = (exports as unknown as {
  default: { fetch: (request: Request) => Promise<Response> };
}).default;

/**
 * 0.18 does not roll storage back between tests, so the tables are cleared
 * explicitly. Deletion order follows the foreign key direction.
 */
beforeEach(async () => {
  await db.batch([db.prepare("DELETE FROM artifacts"), db.prepare("DELETE FROM users")]);
  await insertUser(db, OWNER_UID, OWNER_EMAIL, "2026-07-01T00:00:00.000Z");
  await insertUser(db, OTHER_UID, "other@example.test", "2026-07-01T00:00:00.000Z");
  await env.ARTIFACTS.delete([`${OWNER_UID}/report.html`, `${OTHER_UID}/report.html`]);
});

function uploadRequest(fileName: string, body: string, options: { name?: string; type?: string } = {}) {
  const form = new FormData();
  form.set("file", new File([body], fileName, { type: options.type ?? "text/html" }));
  if (options.name !== undefined) {
    form.set("name", options.name);
  }

  return new Request(`${ORIGIN}/_app/api/artifacts`, {
    method: "POST",
    headers: { Accept: "application/json", "Sec-Fetch-Site": "same-origin" },
    body: form,
  });
}

const HTML = "<!doctype html><html><body><h1>VERSION-1</h1></body></html>";

describe("US1: アップロードして閲覧する", () => {
  it("アップロードが 201 を返し、既定で非公開、閲覧URLが /<uid>/<name> の形になる (FR-010, FR-022)", async () => {
    const response = await worker.fetch(uploadRequest("report.html", HTML));

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      artifact: { uid: string; name: string; size: number; visibility: string; url: string };
    };
    expect(body.artifact.visibility).toBe("private");
    expect(body.artifact.name).toBe("report.html");
    expect(body.artifact.size).toBe(new TextEncoder().encode(HTML).byteLength);
    expect(body.artifact.url).toBe(`${ORIGIN}/${OWNER_UID}/report.html`);
  });

  it("所有者はアップロードしたバイト列と1バイトも違わない本文を取得できる (FR-012, SC-008)", async () => {
    await worker.fetch(uploadRequest("report.html", HTML));

    const response = await worker.fetch(new Request(`${ORIGIN}/${OWNER_UID}/report.html`));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(HTML);
  });

  it("アーティファクト応答に no-store と CSP sandbox が付く (FR-028)", async () => {
    await worker.fetch(uploadRequest("report.html", HTML));

    const response = await worker.fetch(new Request(`${ORIGIN}/${OWNER_UID}/report.html`));

    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const csp = response.headers.get("Content-Security-Policy") ?? "";
    expect(csp.startsWith("sandbox")).toBe(true);
    expect(csp).toContain("allow-scripts");
  });

  it("トップページは /_app/ へリダイレクトする", async () => {
    const response = await worker.fetch(new Request(ORIGIN, { redirect: "manual" }));

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/_app/");
  });
});

describe("US1: 受け付けない入力", () => {
  it("HTML以外の拡張子を拒否する (FR-002)", async () => {
    const response = await worker.fetch(uploadRequest("notes.txt", HTML, { type: "text/plain" }));

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("not_html");
  });

  it("拡張子はHTMLだが中身がHTMLでないファイルを拒否する (FR-002)", async () => {
    const response = await worker.fetch(uploadRequest("data.html", '{"not":"html"}'));

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("not_html");
  });

  it("上限サイズを超えるファイルを上限値とともに拒否する (FR-003)", async () => {
    const oversized = `<!doctype html>${"x".repeat(MAX_SIZE_BYTES)}`;
    const response = await worker.fetch(uploadRequest("big.html", oversized));

    expect(response.status).toBe(413);
    const body = (await response.json()) as { error: { code: string; details?: { limitBytes?: number } } };
    expect(body.error.code).toBe("too_large");
    expect(body.error.details?.limitBytes).toBe(MAX_SIZE_BYTES);
  });

  it("使用できない名前を、使用可能な文字種の説明とともに拒否する (FR-006)", async () => {
    const response = await worker.fetch(uploadRequest("report.html", HTML, { name: "my report.html" }));

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; details?: { allowed?: string } } };
    expect(body.error.code).toBe("invalid_name");
    expect(typeof body.error.details?.allowed).toBe("string");
  });

  it("パストラバーサル形の名前を拒否する", async () => {
    const response = await worker.fetch(uploadRequest("report.html", HTML, { name: "../evil.html" }));

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("invalid_name");
  });
});

describe("名前の衝突で既存アーティファクトが失われない (FR-008, SC-002)", () => {
  it("2回目の同名アップロードは 409 になり、1回目の本文が変化しない", async () => {
    const first = await worker.fetch(uploadRequest("report.html", HTML));
    expect(first.status).toBe(201);

    const second = await worker.fetch(
      uploadRequest("report.html", "<!doctype html><html><body>VERSION-2</body></html>"),
    );
    expect(second.status).toBe(409);
    expect(await errorCode(second)).toBe("name_conflict");

    // 書き込み順を D1 → R2 にしている理由がここ。逆順だと R2 の put が先に成功し、
    // D1 の衝突で失敗した時点で既存の本体が上書きされたまま残る。
    const served = await worker.fetch(new Request(`${ORIGIN}/${OWNER_UID}/report.html`));
    expect(await served.text()).toBe(HTML);
  });

  it("409 の details.suggestions が実際に未使用の名前である (FR-007)", async () => {
    await worker.fetch(uploadRequest("report.html", HTML));
    // 1つ目の候補も埋めておき、候補生成が使用済みを飛ばすことまで確認する。
    await worker.fetch(uploadRequest("report.html", HTML, { name: "report-2.html" }));

    const conflict = await worker.fetch(uploadRequest("report.html", HTML));
    expect(conflict.status).toBe(409);

    const body = (await conflict.json()) as {
      error: { code: string; details?: { suggestions?: string[] } };
    };
    const suggestions = body.error.details?.suggestions ?? [];

    expect(body.error.code).toBe("name_conflict");
    expect(suggestions).not.toHaveLength(0);
    expect(suggestions).not.toContain("report-2.html");

    // 「未使用である」ことは、その名前でのアップロードが 201 になることで示す。
    for (const suggestion of suggestions) {
      const accepted = await worker.fetch(uploadRequest("report.html", HTML, { name: suggestion }));
      expect(accepted.status).toBe(201);
    }
  });
});

describe("非公開アーティファクトは存在を漏らさない (FR-017, FR-023, FR-024)", () => {
  it("他uidの非公開アーティファクトへのアクセスと、存在しないアーティファクトへのアクセスの応答が完全に同一", async () => {
    // 所有者以外の名前空間に、直接データを用意する。
    await db
      .prepare(
        "INSERT INTO artifacts (uid, name, size, uploaded_at) VALUES (?, ?, ?, ?)",
      )
      .bind(OTHER_UID, "report.html", HTML.length, "2026-07-10T00:00:00.000Z")
      .run();
    await env.ARTIFACTS.put(`${OTHER_UID}/report.html`, HTML);

    const foreign = await worker.fetch(new Request(`${ORIGIN}/${OTHER_UID}/report.html`));
    const absent = await worker.fetch(new Request(`${ORIGIN}/${OTHER_UID}/nonexistent.html`));

    expect(foreign.status).toBe(404);
    expect(absent.status).toBe(404);
    expect(await foreign.text()).toBe(await absent.text());
    expect([...foreign.headers].sort()).toEqual([...absent.headers].sort());
  });

  it("uid の形式が不正な場合も同じ 404 を返す", async () => {
    const response = await worker.fetch(new Request(`${ORIGIN}/SHORT/report.html`));

    expect(response.status).toBe(404);
  });
});

describe("US2: 一覧", () => {
  it("自分のuidの分だけをアップロード日時の降順で返す (FR-015, FR-038)", async () => {
    await db.batch([
      db
        .prepare("INSERT INTO artifacts (uid, name, size, uploaded_at) VALUES (?, ?, ?, ?)")
        .bind(OWNER_UID, "old.html", 10, "2026-07-01T00:00:00.000Z"),
      db
        .prepare("INSERT INTO artifacts (uid, name, size, uploaded_at) VALUES (?, ?, ?, ?)")
        .bind(OWNER_UID, "new.html", 10, "2026-07-20T00:00:00.000Z"),
      db
        .prepare("INSERT INTO artifacts (uid, name, size, uploaded_at) VALUES (?, ?, ?, ?)")
        .bind(OTHER_UID, "theirs.html", 10, "2026-07-25T00:00:00.000Z"),
    ]);

    const response = await worker.fetch(
      new Request(`${ORIGIN}/_app/api/artifacts`, { headers: { Accept: "application/json" } }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { artifacts: { name: string }[] };
    expect(body.artifacts.map((a) => a.name)).toEqual(["new.html", "old.html"]);
  });

  it("0件のとき空状態の案内を返す (FR-016)", async () => {
    const response = await worker.fetch(new Request(`${ORIGIN}/_app/`));

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("アップロード");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("一覧画面のヘッダにアップロードとログアウトが常にある (FR-018, FR-019)", async () => {
    const html = await (await worker.fetch(new Request(`${ORIGIN}/_app/`))).text();

    expect(html).toContain("/_app/upload");
    expect(html).toContain("/cdn-cgi/access/logout");
  });
});

async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error: { code: string } };
  return body.error.code;
}
