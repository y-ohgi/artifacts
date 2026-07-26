import type { FC } from "hono/jsx";

import { Layout } from "./layout";

/**
 * 操作を続けられない理由と次の行動だけを示す画面。
 *
 * 認証切れ(FR-021)とuid未発行の案内に使う。ブラウザからのアクセスに対して
 * JSONのエラー封筒を返しても利用者は次に何をすればよいか分からないため、
 * 同じ状態をHTMLで説明する。
 */
export type NoticeAction = {
  /** リンクの文言 */
  label: string;
  /** 遷移先。自ホスト内のパスのみを渡す */
  href: string;
};

export type NoticePageProps = {
  /** 見出し。何が起きたかを一言で示す */
  title: string;
  /** 本文。利用者が取れる行動まで書く */
  message: string;
  /** 主要な導線。無い場合は表示しない */
  action?: NoticeAction;
  /** 補足。運用者向けの情報など */
  hint?: string;
};

export const NoticePage: FC<NoticePageProps> = ({ title, message, action, hint }) => (
  <Layout title={title}>
    <h1 class="page-title">{title}</h1>
    <section class="notice notice-error">
      <p class="notice-title">{title}</p>
      <p>{message}</p>
      {hint === undefined ? null : <p class="field-hint">{hint}</p>}
    </section>
    {action === undefined ? null : (
      <a class="button button-primary" href={action.href}>
        {action.label}
      </a>
    )}
  </Layout>
);
