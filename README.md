# artifacts

生成した単体HTMLをアップロードして閲覧・共有するための小さなサイト。Cloudflare Workers 上で動き、本体は R2、メタデータは D1 に置く。既定は非公開で、必要なものだけを公開へ切り替えて他者へ渡せる。

設計と要件は `specs/001-html-artifact-hosting/` にある。

- [spec.md](specs/001-html-artifact-hosting/spec.md) — 何を作るか、なぜ作るか
- [plan.md](specs/001-html-artifact-hosting/plan.md) — 技術構成とディレクトリ方針
- [contracts/http-api.md](specs/001-html-artifact-hosting/contracts/http-api.md) — HTTPの契約と保護境界
- [data-model.md](specs/001-html-artifact-hosting/data-model.md) — D1のスキーマとR2のキー設計
- [quickstart.md](specs/001-html-artifact-hosting/quickstart.md) — セットアップと検証手順
- [tasks.md](specs/001-html-artifact-hosting/tasks.md) — 実装状況

## URL構成と保護境界

Cloudflare Access が遮断する範囲と、Worker が判定する範囲を分けている。

- `/_app/*` — Access保護。管理画面と管理API。未認証はWorkerへ到達しない
- `/_auth/view` — Access保護。所有者が自分の非公開アーティファクトを開くための経路
- `/cdn-cgi/access/*` — Cloudflare Access が処理する。ログアウトもここ
- `/` — Access非保護。`/_app/` へリダイレクトする
- `/<uid>/<name>.html` — **Access非保護**。公開状態をWorkerが判定する

`/<uid>/<name>.html` を Access で保護してはならない。保護すると公開アーティファクトへの未認証アクセスが成立しなくなる。

アーティファクトの応答には常に `Cache-Control: no-store` と `Content-Security-Policy: sandbox ...` が付く。アップロードされたHTMLは不透明なオリジンに置かれ、管理画面のCookieやAPIへは触れられない。本文はR2に保存したバイト列をそのまま返し、ナビゲーションもスクリプトも注入しない。

非公開のアーティファクトと存在しないアーティファクトは、ステータス・本文・ヘッダが完全に同一の404を返す。応答から存在の有無を判別できない。

## セットアップ

前提と手順の詳細は [quickstart.md](specs/001-html-artifact-hosting/quickstart.md) を参照する。要点だけ挙げる。

```sh
npm install

# リソース(初回のみ)
npx wrangler r2 bucket create artifacts-html-dev
npx wrangler d1 create artifacts-meta-dev   # 出力の database_id を wrangler.jsonc へ

# スキーマ
npm run migrate:local
npm run migrate:remote

# デプロイ
npm run deploy
```

Cloudflare Access の設定は Cloudflare 側の操作が必要で、`wrangler` からは行えない。

1. Zero Trust で管理画面を保護する(dev環境は Workers & Pages → `artifacts-dev` → Settings → Domains & Routes の workers.dev で有効化する)

   **workers.dev の One-click Access はホスト全体を保護する。** 管理画面は守られるが、アーティファクトの配信パスもAccessの内側に入るため、公開アーティファクトを未認証で読ませること(FR-026)はできない。全アーティファクトを非公開で使う分には問題ない。他者への共有を使うには、カスタムドメインへ移して `/_app` と `/_auth` だけを保護する。

2. Access application の AUD タグとチームドメインを控える
3. secret を設定する

```sh
npx wrangler secret put ACCESS_TEAM_DOMAIN --env dev   # 例: myteam.cloudflareaccess.com
npx wrangler secret put ACCESS_AUD --env dev
```

secret が揃うまで管理画面は認証を通さない(fail closed)。ローカル開発では `.dev.vars.example` をコピーして `.dev.vars` を作る。`ENVIRONMENT=local` のときだけ `DEV_OWNER_EMAIL` を所有者として扱う分岐が有効になり、この変数は `wrangler.jsonc` に書かないためデプロイ環境では絶対に有効にならない。

## uidの発行

uidは利用者ごとの名前空間で、`/<uid>/<name>.html` の一部として外に出る。初期リリースでは手作業で発行する。

**手で考えた値を使ってはならない。** 非公開アーティファクトのURLの一部であり、1つ知られたときに他を推測できてはならない(FR-036・SC-011)。必ずCSPRNGで生成する。

```sh
# a-z0-9 の10文字を生成する
node -e 'const a="abcdefghijklmnopqrstuvwxyz0123456789";const b=require("crypto").randomBytes(64);let s="";for(const x of b){if(x<252&&s.length<10)s+=a[x%36]}console.log(s)'
```

生成した値で登録する。`email` は Cloudflare Access が返す値と完全に一致させる。一致しないと認証は通るがuidが解決できず、uid発行が必要であることを案内する403になる。

```sh
npx wrangler d1 execute artifacts-meta-dev --env dev --remote \
  --command "INSERT INTO users (uid, email, created_at) VALUES ('<uid>', '<email>', '<ISO8601>')"
```

手順の全体は [quickstart.md](specs/001-html-artifact-hosting/quickstart.md) の手順4にある。

## 開発

```sh
npm run dev         # wrangler dev(ローカルのD1/R2を使う)
npm run typecheck   # tsc --noEmit
npm test            # 単体・統合テスト(vitest-pool-workers)
npm run test:e2e    # E2E(wrangler dev を起動して実際のHTTPで確認する)
npm run test:all    # 上の3つを順に実行する
```

`npm test` は Worker を直接呼び出す単体・統合テスト。`npm run test:e2e` は `wrangler dev` を3つ起動し、所有者・2人目の利用者・認証情報を持たない訪問者の3つの立場から同じデータを見て、公開状態による見え方の違いまで確認する。

デプロイ済み環境への未認証スモークは、環境変数を渡したときだけ走る。

```sh
E2E_REMOTE_BASE_URL=https://artifacts-dev.example.workers.dev \
E2E_REMOTE_UID=<uid> \
E2E_REMOTE_PUBLIC_NAME=<公開済みの名前>.html \
E2E_REMOTE_PRIVATE_NAME=<非公開の名前>.html \
npx vitest run --config vitest.e2e.config.ts tests/e2e/remote.test.ts
```

Cloudflare Access 自体はローカルに存在しないため、Accessの認証画面・ログアウト・トークン失効の確認だけは手動で行う([quickstart.md](specs/001-html-artifact-hosting/quickstart.md) の US4)。

## 構成

```text
src/
  index.tsx          ルーティングと保護境界の表現
  auth.ts            Access JWT の検証(ヘッダとcookieの両方)とuidの解決
  db.ts              D1へのクエリ。すべてuidを必須引数に取る
  ids.ts             uid生成、名前の検証、衝突時の候補生成
  headers.ts         管理画面用とアーティファクト用のヘッダプロファイル
  errors.ts          JSONエラー封筒とエラーコード
  artifacts/         アップロードと配信
  views/             サーバサイドレンダリングの画面(クライアントJSなし)
migrations/          D1のマイグレーション
tests/unit/          純粋関数と画面の単体テスト
tests/integration/   Workerを直接呼ぶ契約テスト
tests/e2e/           起動したWorkerへHTTPで話すE2E
```
