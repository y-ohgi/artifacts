# HTTP Interface Contract: HTMLアーティファクト共有サイト

**Date**: 2026-07-26 | **Plan**: [../plan.md](../plan.md) | **Data model**: [../data-model.md](../data-model.md)

このサイトが外部へ公開するHTTPインターフェースの契約。ホストは `artifacts.<domain>` の1つ。

## 保護境界

Cloudflare Accessが遮断する範囲とWorkerが判定する範囲を明確に分ける。この表がAccess applicationの設定と1対1で対応する。

- `/_app/*` — Access保護。未認証はWorkerに到達しない
- `/_app/api/*` — Access保護(`/_app/*` に含まれるが、APIとしてAUDを分けたい場合は別applicationにしてよい)
- `/_app/assets/*` — Access保護(`/_app/*` に含まれる)。管理画面のCSSなど、画面自身が読み込む静的アセット
- `/_auth/*` — Access保護。非保護パスでの所有者判定のフォールバック用
- `/cdn-cgi/access/*` — Cloudflare Accessが処理。Workerには到達しない
- 上記以外(`/`、`/<uid>/<name>.html`) — Access非保護。Workerが判定する

**不変条件**: アーティファクトの閲覧パスは決してAccessで保護しない。保護すると公開アーティファクトへの未認証アクセス(FR-026)が成立しなくなる。

## 共通のレスポンスヘッダ

管理画面(`/_app/*`)の応答:

