import type { FC } from "hono/jsx";

import { Layout, PATH_UPLOAD } from "./layout";
import type { ArtifactListItem, Visibility } from "./types";

/** JST のオフセット(ミリ秒)。Workers には tz データベースを前提にしない */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

const pad2 = (value: number): string => String(value).padStart(2, "0");

/**
 * ISO 8601 の日時を `YYYY-MM-DD HH:mm JST` の形へ整形する。
 * 解釈できない値はそのまま返す。
 */
export const formatDateTime = (iso: string): string => {
  const epochMs = Date.parse(iso);
  if (Number.isNaN(epochMs)) {
    return iso;
  }
  const jst = new Date(epochMs + JST_OFFSET_MS);
  const date = `${jst.getUTCFullYear()}-${pad2(jst.getUTCMonth() + 1)}-${pad2(jst.getUTCDate())}`;
  const time = `${pad2(jst.getUTCHours())}:${pad2(jst.getUTCMinutes())}`;
  return `${date} ${time} JST`;
};

/** バイト数を人間が読める形へ整形する */
export const formatSize = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "-";
  }
  const kb = 1024;
  const mb = kb * 1024;
  if (bytes < kb) {
    return `${Math.round(bytes)} B`;
  }
  if (bytes < mb) {
    return `${(bytes / kb).toFixed(1)} KB`;
  }
  return `${(bytes / mb).toFixed(1)} MB`;
};

/** 公開状態の日本語ラベル。色に頼らずテキストでも区別できるようにする(FR-029) */
export const visibilityLabel = (visibility: Visibility): string =>
  visibility === "public" ? "公開" : "非公開";

/** 公開状態を切り替える先 */
const nextVisibility = (visibility: Visibility): Visibility =>
  visibility === "public" ? "private" : "public";

/** 切り替えボタンの文言 */
const toggleLabel = (visibility: Visibility): string =>
  visibility === "public" ? "非公開に戻す" : "公開する";

/** `PUT /_app/api/artifacts/:name/visibility` の宛先 */
export const visibilityActionPath = (name: string): string =>
  `/_app/api/artifacts/${encodeURIComponent(name)}/visibility`;

const VisibilityBadge: FC<{ visibility: Visibility }> = ({ visibility }) => (
  <span class={`badge badge-${visibility}`}>{visibilityLabel(visibility)}</span>
);

/**
 * 公開状態の切り替え操作。
 *
 * JavaScript を使わずに済ませるため `<form method="post">` で表現し、
 * `_method` で `PUT` へオーバーライドする前提とする(実際の配線は統合時に行う)。
 */
const VisibilityToggleForm: FC<{ item: ArtifactListItem }> = ({ item }) => {
  const next = nextVisibility(item.visibility);
  return (
    <form class="visibility-form" method="post" action={visibilityActionPath(item.name)}>
      <input type="hidden" name="_method" value="PUT" />
      <input type="hidden" name="visibility" value={next} />
      <button type="submit" class="button">
        {toggleLabel(item.visibility)}
      </button>
    </form>
  );
};

const EmptyState: FC = () => (
  <div class="empty-state">
    <p class="empty-state-title">まだ何もアップロードされていません</p>
    <p class="empty-state-description">
      HTMLファイルをアップロードすると、ここに一覧として並びます。
    </p>
    <a class="button button-primary" href={PATH_UPLOAD}>
      最初のHTMLをアップロードする
    </a>
  </div>
);

/**
 * 非公開アーティファクトを所有者として開くための導線。
 *
 * 閲覧URL(`item.url`)はAccess非保護のため、Accessのcookieが届かない環境では
 * 所有者でも404になりうる。Access保護下の `/_auth/view` を併記しておくことで、
 * cookieの挙動に依存せず所有者が内容を確認できる。
 */
const OwnerViewLink: FC<{ item: ArtifactListItem }> = ({ item }) =>
  item.visibility === "private" && item.ownerViewUrl !== undefined ? (
    <div class="artifact-meta">
      <a href={item.ownerViewUrl}>所有者として開く</a>
    </div>
  ) : null;

const ArtifactRow: FC<{ item: ArtifactListItem }> = ({ item }) => (
  <tr>
    <td class="artifact-name">
      <a href={item.url}>{item.name}</a>
      <OwnerViewLink item={item} />
    </td>
    <td class="artifact-meta">{formatSize(item.size)}</td>
    <td class="artifact-meta">
      <time datetime={item.uploadedAt}>{formatDateTime(item.uploadedAt)}</time>
    </td>
    <td>
      <VisibilityBadge visibility={item.visibility} />
      {item.visibilityChangedAt === null ? null : (
        <div class="artifact-meta">{formatDateTime(item.visibilityChangedAt)} に変更</div>
      )}
    </td>
    <td>
      <VisibilityToggleForm item={item} />
    </td>
  </tr>
);

export type ListPageProps = {
  /**
   * 表示するアーティファクト。
   * 並び順は呼び出し側の責務(FR-015)であり、受け取った配列の順にそのまま描画する。
   */
  artifacts: readonly ArtifactListItem[];
};

/**
 * トップページの一覧画面(T031)。
 *
 * 各項目に名前・アップロード日時・公開状態を表示し、名前を閲覧URLへのリンクにする(FR-014)。
 * 0件のときは空状態と最初のアップロードへの導線を出す(FR-016)。
 */
export const ListPage: FC<ListPageProps> = ({ artifacts }) => (
  <Layout title="アーティファクト一覧">
    <h1 class="page-title">アーティファクト一覧</h1>
    {artifacts.length === 0 ? (
      <EmptyState />
    ) : (
      <div class="table-scroll">
        <table class="artifact-table">
          <thead>
            <tr>
              <th scope="col">名前</th>
              <th scope="col">サイズ</th>
              <th scope="col">アップロード日時</th>
              <th scope="col">公開状態</th>
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            {artifacts.map((item) => (
              <ArtifactRow key={item.name} item={item} />
            ))}
          </tbody>
        </table>
      </div>
    )}
  </Layout>
);
