# Phase 0 Research: HTMLアーティファクト共有サイト

**Date**: 2026-07-26 | **Plan**: [plan.md](./plan.md) | **Spec**: [spec.md](./spec.md)

このリポジトリにはアプリケーションコードが存在せず、技術選定は白紙からの判断になる。以下は各判断のDecision / Rationale / Alternatives considered。Cloudflareの仕様・上限値は記憶に頼らず公式ドキュメントで確認し、出典を併記した。確認できなかった事項は「未確認」として明記する。

## 1. 実行環境とアプリケーション構成

**Decision**: 単一のCloudflare Workerで管理UI・API・アーティファクト配信のすべてを処理する。TypeScriptで実装し、ルーティングとサーバサイドHTML生成にHono、Access JWTの検証にjoseを使う。

**Rationale**:

- 要件はサーバサイドレンダリングの3画面(一覧・アップロード・アーティファクト配信)のみで、クライアント側の状態管理を必要としない。SPAフレームワークを持ち込む理由がない
- アーティファクト配信で公開状態を動的に判定する必要があるため(FR-022〜FR-028)、静的ホスティングだけでは成立せず、リクエスト時に判定できる実行環境が必須
- 管理UIとアーティファクト配信が同一ホスト上のパスで分かれる設計(後述の3)のため、両者を1つのルーティングテーブルで扱えると保護境界の把握が容易になる
- joseを使うのはJWTの署名検証を自作しないため。認証部分の実装責任を減らす判断

**Alternatives considered**:

- **Pages + Functions**: 静的アセット中心の構成に寄っており、今回は静的アセットがほぼ無い。Workerに寄せる方が構成要素が少ない
- **依存ゼロ(Workers標準APIのみ)**: WebCryptoでRS256検証を自作すれば依存は消えるが、JWKS取得・kid照合・claim検証を自前で持つことになり、認証コードの実装責任が増える。個人用途でも認証は壊れたときの影響が大きいため実績あるライブラリに寄せた
- **Hono以外のルータ**: 標準の `fetch` ハンドラ内で手書きのURL分岐でも動くが、保護境界がif文に散るとレビューしにくい

## 2. Cloudflare Accessによる認証の受け取り方

**Decision**: Access保護パスで受け取る `Cf-Access-Jwt-Assertion` ヘッダのJWTを、`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` から動的取得した公開鍵で検証する。検証項目は署名(JWTの `kid` に対応する鍵)、`aud`(Access applicationのAUDタグ)、`iss`(チームドメイン)。JWKSはWorker内でTTL付きにキャッシュする。

**Rationale**:

- 公式ドキュメントが、JWTは `Cf-Access-Jwt-Assertion` ヘッダと `CF_Authorization` cookieの2経路で渡り、cookieは必ず渡るとは限らないためヘッダでの検証を推奨している
- 同ドキュメントは署名鍵が6週間ごとにローテートされる(7日間の猶予期間あり)ため鍵をハードコードせず動的取得せよと明記している。したがってJWKSの取得とキャッシュは必須の実装要素
- ログアウトは `<app-domain>/cdn-cgi/access/logout` を使う。cookieは即時削除され、既発行トークンは20〜30秒で受け付け停止になる。アプリ側でセッションを持たないため、独自のセッション失効処理が不要になる

**出典**:

- [Validating JSON web tokens](https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/)
- [Session management](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/)

**Alternatives considered**:

- **アプリ独自のセッションcookieを発行する**: Access保護パスでJWTを検証した後、自前の署名付きcookieを発行して以降はそれを使う方式。非保護パスでの所有者判定が確実になる利点はあるが、セッション管理・失効・鍵ローテーションを自分で背負うことになる。ログアウト要件(FR-019)もAccess側の失効と二重管理になる。未確認事項(後述の4)が解消しない場合の第2候補として保留する

## 3. URL構成とアクセス制御の境界

**Decision**: 単一ホスト `artifacts.<domain>` 上で、管理UIとAPIを `_` 始まりの予約prefixへ寄せ、そこだけをAccessで保護する。アーティファクトの閲覧パス `/<uid>/<name>.html` はAccess非保護にし、Workerが公開状態を判定する。

