import { describe, expect, it } from "vitest";

import {
  NAME_ALLOWED_DESCRIPTION,
  UID_ALPHABET,
  UID_LENGTH,
  generateUid,
  suggestAlternativeNames,
  validateName,
} from "../../src/ids";

const SAMPLE_COUNT = 10_000;

describe("generateUid", () => {
  it("returns 10 characters from a-z0-9 only", () => {
    for (let i = 0; i < 100; i++) {
      const uid = generateUid();
      expect(uid).toHaveLength(UID_LENGTH);
      expect(uid).toMatch(/^[a-z0-9]{10}$/);
    }
  });

  it("produces no duplicates across 10,000 generations", () => {
    const seen = new Set<string>();

    for (let i = 0; i < SAMPLE_COUNT; i++) {
      seen.add(generateUid());
    }

    expect(seen.size).toBe(SAMPLE_COUNT);
  });

  it("distributes characters without modulo bias", () => {
    const counts = new Map<string, number>();

    for (let i = 0; i < SAMPLE_COUNT; i++) {
      for (const char of generateUid()) {
        counts.set(char, (counts.get(char) ?? 0) + 1);
      }
    }

    // Every symbol of the alphabet must appear.
    expect(counts.size).toBe(UID_ALPHABET.length);

    const total = SAMPLE_COUNT * UID_LENGTH;
    const expectedPerSymbol = total / UID_ALPHABET.length;
    // 100,000 samples over 36 symbols: expected 2,777.8 each, sigma ~52.
    // A naive `byte % 36` favours the first 4 symbols by +12.5% (~+347, > 6 sigma),
    // so a +-10% band (~5 sigma) detects the bias without being flaky.
    const lower = expectedPerSymbol * 0.9;
    const upper = expectedPerSymbol * 1.1;

    for (const symbol of UID_ALPHABET) {
      const count = counts.get(symbol) ?? 0;
      expect(count).toBeGreaterThan(lower);
      expect(count).toBeLessThan(upper);
    }
  });
});

describe("validateName", () => {
  const validNames = ["report.html", "a.htm", "my-report_v2.html", "0.html"];

  for (const name of validNames) {
    it(`accepts ${name}`, () => {
      const result = validateName(name);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.name).toBe(name);
      }
    });
  }

  const invalidNames = [
    "../etc/passwd",
    "my report.html",
    "レポート.html",
    "_internal.html",
    "report.txt",
    "report",
    ".html",
    "-report.html",
    "a..b.html",
    // 70 character base: exceeds the 1 + 63 character limit before the extension.
    `${"a".repeat(70)}.html`,
    "",
  ];

  for (const name of invalidNames) {
    it(`rejects ${JSON.stringify(name)}`, () => {
      const result = validateName(name);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBeTruthy();
        expect(result.message.length).toBeGreaterThan(0);
        expect(result.allowed).toBe(NAME_ALLOWED_DESCRIPTION);
      }
    });
  }

  it("accepts a 64 character base and rejects one character more", () => {
    // The pattern allows 1 + 63 characters before the extension.
    const maxName = `${"a".repeat(64)}.html`;
    expect(validateName(maxName).ok).toBe(true);
    expect(validateName(`${"a".repeat(65)}.html`).ok).toBe(false);
  });
});

describe("suggestAlternativeNames (FR-007)", () => {
  const takenNames = (...names: string[]) => {
    const taken = new Set(names);
    return async (candidate: string) => taken.has(candidate);
  };

  it("proposes -2, -3, -4 in order when nothing is taken", async () => {
    expect(await suggestAlternativeNames("report.html", takenNames())).toEqual([
      "report-2.html",
      "report-3.html",
      "report-4.html",
    ]);
  });

  it("skips candidates that are already in use", async () => {
    const suggestions = await suggestAlternativeNames(
      "report.html",
      takenNames("report-2.html", "report-3.html"),
    );

    expect(suggestions).toEqual(["report-4.html", "report-5.html", "report-6.html"]);
  });

  it("keeps the extension of the original name", async () => {
    expect(await suggestAlternativeNames("page.htm", takenNames(), 1)).toEqual(["page-2.htm"]);
  });

  it("returns only names that pass validateName, even at the length limit", async () => {
    const longName = `${"a".repeat(64)}.html`;

    const suggestions = await suggestAlternativeNames(longName, takenNames());

    expect(suggestions).not.toHaveLength(0);
    for (const suggestion of suggestions) {
      expect(validateName(suggestion).ok).toBe(true);
    }
  });

  it("gives up instead of probing forever when every candidate is taken", async () => {
    let probes = 0;
    const suggestions = await suggestAlternativeNames("report.html", async () => {
      probes += 1;
      return true;
    });

    expect(suggestions).toEqual([]);
    // The probe limit is 100; the point is that it terminates well short of
    // unbounded work rather than the exact number.
    expect(probes).toBe(100);
  });

  it("honours the requested maximum", async () => {
    expect(await suggestAlternativeNames("report.html", takenNames(), 1)).toEqual([
      "report-2.html",
    ]);
  });
});
