/**
 * E2Eで使う固定値。global-setup とテスト本体が共有する。
 *
 * uid は `a-z0-9` の10文字という規則(FR-034・FR-035)を満たしつつ、実データと
 * 見分けがつく値にしている。E2Eはローカルのstateディレクトリを毎回作り直すため、
 * 固定値でも他の環境に影響しない。
 */

export type E2eUser = {
  readonly uid: string;
  readonly email: string;
};

/** 所有者。アップロードと公開切替を行う主役 */
export const OWNER: E2eUser = { uid: "e2eowner01", email: "e2e-owner@example.test" };

/** 2人目の利用者。名前空間が分かれていることの確認に使う(US6) */
export const OTHER: E2eUser = { uid: "e2eother02", email: "e2e-other@example.test" };

/** D1のデータベース名。wrangler.jsonc の env.dev と一致させる */
export const DATABASE_NAME = "artifacts-meta-dev";

/** 100件表示の計測(SC-009)で使う件数 */
export const PERF_ARTIFACT_COUNT = 100;
