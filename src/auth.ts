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

/**
 * Cookie Access sets on the whole hostname after a successful login.
 *
 * The header above only exists on requests that passed through an Access
 * application, so it is absent on `/<uid>/<name>` — a path that must stay
 * unprotected for public artifacts to work (contracts/http-api.md). The cookie
 * carries the same signed JWT and is scoped to the host, so it is the only
 * identity available there. It is verified exactly like the header: signature
 * against the team JWKS, plus `iss`, `aud` and expiry. An unverified cookie can
 * therefore never grant access.
 */
export const ACCESS_JWT_COOKIE = "CF_Authorization";

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

/** Reads one cookie value out of a `Cookie` header. */
function cookieValue(cookieHeader: string | null, name: string): string | null {
  if (cookieHeader === null) {
    return null;
  }

  for (const pair of cookieHeader.split(";")) {
    const separator = pair.indexOf("=");
    if (separator === -1 || pair.slice(0, separator).trim() !== name) {
      continue;
    }

    const value = pair.slice(separator + 1).trim();
    return value === "" ? null : value;
  }

  return null;
}

/**
 * Picks the Access token off the request.
 *
 * The header wins when both are present: on an Access-protected path it is
 * injected per request by Access itself, while the cookie is whatever the client
 * happened to send.
 */
function accessToken(request: Request): string | null {
  const header = request.headers.get(ACCESS_JWT_HEADER);
  if (header !== null && header !== "") {
    return header;
  }

  return cookieValue(request.headers.get("Cookie"), ACCESS_JWT_COOKIE);
}

/**
 * Extracts the verified email from the Access JWT on the request.
 *
 * Returns null when no token is present or the token fails verification. The
 * `Cf-Access-Authenticated-User-Email` header is deliberately not used as a
 * source of truth: only a signature check proves the value came from Access.
 */
async function verifiedEmailFromAccessJwt(
  request: Request,
  teamDomain: string,
  audience: string,
): Promise<string | null> {
  const token = accessToken(request);
  if (token === null) {
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
