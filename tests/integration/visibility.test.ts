import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { findArtifact, insertArtifact, insertUser, updateVisibility } from "../../src/db";

/**
 * 公開切替と配信の分岐(T046〜T049)。
 *
 * 「未認証」は DEV_OWNER_EMAIL を一時的に外して再現する。テスト環境では
 * resolveOwner が常にこの値を所有者として返すため、外すと本番で認証情報が
 * 無い状態と同じ「所有者が解決できないリクエスト」になる。
 */

const OWNER_UID = "aaaaaaaaaa";
const OTHER_UID = "bbbbbbbbbb";
const OWNER_EMAIL = "owner@example.test";

const ORIGIN = "https://artifacts.example.test";
const HTML = "<!doctype html><html><body>PUBLISHED</body></html>";

const db = env.DB;

const worker = (exports as unknown as {
  default: { fetch: (request: Request) => Promise<Response> };
}).default;

const mutableEnv = env as unknown as Record<string, string | undefined>;
const ownerEmail = mutableEnv["DEV_OWNER_EMAIL"];

/** Runs `body` as a requester whose identity cannot be resolved. */
async function asUnauthenticated<T>(body: () => Promise<T>): Promise<T> {
  mutableEnv["DEV_OWNER_EMAIL"] = undefined;
  try {
    return await body();
  } finally {
    mutableEnv["DEV_OWNER_EMAIL"] = ownerEmail;
  }
}

const artifactRequest = (uid: string, name: string): Request =>
  new Request(`${ORIGIN}/${uid}/${name}`);

const toggleRequest = (name: string, visibility: string): Request =>
  new Request(`${ORIGIN}/_app/api/artifacts/${encodeURIComponent(name)}/visibility`, {
    method: "PUT",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "Sec-Fetch-Site": "same-origin",
    },
    body: JSON.stringify({ visibility }),
  });

type ToggleBody = { artifact: { name: string; visibility: string; url: string } };

beforeEach(async () => {
  await db.batch([db.prepare("DELETE FROM artifacts"), db.prepare("DELETE FROM users")]);
  await insertUser(db, OWNER_UID, OWNER_EMAIL, "2026-07-01T00:00:00.000Z");
  await insertUser(db, OTHER_UID, "other@example.test", "2026-07-01T00:00:00.000Z");

  await insertArtifact(db, OWNER_UID, "report.html", HTML.length, "2026-07-02T00:00:00.000Z");
  await env.ARTIFACTS.put(`${OWNER_UID}/report.html`, HTML);

  await insertArtifact(db, OTHER_UID, "theirs.html", HTML.length, "2026-07-02T00:00:00.000Z");
  await env.ARTIFACTS.put(`${OTHER_UID}/theirs.html`, HTML);
});

afterEach(() => {
  mutableEnv["DEV_OWNER_EMAIL"] = ownerEmail;
});

