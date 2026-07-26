-- Migration number: 0001 	 2026-07-26T00:00:00.000Z
-- specs/001-html-artifact-hosting/data-model.md の「D1 スキーマ」節に対応する。

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
