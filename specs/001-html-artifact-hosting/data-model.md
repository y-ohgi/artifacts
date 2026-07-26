# Phase 1 Data Model: HTMLアーティファクト共有サイト

**Date**: 2026-07-26 | **Plan**: [plan.md](./plan.md) | **Spec**: [spec.md](./spec.md)

specのKey Entities(利用者、アーティファクト)を、D1(メタデータ)とR2(本体)に落とした設計。

## 全体像

- D1がメタデータと制約の唯一の正とする。所有関係・名前の一意性・公開状態はすべてD1で判定する
- R2はHTML本体のみを持つ。R2にオブジェクトが存在することを閲覧可否の根拠にはしない。D1に行がなければ存在しないものとして扱う
- 一貫性の方向: D1に行があるがR2にオブジェクトがない状態は「壊れた状態」として扱い、発生させない。逆にR2に孤児オブジェクトが残る状態は許容する(閲覧経路に現れないため)

## D1 スキーマ

`migrations/0001_init.sql` として作成する。

```sql
CREATE TABLE users (
  uid        TEXT PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE artifacts (
  uid                    TEXT NOT NULL,
  name                   TEXT NOT NULL,
  size                   INTEGER NOT NULL,
  visibility             TEXT NOT NULL DEFAULT 'private'
                           CHECK (visibility IN ('private', 'public')),
  uploaded_at            TEXT NOT NULL,
  visibility_changed_at  TEXT,
  PRIMARY KEY (uid, name),
  FOREIGN KEY (uid) REFERENCES users(uid)
) STRICT;

CREATE INDEX idx_artifacts_uid_uploaded_at
  ON artifacts (uid, uploaded_at DESC);
```

### users

- **uid**: 利用者の識別子。`a-z0-9` の10文字(FR-034・FR-035)。CSPRNG由来で連番・日時・メールに依存しない(FR-036)。主キーであることが2人以上への割り当てを防ぐ(FR-037)
- **email**: Cloudflare Accessが返す認証済みメールアドレス。JWT検証後にこの列でuidを引く。`UNIQUE` により1メールに複数uidが割り当たらない
- **created_at**: ISO 8601のUTC文字列

初期リリースではuidの発行は運用者の手作業(specのAssumptions)。運用者は `wrangler d1 execute` でINSERTする。手順は [quickstart.md](./quickstart.md) に記載した。

### artifacts

- **(uid, name)**: 複合主キー。同一uid内での名前の一意性(FR-007・FR-008)と、異なるuidであれば同じ名前を使える性質(FR-039)を同時に表現する
- **name**: `<base>.html` または `<base>.htm` の形。バリデーション規則は後述
- **size**: バイト数。一覧表示と上限検証の記録用
- **visibility**: `'private'` / `'public'`。DEFAULTが `'private'` であることがFR-022(既定は非公開)をスキーマレベルで担保する。INSERT時にこの列を指定しない
- **uploaded_at**: ISO 8601のUTC文字列。一覧の並び順(FR-015)の基準
- **visibility_changed_at**: 公開状態を最後に変更した時刻。初回は `NULL`。運用時に「いつ公開したか」を追える必要があるため保持する

`idx_artifacts_uid_uploaded_at` は一覧クエリ(`WHERE uid = ? ORDER BY uploaded_at DESC`)のためのインデックス。SC-009(100件で3秒以内)に対して余裕を持たせる。

`STRICT` を付けるのは、SQLiteの動的型付けによる意図しない型混入(`size` に文字列が入るなど)を防ぐため。

## R2 オブジェクト

- **バケット**: 1つ。バインディング名 `ARTIFACTS`
- **キー**: `<uid>/<name>`(例: `a3f9k2m1x8/report.html`)。URLパスの `/<uid>/<name>.html` と1対1で対応するため、キーからパスを導出する変換ロジックが不要になる
- **キー長**: R2の上限は1,024バイト。uid 10文字 + `/` + name 最大68文字なので余裕がある
- **httpMetadata**: `contentType: 'text/html; charset=utf-8'` を保存時に設定する。ただし配信時のヘッダはWorkerが明示的に組み立てるため、R2のメタデータには依存しない
- **customMetadata**: 使わない。メタデータの正はD1に一元化する

