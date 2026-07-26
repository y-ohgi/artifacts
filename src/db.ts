/**
 * D1 への型付きアクセス層。
 *
 * 設計上の不変条件:
 * - `artifacts` を参照・更新するすべての関数は `uid` を必須引数として受け取る。
 *   uid を省略できる関数を作らないことで、他利用者の名前空間への越境
 *   (FR-038)を関数シグネチャの段階で不可能にする。
 * - 時刻は `Date` ではなく ISO 8601 の UTC 文字列で扱う(data-model.md)。
 * - 制約違反(名前衝突)の判別ロジックはこのモジュール内に閉じ込め、
 *   呼び出し側は例外の中身を知らずに結果型だけを見れば済むようにする。
 */

export type Visibility = "private" | "public";

/** `users` テーブルの1行。 */
export interface UserRow {
  uid: string;
  email: string;
  /** ISO 8601 UTC 文字列 */
  created_at: string;
}

/** `artifacts` テーブルの1行。 */
export interface ArtifactRow {
  uid: string;
  name: string;
  size: number;
  visibility: Visibility;
  /** ISO 8601 UTC 文字列 */
  uploaded_at: string;
  /** ISO 8601 UTC 文字列。公開状態を一度も変更していなければ null */
  visibility_changed_at: string | null;
}

/** 一覧表示(FR-014)に必要な列だけを持つ行。uid は呼び出し側が既に持っている。 */
export type ArtifactListItem = Omit<ArtifactRow, "uid">;

export type InsertUserResult =
  | { ok: true }
  | { ok: false; reason: "uid_taken" | "email_taken" };

/** `name_taken` は同一 uid の名前空間に同名が既に存在すること(FR-007・FR-008)。 */
export type InsertArtifactResult = { ok: true } | { ok: false; reason: "name_taken" };

/** `not_found` は「その uid の名前空間に該当行が無い」ことを表す(FR-031・FR-038)。 */
export type UpdateVisibilityResult = { ok: true } | { ok: false; reason: "not_found" };

/**
 * D1 は UNIQUE / PRIMARY KEY 制約違反を例外として throw する。実測したメッセージ:
 *
 *   D1_ERROR: UNIQUE constraint failed: users.email: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)
 *   D1_ERROR: UNIQUE constraint failed: artifacts.uid, artifacts.name: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY)
 *
 * エラーコードで判別する方法は公式ドキュメントで確認できていないため、
 * メッセージの部分一致で判別する。判別をこの関数1つに閉じ込め、他の箇所では
 * 例外の中身を見ない。
 *
 * @returns 制約違反なら違反した列の一覧(`["users.email"]` など)、それ以外は null
 */
const UNIQUE_CONSTRAINT_MARKER = "UNIQUE constraint failed";

function uniqueConstraintColumns(error: unknown): string[] | null {
  const message = error instanceof Error ? error.message : String(error);
  const index = message.indexOf(UNIQUE_CONSTRAINT_MARKER);
  if (index === -1) {
    return null;
  }
  // マーカー直後の `: ` を落とし、末尾に付く `: SQLITE_CONSTRAINT (...)` を切る。
  const detail = message.slice(index + UNIQUE_CONSTRAINT_MARKER.length).replace(/^\s*:\s*/, "");
  const codeIndex = detail.search(/:\s*SQLITE_/);
  const columns = codeIndex === -1 ? detail : detail.slice(0, codeIndex);
  return columns
    .split(",")
    .map((column) => column.trim())
    .filter((column) => column.length > 0);
}

/** 認証済みメールアドレスから利用者を引く。未登録なら null(FR-033)。 */
export async function findUserByEmail(
  db: D1Database,
  email: string,
): Promise<UserRow | null> {
  return await db
    .prepare("SELECT uid, email, created_at FROM users WHERE email = ?")
    .bind(email)
    .first<UserRow>();
}

