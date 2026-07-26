# Quickstart / Validation Guide: HTMLアーティファクト共有サイト

**Date**: 2026-07-26 | **Plan**: [plan.md](./plan.md) | **Contract**: [contracts/http-api.md](./contracts/http-api.md)

実装後にspecのUser Story 1〜6が満たされていることを端から確認するための手順。実装コードは含まない。

## 前提

必要なもの:

- Cloudflareアカウント。Workers、R2、D1が有効になっていること
- Cloudflare Zero Trust(Access)が設定済みで、チームドメイン `<team>.cloudflareaccess.com` が判明していること
- Cloudflareに登録済みのゾーンと、サイト用のホスト名(以下 `artifacts.example.com` と表記)
- `wrangler` にログイン済み(`wrangler whoami` で確認)
- 未認証状態を再現するためのシークレットウィンドウ、または別ブラウザ

コマンド例は `wrangler` の現行メジャーバージョンを前提としている。オプション名が変わっている場合は `wrangler <サブコマンド> --help` を正とする。

## セットアップ

### 1. リソースを作成する

```sh
wrangler r2 bucket create artifacts-html
wrangler d1 create artifacts-meta
```

`wrangler d1 create` が出力する `database_id` を `wrangler.jsonc` のD1バインディングへ書き込む。

### 2. スキーマを適用する

```sh
# ローカル(テスト・開発用)
wrangler d1 migrations apply artifacts-meta --local

# 本番
wrangler d1 migrations apply artifacts-meta --remote
```

### 3. Access applicationを作成する

Zero Trustダッシュボードで self-hosted application を作成する。保護対象のパスは[contracts/http-api.md](./contracts/http-api.md)の保護境界と一致させる。

- `artifacts.example.com/_app` (配下を含む) — 自分のメールアドレスのみを許可するポリシー
- `artifacts.example.com/_auth` (配下を含む) — 同じポリシー

**重要**: `artifacts.example.com` のrootパスを保護対象にしてはならない。rootを保護すると配下のすべてのサブパスに及び、公開アーティファクトへの未認証アクセスが成立しなくなる。

各applicationのAUDタグを控え、Workerの環境変数へ設定する。

```sh
wrangler secret put ACCESS_AUD_APP
wrangler secret put ACCESS_AUD_AUTH
wrangler secret put ACCESS_TEAM_DOMAIN   # 例: myteam.cloudflareaccess.com
```

### 4. 自分のuidを発行する

初期リリースではuid発行は手作業(specのAssumptions)。uidは `a-z0-9` の10文字で、推測されにくい値でなければならない(FR-034〜FR-036)。手で考えた値を使わず、CSPRNGで生成する。

```sh
# uidを生成する(例)
node -e 'const a="abcdefghijklmnopqrstuvwxyz0123456789";const b=require("crypto").randomBytes(64);let s="";for(const x of b){if(x<252&&s.length<10)s+=a[x%36]}console.log(s)'
```

生成した値でユーザーを登録する。

```sh
wrangler d1 execute artifacts-meta --remote \
  --command "INSERT INTO users (uid, email, created_at) VALUES ('<uid>', '<自分のメールアドレス>', '2026-07-26T00:00:00.000Z')"
```

`email` はCloudflare Accessで認証したときに返る値と完全に一致させる。一致しない場合、認証は通るがuidが解決できず `403` になる。

### 5. デプロイする

```sh
wrangler deploy
```

## 自動テスト

```sh
npm install
npm test              # Vitest + @cloudflare/vitest-pool-workers
```

カバー範囲は[contracts/http-api.md](./contracts/http-api.md)の「契約テストの観点」を参照。Accessが介在する経路(JWT検証、ログアウト、未認証の遮断)はローカルで再現できないため、以下の手動シナリオで確認する。

## 検証シナリオ

### US1: HTMLをアップロードして閲覧する

1. 認証済みブラウザで `https://artifacts.example.com/` を開く
   - **期待**: `/_app/` へリダイレクトされる
