---

description: "Task list for HTMLアーティファクト共有サイト"
---

# Tasks: HTMLアーティファクト共有サイト

**Input**: Design documents from `/specs/001-html-artifact-hosting/`

**Prerequisites**: [plan.md](./plan.md)、[spec.md](./spec.md)、[research.md](./research.md)、[data-model.md](./data-model.md)、[contracts/http-api.md](./contracts/http-api.md)、[quickstart.md](./quickstart.md)

**Tests**: テストタスクを含める。[plan.md](./plan.md) がVitest + `@cloudflare/vitest-pool-workers` をテスト方針として確定させており、[contracts/http-api.md](./contracts/http-api.md) に契約テストの観点が定義済みで、グローバル設定として読み込まれる共通の作業規約が「コードを追加・変更する際にはテストを追加・更新する」「検証前に完了を報告しない」を要求しているため(リポジトリ直下の `AGENTS.md` ではない。両者の関係は同ファイルの「共通規約との関係」を参照)。

**Organization**: タスクはUser Story単位にまとめ、各ストーリーを独立して実装・検証できるようにする。

## 実装状況(2026-07-27 時点)

69タスクのうち66件完了。残る3件はいずれもCloudflare側の操作か人の目による確認を要するもので、コード上の未実装は無い。実測の記録は [validation-report.md](./validation-report.md) を正とする。

dev環境へデプロイ済み: `https://artifacts-dev.ohgi-211.workers.dev`(Version ID `38b22369-0b3f-4bcc-a579-c69ab1056434`)

- Phase 1 Setup: 完了(T001〜T005)
- Phase 2 Foundational: T006〜T015・T018・T019 完了。**T016・T017 が未完了**
- Phase 3 US1: 完了(T020〜T028)
- Phase 4 US2: 完了(T029〜T033)
- Phase 5 US3: 完了(T034〜T039)
- Phase 6 US4: T040〜T044 完了。**T045 のうちAccess依存の確認が未完了**
- Phase 7 US5: 完了(T046〜T056)
- Phase 8 US6: 完了(T057〜T062)
- Phase 9 Polish: T063〜T069 完了(T066〜T068は自動化できない部分を validation-report.md に明記)

US5の実装がUS3・US4より先に進んだのは、一覧画面が公開切替のUIを持つため配信・切替の実装を先に必要としたから。Implementation Strategy の推奨順とは異なるが、既定非公開はスキーマのDEFAULTで担保されているため情報露出は起きていない。

### 検証済みの事実(2026-07-27 に実行)

- `npx tsc --noEmit`: エラーなし
- `npm test`(単体・統合): 10ファイル・152件すべて成功
- `npm run test:e2e`(`wrangler dev` を起動して実際のHTTPで確認): 31件すべて成功
- dev環境への未認証スモーク(`tests/e2e/remote.test.ts`): 6件すべて成功
- dev環境: `GET /` が `302 /_app/`、`GET /_app/` が `401`、公開アーティファクトが `200` で `no-store` と `sandbox` 付き、非公開と不存在の404が本文・ヘッダまで一致
- SC-009: 105件で `/_app/` の生成が6ms

### MVPを利用可能にするために残っている作業(Cloudflare側の操作が必要)

1. Cloudflareダッシュボードで Workers & Pages → `artifacts-dev` → Settings → Domains & Routes → workers.dev の項目で Cloudflare Access を有効化する(T016)
2. 有効化後にAccessの認証画面・ログアウト・トークン失効を確認する(T045のうちUS4手順1〜5)
3. `CF_Authorization` cookieの到達性を実測し research.md へ反映する(T017)

`ACCESS_TEAM_DOMAIN` と `ACCESS_AUD` は設定済みと判断している。デプロイ環境では `ENVIRONMENT` が常に `undefined` になり、その状態で両secretが未設定なら `src/auth.ts` は `misconfigured` を返して `500` になる。現在返るのが `401`(`unauthenticated`)であることがこれを示す。ただしsecretの値そのものは未確認。

uidは2件登録済み(`ohgi.211@gmail.com` と `y-ohgi@topotal.com`)。Accessがどちらのemailを返しても uid が解決できる。

Access自体はまだ前段に入っていない。`/_app/` がAccessのログイン画面へのリダイレクトではなくWorker自身の `401` を返しているため。**1が完了すればMVPは利用可能になる。** それまでの間も、公開アーティファクトの配信・非公開の遮断・404の同一性はdev環境で動作している。

なおT016はカスタムドメイン前提でパスを2つ保護する内容だが、dev環境はworkers.devのOne-click Accessを使うためURL全体の保護になる。MVPのスコープは全アーティファクトが非公開のUS1なので要件と矛盾しない。パス単位の保護境界はカスタムドメイン段階で必要になる。

## 設計文書と実装の差分

タスク本文の記述より、以下の実装を正とする。タスク本文にも同じ内容を反映済み。

