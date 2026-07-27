# Validation Report: 2026-07-27

[tasks.md](./tasks.md) の Phase 9 と [quickstart.md](./quickstart.md) の Done判定に対する実測の記録。**確認した事実と未確認の事項を分けて書く。**

## 対象

- dev環境: `https://artifacts-dev.ohgi-211.workers.dev`
- Worker Version ID: `38b22369-0b3f-4bcc-a579-c69ab1056434`(2026-07-27、main へのマージ後に再デプロイ)
  - 本レポートの計測は同一の `src/` を持つ `d4c57966-ceb0-4acb-a445-142a5d7e84a9` に対して行い、再デプロイ後に未認証スモーク6件を再実行して同じ結果を確認した
- D1: `artifacts-meta-dev`(マイグレーション適用済み、`No migrations to apply!`)
- R2: `artifacts-html-dev`

## 自動テスト

- `npx tsc --noEmit`: エラーなし
- `npm test`(単体・統合): 10ファイル・152件すべて成功
- `npm run test:e2e`(ローカルE2E): 31件すべて成功
- `tests/e2e/remote.test.ts`(dev環境への未認証スモーク): 6件すべて成功

ローカルE2Eは `wrangler dev` を3つ起動し、所有者・2人目の利用者・認証情報を持たない訪問者の3つの立場から同じローカルのD1/R2を見る構成。US1〜US6のうちAccess自体に依存しない項目を自動で確認している。

## 計測

### SC-009: 100件で一覧が3秒以内(T066)

ローカルのE2E内で計測。105件のアーティファクトを登録した状態で `/_app/` の生成に **6ms**。`idx_artifacts_uid_uploaded_at` を用いた `WHERE uid = ? ORDER BY uploaded_at DESC` の1クエリのみで、件数に対する余裕は十分にある。`EXPLAIN QUERY PLAN` による確認は、閾値に対して3桁の余裕があるため実施していない。

### dev環境の応答時間(T067の一部)

東京から3回計測した最小値/中央値。

- `/` → 302: min 56ms / median 76ms
- `/_app/` → 401: min 67ms / median 75ms
- `/<uid>/e2e-public.html` → 200: min 187ms / median 238ms
- `/<uid>/nonexistent.html` → 404: min 80ms / median 84ms

SC-001(ファイル選択から閲覧URL取得まで30秒以内)、SC-003(目的の生成物を開くまで10秒以内)、SC-007(公開切替を10秒以内)は人の操作時間を含む指標のため、自動計測できるのはサーバ側の応答時間だけである。ローカルE2Eでの実測はアップロード12ms、一覧4ms、公開切替38msで、いずれも指標に対してサーバ側が制約にならないことは言える。**人の操作を含む実測は未実施。**

## セキュリティの確認

### アーティファクト応答のヘッダ(T068)

dev環境の公開アーティファクトに対する実測。

```text
HTTP/2 200
content-type: text/html; charset=utf-8
cache-control: no-store
content-security-policy: sandbox allow-scripts allow-popups allow-forms allow-modals
referrer-policy: no-referrer
x-content-type-options: nosniff
```

`sandbox` に `allow-same-origin` を含めないため、アーティファクトのdocumentは一意のopaque originに置かれる。したがって `/_app/api/*` への資格情報付き同一オリジンリクエストは成立しない。多層防御として `Sec-Fetch-Site` / `Origin` の検証も入っている(`tests/integration/visibility.test.ts` でクロスオリジンが403になることを確認)。

**ブラウザのdevtoolsによる確認は未実施。** 上記はヘッダの実測と仕様からの帰結であり、実際のブラウザで `fetch` が失敗する様子を観測したものではない。

### 404の同一性(FR-017・FR-024)

dev環境で非公開アーティファクトと存在しないアーティファクトを比較した。

- 本文: 完全一致(`diff` で差分なし)
- ヘッダ: `Date`、`cf-ray`、`report-to` を除いて完全一致

差が出た3つはいずれもCloudflareのエッジがリクエストごとに付ける値で、Workerの応答に由来しない。アーティファクトの存在有無は判別できない。

### デバッグコードと秘密情報(T064・T065)

- `src/` に `console.*`・`debugger`・`TODO`/`FIXME` は無い
- 一時的なcookieダンプ経路は無い(`src/auth.ts` のcookie参照は所有者判定の実装そのもの)
- 追跡されている `.dev.vars` 系のファイルは `.dev.vars.example` のみ
- AUDタグ相当の64桁hexは `tests/integration/auth.test.ts` のテスト用固定値だけ
- `cloudflareaccess.com` の出現箇所はすべてプレースホルダ(`yourteam` / `myteam` / `example-team`)

## Access有効化後の観測(2026-07-27、追記)

Cloudflare Access を workers.dev で有効化した後、未認証から再観測した。

- `/`、`/_app/`、`/<uid>/e2e-public.html`、`/<uid>/e2e-private.html`、`/<uid>/nonexistent.html` のすべてが `302` で `https://y-ohgi.cloudflareaccess.com/cdn-cgi/access/login/...` へ送られる
- 管理画面へのログインは成功する(利用者による確認)

workers.dev の One-click Access は**ホスト全体**を保護する。管理画面の保護(FR-020)は意図どおり成立する一方、アーティファクトの配信パスもAccessの内側に入るため、**公開アーティファクトを未認証で読ませる要件(FR-026・US5)はこの構成では成立しない**。全アーティファクトが非公開であるMVPのスコープとは矛盾しない。

他者への共有を有効にするには、カスタムドメインへ移して `/_app` と `/_auth` だけを保護するパス単位の境界へ切り替える(contracts/http-api.md)。Worker側の実装は変更不要で、保護境界の設定だけが変わる。

`tests/e2e/remote.test.ts` は保護の形を観測してから期待値を選ぶようにした。現在は `host` と判定され、6件のうち4件が成功、公開配信に関する2件が理由付きでスキップされる。

## 残っている作業

いずれも Cloudflare 側の操作か、人の目による確認を要する。

1. **US4の残りの手動確認**: ログアウトが機能すること、既発行トークンが20〜30秒で失効すること(認証画面が出ることと認証後に使えることは確認済み)
2. **T017: `CF_Authorization` cookieの到達性の実測**。現在の構成では配信パスもAccess保護下にあり `Cf-Access-Jwt-Assertion` が届くため、この確認が必要になるのはカスタムドメインへ移した後。実装は届く場合と届かない場合の両方に対応済み([research.md セクション4](./research.md))
3. **SC-001・SC-003・SC-007の人による実測**
4. **(US5を使う場合)カスタムドメインへの移行**。上の「Access有効化後の観測」を参照

## 参考: dev環境に置いたスモーク用データ

`tests/e2e/remote.test.ts` を実行するための固定データを uid `cmlnc9ifiv` に置いた。不要になったら削除してよい。

- `e2e-public.html`(公開)
- `e2e-private.html`(非公開)

```sh
npx wrangler d1 execute artifacts-meta-dev --env dev --remote \
  --command "DELETE FROM artifacts WHERE name LIKE 'e2e-%'"
npx wrangler r2 object delete artifacts-html-dev/cmlnc9ifiv/e2e-public.html --remote
npx wrangler r2 object delete artifacts-html-dev/cmlnc9ifiv/e2e-private.html --remote
```