```text
  /                     → 302 /_app/
  /_app/                [Access保護]   一覧(トップページ)
  /_app/upload          [Access保護]   アップロード画面
  /_app/api/*           [Access保護]   アップロード・公開切替API
  /_auth/*              [Access保護]   非保護パスでの所有者判定のフォールバック
  /<uid>/<name>.html    [Access非保護] Workerが判定
```

**Rationale**:

- Accessのアプリ設定は静的であり、アーティファクト単位の公開トグル(FR-025・FR-027)を表現できない。したがって公開状態の判定主体はWorkerでなければならず、アーティファクトのパスはAccess非保護である必要がある
- Accessのパス保護は「より具体的なパスが優先」だが、rootパスを保護すると配下のサブパスすべてに及び、より具体的なパスで保護を外す方向の上書きはできない。よって管理UIを `/` に置くとアーティファクトのパスも保護されてしまい、公開が成立しない
- uidの文字集合は `a-z0-9` のみ(FR-034)なので、`_` 始まりの予約prefixとuidは構造的に衝突しない。予約語リストを保守する必要がなくなる
- 単一ホストのためDNSレコードもデプロイ対象も1つで済み、FR-030(公開状態を変えてもURLが変わらない)を自然に満たす

**出典**: [Application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)

**Alternatives considered**:

- **2ホストに分離(管理UIと閲覧を別ホスト)**: 管理UIのホスト全体をAccessで保護できるためパス設計の制約が消え、ユーザー由来HTMLと管理UIのオリジンが完全に分かれるためXSSリスクが構造的に消える。却下理由は、所有者が非公開アーティファクトを閲覧する際に閲覧側ホストのAccessセッションが存在せず、閲覧側にもAccess applicationを追加する必要があり、DNSとAccessの設定が2倍になること。単一ホスト側のXSSはCSP sandboxで緩和できると判断した(後述の6)。将来アーティファクト件数や共有相手が増えた場合の強化策として残す
- **管理UIを `/` に置き、閲覧パスを `/v/*` にしてBypassポリシーで開放**: specのFR-011のURL形式を変える必要があり、かつ保護されたrootの配下をBypassで開放できるかを公式ドキュメントで確認できなかった。未検証の挙動に設計を依存させないため却下

## 4. 未確認事項: 非保護パスでの所有者判定

**未確認**: `CF_Authorization` cookieが、同一ホストのAccess非保護パスへのリクエストでWorkerまで到達するかは公式ドキュメントに記載を見つけられなかった。Cloudflareが明示的にstripすると記載しているのは binding cookie のみである。

この点は非公開アーティファクトを所有者本人が `/<uid>/<name>.html` で閲覧する経路(FR-023)に影響する。

**検証方法**: デプロイ環境で `/_app/` にて認証を通した後、Access非保護パスへアクセスし、Worker側で `request.headers.get('cookie')` に `CF_Authorization` が含まれるかを確認する。ローカルの `wrangler dev` ではAccessが介在しないため再現できない。

**分岐**:

- 到達する場合: cookie内のJWTを 2 と同じ手順で検証し、`aud` はAccess applicationのAUDタグと照合する。追加の実装要素はない
- 到達しない場合: 非公開アーティファクトへの未認証アクセスを `/_auth/view?target=<path>` へ302する。このパスはAccess保護下にあるため `Cf-Access-Jwt-Assertion` が確実に届く。所有者を確認した上でそこから本文を返す。正規URL `/<uid>/<name>.html` は公開・非公開のどちらでも変わらないため、FR-030は維持される。所有者のブラウザのアドレスバーだけが一時的に `/_auth/view` を指す点はUXの妥協になる

いずれの分岐でも、データモデル・スキーマ・API契約・公開判定ロジックは変わらない。したがってこの1点はPhase 2以降の実装時に確定させ、設計全体をブロックしない。

## 5. ストレージ

**Decision**: HTML本体はR2(キー `<uid>/<name>`)、メタデータはD1(`users` と `artifacts`)。

**Rationale**:

