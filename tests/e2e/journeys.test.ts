import { beforeAll, describe, expect, inject, it } from "vitest";

import { OTHER, OWNER, PERF_ARTIFACT_COUNT } from "./fixtures";
import { executeSql } from "./wrangler";

/**
 * quickstart.md の検証シナリオを、実際に起動したWorkerへHTTPで話して確認する
 * (T028・T033・T039・T045・T056・T062)。
 *
 * 3つの立場を使い分ける。owner は所有者、other は2人目の利用者、anonymous は
 * 認証情報を持たない訪問者。いずれも同じローカルのD1/R2を共有しているため、
 * 「所有者には見えるが訪問者には見えない」という判定を実際の応答で確かめられる。
 *
 * Cloudflare Access そのものはローカルに存在しないため、Accessの認証画面・
 * ログアウト・トークン失効の確認だけは対象外。それ以外は自動化している。
 *
 * このファイル内のテストは宣言順に実行され、前のテストが作ったアーティファクトを
 * 前提にする箇所がある(先頭の空状態と、末尾の100件計測が特にそう)。
 */

const owner = inject("ownerBaseUrl");
const other = inject("otherBaseUrl");
const anonymous = inject("anonymousBaseUrl");

const HTML_WITH_SCRIPT =
  '<!doctype html><html><head><title>E2E</title></head><body><h1>VERSION-1</h1>' +
  '<script>document.body.dataset.ran = "yes";</script></body></html>';

type UploadOptions = {
  fileName?: string;
  name?: string;
  body?: string;
  type?: string;
  accept?: string;
};

async function upload(baseUrl: string, options: UploadOptions = {}): Promise<Response> {
  const fileName = options.fileName ?? "report.html";
  const form = new FormData();
  form.set(
    "file",
    new File([options.body ?? HTML_WITH_SCRIPT], fileName, {
      type: options.type ?? "text/html",
    }),
  );
  if (options.name !== undefined) {
    form.set("name", options.name);
  }

  return await fetch(`${baseUrl}/_app/api/artifacts`, {
    method: "POST",
    headers: { Accept: options.accept ?? "application/json", "Sec-Fetch-Site": "same-origin" },
    body: form,
    redirect: "manual",
  });
}

async function toggle(baseUrl: string, name: string, visibility: string): Promise<Response> {
  return await fetch(`${baseUrl}/_app/api/artifacts/${encodeURIComponent(name)}/visibility`, {
    method: "PUT",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "Sec-Fetch-Site": "same-origin",
    },
    body: JSON.stringify({ visibility }),
    redirect: "manual",
  });
}

async function listJson(baseUrl: string): Promise<{ name: string; visibility: string; uploadedAt: string; url: string }[]> {
  const response = await fetch(`${baseUrl}/_app/api/artifacts`, {
    headers: { Accept: "application/json" },
  });
  const body = (await response.json()) as {
    artifacts: { name: string; visibility: string; uploadedAt: string; url: string }[];
  };
  return body.artifacts;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 応答ごとに必ず変わるヘッダを落とす。
 * 404の同一性(FR-017・FR-024)は Date のような値まで一致させる要求ではない。
 */
function stableHeaders(response: Response): [string, string][] {
  const volatile = new Set(["date", "cf-ray", "server", "report-to", "nel"]);
  return [...response.headers]
    .filter(([name]) => !volatile.has(name.toLowerCase()))
    .sort(([a], [b]) => a.localeCompare(b));
}

describe("初期状態", () => {
  it("何も無い一覧は空状態と最初のアップロードへの導線を出す (FR-016)", async () => {
    const response = await fetch(`${owner}/_app/`);

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("まだ何もアップロードされていません");
    expect(html).toContain("最初のHTMLをアップロードする");
  });
});

/**
 * CSPと画面の整合(#8)。
 *
 * ブラウザは動かせないので `document.styleSheets.length > 0` そのものは測れない
 * が、それが成り立つ条件 ―― ページがインラインの `<style>` を持たず、代わりに
 * 同一オリジンのスタイルシートを指し、その宛先が実際に空でないCSSを返すこと
 * ―― を、起動した Worker への実HTTPで確かめる。
 */
describe("管理画面のスタイル配信 (#8)", () => {
  it("各画面がインラインではなく同一オリジンのCSSを読み込み、それが実際に返る", async () => {
    for (const path of ["/_app/", "/_app/upload"]) {
      const page = await fetch(`${owner}${path}`);
      expect(page.status, path).toBe(200);

      const html = await page.text();
      expect(html, path).not.toContain("<style");
      expect(page.headers.get("content-security-policy"), path).not.toContain("unsafe-inline");

      const href = /<link rel="stylesheet" href="([^"]+)"/.exec(html)?.[1];
      expect(href, path).toMatch(/^\//);

      const css = await fetch(`${owner}${href}`);
      expect(css.status, href).toBe(200);
      expect(css.headers.get("content-type")).toContain("text/css");
      expect((await css.text()).length).toBeGreaterThan(0);
    }
  });
});

