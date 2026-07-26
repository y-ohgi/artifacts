import type { HtmlEscapedString } from "hono/utils/html";
import { describe, expect, it } from "vitest";

import { Layout } from "../../src/views/layout";
import { ListPage, formatDateTime, formatSize } from "../../src/views/list";
import type { ArtifactListItem } from "../../src/views/types";
import { UploadPage } from "../../src/views/upload";

/**
 * Hono JSX の要素は `HtmlEscapedString | Promise<HtmlEscapedString>` なので、
 * await して文字列化すれば同期・非同期どちらのコンポーネントでも SSR 結果が得られる。
 */
const render = async (
  element: HtmlEscapedString | Promise<HtmlEscapedString>,
): Promise<string> => String(await element);

const item = (overrides: Partial<ArtifactListItem> = {}): ArtifactListItem => ({
  name: "report.html",
  size: 48213,
  visibility: "private",
  uploadedAt: "2026-07-26T09:41:22.000Z",
  visibilityChangedAt: null,
  url: "https://artifacts.example.com/a3f9k2m1x8/report.html",
  ...overrides,
});

describe("Layout", () => {
  it("ヘッダにアップロード画面へのリンクを含む (FR-018)", async () => {
    const html = await render(<Layout title="テスト">本文</Layout>);

    expect(html).toContain('href="/_app/upload"');
  });

  it("ヘッダにログアウトへのリンクを含む (FR-019)", async () => {
    const html = await render(<Layout title="テスト">本文</Layout>);

    expect(html).toContain('href="/cdn-cgi/access/logout"');
  });

  it("DOCTYPE と lang、children を出力する", async () => {
    const html = await render(<Layout title="テスト">ここが本文</Layout>);

    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain('<html lang="ja">');
    expect(html).toContain("ここが本文");
  });
});

describe("ListPage", () => {
  it("0件のとき空状態と最初のアップロードへの導線を出す (FR-016)", async () => {
    const html = await render(<ListPage artifacts={[]} />);

    expect(html).toContain("まだ何もアップロードされていません");
    expect(html).toContain("最初のHTMLをアップロードする");
  });

  it("3件を受け取った順序で描画し、名前を閲覧URLへのリンクにする (FR-014)", async () => {
    const artifacts = [
      item({ name: "third.html", url: "https://example.test/u/third.html" }),
      item({ name: "second.html", url: "https://example.test/u/second.html" }),
      item({ name: "first.html", url: "https://example.test/u/first.html" }),
    ];

    const html = await render(<ListPage artifacts={artifacts} />);

    const positions = artifacts.map((artifact) => html.indexOf(artifact.name));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(html).toContain('href="https://example.test/u/first.html"');
  });

  it("公開と非公開をテキストで区別できる (FR-029)", async () => {
    const html = await render(
      <ListPage
        artifacts={[
          item({ name: "public.html", visibility: "public" }),
          item({ name: "private.html", visibility: "private" }),
        ]}
      />,
    );

    expect(html).toContain(">公開<");
    expect(html).toContain(">非公開<");
    expect(html).toContain("badge-public");
    expect(html).toContain("badge-private");
  });

  it("公開状態の切り替えを form で表現し、対象名をエンコードした宛先へ向ける", async () => {
    const html = await render(
      <ListPage artifacts={[item({ name: "my report.html", visibility: "private" })]} />,
    );

    expect(html).toContain('action="/_app/api/artifacts/my%20report.html/visibility"');
    expect(html).toContain('name="visibility" value="public"');
    expect(html).toContain("公開する");
  });

  it("アップロード日時とサイズを人間が読める形で表示する", async () => {
    const html = await render(<ListPage artifacts={[item()]} />);

    expect(html).toContain("2026-07-26 18:41 JST");
    expect(html).toContain("47.1 KB");
  });
});

describe("UploadPage", () => {
  it("multipart のフォームとファイル選択・名前入力欄を持つ (FR-004・FR-005)", async () => {
    const html = await render(<UploadPage />);

    expect(html).toContain('action="/_app/api/artifacts"');
    expect(html).toContain('enctype="multipart/form-data"');
    expect(html).toContain('type="file"');
    expect(html).toContain('name="file"');
    expect(html).toContain('name="name"');
  });

  it("使用可能な文字種の説明を含む (FR-006)", async () => {
    const html = await render(<UploadPage />);

    expect(html).toContain("半角英数と . _ - のみ使用できます");
    expect(html).toContain(".html または .htm で終わる必要があります");
    expect(html).toContain("_ で始めることはできません");
  });

  it("result を渡すと閲覧URLを表示する (FR-010)", async () => {
    const html = await render(
      <UploadPage result={{ name: "report.html", url: "https://example.test/u/report.html" }} />,
    );

    expect(html).toContain('href="https://example.test/u/report.html"');
    expect(html).toContain("<strong>report.html</strong> をアップロードしました");
  });

  it("suggestions を渡すと候補を選べる形で表示する (FR-007)", async () => {
    const html = await render(
      <UploadPage
        error={{
          message: "同じ名前のアーティファクトが既に存在する",
          suggestions: ["report-2.html", "report-3.html"],
        }}
      />,
    );

    expect(html).toContain("同じ名前のアーティファクトが既に存在する");
    expect(html).toContain("report-2.html");
    expect(html).toContain("report-3.html");
    expect(html).toContain('<datalist id="name-suggestions">');
    expect(html).toContain('list="name-suggestions"');
  });

  it("エラーが無いときはエラー領域を出さない", async () => {
    const html = await render(<UploadPage />);

    expect(html).not.toContain("アップロードできませんでした");
    expect(html).not.toContain("<datalist");
  });
});

describe("エスケープ", () => {
  it("アーティファクト名の HTML をエスケープする", async () => {
    const html = await render(
      <ListPage artifacts={[item({ name: "<script>alert(1)</script>" })]} />,
    );

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script");
  });

  it("属性値に埋め込む URL をエスケープする", async () => {
    const html = await render(
      <ListPage artifacts={[item({ url: '/x.html" onmouseover="alert(1)' })]} />,
    );

    expect(html).not.toContain('onmouseover="alert(1)"');
    expect(html).toContain("&quot;");
  });

  it("アップロード画面のエラーメッセージと候補をエスケープする", async () => {
    const html = await render(
      <UploadPage
        error={{ message: "<img src=x onerror=alert(1)>", suggestions: ["<b>bold</b>.html"] }}
      />,
    );

    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<b>bold</b>.html");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});

describe("整形ユーティリティ", () => {
  it("サイズを B / KB / MB へ整形する", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(2048)).toBe("2.0 KB");
    expect(formatSize(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatSize(-1)).toBe("-");
  });

  it("解釈できない日時はそのまま返す", () => {
    expect(formatDateTime("not-a-date")).toBe("not-a-date");
    expect(formatDateTime("2026-01-01T00:00:00.000Z")).toBe("2026-01-01 09:00 JST");
  });
});
