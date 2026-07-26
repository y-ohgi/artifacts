/**
 * 画面が受け取るデータの型。
 *
 * `GET /_app/api/artifacts` の応答(contracts/http-api.md)と同じ形にしている。
 * view 層は他モジュールへ依存しないため、ここで自前に定義する。
 */
export type Visibility = "private" | "public";

export type ArtifactListItem = {
  /** 名前空間内で一意な名前。例: `report.html` */
  name: string;
  /** バイト数 */
  size: number;
  /** 現在の公開状態 */
  visibility: Visibility;
  /** アップロード日時(ISO 8601) */
  uploadedAt: string;
  /** 公開状態の最終変更日時(ISO 8601)。一度も変更していなければ null */
  visibilityChangedAt: string | null;
  /** 閲覧URL */
  url: string;
  /**
   * Access保護下で所有者が自分のアーティファクトを開くためのリンク。
   * 画面だけが使う値で、`GET /_app/api/artifacts` の応答には含めない。
   */
  ownerViewUrl?: string;
};