describe("US1: HTMLをアップロードして閲覧する", () => {
  it("/ は /_app/ へリダイレクトする", async () => {
    const response = await fetch(`${owner}/`, { redirect: "manual" });

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/_app/");
  });

  it("アップロードすると 201 と非公開の閲覧URLが返る (FR-010, FR-022)", async () => {
    const response = await upload(owner, { name: "report.html" });

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      artifact: { uid: string; name: string; visibility: string; url: string };
    };
    expect(body.artifact.uid).toBe(OWNER.uid);
    expect(body.artifact.visibility).toBe("private");
    expect(body.artifact.url).toBe(`${owner}/${OWNER.uid}/report.html`);
  });

  it("所有者はアップロードしたバイト列と1バイトも違わない本文を得る (FR-012, SC-008)", async () => {
    const response = await fetch(`${owner}/${OWNER.uid}/report.html`);

    expect(response.status).toBe(200);
    // inline script も含めて完全一致。ナビゲーションもスクリプトも注入しない(FR-032)。
    expect(await response.text()).toBe(HTML_WITH_SCRIPT);
  });

  it("配信応答に no-store と sandbox が付く (FR-028)", async () => {
    const response = await fetch(`${owner}/${OWNER.uid}/report.html`);

    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toBe(
      "sandbox allow-scripts allow-popups allow-forms allow-modals",
    );
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  it("拡張子がHTMLでないファイルを拒否する (FR-002)", async () => {
    const response = await upload(owner, {
      fileName: "notes.txt",
      name: "notes.txt",
      type: "text/plain",
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_html");
  });

  it("拡張子はHTMLだが中身がHTMLでないファイルを拒否する (FR-002)", async () => {
    const response = await upload(owner, {
      name: "payload.html",
      body: '{"not":"html"}',
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_html");
  });

  it("上限を超えるファイルを上限値とともに拒否する (FR-003)", async () => {
    const oversized = `<!doctype html><html><body>${"x".repeat(11 * 1024 * 1024)}</body></html>`;

    const response = await upload(owner, { name: "big.html", body: oversized });

    expect(response.status).toBe(413);
    const body = (await response.json()) as {
      error: { code: string; details?: { limitBytes?: number } };
    };
    expect(body.error.code).toBe("too_large");
    expect(body.error.details?.limitBytes).toBe(10 * 1024 * 1024);
  });

  it("ブラウザからのフォーム送信では閲覧URLを含む画面を返す (FR-010)", async () => {
    const response = await upload(owner, { name: "from-form.html", accept: "text/html" });

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(`${OWNER.uid}/from-form.html`);
    expect(html).toContain("アップロードしました");
  });
});

describe("US2: トップページで過去のアーティファクトを探す", () => {
  beforeAll(async () => {
    // 並び順の比較が uploaded_at の同値で崩れないよう、間隔を空けて登録する。
    await upload(owner, { name: "second.html" });
    await sleep(10);
    await upload(owner, { name: "third.html" });
  });

  it("一覧はアップロード日時の降順で返る (FR-015)", async () => {
    const artifacts = await listJson(owner);

    const timestamps = artifacts.map((item) => Date.parse(item.uploadedAt));
    expect(timestamps).toEqual([...timestamps].sort((a, b) => b - a));
    expect(artifacts.map((item) => item.name).slice(0, 2)).toEqual(["third.html", "second.html"]);
  });

  it("一覧画面に名前・日時・公開状態と閲覧URLへのリンクが並ぶ (FR-014)", async () => {
    const response = await fetch(`${owner}/_app/`);
    const html = await response.text();

    expect(html).toContain("third.html");
    expect(html).toContain(`href="${owner}/${OWNER.uid}/third.html"`);
    expect(html).toContain("非公開");
    expect(html).toContain("JST");
  });

  it("ヘッダにアップロードとログアウトが常にある (FR-018, FR-019)", async () => {
    const response = await fetch(`${owner}/_app/`);
    const html = await response.text();

    expect(html).toContain('href="/_app/upload"');
    expect(html).toContain('href="/cdn-cgi/access/logout"');
  });
});

describe("US3: 名前の確認と衝突回避", () => {
  it("同名の2回目は 409 になり、候補が示され、1回目は変化しない (FR-007, FR-008, SC-002)", async () => {
    const conflict = await upload(owner, { name: "report.html", body: "<!doctype html><html><body>VERSION-2</body></html>" });

    expect(conflict.status).toBe(409);
    const body = (await conflict.json()) as {
      error: { code: string; details?: { suggestions?: string[] } };
    };
    expect(body.error.code).toBe("name_conflict");

    const suggestions = body.error.details?.suggestions ?? [];
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0]).toBe("report-2.html");

    // 1回目の本文が上書きされていないこと。
    const served = await fetch(`${owner}/${OWNER.uid}/report.html`);
    expect(await served.text()).toBe(HTML_WITH_SCRIPT);

    // 示された候補が実際に使えること。
    const accepted = await upload(owner, {
      name: suggestions[0] as string,
      body: "<!doctype html><html><body>VERSION-2</body></html>",
    });
    expect(accepted.status).toBe(201);
  });

  const rejectedNames = ["my report.html", "../evil.html", "レポート.html", "_internal.html"];
  for (const name of rejectedNames) {
    it(`使用できない名前を説明とともに拒否する: ${name} (FR-006)`, async () => {
      const response = await upload(owner, { name });

      expect(response.status).toBe(400);
      const body = (await response.json()) as {
        error: { code: string; details?: { allowed?: string } };
      };
      // `../evil.html` は拡張子より先にHTML判定を通るため not_html になりうる。
      expect(["invalid_name", "not_html"]).toContain(body.error.code);
      if (body.error.code === "invalid_name") {
        expect(body.error.details?.allowed).toContain(".html");
      }
    });
  }

  it("アップロード画面に使用可能な文字種が明示されている (FR-006)", async () => {
    const response = await fetch(`${owner}/_app/upload`);
    const html = await response.text();

    expect(html).toContain("半角英数");
    expect(html).toContain(".html");
  });
});

describe("US4: 認証されていない訪問者", () => {
  it("管理画面は内容を返さず、再認証の導線を示す (FR-020, FR-021)", async () => {
    const response = await fetch(`${anonymous}/_app/`, {
      headers: { Accept: "text/html" },
    });

    expect(response.status).toBe(401);
    const html = await response.text();
    expect(html).toContain("認証が切れています");
    expect(html).toContain("開き直す");
    expect(html).not.toContain("report.html");
  });

  it("管理APIもJSONを返さない (FR-020)", async () => {
    const response = await fetch(`${anonymous}/_app/api/artifacts`, {
      headers: { Accept: "application/json" },
    });

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error?: { code: string }; artifacts?: unknown };
    expect(body.artifacts).toBeUndefined();
    expect(body.error?.code).toBe("not_found");
  });

  it("アップロードもできない", async () => {
    const before = await listJson(owner);

    const response = await upload(anonymous, { name: "sneaked.html" });
    expect(response.status).toBe(401);

    const after = await listJson(owner);
    expect(after).toHaveLength(before.length);
  });
});

describe("US5: 公開と非公開", () => {
  it("公開に切り替えると未認証でも本文が返り、URLは変わらない (FR-026, FR-030)", async () => {
    const before = (await (await fetch(`${owner}/_app/api/artifacts`, { headers: { Accept: "application/json" } })).json()) as {
      artifacts: { name: string; url: string }[];
    };
    const beforeUrl = before.artifacts.find((item) => item.name === "report.html")?.url;

    const toggled = await toggle(owner, "report.html", "public");
    expect(toggled.status).toBe(200);
    const body = (await toggled.json()) as { artifact: { url: string; visibility: string } };
    expect(body.artifact.visibility).toBe("public");
    expect(body.artifact.url).toBe(beforeUrl);

    const response = await fetch(`${anonymous}/${OWNER.uid}/report.html`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(HTML_WITH_SCRIPT);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
  });

  it("非公開へ戻すと次のリクエストから未認証には返らない (FR-027, SC-006)", async () => {
    const toggled = await toggle(owner, "report.html", "private");
    expect(toggled.status).toBe(200);

    const response = await fetch(`${anonymous}/${OWNER.uid}/report.html`);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("VERSION-1");
  });

  it("非公開と不存在の応答が見分けられない (FR-017, FR-024)", async () => {
    const privateOne = await fetch(`${anonymous}/${OWNER.uid}/report.html`);
    const absent = await fetch(`${anonymous}/${OWNER.uid}/nonexistent.html`);
    const badUid = await fetch(`${anonymous}/SHORT/report.html`);
    const badName = await fetch(`${anonymous}/${OWNER.uid}/report.txt`);

    const expected = {
      status: privateOne.status,
      body: await privateOne.text(),
      headers: stableHeaders(privateOne),
    };

    expect(expected.status).toBe(404);
    for (const response of [absent, badUid, badName]) {
      expect(response.status).toBe(expected.status);
      expect(await response.text()).toBe(expected.body);
      expect(stableHeaders(response)).toEqual(expected.headers);
    }
  });

  it("所有者はAccess保護下の経路から非公開アーティファクトを開ける (T018)", async () => {
    const target = encodeURIComponent(`/${OWNER.uid}/report.html`);

    const asOwner = await fetch(`${owner}/_auth/view?target=${target}`);
    expect(asOwner.status).toBe(200);
    expect(await asOwner.text()).toBe(HTML_WITH_SCRIPT);

    // 訪問者と別の利用者には同じ経路でも404。
    for (const baseUrl of [anonymous, other]) {
      const response = await fetch(`${baseUrl}/_auth/view?target=${target}`);
      expect(response.status).toBe(404);
    }
  });

  it("一覧に公開状態と切り替え操作が出る (FR-014, FR-029)", async () => {
    const response = await fetch(`${owner}/_app/`);
    const html = await response.text();

    expect(html).toContain("公開する");
    expect(html).toContain("所有者として開く");
  });
});

describe("US6: uidの名前空間", () => {
  const OTHER_HTML = "<!doctype html><html><body>OTHER NAMESPACE</body></html>";

  beforeAll(async () => {
    await upload(other, { name: "report.html", body: OTHER_HTML });
    await toggle(other, "report.html", "public");
    await toggle(owner, "report.html", "public");
  });

  it("同じ名前が別のuidで共存し、それぞれの内容を返す (FR-039)", async () => {
    const mine = await fetch(`${anonymous}/${OWNER.uid}/report.html`);
    const theirs = await fetch(`${anonymous}/${OTHER.uid}/report.html`);

    expect(await mine.text()).toBe(HTML_WITH_SCRIPT);
    expect(await theirs.text()).toBe(OTHER_HTML);
  });

  it("一覧は自分のuidの分だけを返す (FR-038)", async () => {
    const mine = await listJson(owner);
    const theirs = await listJson(other);

    expect(mine.every((item) => item.url.includes(`/${OWNER.uid}/`))).toBe(true);
    expect(theirs.map((item) => item.name)).toEqual(["report.html"]);
    expect(theirs).toHaveLength(1);
  });

  it("他uidのアーティファクトは公開状態を変えられない (FR-031, FR-038)", async () => {
    // owner から見て "report.html" は自分の名前空間にもあるため、相手の
    // アーティファクトが影響を受けないことを内容で確認する。
    const response = await toggle(other, "report.html", "private");
    expect(response.status).toBe(200);

    // owner 側は公開のまま維持されている。
    const mine = await fetch(`${anonymous}/${OWNER.uid}/report.html`);
    expect(mine.status).toBe(200);

    // 相手側は非公開になっている。
    const theirs = await fetch(`${anonymous}/${OTHER.uid}/report.html`);
    expect(theirs.status).toBe(404);
  });

  it("存在しない名前へのトグルは404になる", async () => {
    const response = await toggle(owner, "not-mine.html", "public");

    expect(response.status).toBe(404);
  });
});

describe("SC-009: 100件でも一覧が3秒以内に表示される", () => {
  beforeAll(async () => {
    // R2の本体は一覧表示に不要(D1のみ参照する)ため、行だけを投入する。
    const rows = Array.from({ length: PERF_ARTIFACT_COUNT }, (_, index) => {
      const suffix = String(index).padStart(3, "0");
      const uploadedAt = `2026-06-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`;
      return `('${OWNER.uid}', 'perf-${suffix}.html', 1024, '${uploadedAt}')`;
    }).join(", ");

    await executeSql(`INSERT INTO artifacts (uid, name, size, uploaded_at) VALUES ${rows}`);
  });

  it("初期表示が3秒以内に完了する", async () => {
    const artifacts = await listJson(owner);
    expect(artifacts.length).toBeGreaterThanOrEqual(PERF_ARTIFACT_COUNT);

    const started = Date.now();
    const response = await fetch(`${owner}/_app/`);
    const html = await response.text();
    const elapsed = Date.now() - started;

    expect(response.status).toBe(200);
    expect(html).toContain("perf-099.html");
    expect(elapsed).toBeLessThan(3_000);

    // 計測値を残す。回帰したときに切り分けやすくする。
    console.info(`[SC-009] ${artifacts.length} artifacts rendered in ${elapsed}ms`);
  });
});
