import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { insertArtifact, insertUser } from "../../src/db";
import { ADMIN_RESPONSE_HEADERS } from "../../src/headers";
import { APP_CSS, STYLESHEET_PATH } from "../../src/views/styles";

/**
 * 管理画面のCSPと、実際に返るHTMLの整合(#8)。
 *
 * tests/unit/headers.test.ts はヘッダの値だけを見ているので、「そのCSPのもとで
 * ページが本当に描画できるのか」は誰も見ていなかった。CSPは
 * `default-src 'self'` で `style-src` を持たず、インラインの `<style>` は
 * ブラウザに拒否される。ヘッダも画面もそれ単体では正しく見えるのに、組み合わせ
 * だけが壊れる ―― その組み合わせをここで検証する。
 *
 * 検査は「CSPをパースして、そのCSPが禁じているものがHTMLに無いこと」を確かめる
 * 形にしてある。CSPを緩めても厳しくしても、テストは新しいCSPを基準に判定する。
 */

const OWNER_EMAIL = "owner@example.test";
const OWNER_UID = "aaaaaaaaaa";
const ORIGIN = "https://artifacts.example.test";

const db = env.DB;

const worker = (exports as unknown as {
  default: { fetch: (request: Request) => Promise<Response> };
}).default;

beforeEach(async () => {
  await db.batch([db.prepare("DELETE FROM artifacts"), db.prepare("DELETE FROM users")]);
  await insertUser(db, OWNER_UID, OWNER_EMAIL, "2026-07-01T00:00:00.000Z");
});

const get = async (path: string): Promise<Response> =>
  await worker.fetch(new Request(`${ORIGIN}${path}`));

/** `name` に効くソースリスト。未指定のディレクティブは `default-src` へ落ちる。 */
function sources(csp: string, name: string): string[] {
  const directives = new Map(
    csp
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part !== "")
      .map((part) => {
        const [directive, ...values] = part.split(/\s+/);
        return [directive, values] as const;
      }),
  );

  return [...(directives.get(name) ?? directives.get("default-src") ?? [])];
}

/** ページが読み込む外部スタイルシートの `href`。 */
function stylesheetHrefs(html: string): string[] {
  return [...html.matchAll(/<link\b[^>]*>/g)]
    .filter((tag) => /rel="stylesheet"/.test(tag[0]))
    .map((tag) => /href="([^"]*)"/.exec(tag[0])?.[1] ?? "");
}

/** 管理画面として想定しているすべての応答。エラー画面も装飾の対象に含む。 */
async function adminPages(): Promise<{ label: string; html: string }[]> {
  // 空状態ではなく、テーブル・バッジ・切り替えフォームが出る状態で見る。
  await insertArtifact(db, OWNER_UID, "report.html", 1024, "2026-07-20T00:00:00.000Z");

  const list = await get("/_app/");
  const upload = await get("/_app/upload");

  // uid未発行の利用者に返る通知画面。ここも同じレイアウトで描画される。
  await db.batch([db.prepare("DELETE FROM artifacts"), db.prepare("DELETE FROM users")]);
  const notice = await get("/_app/");

  expect(list.status).toBe(200);
  expect(upload.status).toBe(200);
  expect(notice.status).toBe(403);

  return [
    { label: "一覧", html: await list.text() },
    { label: "アップロード", html: await upload.text() },
    { label: "通知(uid未発行)", html: await notice.text() },
  ];
}

describe("管理画面のCSPとスタイルの整合 (#8)", () => {
  it("CSPはインラインのスタイルもスクリプトも許可しない", () => {
    const csp = ADMIN_RESPONSE_HEADERS["Content-Security-Policy"];

    expect(sources(csp, "style-src")).not.toContain("'unsafe-inline'");
    expect(sources(csp, "script-src")).not.toContain("'unsafe-inline'");
    expect(csp).not.toContain("unsafe-inline");
  });

  it("CSPが拒否するインラインのスタイル・スクリプトがHTMLに含まれない", async () => {
    for (const page of await adminPages()) {
      expect(page.html, page.label).not.toContain("<style");
      expect(page.html, page.label).not.toMatch(/\sstyle="/);
      expect(page.html, page.label).not.toContain("<script");
      expect(page.html, page.label).not.toMatch(/\son[a-z]+="/);
    }
  });

  it("各画面が 'self' で解決できるスタイルシートを読み込む", async () => {
    for (const page of await adminPages()) {
      const hrefs = stylesheetHrefs(page.html);
      expect(hrefs, page.label).not.toHaveLength(0);

      for (const href of hrefs) {
        // ルート相対なら同一オリジンに解決されるので `'self'` を満たす。
        expect(href, page.label).toMatch(/^\//);

        const response = await get(href);
        expect(response.status, `${page.label}: ${href}`).toBe(200);
        expect(response.headers.get("Content-Type")).toContain("text/css");
        expect((await response.text()).length).toBeGreaterThan(0);
      }
    }
  });
});

describe("スタイルシートの配信", () => {
  it("CSS本文をそのまま text/css で返す", async () => {
    const response = await get(STYLESHEET_PATH);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/css; charset=utf-8");
    expect(await response.text()).toBe(APP_CSS);
  });

  it("認証情報がなくても管理画面と同じセキュリティヘッダが付く", async () => {
    const response = await get(STYLESHEET_PATH);

    expect(response.headers.get("Content-Security-Policy")).toBe(
      ADMIN_RESPONSE_HEADERS["Content-Security-Policy"],
    );
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  it("内容ハッシュ付きのパスなので長期キャッシュを返す", async () => {
    const response = await get(STYLESHEET_PATH);

    expect(response.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable");
    expect(STYLESHEET_PATH).toMatch(/^\/_app\/assets\/app-[0-9a-z]+\.css$/);
  });

  it("uid が未発行でもスタイルシートは読める", async () => {
    await db.prepare("DELETE FROM users").run();

    expect((await get(STYLESHEET_PATH)).status).toBe(200);
  });

  it("別のパスのCSSは存在しない", async () => {
    const response = await get("/_app/assets/app-deadbeef.css");

    expect(response.status).toBe(404);
  });
});
