import { describe, expect, it } from "vitest";

import {
  ADMIN_RESPONSE_HEADERS,
  ARTIFACT_RESPONSE_HEADERS,
  adminHeaders,
  artifactHeaders,
} from "../../src/headers";

describe("artifact response headers", () => {
  it("sets Cache-Control: no-store (FR-028)", () => {
    expect(ARTIFACT_RESPONSE_HEADERS["Cache-Control"]).toBe("no-store");
    expect(artifactHeaders().get("Cache-Control")).toBe("no-store");
  });

  it("sandboxes the artifact via CSP while allowing scripts", () => {
    const csp = artifactHeaders().get("Content-Security-Policy") ?? "";
    expect(csp.startsWith("sandbox")).toBe(true);
    expect(csp).toContain("allow-scripts");
    expect(csp).toBe("sandbox allow-scripts allow-popups allow-forms allow-modals");
  });

  it("serves HTML with nosniff and no referrer", () => {
    const headers = artifactHeaders();
    expect(headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("Referrer-Policy")).toBe("no-referrer");
  });
});

describe("admin response headers", () => {
  it("sets Cache-Control: private, no-store", () => {
    expect(ADMIN_RESPONSE_HEADERS["Cache-Control"]).toBe("private, no-store");
    expect(adminHeaders().get("Cache-Control")).toBe("private, no-store");
  });

  it("never uses the artifact sandbox CSP", () => {
    const csp = adminHeaders().get("Content-Security-Policy") ?? "";
    expect(csp).not.toContain("sandbox");
    expect(csp).toBe("default-src 'self'; frame-ancestors 'none'");
  });

  it("sets nosniff and no referrer", () => {
    const headers = adminHeaders();
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("Referrer-Policy")).toBe("no-referrer");
  });
});
