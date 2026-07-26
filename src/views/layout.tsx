import { raw } from "hono/html";
import type { Child, FC } from "hono/jsx";

/** ヘッダに表示するサイト名 */
export const SITE_NAME = "Artifacts";

/** トップページ(一覧)のパス */
export const PATH_LIST = "/_app/";

/** アップロード画面のパス */
export const PATH_UPLOAD = "/_app/upload";

/**
 * ログアウトのパス。Cloudflare Access が処理するため Worker 側の実装は不要(FR-019)。
 */
export const PATH_LOGOUT = "/cdn-cgi/access/logout";

/**
 * 管理画面共通のスタイル。
 *
 * CSP が `default-src 'self'` のため外部CDNは参照せず、インラインの `<style>` で完結させる。
 * デスクトップ主体だが、狭い画面でも横スクロールが出ないようにしている。
 */
const STYLES = `
:root {
  --color-bg: #f6f7f9;
  --color-surface: #ffffff;
  --color-border: #d5d9e0;
  --color-text: #1c2024;
  --color-text-muted: #5b636d;
  --color-accent: #1f5eff;
  --color-public: #0a6b3d;
  --color-public-bg: #e3f6ec;
  --color-private: #6b4b00;
  --color-private-bg: #fdf3d7;
  --color-danger: #a12020;
  --color-danger-bg: #fdeceb;
  --radius: 8px;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--color-bg);
  color: var(--color-text);
  font-family: system-ui, -apple-system, "Helvetica Neue", "Hiragino Sans", "Noto Sans JP", sans-serif;
  font-size: 15px;
  line-height: 1.7;
}

a {
  color: var(--color-accent);
}

.site-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 24px;
  background: var(--color-surface);
  border-bottom: 1px solid var(--color-border);
}

.site-title {
  font-size: 18px;
  font-weight: 700;
  color: var(--color-text);
  text-decoration: none;
}

.site-nav {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.site-main {
  max-width: 960px;
  margin: 0 auto;
  padding: 24px;
}

.page-title {
  font-size: 20px;
  margin: 0 0 16px;
}

.button {
  display: inline-block;
  padding: 6px 14px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-surface);
  color: var(--color-text);
  font-size: 14px;
  line-height: 1.6;
  text-decoration: none;
  cursor: pointer;
}

.button:hover {
  border-color: var(--color-accent);
}

.button-primary {
  border-color: var(--color-accent);
  background: var(--color-accent);
  color: #ffffff;
  font-weight: 700;
}

.card {
  padding: 20px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
}

.table-scroll {
  overflow-x: auto;
}

.artifact-table {
  width: 100%;
  border-collapse: collapse;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
}

.artifact-table th,
.artifact-table td {
  padding: 10px 14px;
  text-align: left;
  border-bottom: 1px solid var(--color-border);
  vertical-align: middle;
  white-space: nowrap;
}

.artifact-table th {
  font-size: 13px;
  color: var(--color-text-muted);
  background: var(--color-bg);
}

.artifact-name {
  font-weight: 600;
  word-break: break-all;
  white-space: normal;
}

.artifact-meta {
  color: var(--color-text-muted);
  font-size: 13px;
}

.badge {
  display: inline-block;
  padding: 1px 10px;
  border-radius: 999px;
  border: 1px solid currentColor;
  font-size: 13px;
  font-weight: 700;
}

.badge-public {
  color: var(--color-public);
  background: var(--color-public-bg);
  border-style: solid;
}

.badge-private {
  color: var(--color-private);
  background: var(--color-private-bg);
  border-style: dashed;
}

.empty-state {
  padding: 48px 24px;
  text-align: center;
  background: var(--color-surface);
  border: 1px dashed var(--color-border);
  border-radius: var(--radius);
}

.empty-state-title {
  font-size: 17px;
  margin: 0 0 8px;
}

.empty-state-description {
  margin: 0 0 20px;
  color: var(--color-text-muted);
}

.field {
  margin-bottom: 20px;
}

.field-label {
  display: block;
  font-weight: 700;
  margin-bottom: 4px;
}

.field-hint {
  margin: 6px 0 0;
  color: var(--color-text-muted);
  font-size: 13px;
}

.text-input,
.file-input {
  width: 100%;
  max-width: 420px;
  padding: 6px 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-surface);
  color: var(--color-text);
  font-size: 15px;
}

.notice {
  margin-bottom: 20px;
  padding: 16px 20px;
  border: 1px solid var(--color-border);
  border-left-width: 4px;
  border-radius: var(--radius);
  background: var(--color-surface);
}

.notice-title {
  margin: 0 0 8px;
  font-size: 15px;
}

.notice-success {
  border-left-color: var(--color-public);
  background: var(--color-public-bg);
}

.notice-error {
  border-left-color: var(--color-danger);
  background: var(--color-danger-bg);
}

.notice-error .notice-title {
  color: var(--color-danger);
}

.result-url {
  display: inline-block;
  word-break: break-all;
}

.suggestion-list {
  margin: 8px 0 0;
  padding-left: 20px;
}

.rule-list {
  margin: 6px 0 0;
  padding-left: 20px;
  color: var(--color-text-muted);
  font-size: 13px;
}

code {
  padding: 1px 4px;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 4px;
  font-size: 0.92em;
}

@media (max-width: 640px) {
  .site-header {
    padding: 12px 16px;
  }

  .site-main {
    padding: 16px;
  }
}
`;

export type LayoutProps = {
  /** `<title>` に使う画面名 */
  title: string;
  children?: Child;
};

/**
 * 全管理画面で共有するレイアウト(T023)。
 *
 * ヘッダにはアップロードボタン(FR-018)とログアウト(FR-019)を常に含める。
 */
export const Layout: FC<LayoutProps> = ({ title, children }) => (
  <>
    {raw("<!DOCTYPE html>")}
    <html lang="ja">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* 管理画面も生成物も検索エンジンにインデックスさせない方針 */}
        <meta name="robots" content="noindex, nofollow" />
        <title>
          {title} | {SITE_NAME}
        </title>
        <style>{raw(STYLES)}</style>
      </head>
      <body>
        <header class="site-header">
          <a class="site-title" href={PATH_LIST}>
            {SITE_NAME}
          </a>
          <nav class="site-nav" aria-label="グローバルナビゲーション">
            <a class="button button-primary" href={PATH_UPLOAD}>
              アップロード
            </a>
            <a class="button" href={PATH_LOGOUT}>
              ログアウト
            </a>
          </nav>
        </header>
        <main class="site-main">{children}</main>
      </body>
    </html>
  </>
);
