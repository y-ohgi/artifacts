import { resolveOwner } from "../auth";
import { findArtifact } from "../db";
import type { AppEnv } from "../env";
import { artifactHeaders } from "../headers";
import { UID_LENGTH, validateName } from "../ids";

/** uid is exactly `UID_LENGTH` lowercase alphanumerics (FR-034, FR-035). */
const UID_PATTERN = new RegExp(`^[a-z0-9]{${UID_LENGTH}}$`);

/**
 * The single 404 used by every rejection path.
 *
 * FR-017 and FR-024 require that "exists but you may not see it" and "does not
 * exist" are indistinguishable. Building the response in one place — with a
 * fixed body so even Content-Length matches — is what makes that hold. Do not
 * add a reason, a header or a distinct body to any individual branch.
 */
const NOT_FOUND_BODY = "Not Found";

function notFound(): Response {
  return new Response(NOT_FOUND_BODY, {
    status: 404,
    headers: artifactHeaders(),
  });
}

/** R2 keys mirror the URL path, so no translation table is needed. */
export function objectKey(uid: string, name: string): string {
  return `${uid}/${name}`;
}

/**
 * Serves `/<uid>/<name>.html` (FR-011, FR-012, FR-023, FR-024, FR-026).
 *
 * Public artifacts are returned without authentication. Private ones are
 * returned only to their owner; everyone else gets the shared 404.
 */
export async function serveArtifact(
  env: AppEnv,
  request: Request,
  uid: string,
  name: string,
): Promise<Response> {
  if (!UID_PATTERN.test(uid) || !validateName(name).ok) {
    return notFound();
  }

  const artifact = await findArtifact(env.DB, uid, name);
  if (artifact === null) {
    return notFound();
  }

  if (artifact.visibility === "private") {
    const owner = await resolveOwner(env, request);
    if (!owner.ok || owner.uid !== uid) {
      return notFound();
    }
  }

  const object = await env.ARTIFACTS.get(objectKey(uid, name));
  if (object === null) {
    // Metadata without a body. Upload deletes the row when the R2 write fails,
    // so this window is tiny — but it must not leak a different response.
    return notFound();
  }

  // The body is passed through untouched (FR-012, FR-032): no wrapper markup,
  // no injected navigation, no rewriting.
  return new Response(object.body, { status: 200, headers: artifactHeaders() });
}
