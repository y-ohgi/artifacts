# Implementation Plan: HTMLアーティファクト共有サイト

**Branch**: `main`(feature branch未作成) | **Date**: 2026-07-26 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-html-artifact-hosting/spec.md`

## Summary

Claude Codeが生成した単体HTMLをアップロードし、既定では非公開で保管し、必要なものだけ明示的に公開して他者へURLを共有できるサイトをCloudflare上に構築する。

技術方針は単一のCloudflare Workerで完結させる。HTML本体はR2、メタデータ(所有者・名前・公開状態・日時)はD1に置く。管理UIとAPIはパス `/_app/*` をCloudflare Accessで保護し、アーティファクトの閲覧パス `/<uid>/<name>.html` はAccess非保護にしてWorker自身が公開状態を判定する。この分離は、Accessのアプリ設定が静的でアーティファクト単位の公開トグルを表現できないことから必然的に決まる。

## Technical Context

**Language/Version**: TypeScript 5.x / Cloudflare Workers runtime(workerd)。Node.js互換フラグは不要

**Primary Dependencies**: Hono(ルーティングとJSXによるサーバサイドHTML生成)、jose(Access JWTのRS256検証とJWKS取得)。開発時のみ wrangler、vitest、@cloudflare/vitest-pool-workers、@cloudflare/workers-types

**Storage**: R2(HTML本体、キーは `<uid>/<name>`)、D1(`users` と `artifacts` の2テーブル)

**Testing**: Vitest + @cloudflare/vitest-pool-workers(Workers実行環境上でのunit / integration)。R2とD1はローカルバインディングで再現する

**Target Platform**: Cloudflare Workers。単一ホスト `artifacts.<domain>` に集約

**Project Type**: web-service(サーバサイドレンダリングの管理UI + ユーザー由来HTMLの配信)

**Performance Goals**: 100件蓄積時のトップページ初期表示3秒以内(SC-009)。非公開へ戻す操作の反映30秒以内(SC-006)

**Constraints**: アーティファクト応答は `Cache-Control: no-store` 固定(FR-028のため、CDNキャッシュによる高速化を意図的に捨てる)。アップロード上限10 MB。ユーザー由来HTMLと管理UIが同一オリジンになるため `Content-Security-Policy: sandbox` による隔離が必須

**Scale/Scope**: 利用者は初期1名、将来複数名。アーティファクトは100〜1,000件規模を想定。画面数は3(一覧、アップロード、アーティファクト配信)

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` はspecify-cliが生成したプレースホルダのままで、批准された原則が1つも存在しない(`[PRINCIPLE_1_NAME]` などの雛形文字列が残っている)。したがってこのゲートは評価対象が無く、空振りとなる。

- **Phase 0前の判定**: PASS(評価すべき原則が存在しないため)
- **Phase 1後の再判定**: PASS(同上。設計内容によって変わる余地がない)

推測でプロジェクト原則をでっち上げることはしない。原則を整備する場合は `/speckit-constitution` を別途実行する。

なお、憲章の代わりに実効的な制約として働いているのはリポジトリ直下の `AGENTS.md`(全エージェント共通の作業規約)である。本計画は特に次の3点をゲートとして扱った。

- 認証・認可に関わる設計は実装前に方針を提示して承認を得る → 本計画のアクセス制御設計がその提示にあたる
- 依存パッケージの追加は事前に理由を提示して承認を得る → Hono / jose / Vitest について承認済み
- ライブラリのAPIや上限値は記憶で断定せず一次情報で確認する → Cloudflare公式ドキュメントで確認し、[research.md](./research.md) に出典を記録した

## Project Structure

### Documentation (this feature)

```text
specs/001-html-artifact-hosting/
├── plan.md              # This file (/speckit-plan command output)
├── spec.md              # Feature specification (/speckit-specify output)
├── research.md          # Phase 0 output (/speckit-plan command)
├── data-model.md        # Phase 1 output (/speckit-plan command)
├── quickstart.md        # Phase 1 output (/speckit-plan command)
├── contracts/
│   └── http-api.md      # Phase 1 output (/speckit-plan command)
├── checklists/
│   └── requirements.md  # Spec quality checklist (/speckit-specify output)
└── tasks.md             # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
wrangler.jsonc              # Worker設定、R2 / D1バインディング、環境変数
package.json
tsconfig.json
vitest.config.ts
src/
├── index.ts                # Honoアプリとルート定義。保護境界の単一の定義場所
├── auth.ts                 # Access JWT検証(jose)、email→uid解決、所有者判定
├── artifacts/
│   ├── upload.ts           # 検証、名前決定、R2 put → D1 insert、失敗時の巻き戻し
│   ├── list.ts             # 一覧取得(日時降順)
│   ├── visibility.ts       # 公開・非公開の切り替え
│   └── serve.ts            # /<uid>/<name>.html の配信と公開状態の判定
├── ids.ts                  # uid生成、名前バリデーション、衝突候補の算出
├── db.ts                   # D1クエリ(型付きラッパ)
├── headers.ts              # セキュリティヘッダの一元定義
└── views/
    ├── layout.tsx          # 共通レイアウトとヘッダ(アップロードボタン、ログアウト)
    ├── list.tsx            # 一覧画面(空状態を含む)
    └── upload.tsx          # アップロード画面と名前確認UI
migrations/
└── 0001_init.sql           # users / artifacts のスキーマ
tests/
├── unit/
│   ├── ids.test.ts         # uid生成の文字集合・長さ・分布、名前バリデーション
│   └── headers.test.ts     # セキュリティヘッダ
└── integration/
    ├── upload.test.ts      # 衝突回避、サイズ・形式の拒否、失敗時の巻き戻し
    ├── visibility.test.ts  # 公開/非公開のトグルと反映
    └── serve.test.ts       # 公開状態別の配信、404の同一性、他uidへの越境
```

**Structure Decision**: 単一のWorkerプロジェクトをリポジトリ直下に配置する。フロントエンドとバックエンドを分けないのは、管理UIがサーバサイドレンダリングの3画面のみで、クライアント側の状態管理を必要としないため。`src/artifacts/` を機能単位で分割し、アクセス制御の判定は `src/auth.ts` と `src/index.ts` のルート定義に集約して、保護境界がコードの1箇所を読めば分かる状態を保つ。

既存の `harness/`・`.specify/`・`.claude/` はエージェント運用のためのメタ資産であり、アプリケーションコードとは独立して共存させる。

## Key Design Decisions

詳細な根拠と却下した代替案は [research.md](./research.md) に記録した。ここでは結論のみを示す。

### URL構成とアクセス制御の境界

```text
artifacts.<domain>
  /                     → 302 /_app/
  /_app/                [Access保護]   一覧(トップページ)
  /_app/upload          [Access保護]   アップロード画面
  /_app/api/*           [Access保護]   アップロード・公開切替API
  /_auth/*              [Access保護]   非保護パスでの所有者判定のフォールバック
  /cdn-cgi/access/logout                Cloudflare Accessが処理(ログアウト)
  /<uid>/<name>.html    [Access非保護] Workerが公開状態を判定
```

Accessはrootパスを保護すると配下のサブパスすべてに及び、より具体的なパスで保護を外す方向の上書きができない。よって管理UIを `/` に置くとアーティファクトのパスも保護されてしまい、公開が成立しない。管理UIを `_` 始まりの予約prefixへ寄せることでこの制約を回避する。uidの文字集合は `a-z0-9` のみ(FR-034)なので、`_` 始まりのパスとuidは構造的に衝突しない。

### 公開状態の強制

判定はWorkerが行い、アーティファクト応答は常に `Cache-Control: no-store` とする。Cache APIも使わない。`cache.delete()` はリクエストを受けたコロケーションにしか作用せず、非公開へ戻した後に他リージョンのエッジから公開時点の内容が返らない保証が得られないため(FR-028)。

### 同一オリジンXSSの隔離

アーティファクト応答に `Content-Security-Policy: sandbox allow-scripts allow-popups allow-forms allow-modals` を付与し、documentを一意のopaque originに置く。これによりユーザー由来HTMLのJSから `/_app/api/*` への資格情報付きリクエストが成立しなくなる。`allow-scripts` を含めるのは、Claude Codeの生成物がinline scriptを多用するため。

### uidの生成

`a-z0-9` の36文字から10文字を `crypto.getRandomValues` + rejection sampling(モジュロバイアス除去)で生成する。36^10 ≈ 3.66×10^15、約51.7ビット。FR-035(12文字以内)を満たし、連番・日時・メールアドレスに由来しないためFR-036を満たす。一意性はD1のUNIQUE制約で担保する(FR-037)。

## Requirements Traceability

specの全要件が設計上どこで満たされるかの対応。

アップロード:

- FR-001: `POST /_app/api/artifacts`(multipart/form-data)。Access保護パス配下
- FR-002: 拡張子・Content-Type・先頭バイトのsniff(`<!doctype html` / `<html`)の3点検証
- FR-003: 10 MB上限。超過時は上限値を含むエラー本文を返す
- FR-004、FR-005: アップロード画面で名前を初期値付きで提示し、変更可能にする
- FR-006: `src/ids.ts` の名前バリデーション(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.html?$`、`..` 禁止、`_` 始まり禁止)
- FR-007: D1の `UNIQUE(uid, name)` で検知し、`base-2.html` 形式の候補を算出して返す
- FR-008: 既存行があるときはINSERTを失敗させ、R2 putも行わない
- FR-009: R2 put → D1 insertの順で書き、D1が失敗したらR2オブジェクトを削除する
- FR-010: 成功応答に閲覧URLを含め、画面に表示する

閲覧と一覧:

- FR-011: ルート `GET /:uid/:name` を `src/artifacts/serve.ts` が処理する
- FR-012: R2オブジェクトのbodyをそのまま返す。書き換え・注入は行わない
- FR-013、FR-015: `GET /_app/` が `uploaded_at DESC` で一覧を取得する
- FR-014: 一覧項目に名前・アップロード日時・公開状態・閲覧URLへのリンクを含める
- FR-016: 件数0のとき空状態のコンポーネントを表示する
- FR-017: 存在しないアーティファクトは本文・ヘッダを固定した404を返す
- SC-009: 一覧クエリに `(uid, uploaded_at)` のインデックスを張る

ヘッダーと認証:

- FR-018: `src/views/layout.tsx` の共通ヘッダにアップロードボタンを置き、全管理画面で共有する
- FR-019: ヘッダのログアウトを `/cdn-cgi/access/logout` へのリンクとする。Cloudflareがcookieを即時削除し、既発行トークンは20〜30秒で失効する
- FR-020: `/_app/*` をAccessで保護する。Workerに到達する前段で遮断される
- FR-021: API応答が401/302のとき、画面側で再認証を促し、再認証後に同じ画面へ戻す

公開設定:

- FR-022: `artifacts.visibility` のDEFAULTを `'private'` にし、INSERT時に明示的に指定しない
- FR-023、FR-024: `src/artifacts/serve.ts` で、非公開かつ非所有者のときFR-017と同一の404を返す
- FR-025、FR-027: `PUT /_app/api/artifacts/:name/visibility` が双方向のトグルを担う
- FR-026: 公開状態のときは認証を要求せずR2のbodyを返す
- FR-028: `Cache-Control: no-store` とCache API不使用で担保する
- FR-029: 一覧と詳細に公開状態を表示する
- FR-030: 公開状態はD1の列で、R2キーもルートも公開状態に依存しない
- FR-031: トグルAPIで `uid` の一致を検証する
- FR-032: アーティファクト応答は単一のHTMLのみで、一覧やナビゲーションを注入しない

利用者識別子(uid):

- FR-033、FR-037: `users` テーブルの `uid TEXT PRIMARY KEY`
- FR-034、FR-035、FR-036: `src/ids.ts` の生成関数(`a-z0-9` 10文字、CSPRNG由来)
- FR-038: 全クエリで `uid` を条件に含める。トグルと一覧は認証から解決したuidのみを使い、リクエストパラメータのuidは信用しない
- FR-039: `UNIQUE(uid, name)` により名前空間ごとの一意性になる

計測可能な成果:

- SC-001、SC-003、SC-007: UI導線の設計で担保し、quickstartの手順で実測する
- SC-002: `tests/integration/upload.test.ts` の同名アップロードケース
- SC-004、SC-005: `tests/integration/serve.test.ts` の未認証アクセスケース
- SC-006: D1の強整合性と `no-store` により、トグル完了後の次のリクエストから反映される
- SC-008: R2 bodyの無改変を配信テストで確認する
- SC-010: 公開状態とuid追加がURLに影響しない構造であることを設計で担保する
- SC-011: uid生成のunitテストで文字集合・長さ・重複を確認する

## Complexity Tracking

Constitution Checkに違反がないため、記載事項なし。