- `Cache-Control: private, no-store`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: no-referrer`
- `Content-Security-Policy: default-src 'self'; frame-ancestors 'none'`

このCSPには `style-src` も `script-src` も無く、どちらも `default-src 'self'` へ落ちる。つまり**インラインの `<style>` も `<script>` もブラウザに拒否される**。管理画面はこれに合わせて書く ―― CSSは同一オリジンの外部スタイルシートから読み、インラインのスタイル・スクリプト・`on*` 属性は一切持たない。このCSPを変えるときは、画面にスタイルが当たっているかを併せて確認すること(ヘッダだけを見ても壊れたことが分からない)。`'unsafe-inline'` を足して解決してはならない。

管理画面の静的アセット(`/_app/assets/*`)の応答は、上記からキャッシュだけを差し替える:

- `Cache-Control: private, max-age=31536000, immutable`(パスに内容ハッシュを含むため。他のヘッダは管理画面と同一)

アーティファクト(`/<uid>/<name>.html`)の応答:

- `Content-Type: text/html; charset=utf-8`
- `Cache-Control: no-store`(公開・非公開いずれも。FR-028)
- `Content-Security-Policy: sandbox allow-scripts allow-popups allow-forms allow-modals`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: no-referrer`

エラー応答(JSON)の形:

```json
{
  "error": {
    "code": "name_conflict",
    "message": "同じ名前のアーティファクトが既に存在する",
    "details": { "suggestions": ["report-2.html", "report-3.html"] }
  }
}
```

`details` はコードごとに定義された任意フィールド。存在しない場合もある。

## GET /

**目的**: エントリポイント。トップページへ誘導する。

- 認証: 不要(Access非保護)
- 応答: `302 Found`、`Location: /_app/`

## GET /_app/

**目的**: トップページ。自分のアーティファクト一覧を表示する(FR-013)。

- 認証: Access保護。Workerは `Cf-Access-Jwt-Assertion` を検証し、emailからuidを解決する
- 応答: `200 OK`、`text/html`

画面が満たす契約:

- 項目は `uploaded_at` の降順(FR-015)
- 各項目に名前、アップロード日時、公開状態、閲覧URLへのリンクを含む(FR-014・FR-029)
- 公開と非公開が視覚的に区別できる(FR-029)
- 0件のときは空状態の案内と最初のアップロードへの導線を表示する(FR-016)
- ヘッダにアップロードボタンとログアウトを含む(FR-018・FR-019)
- 自分のuidに属するアーティファクトのみを表示する(FR-038)

エラー:

- `403 Forbidden` — JWTは有効だが `users` にemailが登録されていない(uid未発行)。運用者による発行が必要であることを案内する

## GET /_app/upload

**目的**: アップロード画面。ファイル選択と名前の確認を行う(FR-004・FR-005)。

- 認証: Access保護
- 応答: `200 OK`、`text/html`

画面が満たす契約:

- ファイル選択後、確定前に名前を初期値付きで提示する。初期値は元のファイル名(FR-004)
- 名前を任意の値へ変更できる(FR-005)
- 使用可能な文字種を画面上で明示する(FR-006)

## GET /_app/assets/app-&lt;hash&gt;.css

**目的**: 管理画面のスタイルシート。`default-src 'self'` を緩めずにCSSを届けるための唯一の経路。

- 認証: Access保護(`/_app/*` に含まれる)。ただしWorkerはuidを解決しない。CSSは全利用者で同一で、uid未発行の利用者に返る通知画面も装飾する必要があるため
- 応答: `200 OK`、`Content-Type: text/css; charset=utf-8`

`<hash>` はCSS本文から決まる。内容が変われば別のパスになるので、応答は長期キャッシュしてよい。画面側はこのパスを `<link rel="stylesheet">` で参照する。

## POST /_app/api/artifacts

**目的**: アーティファクトを新規登録する(FR-001)。

- 認証: Access保護
- リクエスト: `Content-Type: multipart/form-data`
  - `file` — HTMLファイル本体。必須
  - `name` — 公開名。省略時は `file` のファイル名を使う
- 追加検証: `Sec-Fetch-Site` が `same-origin` であること、`Origin` が自ホストであること(多層防御)

成功応答 `201 Created`:

```json
{
  "artifact": {
    "uid": "a3f9k2m1x8",
    "name": "report.html",
    "size": 48213,
    "visibility": "private",
    "uploadedAt": "2026-07-26T09:41:22.000Z",
    "url": "https://artifacts.example.com/a3f9k2m1x8/report.html"
  }
}
```

`visibility` は必ず `"private"`(FR-022)。`url` が利用者へ提示する閲覧URL(FR-010)。

エラー応答:

- `400 Bad Request` / `invalid_name` — 名前が規則に反する(FR-006)。`details.allowed` に使用可能な文字種の説明を含む
- `400 Bad Request` / `not_html` — 拡張子・Content-Type・先頭バイトのいずれかがHTMLでない(FR-002)
- `409 Conflict` / `name_conflict` — 同一uid内で名前が重複(FR-007)。`details.suggestions` に重複しない候補を含む。既存アーティファクトは変更しない(FR-008)
- `413 Payload Too Large` / `too_large` — 10 MB超(FR-003)。`details.limitBytes` に上限値を含む
- `403 Forbidden` / `cross_origin` — `Sec-Fetch-Site` / `Origin` の検証に失敗
- `500 Internal Server Error` / `storage_failed` — R2またはD1の書き込み失敗。この場合、部分的な生成物は残さない(FR-009)

**不変条件**: 失敗した場合、閲覧可能なアーティファクトが1件も増えていないこと。

## GET /_app/api/artifacts

**目的**: 一覧をJSONで取得する。画面のレンダリングはサーバサイドで行うため必須ではないが、確認と自動テストのために公開する。

- 認証: Access保護
- 応答 `200 OK`:

```json
{
  "artifacts": [
    {
      "name": "report.html",
      "size": 48213,
      "visibility": "public",
      "uploadedAt": "2026-07-26T09:41:22.000Z",
      "visibilityChangedAt": "2026-07-26T10:02:10.000Z",
      "url": "https://artifacts.example.com/a3f9k2m1x8/report.html"
    }
  ]
}
```

- 順序は `uploadedAt` の降順(FR-015)
- 認証から解決したuidに属するものだけを返す(FR-038)。uidをクエリパラメータで受け取ってはならない
- 0件のときは `{"artifacts": []}`

## PUT /_app/api/artifacts/:name/visibility

**目的**: 公開状態を切り替える(FR-025・FR-027)。

- 認証: Access保護
- パスパラメータ: `name` — アーティファクト名。URLエンコードされた値
- リクエスト `application/json`:

```json
{ "visibility": "public" }
```

`visibility` は `"public"` または `"private"` のみ。

- 追加検証: `Sec-Fetch-Site` / `Origin`

成功応答 `200 OK`:

```json
{
  "artifact": {
    "name": "report.html",
    "visibility": "public",
    "visibilityChangedAt": "2026-07-26T10:02:10.000Z",
    "url": "https://artifacts.example.com/a3f9k2m1x8/report.html"
  }
}
```

エラー応答:

- `400 Bad Request` / `invalid_visibility` — 値が `public` / `private` 以外
- `404 Not Found` / `not_found` — 認証から解決したuidの名前空間に該当アーティファクトがない。他人のアーティファクトを指定した場合もこれになる(FR-031・FR-038)
- `403 Forbidden` / `cross_origin`

**不変条件**:

- 対象アーティファクトの `url` は切り替え前後で同一(FR-030)
- 操作対象は認証から解決したuidの名前空間に限られる。リクエストのどの部分にもuidを受け取らない(FR-031・FR-038)
- `public` → `private` の完了後、次のリクエストから未認証アクセスが拒否される(FR-028・SC-006)

## GET /:uid/:name

**目的**: アーティファクトを配信する(FR-011・FR-012・FR-026)。

- 認証: Access非保護。Workerが公開状態で判定を分ける
- パスの形: `uid` は `a-z0-9` の10文字、`name` は `<base>.html` / `<base>.htm`

判定の分岐:

- D1に行があり `visibility = 'public'` → `200 OK`、R2のbodyをそのまま返す。認証は要求しない
- D1に行があり `visibility = 'private'` かつ要求者が所有者 → `200 OK`、R2のbodyをそのまま返す
- D1に行があり `visibility = 'private'` かつ要求者が所有者でない → `404 Not Found`
- D1に行がない → `404 Not Found`
- `uid` または `name` が形式に合わない → `404 Not Found`

**不変条件**:

- 上記4つの `404` は、ステータス・本文・ヘッダのすべてが完全に同一であること(FR-017・FR-024)。応答からアーティファクトの存在有無を判別できてはならない。`Content-Length` も同一になるよう本文を固定する
- 応答bodyはR2に保存したバイト列と1バイトも違わないこと(FR-012・SC-008)。スクリプトやナビゲーションの注入を行わない(FR-032)
- 応答に `Cache-Control: no-store` が付いていること(FR-028)
- 応答に `Content-Security-Policy: sandbox ...` が付いていること

所有者判定の実装は[research.md セクション4](../research.md)の未確認事項に依存する。

- `CF_Authorization` cookieがWorkerに届く場合: cookie内のJWTを検証して所有者を判定する
- 届かない場合: 非公開かつ未認証のとき `302 Found` で `/_auth/view?target=/<uid>/<name>` へ送る

いずれの場合も、**非所有者に対しては存在を漏らさない**という不変条件を崩してはならない。cookieが無い状態で `private` を302させると「存在する」ことが漏れるため、フォールバック方式を採る場合は「行がない場合も同じく302して、`/_auth/view` 側で404を返す」ことで応答を揃える。

## GET /_auth/view

**目的**: 非公開アーティファクトの所有者判定のフォールバック経路。`CF_Authorization` cookieが非保護パスに届かない場合にのみ使う。

- 認証: Access保護。`Cf-Access-Jwt-Assertion` が確実に届く
- クエリパラメータ: `target` — `/<uid>/<name>` の形。自ホスト内の相対パスのみを受け付ける

応答:

- 要求者が `target` のuidの所有者で、アーティファクトが存在する → `200 OK`、アーティファクト配信と同一のヘッダで本文を返す
- それ以外 → `404 Not Found`(`GET /:uid/:name` の404と同一の本文)

**不変条件**: `target` は自ホスト内の相対パスに限る。`//`、スキーム付きURL、`..` を含む値は拒否する(オープンリダイレクトの防止)。

## GET /cdn-cgi/access/logout

**目的**: ログアウト(FR-019)。

Cloudflare Accessが処理するためWorkerの実装は不要。ヘッダのログアウトリンクをこのパスへ向ける。cookieは即時削除され、既発行トークンは20〜30秒で受け付け停止になる。

## 認証切れの扱い(FR-021)

`/_app/api/*` への呼び出しが認証切れになった場合、Accessは `302` でログイン画面へリダイレクトする。`fetch` からの呼び出しではリダイレクト先のHTMLが返るため、画面側は次のように扱う。

- 応答が期待するJSONでない、または `302` が観測された場合は認証切れと判断する
- 認証切れであることを利用者に示し、再認証の導線を出す
- 再認証後、同じ画面へ戻して操作を再開できるようにする

## 契約テストの観点

`tests/integration/` で検証すべき項目。

- `POST /_app/api/artifacts` の同名2回目が `409` を返し、1回目のアーティファクトの本文が変化していない(FR-008・SC-002)
- `409` の `details.suggestions` が実際に未使用の名前である(FR-007)
- 10 MB超が `413`、非HTMLが `400 not_html`(FR-002・FR-003)
- アップロード直後の `visibility` が `private`(FR-022・SC-005)
- 未認証で `private` を要求したときの応答と、存在しないアーティファクトを要求したときの応答がバイト単位で同一(FR-017・FR-024)
- `public` へ切り替えた直後、未認証で `200` が返る(FR-026)
- `private` へ戻した直後、未認証で `404` が返る(FR-027・FR-028・SC-006)
- 切り替え前後で `url` が変化しない(FR-030)
- 他uidのアーティファクト名を指定したトグルが `404`(FR-031・FR-038)
- 配信されたbodyがアップロードしたバイト列と同一(FR-012・SC-008)
- アーティファクト応答に `Cache-Control: no-store` と `Content-Security-Policy: sandbox` が付く