- 一覧はアップロード日時の降順(FR-015)で、公開状態でのフィルタや件数の把握も必要になる。SQLが使えるD1が素直
- FR-028とSC-006は「非公開へ戻した後に公開時点の内容が返り続けない」「30秒以内に反映」を要求する。D1は書き込み後の読み取りが強整合なので、トグル直後の次のリクエストから確実に新しい状態で判定できる
- 名前の一意性(FR-007・FR-039)は `UNIQUE(uid, name)` 制約でデータベース側に寄せられる。アプリ側の事前チェックだけに頼ると競合状態で二重登録が起こりうる
- R2は1オブジェクト最大5 TiB、単一PUT 5 GiB、キー長1,024バイトで、10 MB上限のHTMLに対して余裕が大きい
- D1は最大DBサイズ10 GB(Workers Paid)/ 500 MB(Free)、1 invocationあたり1,000クエリ(Paid)。メタデータのみを置く用途では上限が問題になる規模に達しない

**出典**:

- [R2 limits](https://developers.cloudflare.com/r2/platform/limits/)
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)

**Alternatives considered**:

- **メタデータもKVに置く**: 日時順の一覧クエリを表現できず、キー設計で疑似的に順序を作る必要がある。加えて書き込みの伝播に時間がかかるため、非公開へ戻す操作の反映を30秒以内とするSC-006を満たせるか保証できない。却下
- **メタデータをR2のカスタムメタデータのみで持つ**: `list()` はキー順で返り日時順ソートを自前で行う必要があり、件数が増えるとSC-009(100件で3秒以内)に不利。一意性制約も表現できない。却下
- **HTML本体もD1に入れる**: 最大行サイズ2 MBの制約があり、10 MB上限のHTMLを格納できない。却下

## 6. ユーザー由来HTMLの隔離

**Decision**: アーティファクト応答に次のヘッダを付与する。