describe("公開状態の双方向トグル (T046, FR-025〜FR-028, FR-030)", () => {
  it("private → public → private を切り替えられ、URLは変化しない", async () => {
    const toPublic = await worker.fetch(toggleRequest("report.html", "public"));
    expect(toPublic.status).toBe(200);
    const published = (await toPublic.json()) as ToggleBody;
    expect(published.artifact.visibility).toBe("public");

    const toPrivate = await worker.fetch(toggleRequest("report.html", "private"));
    expect(toPrivate.status).toBe(200);
    const unpublished = (await toPrivate.json()) as ToggleBody;
    expect(unpublished.artifact.visibility).toBe("private");

    // FR-030: 公開状態を変えても閲覧URLは同じでなければならない。
    expect(unpublished.artifact.url).toBe(published.artifact.url);
    expect(published.artifact.url).toBe(`${ORIGIN}/${OWNER_UID}/report.html`);
  });

  it("公開にした直後は未認証でも本文が返る (FR-026)", async () => {
    await worker.fetch(toggleRequest("report.html", "public"));

    const response = await asUnauthenticated(() =>
      worker.fetch(artifactRequest(OWNER_UID, "report.html")),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(HTML);
  });

  it("非公開へ戻した直後は未認証で404になる (FR-027, SC-006)", async () => {
    await worker.fetch(toggleRequest("report.html", "public"));
    await worker.fetch(toggleRequest("report.html", "private"));

    const response = await asUnauthenticated(() =>
      worker.fetch(artifactRequest(OWNER_UID, "report.html")),
    );

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("PUBLISHED");
  });

  it("visibility_changed_at を記録する (FR-025)", async () => {
    const before = await findArtifact(db, OWNER_UID, "report.html");
    expect(before?.visibility_changed_at).toBeNull();

    await worker.fetch(toggleRequest("report.html", "public"));

    const after = await findArtifact(db, OWNER_UID, "report.html");
    expect(after?.visibility_changed_at).not.toBeNull();
  });

  it("public / private 以外の値は 400 invalid_visibility になる", async () => {
    const response = await worker.fetch(toggleRequest("report.html", "world-readable"));

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_visibility");

    const unchanged = await findArtifact(db, OWNER_UID, "report.html");
    expect(unchanged?.visibility).toBe("private");
  });
});

describe("存在を漏らさない404 (T047, FR-017, FR-024)", () => {
  it("4つの分岐すべてがステータス・本文・ヘッダまで同一", async () => {
    const responses = await asUnauthenticated(async () => [
      // 非公開かつ非所有者
      await worker.fetch(artifactRequest(OWNER_UID, "report.html")),
      // 行が無い
      await worker.fetch(artifactRequest(OWNER_UID, "nonexistent.html")),
      // uid の形式が不正
      await worker.fetch(artifactRequest("SHORT", "report.html")),
      // name の形式が不正
      await worker.fetch(artifactRequest(OWNER_UID, "report.txt")),
    ]);

    const [first, ...rest] = responses;
    const expected = {
      status: first?.status,
      body: await first?.text(),
      headers: [...(first?.headers ?? [])].sort(),
    };

    expect(expected.status).toBe(404);
    for (const response of rest) {
      expect(response.status).toBe(expected.status);
      expect(await response.text()).toBe(expected.body);
      expect([...response.headers].sort()).toEqual(expected.headers);
    }
  });

  it("Content-Length も一致する", async () => {
    const [privateOne, absent] = await asUnauthenticated(async () => [
      await worker.fetch(artifactRequest(OWNER_UID, "report.html")),
      await worker.fetch(artifactRequest(OWNER_UID, "nonexistent.html")),
    ]);

    // 本文が固定なので長さも一致する。ヘッダに出ない場合も本文長で確認する。
    expect((await privateOne?.text())?.length).toBe((await absent?.text())?.length);
  });
});

describe("配信ヘッダ (T048, FR-028)", () => {
  const expectArtifactHeaders = (response: Response): void => {
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Security-Policy")).toBe(
      "sandbox allow-scripts allow-popups allow-forms allow-modals",
    );
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  };

  it("非公開アーティファクトを所有者へ返すとき", async () => {
    const response = await worker.fetch(artifactRequest(OWNER_UID, "report.html"));

    expect(response.status).toBe(200);
    expectArtifactHeaders(response);
  });

  it("公開アーティファクトを未認証へ返すとき", async () => {
    await worker.fetch(toggleRequest("report.html", "public"));

    const response = await asUnauthenticated(() =>
      worker.fetch(artifactRequest(OWNER_UID, "report.html")),
    );

    expect(response.status).toBe(200);
    expectArtifactHeaders(response);
  });

  it("404 のときも同じプロファイルを使う", async () => {
    const response = await worker.fetch(artifactRequest(OWNER_UID, "nonexistent.html"));

    expect(response.status).toBe(404);
    expectArtifactHeaders(response);
  });
});

describe("他人の名前空間は操作できない (T049, FR-031, FR-038)", () => {
  it("他uidのアーティファクト名を指定したトグルは404になり、対象は変化しない", async () => {
    const response = await worker.fetch(toggleRequest("theirs.html", "public"));

    expect(response.status).toBe(404);

    const target = await findArtifact(db, OTHER_UID, "theirs.html");
    expect(target?.visibility).toBe("private");
    expect(target?.visibility_changed_at).toBeNull();
  });

  it("他uidの公開アーティファクトを非公開へ戻すこともできない", async () => {
    await updateVisibility(db, OTHER_UID, "theirs.html", "public", "2026-07-03T00:00:00.000Z");

    const response = await worker.fetch(toggleRequest("theirs.html", "private"));

    expect(response.status).toBe(404);

    const target = await findArtifact(db, OTHER_UID, "theirs.html");
    expect(target?.visibility).toBe("public");
  });

  it("クロスオリジンからの操作は 403 cross_origin になる", async () => {
    const request = new Request(
      `${ORIGIN}/_app/api/artifacts/report.html/visibility`,
      {
        method: "PUT",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Sec-Fetch-Site": "cross-site",
        },
        body: JSON.stringify({ visibility: "public" }),
      },
    );

    const response = await worker.fetch(request);

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("cross_origin");

    const unchanged = await findArtifact(db, OWNER_UID, "report.html");
    expect(unchanged?.visibility).toBe("private");
  });
});
