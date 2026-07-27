import { raw } from "hono/html";
import type { Child, FC } from "hono/jsx";

import { STYLESHEET_PATH } from "./styles";

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
        <link rel="stylesheet" href={STYLESHEET_PATH} />
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