- `Content-Security-Policy: sandbox allow-scripts allow-popups allow-forms allow-modals`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: no-referrer`
- `Cache-Control: no-store`

加えて `/_app/api/*` 側で `Sec-Fetch-Site` と `Origin` を検証する。

**Rationale**:

- 公開アーティファクトは管理UIと同一ホストで配信されるため、対策しなければ悪意あるHTMLのJSが `/_app/api/*` を資格情報付きで呼び出し、他のアーティファクトを公開したり新規アップロードを行えてしまう。これはユーザーが自分でアップロードしたものだけを置く現状でも、公開URLを共有した相手にHTMLを差し替えられる経路が生まれた時点で問題になる
- `CSP: sandbox` は `allow-same-origin` を含めない限りdocumentを一意のopaque originに置く。同一オリジン扱いの資格情報付きリクエストが成立しなくなるため、上記の経路が閉じる
- `allow-scripts` を含めるのは、Claude Codeの生成物がinline scriptを多用し、これを止めるとFR-012・SC-008(意図した見た目のまま表示される)を満たせなくなるため
- `no-store` はFR-028のためだが、副作用としてブラウザ・中間キャッシュのいずれにも公開時点の内容が残らない

**残存リスク**: 同一ホストである以上、cookieのpath属性やブラウザ実装の差異に依存する部分が残る。より強固にするならセクション3のAlternativeにある閲覧専用ホストへのオリジン分離へ移行する。移行時もURLのパス部分は変わらないため、アーティファクトの相対的な位置づけは保たれる。

## 7. アップロードの受け取りと上限

**Decision**: `POST /_app/api/artifacts` で `multipart/form-data` を受け取り、1ファイルあたり10 MBを上限とする。検証は拡張子・Content-Type・先頭バイトのsniffの3点。書き込みはR2 put → D1 insertの順で、D1が失敗したらR2オブジェクトを削除する。

**Rationale**:

- Workersのリクエストボディ上限はFree / Proアカウントで100 MB。10 MBはこれに対して十分な余裕があり、Claude Codeが出力する単体HTML(通常1 MB未満)に対しても余裕がある
- 拡張子のみの検証では中身がHTMLでないファイルを通してしまう(specのEdge Cases)。先頭バイトで `<!doctype html` / `<html` を確認することで、意図しないコンテンツの配信を防ぐ
- 書き込み順をR2先行にするのは、D1に行があるのにR2に本体がない状態(一覧に出るが開けない)を避けるため。逆順の失敗は「R2に孤児オブジェクトが残るが一覧には出ない」となり、FR-009の「部分的な生成物を閲覧可能にしない」を満たす。孤児は削除処理で回収する

**出典**: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)

**Alternatives considered**:

- **R2の署名付きURLへブラウザから直接PUTする**: Workersのボディ上限を回避でき大容量に強いが、アップロード完了とメタデータ登録が二段になり、片方だけ成立した状態の後始末が複雑になる。10 MB上限では不要な複雑さ。却下

## 8. uidの生成

**Decision**: `a-z0-9` の36文字から10文字を `crypto.getRandomValues` で生成する。バイト値を36で割った余りを使うとモジュロバイアスが出るため、rejection sampling(36の倍数を超えるバイト値を捨てる)を用いる。一意性はD1のUNIQUE制約で担保し、衝突時は再生成する。

**Rationale**:

- 36^10 ≈ 3.66×10^15 で約51.7ビット。FR-035(12文字以内)を満たしながら、総当たりでの列挙が現実的でない空間を確保できる
- FR-036は連番・発行順・日時・メールアドレスなど観測可能な情報からの導出を禁じている。CSPRNG由来であればこれを満たす
- 10文字は手で書き写せる程度の短さで、「短く」という元の要望に沿う

**Alternatives considered**:

- **UUIDv4をそのまま使う**: 36文字(ハイフン含む)で長く、`a-z0-9` のみという制約にも合わない(ハイフンを除去しても32文字)。却下
- **メールアドレスのハッシュ**: 決定的で再現しやすいが、候補となるメールアドレスの集合が小さいため総当たりで逆算されうる。FR-036の趣旨に反する。却下
- **8文字**: 36^8 ≈ 2.8×10^12(約41.4ビット)。短さは魅力だが推測困難性の余裕が小さい。10文字との差が2文字しかないため10文字を選んだ

## 9. 名前の規則と衝突回避

**Decision**: 名前は `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.html?$` に一致し、`..` を含まず、`_` で始まらないものとする。衝突時は `base-2.html`、`base-3.html` の順に空きを探して候補として提示する。

**Rationale**:

- `/` と空白と非ASCIIを排除することで、パスの解釈が曖昧になる余地とURLエンコードの取り回しを消す。`..` の禁止はパストラバーサル的な解釈を防ぐ
- `_` 始まりの禁止は、将来アーティファクトのパスに予約prefixを追加する余地を残すため
- 連番サフィックスは、利用者が元の名前との関係を一目で把握できる。ランダム文字列の付与より意図が伝わる

**Alternatives considered**:

- **衝突時に自動で連番を付けて保存する**: FR-004・FR-007が「確認してから確定する」ことを求めているため、暗黙のリネームは要件に反する。候補の提示にとどめる
- **タイムスタンプのサフィックス**: 一意性は高いが名前が読みにくくなる。却下

## 10. テスト方針

**Decision**: Vitest + `@cloudflare/vitest-pool-workers` を使い、Workers実行環境上でunitとintegrationを走らせる。R2とD1はローカルバインディングで再現する。

**Rationale**:

- 検証すべき挙動の多くがWorkersのランタイムAPI(R2バインディング、D1バインディング、`crypto`、`Response` ヘッダ)に依存するため、Node上のモックでは実挙動との乖離が生じやすい
- Cloudflare公式が提供するpoolであり、バインディングをそのまま使えるためテストコードと本番コードの差が小さい

**カバーすべき観点**(specのSuccess Criteriaに対応):

- 同名アップロード時に既存アーティファクトが元の内容のまま残る(SC-002)
- 未認証アクセスで管理画面と非公開アーティファクトの内容が返らない(SC-004)
- 非公開へ戻した直後のアクセスが拒否される(SC-006)
- 非公開かつ非所有者への404と、存在しないアーティファクトへの404が完全に同一(FR-017・FR-024)
- R2 bodyが無改変で返る(SC-008)
- uidが文字集合・長さを満たし、重複しない(SC-011)

**Alternatives considered**:

- **`wrangler dev` へ実リクエストを送るE2Eのみ**: 起動と後始末が重く、失敗時の原因切り分けがしにくい。ただしAccessが介在する経路(セクション4の未確認事項)はローカルで再現できないため、そこだけはデプロイ環境での手動確認に頼る。[quickstart.md](./quickstart.md) にその手順を記載した
