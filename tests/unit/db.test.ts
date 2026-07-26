import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  findArtifact,
  findUserByEmail,
  insertArtifact,
  insertUser,
  listArtifacts,
  nameExists,
  updateVisibility,
} from "../../src/db";

const db = env.DB;

const OWNER = "aaaaaaaaaa";
const OTHER = "bbbbbbbbbb";

/**
 * `artifacts.uid` は `users.uid` への外部キーなので、アーティファクトを入れる前に
 * 利用者行が必要になる場合がある。data-model.md のスキーマを正として、テスト側で
 * 両方の利用者を用意する。
 *
 * @cloudflare/vitest-pool-workers 0.18 はテスト単位のストレージ巻き戻しを行わない
 * (`isolatedStorage` オプションが存在しない)ため、各テストの前に明示的に消す。
 * 外部キーの向きに合わせて `artifacts` → `users` の順で削除する。
 */
beforeEach(async () => {
  await db.batch([db.prepare("DELETE FROM artifacts"), db.prepare("DELETE FROM users")]);

  expect(await insertUser(db, OWNER, "owner@example.test", "2026-07-01T00:00:00.000Z")).toEqual({
    ok: true,
  });
  expect(await insertUser(db, OTHER, "other@example.test", "2026-07-01T00:00:00.000Z")).toEqual({
    ok: true,
  });
});

describe("insertArtifact", () => {
  it("visibility を指定しないため既定で private になる (FR-022)", async () => {
    const result = await insertArtifact(db, OWNER, "report.html", 1234, "2026-07-10T00:00:00.000Z");
    expect(result).toEqual({ ok: true });

    const row = await findArtifact(db, OWNER, "report.html");
    expect(row).not.toBeNull();
    expect(row?.visibility).toBe("private");
    expect(row?.visibility_changed_at).toBeNull();
    expect(row?.size).toBe(1234);
    expect(row?.uploaded_at).toBe("2026-07-10T00:00:00.000Z");
  });

  it("同一uidで同名を2回insertすると衝突として判別でき、1件目は変化しない (FR-008)", async () => {
    expect(await insertArtifact(db, OWNER, "report.html", 100, "2026-07-10T00:00:00.000Z")).toEqual({
      ok: true,
    });

    const second = await insertArtifact(db, OWNER, "report.html", 999, "2026-07-11T00:00:00.000Z");
    expect(second).toEqual({ ok: false, reason: "name_taken" });

    // 暗黙の上書きが起きていないこと。
    const row = await findArtifact(db, OWNER, "report.html");
    expect(row?.size).toBe(100);
    expect(row?.uploaded_at).toBe("2026-07-10T00:00:00.000Z");
    expect(await listArtifacts(db, OWNER)).toHaveLength(1);
  });

  it("異なるuidであれば同じ名前をinsertできる (FR-039)", async () => {
    expect(await insertArtifact(db, OWNER, "report.html", 100, "2026-07-10T00:00:00.000Z")).toEqual({
      ok: true,
    });
    expect(await insertArtifact(db, OTHER, "report.html", 200, "2026-07-10T00:00:00.000Z")).toEqual({
      ok: true,
    });

    expect((await findArtifact(db, OWNER, "report.html"))?.size).toBe(100);
    expect((await findArtifact(db, OTHER, "report.html"))?.size).toBe(200);
  });

  it("複合主キー違反の生の例外メッセージが UNIQUE constraint failed を含む", async () => {
    await insertArtifact(db, OWNER, "report.html", 100, "2026-07-10T00:00:00.000Z");

    // src/db.ts の判別ロジックが依存している文字列を、生のクエリで固定する。
    // 実測値: "D1_ERROR: UNIQUE constraint failed: artifacts.uid, artifacts.name:
    //          SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY)"
    await expect(
      db
        .prepare("INSERT INTO artifacts (uid, name, size, uploaded_at) VALUES (?, ?, ?, ?)")
        .bind(OWNER, "report.html", 100, "2026-07-10T00:00:00.000Z")
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed: artifacts\.uid, artifacts\.name/);
  });
});