## バリデーション規則

### uid

- 文字集合は `a-z0-9` のみ(FR-034)
- 長さは10文字(FR-035の12文字以内を満たす)
- `crypto.getRandomValues` + rejection samplingで生成し、モジュロバイアスを持たない
- 生成後にINSERTを試み、主キー衝突なら再生成する

### name

正規表現とその補足条件:

- `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.html?$` に一致すること
- `..` を含まないこと
- `_` で始まらないこと(将来の予約prefixのための余地)

拒否する例とその理由(specのEdge Casesに対応):

- `../etc/passwd` — `..` を含み、`/` も含む
- `my report.html` — 空白を含む
- `レポート.html` — 非ASCII
- `_internal.html` — 予約prefix
- `report.txt` — `.html` / `.htm` で終わらない
- `report` — 拡張子がない

### 衝突時の候補算出(FR-007)

`<base>.<ext>` に対して `<base>-2.<ext>`、`<base>-3.<ext>` の順に、同一uid内で未使用のものを探す。上限を設けて(例: 100)見つからない場合は候補提示を諦め、利用者に別名の入力を促す。

### ファイル内容

- サイズ10 MB以下(FR-003)
- 拡張子が `.html` / `.htm`
- Content-Typeが `text/html` 系
- 先頭を空白除去した上で `<!doctype html`(大文字小文字を無視)または `<html` で始まる(FR-002)

3点すべてを満たす場合のみ受け付ける。

## 状態遷移

アーティファクトの公開状態のみが状態を持つ。

```text
        [アップロード完了]
               │
               ▼
        ┌─────────────┐   公開へ切り替え (FR-025)   ┌────────────┐
        │   private   │ ──────────────────────────▶ │   public   │
        │   (既定)    │ ◀────────────────────────── │            │
        └─────────────┘   非公開へ戻す (FR-027)      └────────────┘
```

遷移の性質:

- 初期状態は必ず `private`(FR-022)。スキーマのDEFAULTで担保する
- 双方向に、回数制限なく遷移できる(FR-025・FR-027)
- 遷移させられるのは所有者のみ(FR-031)。APIは認証から解決したuidのみを使い、リクエストパラメータのuidは信用しない
- 遷移によってR2キー・URL・`uploaded_at` は変化しない(FR-030)
- 遷移時に `visibility_changed_at` を更新する
- `public` → `private` の遷移後、次のリクエストから未認証アクセスが拒否される。D1の書き込み後読み取りが強整合であり、かつアーティファクト応答が `Cache-Control: no-store` でキャッシュを持たないため(FR-028・SC-006)

状態別のアクセス可否:

- `private` + 所有者 → 本文を返す
- `private` + 非所有者(未認証を含む) → 404(FR-023・FR-024)
- `public` + 誰でも → 本文を返す(FR-026)
- D1に行がない → 404

`private` + 非所有者の404と、行が存在しない場合の404は、ステータス・本文・ヘッダを完全に同一にする(FR-017・FR-024)。存在の有無を応答から判別できてはならない。

## 書き込みの順序と失敗時の扱い

アップロード(FR-009):

1. 名前とファイル内容を検証する
2. R2に `<uid>/<name>` を `put` する
3. D1に行を `INSERT` する
4. 3が失敗した場合、2で置いたR2オブジェクトを `delete` する

この順序により、D1に行があるのにR2に本体がない状態(一覧に出るが開けない)が生じない。逆の失敗(R2に孤児が残る)は閲覧経路に現れないため許容する。

なお名前の重複は2の前にD1で確認するが、それだけに頼らず主キー制約で最終的に弾く。事前チェックと `INSERT` の間に別のリクエストが割り込む競合を防ぐため。

## 初期リリースで持たないもの

specのAssumptionsに対応。

- 削除・差し替え: `artifacts` からのDELETEおよびR2からの削除を行うAPIは作らない。露出を止める手段は非公開へ戻すことで足りる
- 複数ファイルのバンドル: アーティファクト1件がR2オブジェクト1つに対応する前提を崩さない
- 利用者の招待・管理: `users` へのINSERTは運用者の手作業
- 閲覧数・アクセスログの保持: テーブルを持たない
