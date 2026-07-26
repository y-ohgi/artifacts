import { env, exports } from "cloudflare:workers";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ACCESS_JWT_COOKIE, ACCESS_JWT_HEADER } from "../../src/auth";
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

/** Body of the private artifact used by the delivery-path tests. */
const PRIVATE_HTML = "<!doctype html><html><body>PRIVATE</body></html>";

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
  await insertArtifact(db, OWNER_UID, "secret.html", PRIVATE_HTML.length, "2026-07-02T00:00:00.000Z");
  await env.ARTIFACTS.put(`${OWNER_UID}/secret.html`, PRIVATE_HTML);
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

describe("認証切れの案内 (FR-021, T044)", () => {
  const browserRequest = (path: string, method = "GET"): Request =>
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: { Accept: "text/html,application/xhtml+xml" },
      ...(method === "GET" ? {} : { body: new FormData() }),
    });

  it("ブラウザからの一覧アクセスにはHTMLで認証切れと再認証の導線を返す", async () => {
    const response = await worker.fetch(browserRequest("/_app/"));

    expect(response.status).toBe(401);
    expect(response.headers.get("Content-Type")).toContain("text/html");

    const html = await response.text();
    expect(html).toContain("認証が切れています");
    expect(html).toContain("開き直す");
    // 再認証後に同じ画面へ戻せること(FR-021)。
    expect(html).toContain('href="/_app/"');
  });

  it("再認証の導線は元のクエリまで保つ", async () => {
    const response = await worker.fetch(browserRequest("/_app/upload?from=list"));

    expect(await response.text()).toContain('href="/_app/upload?from=list"');
  });

  it("フォーム送信が認証切れになった場合は対応する画面へ戻す", async () => {
    // POST の本文は再送できないため、同じURLではなくアップロード画面へ導く。
    const response = await worker.fetch(browserRequest("/_app/api/artifacts", "POST"));

    expect(response.status).toBe(401);
    expect(await response.text()).toContain('href="/_app/upload"');
  });

  it("APIクライアントには従来どおりJSONを返す", async () => {
    const response = await worker.fetch(listRequest());

    expect(response.headers.get("Content-Type")).toContain("application/json");
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });

  it("uid未発行はHTMLでも発行が必要であることを案内する", async () => {
    const token = await mintToken({ email: "stranger@example.test" });
    const request = new Request(`${ORIGIN}/_app/`, {
      headers: { Accept: "text/html", [ACCESS_JWT_HEADER]: token },
    });

    const response = await worker.fetch(request);

    expect(response.status).toBe(403);
    const html = await response.text();
    expect(html).toContain("uid が発行されていません");
    expect(html).toContain("stranger@example.test");
    // 再試行しても解決しないため、開き直す導線は出さない。
    expect(html).not.toContain("開き直す");
  });
});

describe("非保護パスでの所有者判定 (T018)", () => {
  const artifactRequest = (init: { cookie?: string; token?: string } = {}): Request => {
    const headers = new Headers();
    if (init.cookie !== undefined) {
      headers.set("Cookie", init.cookie);
    }
    if (init.token !== undefined) {
      headers.set(ACCESS_JWT_HEADER, init.token);
    }

    return new Request(`${ORIGIN}/${OWNER_UID}/secret.html`, { headers });
  };

  it("Accessのcookieに入ったJWTを検証して所有者へ本文を返す", async () => {
    const token = await mintToken();

    const response = await worker.fetch(
      artifactRequest({ cookie: `${ACCESS_JWT_COOKIE}=${token}` }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(PRIVATE_HTML);
  });

  it("他のcookieが混ざっていても取り出せる", async () => {
    const token = await mintToken();

    const response = await worker.fetch(
      artifactRequest({ cookie: `foo=bar; ${ACCESS_JWT_COOKIE}=${token}; baz=qux` }),
    );

    expect(response.status).toBe(200);
  });

  it("cookieが無ければ非公開アーティファクトは404になる", async () => {
    const response = await worker.fetch(artifactRequest());

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("PRIVATE");
  });

  it("署名が検証できないcookieでは404になる", async () => {
    const token = await mintToken({ key: foreignKey });

    const response = await worker.fetch(
      artifactRequest({ cookie: `${ACCESS_JWT_COOKIE}=${token}` }),
    );

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("PRIVATE");
  });

  it("cookieのemailが他人でも他人の名前空間は覗けない", async () => {
    // stranger は users に無いため uid が解決できず、所有者にはなれない。
    const token = await mintToken({ email: "stranger@example.test" });

    const response = await worker.fetch(
      artifactRequest({ cookie: `${ACCESS_JWT_COOKIE}=${token}` }),
    );

    expect(response.status).toBe(404);
  });

  it("ヘッダとcookieの両方があるときはヘッダを優先する", async () => {
    const valid = await mintToken();
    const invalid = await mintToken({ key: foreignKey });

    const response = await worker.fetch(
      artifactRequest({ token: valid, cookie: `${ACCESS_JWT_COOKIE}=${invalid}` }),
    );

    expect(response.status).toBe(200);
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
