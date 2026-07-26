import { env, exports } from "cloudflare:workers";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ACCESS_JWT_HEADER } from "../../src/auth";
import { insertArtifact, insertUser } from "../../src/db";

/**
 * Verification of the Cloudflare Access JWT (T040, T041).
 *
 * Every other test file runs with ENVIRONMENT="test", which takes the
 * development identity path and never touches `jose`. This file removes that
 * variable so the deployed code path — verify the JWT, then map the verified
 * email onto a uid — is the one under test. The JWKS endpoint is served by a
 * stubbed `globalThis.fetch` with a key pair generated here, so no Cloudflare
 * account is involved. (`cloudflare:test` in 0.18 no longer exports `fetchMock`,
 * and the test shares its isolate with the Worker, so patching the global is
 * both available and sufficient.)
 */

const TEAM_DOMAIN = "example-team.cloudflareaccess.com";
const ISSUER = `https://${TEAM_DOMAIN}`;
const AUD = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const KID = "test-signing-key";

const OWNER_EMAIL = "owner@example.test";
const OWNER_UID = "aaaaaaaaaa";

const ORIGIN = "https://artifacts.example.test";

const db = env.DB;

const worker = (exports as unknown as {
  default: { fetch: (request: Request) => Promise<Response> };
}).default;

/** Mutable view of the bindings, so the identity configuration can be swapped. */
const mutableEnv = env as unknown as Record<string, string | undefined>;

const CERTS_URL = `${ISSUER}/cdn-cgi/access/certs`;

let signingKey: CryptoKey;
let foreignKey: CryptoKey;
let originalEnvironment: string | undefined;
let originalFetch: typeof globalThis.fetch;
let certsRequests = 0;

beforeAll(async () => {
  const signing = await generateKeyPair("RS256", { extractable: true });
  const foreign = await generateKeyPair("RS256", { extractable: true });
  signingKey = signing.privateKey;
  foreignKey = foreign.privateKey;

  const jwks = JSON.stringify({
    keys: [{ ...(await exportJWK(signing.publicKey)), kid: KID, alg: "RS256", use: "sig" }],
  });

  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === CERTS_URL) {
      certsRequests += 1;
      return new Response(jwks, { headers: { "Content-Type": "application/json" } });
    }
    return await originalFetch(input, init);
  }) as typeof globalThis.fetch;

  originalEnvironment = mutableEnv["ENVIRONMENT"];
});

afterAll(() => {
  // Restore the development identity for any file that shares this isolate.
  mutableEnv["ENVIRONMENT"] = originalEnvironment;
  globalThis.fetch = originalFetch;
});

beforeEach(async () => {
  // No ENVIRONMENT means the Access path, exactly as in a deployed Worker.
  mutableEnv["ENVIRONMENT"] = undefined;
  mutableEnv["ACCESS_TEAM_DOMAIN"] = TEAM_DOMAIN;
  mutableEnv["ACCESS_AUD"] = AUD;

  await db.batch([db.prepare("DELETE FROM artifacts"), db.prepare("DELETE FROM users")]);
  await insertUser(db, OWNER_UID, OWNER_EMAIL, "2026-07-01T00:00:00.000Z");
  await insertArtifact(db, OWNER_UID, "secret.html", 42, "2026-07-02T00:00:00.000Z");
});

afterEach(() => {
  mutableEnv["ENVIRONMENT"] = originalEnvironment;
});

type TokenOptions = {
  email?: string;
  audience?: string;
  issuer?: string;
  key?: CryptoKey;
  expiresIn?: string;
};

async function mintToken(options: TokenOptions = {}): Promise<string> {
  return await new SignJWT({ email: options.email ?? OWNER_EMAIL })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuedAt()
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? AUD)
    .setExpirationTime(options.expiresIn ?? "1h")
    .sign(options.key ?? signingKey);
}

function listRequest(token?: string): Request {
  const headers = new Headers({ Accept: "application/json" });
  if (token !== undefined) {
    headers.set(ACCESS_JWT_HEADER, token);
  }

  return new Request(`${ORIGIN}/_app/api/artifacts`, { headers });
}

/** Fails if a rejected response leaked any part of the artifact list. */
async function expectNoContent(response: Response): Promise<void> {
  const body = await response.text();
  expect(body).not.toContain("secret.html");
  expect(body).not.toContain("artifacts\":[{");
}

describe("管理APIはAccessのJWTを検証する (FR-020, T040)", () => {
  it("JWTが無いリクエストには内容を返さない", async () => {
    const response = await worker.fetch(listRequest());

    expect(response.status).toBe(401);
    await expectNoContent(response);
  });

  it("JWKSに無い鍵で署名されたJWTを拒否する", async () => {
    const response = await worker.fetch(listRequest(await mintToken({ key: foreignKey })));

    expect(response.status).toBe(401);
    await expectNoContent(response);
  });

  it("aud が一致しないJWTを拒否する", async () => {
    const response = await worker.fetch(
      listRequest(await mintToken({ audience: "f".repeat(64) })),
    );

    expect(response.status).toBe(401);
    await expectNoContent(response);
  });

  it("iss が一致しないJWTを拒否する", async () => {
    const response = await worker.fetch(
      listRequest(await mintToken({ issuer: "https://attacker.cloudflareaccess.com" })),
    );

    expect(response.status).toBe(401);
    await expectNoContent(response);
  });

  it("期限切れのJWTを拒否する", async () => {
    const response = await worker.fetch(listRequest(await mintToken({ expiresIn: "-1m" })));

    expect(response.status).toBe(401);
    await expectNoContent(response);
  });

  it("形式が壊れた値を拒否する", async () => {
    const response = await worker.fetch(listRequest("not-a-jwt"));

    expect(response.status).toBe(401);
    await expectNoContent(response);
  });

  it("有効なJWTなら所有者として一覧を返す", async () => {
    const response = await worker.fetch(listRequest(await mintToken()));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { artifacts: { name: string }[] };
    expect(body.artifacts.map((item) => item.name)).toEqual(["secret.html"]);
  });

  it("ACCESS_AUD が未設定なら有効なJWTでも通さない", async () => {
    const token = await mintToken();
    mutableEnv["ACCESS_AUD"] = undefined;

    const response = await worker.fetch(listRequest(token));

    // 設定が欠けた状態で認証をすり抜けないこと(fail closed)が要点。
    expect(response.status).toBe(500);
    await expectNoContent(response);

    mutableEnv["ACCESS_AUD"] = AUD;
  });
});

describe("uidが未発行の利用者 (T041)", () => {
  it("JWTは有効でも users に無いemailには 403 とuid発行の案内を返す", async () => {
    const response = await worker.fetch(
      listRequest(await mintToken({ email: "stranger@example.test" })),
    );

    expect(response.status).toBe(403);

    // 本文は一度しか読めないため、内容の検査とパースを同じ文字列から行う。
    const text = await response.text();
    expect(text).not.toContain("secret.html");

    const body = JSON.parse(text) as { error: { code: string; message: string } };
    expect(body.error.message).toContain("stranger@example.test");
    expect(body.error.message).toContain("uid");
  });
});

describe("JWKSの取得", () => {
  it("検証を繰り返してもJWKSを取り直さない", async () => {
    const before = certsRequests;

    for (let i = 0; i < 5; i += 1) {
      const response = await worker.fetch(listRequest(await mintToken()));
      expect(response.status).toBe(200);
    }

    // createRemoteJWKSet のキャッシュはモジュールスコープで保持しているため、
    // 同じ kid の検証が続く限り追加の取得は発生しない。
    expect(certsRequests).toBe(before);
  });
});
