/**
 * 管理画面のスタイルシート。
 *
 * 管理画面のCSPは `default-src 'self'` で `style-src` を持たない(src/headers.ts)。
 * インラインの `<style>` はこのCSPに拒否され、CSSが1バイトも適用されない状態に
 * なるため、CSSはここに置いて `/_app/assets/app-<hash>.css` から同一オリジンの
 * 外部スタイルシートとして配信する。CSPを緩めずに済むのが狙いなので、
 * `'unsafe-inline'` を足してインラインへ戻してはいけない。
 *
 * 外部CDNも参照しない(`default-src 'self'` に拒否される)。デスクトップ主体だが、
 * 狭い画面でも横スクロールが出ないようにしている。
 */
export const APP_CSS = `
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

/**
 * CSS本文から決まる短い指紋。
 *
 * このプロジェクトにはビルド工程がないので、ハッシュ付きファイル名をビルド時では
 * なく起動時に組み立てる。用途はキャッシュの無効化だけで、秘密を守る用途ではない
 * ため、暗号学的強度は要らない(FNV-1a 32bit)。同期的に求まることが条件になる。
 */
function fingerprint(source: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash.toString(36);
}

/**
 * スタイルシートの配信パス。ルート相対なので `default-src 'self'` で解決できる。
 *
 * 内容が変わればパスも変わるため、長期キャッシュを返しても古いCSSが残らない。
 */
export const STYLESHEET_PATH = `/_app/assets/app-${fingerprint(APP_CSS)}.css`;
