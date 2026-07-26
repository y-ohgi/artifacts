/**
 * Response header profiles.
 *
 * See specs/001-html-artifact-hosting/contracts/http-api.md ("共通のレスポンスヘッダ").
 *
 * The two profiles must never be swapped: the artifact profile sandboxes the
 * response body (untrusted HTML), while the admin profile locks the app UI down
 * with `default-src 'self'` and forbids framing. They are therefore exposed
 * under distinct names and distinct types.
 */

/** Headers for the management UI and its JSON APIs (`/_app/*`). */
export const ADMIN_RESPONSE_HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'",
} as const;

/** Headers for artifact delivery (`/<uid>/<name>.html`). */
export const ARTIFACT_RESPONSE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Content-Security-Policy": "sandbox allow-scripts allow-popups allow-forms allow-modals",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
} as const;

export type AdminResponseHeaders = typeof ADMIN_RESPONSE_HEADERS;
export type ArtifactResponseHeaders = typeof ARTIFACT_RESPONSE_HEADERS;

/** Plain object copy of the admin profile, for spreading into header records. */
export function adminHeaderRecord(): Record<string, string> {
  return { ...ADMIN_RESPONSE_HEADERS };
}

/** Plain object copy of the artifact profile, for spreading into header records. */
export function artifactHeaderRecord(): Record<string, string> {
  return { ...ARTIFACT_RESPONSE_HEADERS };
}

/**
 * `Headers` instance for the management UI.
 * `extra` is applied after the profile, so callers can add e.g. `Content-Type`.
 */
export function adminHeaders(extra?: HeadersInit): Headers {
  return buildHeaders(ADMIN_RESPONSE_HEADERS, extra);
}

/**
 * `Headers` instance for artifact delivery.
 * `extra` is applied after the profile; note that overriding `Cache-Control`
 * or the sandbox CSP would violate FR-028 and the artifact isolation contract.
 */
export function artifactHeaders(extra?: HeadersInit): Headers {
  return buildHeaders(ARTIFACT_RESPONSE_HEADERS, extra);
}

function buildHeaders(
  profile: AdminResponseHeaders | ArtifactResponseHeaders,
  extra?: HeadersInit,
): Headers {
  const headers = new Headers(profile);

  if (extra !== undefined) {
    for (const [name, value] of new Headers(extra)) {
      headers.set(name, value);
    }
  }

  return headers;
}