/**
 * 運用者による uid 発行(specの Assumptions)。
 * uid の主キー衝突と email の UNIQUE 違反を区別して返すため、呼び出し側は
 * 「uid を再生成すべきか」「そのメールは既に発行済みか」を判断できる。
 */
export async function insertUser(
  db: D1Database,
  uid: string,
  email: string,
  createdAt: string,
): Promise<InsertUserResult> {
  try {
    await db
      .prepare("INSERT INTO users (uid, email, created_at) VALUES (?, ?, ?)")
      .bind(uid, email, createdAt)
      .run();
    return { ok: true };
  } catch (error) {
    const columns = uniqueConstraintColumns(error);
    if (columns === null) {
      throw error;
    }
    return {
      ok: false,
      reason: columns.includes("users.email") ? "email_taken" : "uid_taken",
    };
  }
}

/**
 * 指定 uid の名前空間のアーティファクト一覧。
 * `uploaded_at` の降順(FR-015)で返し、他 uid の行は返さない(FR-038)。
 */
export async function listArtifacts(
  db: D1Database,
  uid: string,
): Promise<ArtifactListItem[]> {
  const { results } = await db
    .prepare(
      `SELECT name, size, visibility, uploaded_at, visibility_changed_at
         FROM artifacts
        WHERE uid = ?
        ORDER BY uploaded_at DESC`,
    )
    .bind(uid)
    .all<ArtifactListItem>();
  return results;
}

/** 指定 uid の名前空間の1件を取得する。無ければ null。 */
export async function findArtifact(
  db: D1Database,
  uid: string,
  name: string,
): Promise<ArtifactRow | null> {
  return await db
    .prepare(
      `SELECT uid, name, size, visibility, uploaded_at, visibility_changed_at
         FROM artifacts
        WHERE uid = ? AND name = ?`,
    )
    .bind(uid, name)
    .first<ArtifactRow>();
}

/**
 * アーティファクトを登録する。
 * `visibility` は指定せず、スキーマの DEFAULT `'private'` に委ねる(FR-022)。
 * 名前衝突は事前チェック(`nameExists`)だけに頼らず、複合主キー違反としても
 * 捕捉する。事前チェックと INSERT の間に別リクエストが割り込む競合があるため。
 */
export async function insertArtifact(
  db: D1Database,
  uid: string,
  name: string,
  size: number,
  uploadedAt: string,
): Promise<InsertArtifactResult> {
  try {
    await db
      .prepare("INSERT INTO artifacts (uid, name, size, uploaded_at) VALUES (?, ?, ?, ?)")
      .bind(uid, name, size, uploadedAt)
      .run();
    return { ok: true };
  } catch (error) {
    if (uniqueConstraintColumns(error) === null) {
      throw error;
    }
    return { ok: false, reason: "name_taken" };
  }
}

/**
 * 公開状態を切り替える(FR-025・FR-027)。
 * WHERE に uid を含むため、他利用者の行は更新できない(FR-031・FR-038)。
 * 更新行数が0の場合は `not_found` を返し、呼び出し側が404を返せるようにする。
 */
export async function updateVisibility(
  db: D1Database,
  uid: string,
  name: string,
  visibility: Visibility,
  changedAt: string,
): Promise<UpdateVisibilityResult> {
  const { meta } = await db
    .prepare(
      `UPDATE artifacts
          SET visibility = ?, visibility_changed_at = ?
        WHERE uid = ? AND name = ?`,
    )
    .bind(visibility, changedAt, uid, name)
    .run();
  return meta.changes > 0 ? { ok: true } : { ok: false, reason: "not_found" };
}

/**
 * 同一 uid の名前空間に同名が存在するか(FR-007 の候補算出に使う)。
 * 名前の一意性は uid ごとに判定する(FR-039)。
 */
export async function nameExists(
  db: D1Database,
  uid: string,
  name: string,
): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS present FROM artifacts WHERE uid = ? AND name = ?")
    .bind(uid, name)
    .first<{ present: number }>();
  return row !== null;
}
