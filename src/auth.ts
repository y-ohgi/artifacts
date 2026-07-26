import { createRemoteJWKSet, jwtVerify } from "jose";

import { findUserByEmail } from "./db";
import { isDevelopmentEnvironment, type AppEnv } from "./env";

/**
 * Header that Cloudflare Access injects on requests to a protected application.
 * The docs recommend validating this rather than the CF_Authorization cookie,
 * because the cookie is not guaranteed to reach the origin.
 * https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/
 */
export const ACCESS_JWT_HEADER = "Cf-Access-Jwt-Assertion";

export type OwnerResolution =
  | { readonly ok: true; readonly uid: string; readonly email: string }
  /** No usable identity on the request. */
  | { readonly ok: false; readonly reason: "unauthenticated" }
  /** Identity verified, but no uid has been issued for that email yet. */
  | { readonly ok: false; readonly reason: "not_registered"; readonly email: string }
  /** The Worker is missing the configuration needed to verify an identity. */
  | { readonly ok: false; readonly reason: "misconfigured" };

/**
 * JWKS fetchers, one per team domain.
 *
 * `createRemoteJWKSet` keeps its own cache and re-fetches on an unknown `kid`,
 * which is what we need: Access rotates its signing keys every six weeks, so the
 * keys must never be pinned. Keeping the instance at module scope lets that
 * cache survive across requests handled by the same isolate.
 */
const jwkSetCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwkSetFor(teamDomain: string): ReturnType<typeof createRemoteJWKSet> {
  const cached = jwkSetCache.get(teamDomain);
  if (cached !== undefined) {
    return cached;
  }

  const created = createRemoteJWKSet(
    new URL(`https://${teamDomain}/cdn-cgi/access/certs`),
  );
  jwkSetCache.set(teamDomain, created);
  return created;
}

/**
 * Extracts the verified email from the Access JWT on the request.
 *
 * Returns null when the header is absent or the token fails verification. The
 * `Cf-Access-Authenticated-User-Email` header is deliberately not used as a
 * source of truth: only a signature check proves the value came from Access.
 */
async function verifiedEmailFromAccessJwt(
  request: Request,
  teamDomain: string,
  audience: string,
): Promise<string | null> {
  const token = request.headers.get(ACCESS_JWT_HEADER);
  if (token === null || token === "") {
    return null;
  }

  try {
    const { payload } = await jwtVerify(token, jwkSetFor(teamDomain), {
      issuer: `https://${teamDomain}`,
      audience,
    });

    const email = payload["email"];
    return typeof email === "string" && email !== "" ? email : null;
  } catch {
    // Signature, issuer, audience or expiry check failed. Treated the same as a
    // missing token so that callers cannot distinguish the two.
    return null;
  }
}

/**
 * Resolves the identity of the requester and maps it onto a uid.
 *
 * Deployed environments have exactly one path: verify the Access JWT. The
 * development path requires ENVIRONMENT to be "local" or "test", and that
 * variable exists only in .dev.vars and vitest.config.ts — never in
 * wrangler.jsonc — so a deployed Worker cannot reach it (fail closed).
 */
export async function resolveOwner(
  env: AppEnv,
  request: Request,
): Promise<OwnerResolution> {
  const email = isDevelopmentEnvironment(env)
    ? (env.DEV_OWNER_EMAIL ?? null)
    : await resolveEmailFromAccess(env, request);

  if (email === null) {
    return env.ENVIRONMENT === undefined &&
      (env.ACCESS_TEAM_DOMAIN === undefined || env.ACCESS_AUD === undefined)
      ? { ok: false, reason: "misconfigured" }
      : { ok: false, reason: "unauthenticated" };
  }

  const user = await findUserByEmail(env.DB, email);
  if (user === null) {
    return { ok: false, reason: "not_registered", email };
  }

  return { ok: true, uid: user.uid, email: user.email };
}

async function resolveEmailFromAccess(
  env: AppEnv,
  request: Request,
): Promise<string | null> {
  const teamDomain = env.ACCESS_TEAM_DOMAIN;
  const audience = env.ACCESS_AUD;

  // Without both values no token can be verified. Returning null here means the
  // request is rejected; it must never fall through to an unverified identity.
  if (teamDomain === undefined || audience === undefined) {
    return null;
  }

  return await verifiedEmailFromAccessJwt(request, teamDomain, audience);
}

/**
 * Rejects cross-origin state-changing requests.
 *
 * Defence in depth behind the `Content-Security-Policy: sandbox` on artifact
 * responses: an artifact document is placed in an opaque origin and so cannot
 * make a credentialed same-origin request, and this check refuses anything that
 * did not originate from this site anyway.
 */
export function isSameOriginRequest(request: Request): boolean {
  const site = request.headers.get("Sec-Fetch-Site");
  if (site !== null) {
    return site === "same-origin" || site === "none";
  }

  const origin = request.headers.get("Origin");
  if (origin === null) {
    // No Origin and no Sec-Fetch-Site: a plain form post or a non-browser
    // client. Accepted, since Access already gates every mutating route.
    return true;
  }

  return origin === new URL(request.url).origin;
}