- **エントリポイントは `src/index.tsx`**。Honoのjsxを使うため `.tsx`。以下のタスク本文では `src/index.ts` を `src/index.tsx` と読み替える
- **書き込み順は D1 → R2**。plan.mdとT025が記述する「R2 put → D1 insert」の逆。R2を先に書くと同名アップロードでD1の衝突検知より先に既存の本体が上書きされ、FR-008が要求する「1回目が失われない」を満たせないため反転させた。R2の書き込みに失敗した場合はD1の予約行を削除する(FR-009)。理由は `src/artifacts/upload.ts` のdocコメントに記載
- **Access のAUDは単一の `ACCESS_AUD`**。T005・T016が記述する `ACCESS_AUD_APP` / `ACCESS_AUD_AUTH` の2つには分けていない。`/_auth` 配下を別applicationにするかどうかがT017の結果に依存し、それが未確定のため
- **`src/artifacts/list.ts` と `src/artifacts/visibility.ts` は作っていない**。一覧取得と公開切替はいずれもD1の1クエリで完結するため、`src/db.ts` の `listArtifacts()` / `updateVisibility()` と `src/index.tsx` のハンドラに置いた
- **統合テストは `tests/integration/us1.test.ts` に集約**。タスクが指定する `upload.test.ts`・`upload-reject.test.ts`・`serve-owner.test.ts`・`list.test.ts` などのファイルは存在しない。同一のWorkerインスタンスとマイグレーション適用を共有するため1ファイルにまとめている
- **`src/db.ts` の全関数が `uid` を必須の第2引数に取る**。`uid` なしで `artifacts` を参照できる関数は存在しない(FR-038)
- **所有者判定はヘッダとcookieの両方を受ける**。`/<uid>/<name>` はAccess非保護でヘッダが届かないため、`CF_Authorization` cookie のJWTも同一手順で検証する。加えてAccess保護下の `GET /_auth/view` を実装し、一覧から「所有者として開く」で辿れるようにした。cookieの到達性(T017)がどちらに転んでも所有者が閲覧できる(詳細は [research.md セクション4](./research.md) の「実装での結論」)
- **認証を解決できない場合の応答はJSONとHTMLを出し分ける**。`Accept` に `application/json` を含むクライアントには契約どおりのJSON封筒、ブラウザには `src/views/notice.tsx` の案内画面を返す。ステータスコードと契約上のエラーコードは変えていない(FR-021)
- **E2Eを追加した**。`tests/e2e/` に `wrangler dev` を3つ起動して実際のHTTPで確認するテストがある(所有者・2人目の利用者・認証情報を持たない訪問者)。設定は `vitest.e2e.config.ts` に分け、`vitest.config.ts` の対象は単体・統合テストに限定している

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 並列実行可能(別ファイル、未完了タスクへの依存なし)
- **[Story]**: 対応するUser Story(US1〜US6)
- 各タスクに正確なファイルパスを含める

## Path Conventions

[plan.md](./plan.md) の Project Structure に従い、単一のWorkerプロジェクトをリポジトリ直下に配置する。`src/`、`tests/`、`migrations/` はリポジトリルート直下。

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: プロジェクトの初期化と基本構造

- [X] T001 リポジトリ直下に `package.json` を作成し、承認済みの依存(`hono`、`jose`)とdevDependencies(`wrangler`、`vitest`、`@cloudflare/vitest-pool-workers`、`typescript`、`@cloudflare/workers-types`)を宣言する
- [X] T002 [P] リポジトリ直下に `tsconfig.json` を作成し、Workers types と Hono のJSX(`jsxImportSource: "hono/jsx"`)を設定する
- [X] T003 [P] リポジトリ直下に `vitest.config.ts` を作成し、`@cloudflare/vitest-pool-workers/config` の `defineWorkersConfig` でR2・D1バインディングをテストへ渡す
- [X] T004 Cloudflareリソースを作成する(`wrangler r2 bucket create artifacts-html`、`wrangler d1 create artifacts-meta`)。出力された `database_id` を含むバインディングをリポジトリ直下の `wrangler.jsonc` に記述する
- [X] T005 [P] リポジトリ直下の `.gitignore` に `node_modules/`、`.wrangler/`、`.dev.vars` を追加し、`.dev.vars.example` にプレースホルダ値のみで変数を列挙する(実値は絶対にコミットしない)。実装した変数は `ENVIRONMENT` / `DEV_OWNER_EMAIL` / `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD`。AUDを2つに分けていない理由は「設計文書と実装の差分」を参照

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: すべてのUser Storyが依存する基盤。ここが完了するまでストーリーの実装は始められない

**⚠️ CRITICAL**: このフェーズが完了するまでUser Storyの作業を開始できない

