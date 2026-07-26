import { insertArtifact, type Visibility } from "../db";
import type { AppEnv } from "../env";
import { NAME_ALLOWED_DESCRIPTION, validateName } from "../ids";
import { objectKey } from "./serve";

/** FR-003. Well inside the 100 MB Workers request body limit. */
export const MAX_SIZE_BYTES = 10 * 1024 * 1024;

const ALLOWED_EXTENSIONS = [".html", ".htm"] as const;

/** Enough bytes to see a doctype or an opening <html> tag past leading blanks. */
const SNIFF_BYTES = 512;

export type UploadFailure =
  | { readonly reason: "no_file" }
  | { readonly reason: "too_large"; readonly limitBytes: number }
  | { readonly reason: "not_html" }
  | { readonly reason: "invalid_name"; readonly message: string; readonly allowed: string }
  | { readonly reason: "name_conflict" }
  | { readonly reason: "storage_failed" };

export type UploadOutcome =
  | {
      readonly ok: true;
      readonly name: string;
      readonly size: number;
      readonly visibility: Visibility;
      readonly uploadedAt: string;
    }
  | { readonly ok: false; readonly failure: UploadFailure };

function hasAllowedExtension(name: string): boolean {
  const lowered = name.toLowerCase();
  return ALLOWED_EXTENSIONS.some((extension) => lowered.endsWith(extension));
}

/**
 * Confirms the bytes actually look like HTML (FR-002).
 *
 * Checking only the extension and the Content-Type would let a file whose body
 * is JSON or a binary through, which spec.md lists as an edge case.
 */
function looksLikeHtml(bytes: Uint8Array): boolean {
  // Non-fatal by default, so invalid byte sequences become replacement
  // characters instead of throwing — a binary upload just fails the check below.
  const head = new TextDecoder()
    .decode(bytes.subarray(0, SNIFF_BYTES))
    .trimStart()
    .toLowerCase();

  return head.startsWith("<!doctype html") || head.startsWith("<html");
}

function isHtmlContentType(type: string): boolean {
  // Browsers usually send text/html for .html; some send an empty string.
  return type === "" || type.toLowerCase().startsWith("text/html");
}

/**
 * Stores an uploaded HTML file for `uid`.
 *
 * Write order is D1 first, then R2 — the reverse of what plan.md originally
 * described. Writing R2 first would overwrite the body of an existing artifact
 * at the same key before the D1 insert failed on the name conflict, destroying
 * the artifact that FR-008 says must survive. Reserving the name in D1 first
 * means a conflict is detected while R2 is still untouched.
 *
 * If the R2 write then fails, the reservation is rolled back so no row is left
 * pointing at a missing body (FR-009).
 */
export async function storeArtifact(
  env: AppEnv,
  uid: string,
  requestedName: string,
  file: File,
  now: string,
): Promise<UploadOutcome> {
  if (file.size > MAX_SIZE_BYTES) {
    return { ok: false, failure: { reason: "too_large", limitBytes: MAX_SIZE_BYTES } };
  }

  // HTML判定を名前検証より先に行う。`.txt` のような名前は名前規則にも違反するが、
  // 「HTMLとして受け付けられない」ほうが利用者にとって原因が分かりやすく、
  // contracts/http-api.md も拡張子違反を not_html としている。
  if (!hasAllowedExtension(requestedName) || !isHtmlContentType(file.type)) {
    return { ok: false, failure: { reason: "not_html" } };
  }

  const validated = validateName(requestedName);
  if (!validated.ok) {
    return {
      ok: false,
      failure: {
        reason: "invalid_name",
        message: validated.message,
        allowed: NAME_ALLOWED_DESCRIPTION,
      },
    };
  }
  const name = validated.name;

  // Buffered rather than streamed: the body has to be sniffed before it is
  // accepted, and R2 truncates streams of unknown length.
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > MAX_SIZE_BYTES) {
    return { ok: false, failure: { reason: "too_large", limitBytes: MAX_SIZE_BYTES } };
  }
  if (!looksLikeHtml(bytes)) {
    return { ok: false, failure: { reason: "not_html" } };
  }

  // Reserve the name. `visibility` is left to the schema default so that
  // "private unless explicitly published" is enforced in one place (FR-022).
  const reserved = await insertArtifact(env.DB, uid, name, bytes.byteLength, now);
  if (!reserved.ok) {
    return { ok: false, failure: { reason: "name_conflict" } };
  }

  try {
    await env.ARTIFACTS.put(objectKey(uid, name), bytes, {
      httpMetadata: { contentType: "text/html; charset=utf-8" },
    });
  } catch {
    await rollbackReservation(env, uid, name);
    return { ok: false, failure: { reason: "storage_failed" } };
  }

  return {
    ok: true,
    name,
    size: bytes.byteLength,
    visibility: "private",
    uploadedAt: now,
  };
}

/**
 * Removes a reservation whose body never landed.
 *
 * Deliberately scoped by uid and name so it can only ever remove the row this
 * request created. Failure here is swallowed: the caller is already returning an
 * error, and serveArtifact answers with the shared 404 when the body is absent.
 */
async function rollbackReservation(env: AppEnv, uid: string, name: string): Promise<void> {
  try {
    await env.DB.prepare("DELETE FROM artifacts WHERE uid = ? AND name = ?")
      .bind(uid, name)
      .run();
  } catch {
    // Intentionally ignored — see the comment above.
  }
}
