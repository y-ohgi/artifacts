import type { FC } from "hono/jsx";

import { Layout } from "./layout";

/** アップロードを受け付けるエンドポイント */
export const PATH_UPLOAD_API = "/_app/api/artifacts";

/** 名前の候補を `<input list>` から選べるようにするための id */
const SUGGESTION_LIST_ID = "name-suggestions";

/**
 * 名前に使用できる文字種の説明(FR-006)。
 * サーバ側の検証規則と同じ内容を画面にも明示する。
 */
export const NAME_RULES: readonly string[] = [
  "半角英数と . _ - のみ使用できます",
  ".html または .htm で終わる必要があります",
  "_ で始めることはできません",
];

export type UploadResult = {
  /** 保存された名前 */
  name: string;
  /** 利用者へ提示する閲覧URL(FR-010) */
  url: string;
};

export type UploadError = {
  /** 利用者へ示すエラー内容 */
  message: string;
  /** 名前が重複した場合の、重複しない名前の候補(FR-007) */
  suggestions?: string[];
};

const UploadResultNotice: FC<{ result: UploadResult }> = ({ result }) => (
  <section class="notice notice-success">
    <p class="notice-title">
      <strong>{result.name}</strong> をアップロードしました
    </p>
    <p>
      閲覧URL:{" "}
      <a class="result-url" href={result.url}>
        {result.url}
      </a>
    </p>
    <p class="field-hint">
      アップロード直後は非公開です。共有するには一覧から公開へ切り替えてください。
    </p>
  </section>
);

const UploadErrorNotice: FC<{ error: UploadError }> = ({ error }) => {
  const suggestions = error.suggestions ?? [];
  return (
    <section class="notice notice-error">
      <p class="notice-title">アップロードできませんでした</p>
      <p>{error.message}</p>
      {suggestions.length === 0 ? null : (
        <>
          <p class="field-hint">
            重複しない名前の候補です。下の名前の入力欄で選ぶか、入力し直してください。
          </p>
          <ul class="suggestion-list">
            {suggestions.map((suggestion) => (
              <li key={suggestion}>
                <code>{suggestion}</code>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
};

export type UploadPageProps = {
  /** 名前の初期値。元のファイル名を入れる想定(FR-004)。無いときは空欄 */
  defaultName?: string;
  /** アップロード成功時の結果(FR-010) */
  result?: UploadResult;
  /** アップロード失敗時のエラー(FR-006・FR-007) */
  error?: UploadError;
};

/**
 * アップロード画面(T024)。
 *
 * ファイル選択と名前の確認・変更(FR-004・FR-005)、使用可能な文字種の明示(FR-006)、
 * 成功時の閲覧URL表示(FR-010)、失敗時のエラーと候補の提示(FR-007)を行う。
 */
export const UploadPage: FC<UploadPageProps> = ({ defaultName, result, error }) => {
  const suggestions = error?.suggestions ?? [];
  return (
    <Layout title="アップロード">
      <h1 class="page-title">HTMLをアップロード</h1>
      {result === undefined ? null : <UploadResultNotice result={result} />}
      {error === undefined ? null : <UploadErrorNotice error={error} />}
      <form
        class="card"
        method="post"
        action={PATH_UPLOAD_API}
        enctype="multipart/form-data"
      >
        <div class="field">
          <label class="field-label" for="file">
            HTMLファイル
          </label>
          <input
            class="file-input"
            id="file"
            type="file"
            name="file"
            accept=".html,.htm"
            required
          />
          <p class="field-hint">単体で完結するHTML(1ファイル)を選んでください。上限は10 MBです。</p>
        </div>
        <div class="field">
          <label class="field-label" for="name">
            名前
          </label>
          <input
            class="text-input"
            id="name"
            type="text"
            name="name"
            value={defaultName ?? ""}
            placeholder="例: report.html(空欄なら選択したファイル名を使います)"
            list={suggestions.length === 0 ? undefined : SUGGESTION_LIST_ID}
            autocomplete="off"
          />
          {suggestions.length === 0 ? null : (
            <datalist id={SUGGESTION_LIST_ID}>
              {suggestions.map((suggestion) => (
                <option key={suggestion} value={suggestion} />
              ))}
            </datalist>
          )}
          <p class="field-hint">この名前が閲覧URLの末尾になります。あとから変更はできません。</p>
          <ul class="rule-list">
            {NAME_RULES.map((rule) => (
              <li key={rule}>{rule}</li>
            ))}
          </ul>
        </div>
        <button type="submit" class="button button-primary">
          アップロードする
        </button>
      </form>
    </Layout>
  );
};