describe("listArtifacts", () => {
  it("uploaded_at の降順で返す (FR-015)", async () => {
    await insertArtifact(db, OWNER, "old.html", 1, "2026-07-01T00:00:00.000Z");
    await insertArtifact(db, OWNER, "newest.html", 2, "2026-07-20T00:00:00.000Z");
    await insertArtifact(db, OWNER, "middle.html", 3, "2026-07-10T00:00:00.000Z");

    const rows = await listArtifacts(db, OWNER);
    expect(rows.map((row) => row.name)).toEqual(["newest.html", "middle.html", "old.html"]);
  });

  it("他uidの行を返さない (FR-038)", async () => {
    await insertArtifact(db, OWNER, "mine.html", 1, "2026-07-10T00:00:00.000Z");
    await insertArtifact(db, OTHER, "theirs.html", 2, "2026-07-11T00:00:00.000Z");

    expect((await listArtifacts(db, OWNER)).map((row) => row.name)).toEqual(["mine.html"]);
    expect((await listArtifacts(db, OTHER)).map((row) => row.name)).toEqual(["theirs.html"]);
  });

  it("一覧に必要な列(名前・サイズ・公開状態・日時)を返す (FR-014)", async () => {
    await insertArtifact(db, OWNER, "mine.html", 42, "2026-07-10T00:00:00.000Z");

    expect(await listArtifacts(db, OWNER)).toEqual([
      {
        name: "mine.html",
        size: 42,
        visibility: "private",
        uploaded_at: "2026-07-10T00:00:00.000Z",
        visibility_changed_at: null,
      },
    ]);
  });
});

describe("findArtifact", () => {
  it("他uidの名前空間の行は取得できない (FR-038)", async () => {
    await insertArtifact(db, OTHER, "theirs.html", 1, "2026-07-10T00:00:00.000Z");

    expect(await findArtifact(db, OWNER, "theirs.html")).toBeNull();
  });
});