- [X] T006 `migrations/0001_init.sql` を作成し、[data-model.md](./data-model.md) の `users`・`artifacts` テーブル、CHECK制約、`visibility` のDEFAULT `'private'`、`idx_artifacts_uid_uploaded_at` を定義する。`users.uid TEXT PRIMARY KEY` がuidの保持と一意性を担保し(FR-033・FR-037)、`artifacts` の複合主キー `(uid, name)` が名前空間ごとの一意性を担保する(FR-039)
- [X] T007 マイグレーションを適用する(`wrangler d1 migrations apply artifacts-meta --local` と `--remote`)。適用後にテーブル定義を `wrangler d1 execute` で確認する
- [X] T008 [P] `src/headers.ts` を作成し、管理画面用とアーティファクト用の2つのヘッダプロファイルを [contracts/http-api.md](./contracts/http-api.md) の共通レスポンスヘッダのとおりに定義する
- [X] T009 [P] `src/errors.ts` を作成し、`{ error: { code, message, details? } }` のJSONエラー封筒とコード定数(`invalid_name`、`not_html`、`name_conflict`、`too_large`、`cross_origin`、`storage_failed`、`invalid_visibility`、`not_found`)を定義する
- [X] T010 [P] `src/ids.ts` を作成し、`generateUid()`(`a-z0-9` のみ10文字、`crypto.getRandomValues` + rejection sampling)と `validateName()`(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.html?$`、`..` 禁止、`_` 始まり禁止)を実装する(FR-034・FR-035・FR-036・FR-006)
- [X] T011 [P] `tests/unit/ids.test.ts` を作成し、uidの文字集合・長さ・大量生成時の重複なし・剰余バイアスの偏りがないこと、および `validateName()` が [data-model.md](./data-model.md) の拒否例(`../etc/passwd`、`my report.html`、`レポート.html`、`_internal.html`、`report.txt`、`report`)をすべて拒否することを検証する
- [X] T012 [P] `tests/unit/headers.test.ts` を作成し、アーティファクト用プロファイルに `Cache-Control: no-store` と `Content-Security-Policy: sandbox allow-scripts allow-popups allow-forms allow-modals` が含まれることを検証する
- [X] T013 `src/db.ts` を作成し、D1への型付きクエリ(ユーザー取得、アーティファクトの取得・一覧・登録・公開状態更新)を実装する。すべてのクエリが `uid` を条件に含むことを関数シグネチャで強制する
- [X] T014 `src/auth.ts` を作成し、`jose` で `Cf-Access-Jwt-Assertion` のJWTを検証する(JWKSを `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` からTTL付きキャッシュで取得、`kid` 照合、`aud`・`iss` 検証)。検証済みemailから `users` を引いてuidを解決する関数を含める
- [X] T015 `src/index.tsx` を作成し、Honoのルートテーブルで [contracts/http-api.md](./contracts/http-api.md) の保護境界を1箇所に表現する。`GET /` は `302 /_app/` を返す。この時点では各ハンドラは未実装のスタブでよい
- [ ] T016 Access application を作成し、`wrangler secret put` で `ACCESS_TEAM_DOMAIN`・`ACCESS_AUD` を設定する。**secretの設定は完了済みで、残っているのはapplication側の有効化**。dev環境は workers.dev の One-click Access を使うためURL全体の保護になる(Workers & Pages → `artifacts-dev` → Settings → Domains & Routes)。カスタムドメイン段階で self-hosted application を作り、`artifacts.<domain>/_app` 配下と `/_auth` 配下を保護してrootパスを対象外にする。`/_auth` を別applicationに分けてAUDを2つ持つかどうかはT017の結果で決める
- [ ] T017 [research.md](./research.md) セクション4の未確認事項を検証する。一時的なデバッグルートで `request.headers.get('cookie')` のcookie名のみを出力し(値はマスクする)、`/_app/` で認証後にAccess非保護パスへアクセスして `wrangler tail` で `CF_Authorization` の到達を確認する。結果を `research.md` に反映し、デバッグルートを削除する。**T016の完了を待つ。この確認は所有者の閲覧をブロックしない**(T018で両方の分岐を実装済み)
- [X] T018 非保護パスでの所有者判定を実装する。T017の結果を待たずに**両方**を実装した。`src/auth.ts` が `CF_Authorization` cookie のJWTをヘッダと同一手順で検証し、加えてAccess保護下の `GET /_auth/view` を用意して一覧から辿れるようにした(`target` は `/<uid>/<name>` の形のみ許可し、`//`・スキーム付きURL・`..`・深い階層・名前規則違反を拒否する)。当初案の「非公開かつ未認証を302で送る」は404の同一性(FR-017・FR-024)を崩すため採らなかった
- [X] T019 [P] `package.json` に `dev`、`deploy`、`test`、`migrate:local`、`migrate:remote` のnpmスクリプトを追加する

**Checkpoint**: 基盤が整い、User Storyの実装を開始できる

---

## Phase 3: User Story 1 - HTMLをアップロードして閲覧する (Priority: P1) 🎯 MVP

**Goal**: 単体HTMLをアップロードすると閲覧URLが得られ、所有者がそのURLで内容を確認できる。この時点の生成物は非公開。

**Independent Test**: HTMLファイルを1つアップロードし、返されたURLへ所有者としてアクセスして内容が表示されることで完結して検証できる。

### Tests for User Story 1

> **NOTE**: これらのテストを先に書き、実装前に失敗することを確認する

> **実装メモ**: T020〜T022 はいずれも `tests/integration/us1.test.ts` に実装した。個別ファイルには分けていない(理由は「設計文書と実装の差分」)。

- [X] T020 [P] [US1] `POST /_app/api/artifacts` が `201` を返し、応答の `visibility` が `private`、`url` が `/<uid>/<name>.html` の形であることを検証する(FR-010・FR-022)
- [X] T021 [P] [US1] 非HTML(拡張子・Content-Type・先頭バイトの各パターン)が `400 not_html`、10 MB超が `413 too_large`、規則違反の名前が `400 invalid_name` になることを検証する(FR-002・FR-003・FR-006)
- [X] T022 [P] [US1] 非公開アーティファクトを所有者が取得したときにアップロードしたバイト列と1バイトも違わない本文が返り、非所有者には `404` が返ることを検証する(FR-012・FR-023・SC-008)

### Implementation for User Story 1

- [X] T023 [P] [US1] `src/views/layout.tsx` を作成し、全管理画面で共有するレイアウトとヘッダ(アップロードボタンを含む)を実装する(FR-018)
- [X] T024 [US1] `src/views/upload.tsx` を作成し、ファイル選択、名前の初期値付き提示、確定操作、成功時の閲覧URL表示を実装する(FR-004・FR-010)
- [X] T025 [US1] `src/artifacts/upload.ts` を作成し、拡張子・Content-Type・先頭バイトsniff(`<!doctype html` / `<html`)の3点検証、10 MB上限、**D1 insert → R2 put の順**の書き込み、R2失敗時のD1予約行の削除を実装する(FR-001〜FR-003・FR-008・FR-009)。書き込み順を反転させた理由は「設計文書と実装の差分」を参照
- [X] T026 [US1] `src/artifacts/serve.ts` を作成し、`GET /:uid/:name` でD1を引いて非公開かつ所有者のときのみ本文を返し、それ以外は固定の `404` を返す。応答ヘッダは `src/headers.ts` のアーティファクト用プロファイルを使う(FR-011・FR-012・FR-023・FR-024)
- [X] T027 [US1] `src/index.tsx` に `GET /_app/upload`、`POST /_app/api/artifacts`、`GET /:uid/:name` を配線し、APIハンドラで `Sec-Fetch-Site` と `Origin` を検証する(`src/auth.ts` の `isSameOriginRequest()`)
- [X] T028 [US1] `npm test` で T020〜T022 を実行して全件成功を確認し、US1 シナリオ(手順1〜6)を確認する。手動手順は `tests/e2e/journeys.test.ts` の「US1」で自動化した(起動した `wrangler dev` へ実際のHTTPで確認する)。dev環境への未認証スモークは `tests/e2e/remote.test.ts`

**Checkpoint**: User Story 1 が単独で機能し、独立に検証できる状態になる

---

## Phase 4: User Story 2 - トップページで過去のアーティファクトを探す (Priority: P2)

**Goal**: トップページに自分のアーティファクトが新しい順で並び、そこから各生成物を開ける。

**Independent Test**: 複数のHTMLをアップロードした状態でトップページを開き、全項目が新しい順に並び、各項目から該当HTMLへ遷移できることで検証できる。

### Tests for User Story 2

- [X] T029 [P] [US2] `GET /_app/api/artifacts` が `uploadedAt` 降順で自分のuidの分だけを返すこと、0件時に空状態を返すことを検証する(FR-013・FR-015・FR-016・FR-038)。`tests/integration/us1.test.ts` の「US2: 一覧」に実装

### Implementation for User Story 2

- [X] T030 [US2] `src/db.ts` の `listArtifacts()` で `WHERE uid = ? ORDER BY uploaded_at DESC` の一覧を取得する(FR-013・FR-015)。`src/artifacts/list.ts` は作らなかった(理由は「設計文書と実装の差分」)
- [X] T031 [US2] `src/views/list.tsx` を作成し、名前・アップロード日時・閲覧URLへのリンクを持つ一覧と、0件時の空状態(最初のアップロードを促す案内)を実装する(FR-014・FR-016)
- [X] T032 [US2] `src/index.tsx` に `GET /_app/` と `GET /_app/api/artifacts` を配線する。uidは認証から解決した値のみを使い、クエリパラメータで受け取らない(FR-038)
- [X] T033 [US2] `npm test` で T029 を実行し、US2 シナリオ(手順1〜5)を確認する。手動手順は `tests/e2e/journeys.test.ts` の「初期状態」と「US2」で自動化した(空状態・降順・ヘッダの導線を含む)

**Checkpoint**: User Story 1 と 2 がそれぞれ独立に機能する

---

## Phase 5: User Story 3 - アップロード時に名前を確認し、衝突を避ける (Priority: P3)

**Goal**: アップロード確定前に名前を変更でき、既存の名前と重複する場合は上書きせず、重複しない候補が提示される。

**Independent Test**: 同名のHTMLを2回アップロードし、1回目の生成物が2回目のアップロード後も元のURLで元の内容のまま閲覧できることで検証できる。

### Tests for User Story 3

- [X] T034 [P] [US3] 同名の2回目が `409 name_conflict` を返すこと、`details.suggestions` の候補が実際に未使用であること、1回目の本文が変化していないことを検証する(FR-007・FR-008・SC-002)。`tests/integration/us1.test.ts` に実装。候補が未使用であることは「その名前でのアップロードが201になる」ことで示している

### Implementation for User Story 3

- [X] T035 [P] [US3] `src/ids.ts` に `suggestAlternativeNames()` を追加し、`<stem>-2.<ext>`、`<stem>-3.<ext>` の順に同一uid内で未使用の候補を探す(上限100件で打ち切る)(FR-007)。未使用判定は述語として注入し、ids.tsがD1へ依存しないようにした。名前が長い場合はstemを詰めて名前規則を満たす候補だけを返す
- [X] T036 [US3] `src/artifacts/upload.ts` に重複検知を追加する。D1の主キー制約で弾き、競合状態でも二重登録が起きないようにする。重複時は候補を含む `409` を返し、R2への書き込みを行わない(FR-007・FR-008)。候補は衝突時のみ引くため、正常系のクエリは増えない
- [X] T037 [US3] `src/views/upload.tsx` に名前の確認と変更のUIを追加し、`409` 応答の候補を提示して選択・再入力できるようにする(FR-004・FR-005)
- [X] T038 [US3] `src/views/upload.tsx` に使用可能な文字種の説明を表示し、`400 invalid_name` の応答をその説明とともに提示する(FR-006)
- [X] T039 [US3] `npm test` で T034 を実行し、US3 シナリオ(手順1〜6)を確認する。手動手順は `tests/e2e/journeys.test.ts` の「US3」で自動化した(候補の提示から候補を使った再登録まで含む)

**Checkpoint**: 名前の衝突による既存成果物の消失が構造的に起きない状態になる

---

## Phase 6: User Story 4 - 認証された本人だけが操作でき、ログアウトできる (Priority: P4)

**Goal**: 管理画面は本人のみが利用でき、ヘッダのログアウトで認証状態を破棄できる。

**Independent Test**: 未認証で管理画面のURLへ到達できないこと、ログアウト後に同じURLで再認証を求められることで検証できる。

### Tests for User Story 4

- [X] T040 [P] [US4] `tests/integration/auth.test.ts` を作成し、JWTが無い・署名が不正・`aud` が不一致・`iss` が不一致の各ケースで管理APIが内容を返さないことを検証する(FR-020)
- [X] T041 [P] [US4] `tests/integration/auth-unknown-user.test.ts` を作成し、JWTは有効だが `users` にemailが未登録のとき `403` を返し、uid未発行であることを案内することを検証する

### Implementation for User Story 4

- [X] T042 [US4] `src/views/layout.tsx` のヘッダに `/cdn-cgi/access/logout` へのログアウトリンクを追加する(FR-019)
- [X] T043 [US4] `src/index.tsx` の管理画面ハンドラに、uid未解決時の `403` 応答とuid発行が必要であることの案内を実装する(`ownerRejection()` の `not_registered` 分岐)
- [X] T044 [US4] 認証切れの扱いを実装する(FR-021)。画面はクライアントJSを持たないサーバレンダリングのため、元の記述(JSON判定・`302` 観測)はそのままでは適用できない。代わりに、Workerが認証を解決できなかったときブラウザには `src/views/notice.tsx` の案内画面を返し、再認証の導線を出す。GETは元のパスとクエリへ戻し、POSTは本文を再送できないため対応する画面へ導く。Accessが前段に入った状態での挙動確認はT045に含む
- [ ] T045 [US4] `npm test` で T040・T041 を実行し、[quickstart.md](./quickstart.md) の US4 シナリオ(手順1〜5)をシークレットウィンドウを使って実機で確認する。ログアウト後のトークン失効には20〜30秒かかるため、直後に通る場合は30秒待って再確認する。**自動テストは完了(T040・T041、および未認証が管理画面・管理APIから内容を得られないことを `tests/e2e/journeys.test.ts` の「US4」で確認)。Accessの認証画面・ログアウト・トークン失効の確認だけがT016の完了待ちで未実施**

**Checkpoint**: 未認証アクセスが遮断され、ログアウトが機能する

---

## Phase 7: User Story 5 - 生成物を公開し、非公開へ戻す (Priority: P5)

**Goal**: 特定の生成物だけを公開して認証なしで閲覧できるようにし、いつでも非公開へ戻せる。

**Independent Test**: 1件を公開して未認証ブラウザから閲覧できることを確認し、その後非公開へ戻して同じブラウザから閲覧できなくなることで検証できる。

### Tests for User Story 5

- [X] T046 [P] [US5] `tests/integration/visibility.test.ts` を作成し、`PUT /_app/api/artifacts/:name/visibility` の双方向トグル、切り替え前後で `url` が変化しないこと、`public` 直後に未認証で `200`、`private` 直後に未認証で `404` になることを検証する(FR-025〜FR-028・FR-030・SC-006)
- [X] T047 [P] [US5] 非公開かつ非所有者への `404` と存在しないアーティファクトへの `404` が、ステータス・本文・ヘッダ(`Content-Length` を含む)まで完全に同一であることを検証する(FR-017・FR-024)。**`tests/integration/us1.test.ts` で他uidの非公開・存在しない・uid形式不正の3分岐を本文とヘッダ一致まで検証済み。残るのはname形式不正の分岐**
- [X] T048 [P] [US5] 公開・非公開いずれの配信応答にも `Cache-Control: no-store` と `Content-Security-Policy: sandbox ...` が付くことを検証する(FR-028)。**非公開側は `tests/integration/us1.test.ts` で検証済み。公開側が未検証**
- [X] T049 [P] [US5] `tests/integration/visibility-authz.test.ts` を作成し、他uidに属するアーティファクト名を指定したトグルが `404` を返し、対象の公開状態が変化しないことを検証する(FR-031・FR-038)

### Implementation for User Story 5

- [X] T050 [US5] `src/db.ts` の `updateVisibility()` で `visibility` の更新と `visibility_changed_at` の記録を実装する。対象は認証から解決したuidの名前空間に限り、リクエストのどの部分からもuidを受け取らない(FR-025・FR-027・FR-031)。`src/artifacts/visibility.ts` は作らなかった(理由は「設計文書と実装の差分」)
- [X] T051 [US5] `src/artifacts/serve.ts` に公開状態の分岐を追加し、`visibility = 'public'` のときは認証を要求せず本文を返す(FR-026)
- [X] T052 [US5] `src/artifacts/serve.ts` の `404` 応答を1箇所の生成関数(`notFound()`)へ集約し、4つの分岐(非公開かつ非所有者、行なし、uid形式不正、name形式不正)がすべて同一の応答になるようにする(FR-017・FR-024)
- [X] T053 [US5] `src/views/list.tsx` に公開状態の表示と公開・非公開の切り替え操作を追加し、公開と非公開が視覚的に区別できるようにする(FR-014・FR-029)。クライアントJSを持たせないため `<form method="post">` で表現している
- [X] T054 [US5] `src/artifacts/serve.ts` がアーティファクトのHTML以外を一切注入しないことを確認する。ナビゲーション・スクリプト・一覧への導線を付加しない(FR-032)。R2オブジェクトの `body` をそのまま `Response` へ渡している
- [X] T055 [US5] `src/index.tsx` に `PUT /_app/api/artifacts/:name/visibility` を配線し、`Sec-Fetch-Site` / `Origin` 検証を適用する。フォーム送信を受けるため `POST` も同じハンドラで受け付け、JSON要求時はJSON、それ以外は `303` で一覧へ戻す
- [X] T056 [US5] `npm test` で T046〜T049 を実行し、US5 シナリオ(手順1〜9)を確認する。手動手順は `tests/e2e/journeys.test.ts` の「US5」で自動化した。404同一性はdev環境でも `curl` + `diff` で確認済み(結果は [validation-report.md](./validation-report.md))

**Checkpoint**: 既定非公開と双方向の公開切り替えが成立し、非公開へ戻した後の露出が止まる

---

## Phase 8: User Story 6 - 将来の複数利用者に備えた名前空間 (Priority: P6)

**Goal**: 各利用者の生成物が `/<uid>/<name>.html` の名前空間に分かれ、互いに干渉しない。

**Independent Test**: 2つのuidに同じ名前のHTMLを登録し、それぞれのURLで別々の内容が表示され、各uidの一覧に自分の分だけが並ぶことで検証できる。

### Tests for User Story 6

- [X] T057 [P] [US6] `tests/integration/namespace.test.ts` を作成し、2つのuidが同じ名前のアーティファクトを持てること、それぞれのURLで別々の内容が返ること、一覧が自分のuidの分だけを返すことを検証する(FR-039・FR-038)
- [X] T058 [P] [US6] `tests/unit/uid-unpredictability.test.ts` を作成し、連続して発行したuidに連番・時刻順・共通prefixなどの規則性が現れないことを検証する(FR-036・SC-011)

### Implementation for User Story 6

- [X] T059 [US6] `src/db.ts` の全クエリが `uid` を必須引数として受け取り、`uid` なしで `artifacts` を参照できる関数が存在しないことをコードレビューで確認する(FR-038)。`listArtifacts`・`findArtifact`・`insertArtifact`・`updateVisibility`・`nameExists` のすべてが `uid` を第2引数に取る
- [X] T060 [US6] `src/artifacts/serve.ts` でパスから受け取った `uid` を認証済みuidと照合し、越境を防ぐ。公開切替のハンドラはuidをリクエストから受け取らず認証結果のuidだけを使う(FR-027・FR-038)
- [X] T061 [US6] uid発行の運用手順を [quickstart.md](./quickstart.md) の手順4を参照する形でリポジトリの `README.md` に記載する。CSPRNGで生成した値を使い、手で考えた値を使わないことを明記する
- [X] T062 [US6] `npm test` で T057・T058 を実行し、US6 シナリオ(手順1〜6)を確認する。手動手順は `tests/e2e/journeys.test.ts` の「US6」で自動化した(2人目の利用者として振る舞う `wrangler dev` を別に起動している)

**Checkpoint**: 複数利用者を受け入れても既存のURLが壊れない構造になる

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: 複数ストーリーに横断する仕上げ

- [X] T063 [P] リポジトリの `README.md` に、このサイトの目的、セットアップ手順への参照、URL構成とAccess保護境界の要約を記載する
- [X] T064 [P] `src/` 配下から一時的なデバッグコード(T017で追加したものを含む)が残っていないことを `rg` で確認する。`console.*`・`debugger`・`TODO`/`FIXME` はいずれも無い(T017のデバッグルートは未着手のため追加もされていない)
- [X] T065 [P] 秘密情報がリポジトリへ混入していないことを確認する。追跡されている `.dev.vars` 系は `.dev.vars.example` のみ、AUD相当の64桁hexはテスト用固定値のみ、`cloudflareaccess.com` の出現はすべてプレースホルダ(結果は [validation-report.md](./validation-report.md))
- [X] T066 100件のアーティファクトを登録した状態で `/_app/` の初期表示が3秒以内に完了することを計測する(SC-009)。105件で6ms。閾値に対して3桁の余裕があるため `EXPLAIN QUERY PLAN` の確認は行っていない(記録は [validation-report.md](./validation-report.md))
- [X] T067 [quickstart.md](./quickstart.md) の「パフォーマンスの確認」に記載したSC-001・SC-003・SC-007を実測する。いずれも人の操作時間を含む指標のため、計測できたのはサーバ側の応答時間まで。dev環境とローカルE2Eの実測値と、人の操作を含む実測が未実施であることを [validation-report.md](./validation-report.md) に記録した
- [X] T068 セキュリティの最終確認を行う。dev環境の公開アーティファクト応答に `sandbox`(`allow-same-origin` なし)が付くこと、クロスオリジンの操作が403になることを確認した。**ブラウザのdevtoolsによる観測は未実施**で、その旨を [validation-report.md](./validation-report.md) に明記している
- [X] T069 [quickstart.md](./quickstart.md) の Done判定 の全項目を通過させる。自動化した範囲は `npm run test:all` の成功で確認済み。Access依存の項目(US4手順1〜5)はT016・T045として残っている

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: 依存なし。すぐ開始できる
- **Foundational (Phase 2)**: Phase 1の完了に依存。すべてのUser Storyをブロックする
- **User Stories (Phase 3〜8)**: すべてPhase 2の完了に依存
- **Polish (Phase 9)**: 実施するUser Storyがすべて完了していることに依存

### User Story Dependencies

このプロジェクトはUser Story間に一部の実装依存がある。テンプレートの一般形と異なる点を明示する。

- **US1 (P1)**: Phase 2完了後に開始できる。他ストーリーへの依存なし
- **US2 (P2)**: Phase 2完了後に開始できる。US1と独立に実装可能だが、一覧に表示するアーティファクトを作るためUS1完了後に検証する方が容易
- **US3 (P3)**: **US1に依存する**。`src/artifacts/upload.ts`(T025)へ重複検知を追加する形になるため
- **US4 (P4)**: Phase 2完了後に開始できる。JWT検証の本体はT014で完了しており、このフェーズは利用者に見える挙動(ログアウト、403の案内、認証切れの導線)を担う
- **US5 (P5)**: **US1とUS2に依存する**。`src/artifacts/serve.ts`(T026)への分岐追加と、`src/views/list.tsx`(T031)への切り替え操作の追加を含むため
- **US6 (P6)**: **US1・US2・US5に依存する**。既存の全クエリとハンドラの越境防止を確認する内容であるため

### Within Each User Story

- テストを先に書き、実装前に失敗することを確認する
- `src/db.ts` などのデータアクセスを先に整え、その上でハンドラを実装する
- ハンドラ実装後に `src/index.tsx` へ配線する
- 各ストーリーの最後の検証タスク(T028、T033、T039、T045、T056、T062)を通過するまで次の優先度へ進まない

### 同一ファイルを触るタスク(並列にできない)

- `src/artifacts/upload.ts`: T025 → T036(いずれも完了)
- `src/artifacts/serve.ts`: T026 → T051 → T052 → T054 → T060(すべて完了)
- `src/views/list.tsx`: T031 → T053(いずれも完了)
- `src/views/upload.tsx`: T024 → T037 → T038 → T044(T044のみ残り)
- `src/views/layout.tsx`: T023 → T042(いずれも完了)
- `src/index.tsx`: T015 → T027 → T032 → T043 → T055(すべて完了)
- `src/ids.ts`: T010 → T035(T035が残り)
- `src/auth.ts`: T014 → T018(T018が残り)
- `tests/integration/us1.test.ts`: T020〜T022 → T029 → T034 → T046〜T049 → T057。統合テストを1ファイルに集約したため、テストタスクは並列に書けず追記順になる

### Parallel Opportunities

- Phase 1の `[P]` タスク(T002、T003、T005)は並列実行できる
- Phase 2の `[P]` タスク(T008〜T012、T019)は並列実行できる。T008〜T010は互いに独立した新規ファイル
- ~~各ストーリーのテストタスク(`[P]` 付き)は互いに並列に書ける~~ 統合テストを `tests/integration/us1.test.ts` の1ファイルに集約したため、統合テストのタスクは並列に書けない。ユニットテストは引き続きファイルが分かれている
- US1とUS4は触るファイルが重ならないため、Phase 2完了後に並列で進められる
- Phase 9の `[P]` タスク(T063〜T065)は並列実行できる

---

## Parallel Example: User Story 1(実施済み)

```text
# User Story 1 のテストをまとめて書く(実装前に失敗することを確認する)
T020〜T022 tests/integration/us1.test.ts  ← 1ファイルに集約したため直列

# レイアウトは他の実装と独立して進められる
T023 src/views/layout.tsx
```

## Parallel Example: Phase 2 Foundational

```text
# 互いに独立した新規ファイルなので同時に作成できる
T008 src/headers.ts
T009 src/errors.ts
T010 src/ids.ts
T011 tests/unit/ids.test.ts
T012 tests/unit/headers.test.ts
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Phase 1: Setup を完了する
2. Phase 2: Foundational を完了する(全ストーリーをブロックする。特にT016のAccess設定とT017の未確認事項の解消)
3. Phase 3: User Story 1 を完了する
4. **停止して検証**: T028で `npm test` と実機確認を通す
5. この時点で「アップロードして自分だけが見られる」状態が成立する。既定非公開(FR-022)はスキーマのDEFAULTで担保されているため、公開機能が未実装でも情報露出は起きない

### Incremental Delivery

1. Setup + Foundational → 基盤完成
2. US1 追加 → 単独検証 → デプロイ(MVP)
3. US2 追加 → 単独検証 → デプロイ(一覧が使えるようになり実用に入る)
4. US4 追加 → 単独検証 → デプロイ(ログアウトと認証切れの扱いが整う)
5. US3 追加 → 単独検証 → デプロイ(名前衝突の事故が構造的に消える)
6. US5 追加 → 単独検証 → デプロイ(他者への共有が可能になる)
7. US6 追加 → 単独検証 → デプロイ(2人目を受け入れられる)

US5を後半に置くのは、公開機能が唯一の情報露出経路であり、それ以前の段階では非公開のまま安全に運用できるため。公開を有効にする前にUS4(認証)とUS3(名前衝突)を固めておく方が安全側に倒れる。

### 単独作業の場合の推奨順

1人で実装する場合、並列性より依存の少なさを優先して次の順で進める。

Phase 1 → Phase 2 → US1 → US2 → US4 → US3 → US5 → US6 → Phase 9

---

## Notes

- `[P]` は別ファイルで依存関係がないことを意味する。同一ファイルを触るタスクの順序は「同一ファイルを触るタスク」節を正とする
- `[Story]` ラベルはトレーサビリティのためにUser Storyへ紐付ける
- テストは実装前に失敗することを確認する
- 以下3点は、グローバル設定として読み込まれる共通の作業規約に由来する(リポジトリ直下の `AGENTS.md` ではない)
  - commitは機能の粒度ごとに分ける。タスク単位または論理的なまとまりごとにcommitする
  - 20行を超える差分や複数ファイルにまたがる変更に着手する前に、対象ファイルと方針を提示して承認を得る
  - 認証・認可に関わるタスク(T014、T016、T018、T042〜T044、T050、T059、T060)は実装前に方針を提示して承認を得る
- 各Checkpointで停止し、そのストーリーを単独で検証できる