2. ヘッダのアップロードボタンから単体HTMLを1つアップロードする
   - **期待**: 保存完了が示され、`https://artifacts.example.com/<uid>/<name>.html` の形の閲覧URLが表示される
3. 表示された閲覧URLを同じブラウザで開く
   - **期待**: アップロードしたHTMLが意図した見た目でレンダリングされる。inline scriptも動作する
4. 拡張子が `.txt` のファイルをアップロードする
   - **期待**: 受け付けられない理由が示され、一覧に追加されない
5. 拡張子は `.html` だが中身がHTMLでないファイル(先頭が `{` のJSONなど)をアップロードする
   - **期待**: 同じく拒否される
6. 10 MBを超えるファイルをアップロードする
   - **期待**: 上限値を含むエラーが示され、保存されない

### US2: トップページで過去のアーティファクトを探す

1. 合計3件になるまでアップロードする
2. `/_app/` を開く
   - **期待**: 3件すべてが表示され、名前・アップロード日時・公開状態が並ぶ。並び順はアップロードが新しいものから
3. 任意の項目を選ぶ
   - **期待**: そのアーティファクトが表示される
4. ヘッダを確認する
   - **期待**: アップロードボタンとログアウトが存在する
5. 空状態の確認は、別のuidを一時的に発行してそのアカウントで `/_app/` を開くか、`artifacts` テーブルを空にして確認する
   - **期待**: 空であることと最初のアップロードを促す案内が表示される

### US3: 名前の確認と衝突回避

1. `report.html` という名前でアップロードし、内容にわかる目印(例: `VERSION-1`)を入れておく
2. アップロード画面でファイルを選択する
   - **期待**: 元のファイル名が初期値として提示され、そのまま確定するか変更するかを選べる
3. 内容の異なる別のファイル(目印は `VERSION-2`)を、同じ `report.html` という名前で登録しようとする
   - **期待**: 重複が示され、`report-2.html` のような候補が提示される。この時点で保存は行われていない
4. 提示された候補を受け入れて確定する
   - **期待**: 新しい名前で保存される
5. `https://artifacts.example.com/<uid>/report.html` を開く
   - **期待**: `VERSION-1` が表示される。上書きされていない
6. 名前に `my report.html`(空白入り)、`../evil.html`、`レポート.html`、`_internal.html` を順に指定する
   - **期待**: いずれも使用可能な文字種の説明とともに拒否される

### US4: 認証とログアウト

1. シークレットウィンドウで `https://artifacts.example.com/_app/` を開く
   - **期待**: Accessの認証画面が出る。一覧の内容は一切表示されない
2. シークレットウィンドウで `https://artifacts.example.com/_app/api/artifacts` を開く
   - **期待**: 同じく認証を求められ、JSONは返らない
3. 認証済みブラウザでヘッダのログアウトを実行する
   - **期待**: `/cdn-cgi/access/logout` に遷移し、ログアウトが完了する
4. ログアウト後に `/_app/` を開く
   - **期待**: 再認証を求められる。既発行トークンの失効には20〜30秒かかるため、直後に通ってしまう場合は30秒待って再確認する
5. 認証セッションを失効させた状態でアップロードを実行する(3の後に元のタブでアップロードを試す)
   - **期待**: 認証切れであることが示され、再認証後に操作を再開できる

### US5: 公開と非公開

1. 認証済みブラウザで `/_app/` を開き、任意のアーティファクトの公開状態を確認する
   - **期待**: アップロード直後のものはすべて非公開
2. シークレットウィンドウでその非公開アーティファクトのURLを開く
   - **期待**: 内容が返らない。404、または認証を求められる
3. 存在しない名前のURL(`https://artifacts.example.com/<uid>/nonexistent.html`)をシークレットウィンドウで開く
   - **期待**: 2の応答と見分けがつかない。ステータス・本文が同一であることを確認する

     ```sh
     curl -sS -D - -o /tmp/private.txt "https://artifacts.example.com/<uid>/<非公開の名前>.html"
     curl -sS -D - -o /tmp/absent.txt  "https://artifacts.example.com/<uid>/nonexistent.html"
     diff /tmp/private.txt /tmp/absent.txt   # 差分が出ないこと
     ```

