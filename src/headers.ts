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

/**
 * Headers for the management UI and its JSON APIs (`/_app/*`).
 *
 * The CSP has no `style-src`/`script-src`, so both fall back to `default-src
 * 'self'` and nothing inline is allowed to run. The pages are written to match:
 * the stylesheet is served from its own same-origin route (src/views/styles.ts)
 * and there is no inline `<style>`, no `style=` attribute and no script at all.
 * If this CSP ever changes, re-check that the pages still get their styles —
 * a mismatch is silent in the response headers and only shows up in a browser.
 * tests/integration/csp-styles.test.ts checks the two sides against each other.
 */
export const ADMIN_RESPONSE_HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'",
} as const;

/**
 * Headers for the management UI's own static assets (`/_app/assets/*`).
 *
 * Spread from the admin profile so the security headers can never drift apart;
 * only the caching differs. The asset paths carry a hash of their content, so a
 * changed asset is requested under a new path and a long-lived cached copy can
 * never go stale. `private` keeps shared caches out of an Access-protected
 * response.
 */
export const ADMIN_ASSET_RESPONSE_HEADERS = {
  ...ADMIN_RESPONSE_HEADERS,
  "Cache-Control": "private, max-age=31536000, immutable",
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
export type AdminAssetResponseHeaders = typeof ADMIN_ASSET_RESPONSE_HEADERS;
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
 * `Headers` instance for a management-UI static asset.
 * `extra` is applied after the profile, so callers can add e.g. `Content-Type`.
 */
export function adminAssetHeaders(extra?: HeadersInit): Headers {
  return buildHeaders(ADMIN_ASSET_RESPONSE_HEADERS, extra);
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
  profile: AdminResponseHeaders | AdminAssetResponseHeaders | ArtifactResponseHeaders,
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