describe("updateVisibility", () => {
  it("所有者の行を public へ更新し visibility_changed_at を記録する (FR-025)", async () => {
    await insertArtifact(db, OWNER, "report.html", 1, "2026-07-10T00:00:00.000Z");

    const result = await updateVisibility(
      db,
      OWNER,
      "report.html",
      "public",
      "2026-07-12T00:00:00.000Z",
    );
    expect(result).toEqual({ ok: true });

    const row = await findArtifact(db, OWNER, "report.html");
    expect(row?.visibility).toBe("public");
    expect(row?.visibility_changed_at).toBe("2026-07-12T00:00:00.000Z");
    // 公開状態の変更で uploaded_at は変わらない (FR-030)
    expect(row?.uploaded_at).toBe("2026-07-10T00:00:00.000Z");
  });

  it("他uidの行は更新しない (FR-031)", async () => {
    await insertArtifact(db, OTHER, "theirs.html", 1, "2026-07-10T00:00:00.000Z");

    const result = await updateVisibility(
      db,
      OWNER,
      "theirs.html",
      "public",
      "2026-07-12T00:00:00.000Z",
    );
    expect(result).toEqual({ ok: false, reason: "not_found" });

    const row = await findArtifact(db, OTHER, "theirs.html");
    expect(row?.visibility).toBe("private");
    expect(row?.visibility_changed_at).toBeNull();
  });

  it("存在しない名前では not_found を返す", async () => {
    expect(
      await updateVisibility(db, OWNER, "missing.html", "public", "2026-07-12T00:00:00.000Z"),
    ).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("nameExists", () => {
  it("同一uidの名前空間だけを見る (FR-039)", async () => {
    await insertArtifact(db, OTHER, "report.html", 1, "2026-07-10T00:00:00.000Z");

    expect(await nameExists(db, OWNER, "report.html")).toBe(false);
    expect(await nameExists(db, OTHER, "report.html")).toBe(true);
  });
});

describe("findUserByEmail / insertUser", () => {
  it("未登録メールでは null を返す", async () => {
    expect(await findUserByEmail(db, "nobody@example.test")).toBeNull();
  });

  it("登録済みメールから uid を引ける (FR-033)", async () => {
    const user = await findUserByEmail(db, "owner@example.test");
    expect(user?.uid).toBe(OWNER);
    expect(user?.created_at).toBe("2026-07-01T00:00:00.000Z");
  });

  it("同じ uid を2人へ割り当てられない (FR-037)", async () => {
    expect(await insertUser(db, OWNER, "dup@example.test", "2026-07-02T00:00:00.000Z")).toEqual({
      ok: false,
      reason: "uid_taken",
    });
  });

  it("同じメールへ2つの uid を割り当てられない", async () => {
    expect(await insertUser(db, "cccccccccc", "owner@example.test", "2026-07-02T00:00:00.000Z")).toEqual(
      { ok: false, reason: "email_taken" },
    );
  });

  it("uid 衝突と email 衝突の生の例外メッセージが列名で区別できる", async () => {
    // insertUser の reason 判定が依存している文字列を固定する。
    await expect(
      db
        .prepare("INSERT INTO users (uid, email, created_at) VALUES (?, ?, ?)")
        .bind(OWNER, "dup@example.test", "2026-07-02T00:00:00.000Z")
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed: users\.uid/);

    await expect(
      db
        .prepare("INSERT INTO users (uid, email, created_at) VALUES (?, ?, ?)")
        .bind("cccccccccc", "owner@example.test", "2026-07-02T00:00:00.000Z")
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed: users\.email/);
  });
});

describe("スキーマ制約", () => {
  it("users と artifacts が STRICT テーブルである", async () => {
    const { results } = await db
      .prepare("SELECT name, strict FROM pragma_table_list WHERE name IN ('users', 'artifacts')")
      .all<{ name: string; strict: number }>();

    expect(results).toHaveLength(2);
    for (const table of results) {
      expect(table.strict, `${table.name} should be STRICT`).toBe(1);
    }
  });

  it("STRICT により size に文字列を入れられない", async () => {
    await expect(
      db
        .prepare("INSERT INTO artifacts (uid, name, size, uploaded_at) VALUES (?, ?, ?, ?)")
        .bind(OWNER, "bad-size.html", "not-a-number", "2026-07-10T00:00:00.000Z")
        .run(),
    ).rejects.toThrow(/cannot store TEXT value in INTEGER column/i);
  });

  it("visibility の CHECK 制約が効いている", async () => {
    await expect(
      db
        .prepare(
          "INSERT INTO artifacts (uid, name, size, visibility, uploaded_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(OWNER, "bogus.html", 1, "bogus", "2026-07-10T00:00:00.000Z")
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it("外部キー制約が効いており、未登録uidのinsertは name_taken に丸められず throw する", async () => {
    // UNIQUE 以外の制約違反は insertArtifact が握り潰さず再throwすることの確認。
    await expect(
      insertArtifact(db, "zzzzzzzzzz", "orphan.html", 1, "2026-07-10T00:00:00.000Z"),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });

  it("visibility を bogus へ UPDATE できない", async () => {
    await insertArtifact(db, OWNER, "report.html", 1, "2026-07-10T00:00:00.000Z");

    await expect(
      db
        .prepare("UPDATE artifacts SET visibility = ? WHERE uid = ? AND name = ?")
        .bind("bogus", OWNER, "report.html")
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);

    expect((await findArtifact(db, OWNER, "report.html"))?.visibility).toBe("private");
  });

  it("一覧クエリ用のインデックスが存在する", async () => {
    const row = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
      .bind("idx_artifacts_uid_uploaded_at")
      .first<{ name: string }>();

    expect(row?.name).toBe("idx_artifacts_uid_uploaded_at");
  });
});