4. 認証済みブラウザで同じアーティファクトを公開へ切り替える
   - **期待**: 公開状態になったことが示され、一覧上の表示も変わる。閲覧URLは切り替え前と同一
5. シークレットウィンドウでそのURLを開く
   - **期待**: HTMLがレンダリングされる
6. 応答ヘッダを確認する

     ```sh
     curl -sSI "https://artifacts.example.com/<uid>/<公開した名前>.html"
     ```

   - **期待**: `Cache-Control: no-store` と `Content-Security-Policy: sandbox ...` が付いている
7. 認証済みブラウザで非公開へ戻す
8. シークレットウィンドウで再度そのURLを開く(スーパーリロード)
   - **期待**: 30秒以内に内容が返らなくなる(SC-006)。ブラウザキャッシュの影響を排除するため `curl` でも確認する
9. 公開アーティファクトのページから、同じ利用者の一覧や他のアーティファクトへ辿れる導線がないことを確認する
   - **期待**: アーティファクトのHTML以外に何も注入されていない。ページのソースがアップロードしたHTMLと一致する

### US6: uidの名前空間

1. 2つ目のuidを発行し、`users` に登録する(手順4と同じ方法)
2. 両方のuidに、同じ名前で内容の異なるアーティファクトを登録する
   - **期待**: 両方が登録できる。名前の重複エラーにならない
3. それぞれの閲覧URLを開く
   - **期待**: それぞれのuidに属する内容が表示され、混同されない
4. 1つ目のuidのアカウントで `/_app/` を開く
   - **期待**: 自分のuidに属するアーティファクトのみが並ぶ。2つ目のuidのものは表示されない
5. 1つ目のuidのアカウントから、2つ目のuidに属するアーティファクト名を指定して公開切替APIを呼ぶ
   - **期待**: `404` が返り、2つ目のuidのアーティファクトの公開状態は変化しない
6. 発行した2つのuidを見比べる
   - **期待**: `a-z0-9` のみ、10文字。一方から他方を推測できる規則性(連番、時刻順、メールアドレス由来)がない

## 未確認事項の検証

[research.md セクション4](./research.md)の未確認事項を、この段階で必ず確認する。

`CF_Authorization` cookieがAccess非保護パスへのリクエストでWorkerに届くかを調べる。

1. Workerに一時的なデバッグ経路を追加し、`request.headers.get('cookie')` の内容(値はマスクし、cookie名のみ)をログ出力する
2. 認証済みブラウザで `/_app/` を開いて認証を通す
3. 同じブラウザでAccess非保護パスへアクセスする
4. `wrangler tail` でログを確認する

```sh
wrangler tail
```

- `CF_Authorization` が含まれる → cookie内のJWTを検証する方式で所有者判定を実装する
- 含まれない → `/_auth/view` へのフォールバック方式へ切り替える。契約は[contracts/http-api.md](./contracts/http-api.md)の `GET /_auth/view` に記載済み

確認後、デバッグ経路は必ず削除する。cookie名以外の値をログへ出さないよう注意する。

## パフォーマンスの確認

- SC-009: 100件のアーティファクトを登録した状態で `/_app/` の初期表示が3秒以内に完了すること。ブラウザのdevtoolsでLoad時間を計測する
- SC-001: ファイル選択から閲覧URLの取得までを30秒以内に完了できること
- SC-003: `/_app/` を開いてから目的のアーティファクトを見つけて開くまで10秒以内
- SC-007: 一覧から公開・非公開の切り替えを10秒以内に完了できること

## Done判定

- 上記のUS1〜US6のすべての期待結果が観測できた
- `npm test` が全件成功した
- 未確認事項の検証が完了し、採用した方式が[research.md](./research.md)に反映された
- デバッグ用の一時的なコードがリポジトリに残っていない
