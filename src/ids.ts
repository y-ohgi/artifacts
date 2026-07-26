/**
 * uid generation and artifact name validation.
 *
 * See specs/001-html-artifact-hosting/data-model.md ("バリデーション規則")
 * and FR-006 / FR-034 / FR-035 / FR-036.
 */

/** Character set for uids: lower case ASCII letters and digits only (FR-034). */
export const UID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** uid length. 10 satisfies FR-035 (12 characters or fewer). */
export const UID_LENGTH = 10;

/**
 * Rejection sampling threshold.
 *
 * 256 is not a multiple of 36, so mapping every byte with `% 36` would make the
 * first 256 % 36 = 4 symbols more likely. Bytes at or above
 * floor(256 / 36) * 36 = 252 are discarded instead, which removes the bias.
 */
const UID_REJECTION_LIMIT = Math.floor(256 / UID_ALPHABET.length) * UID_ALPHABET.length;

/**
 * Generates a uid from cryptographically secure randomness.
 *
 * The value is derived only from `crypto.getRandomValues`; it must never depend
 * on a counter, a timestamp or any request input (FR-036).
 */
export function generateUid(): string {
  let uid = "";
  const buffer = new Uint8Array(UID_LENGTH);

  while (uid.length < UID_LENGTH) {
    crypto.getRandomValues(buffer);

    for (const byte of buffer) {
      if (byte >= UID_REJECTION_LIMIT) {
        continue;
      }

      uid += UID_ALPHABET.charAt(byte % UID_ALPHABET.length);

      if (uid.length === UID_LENGTH) {
        break;
      }
    }
  }

  return uid;
}

/** Names must match this pattern, plus the two extra conditions below. */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.html?$/;

/**
 * Human readable description of the allowed character set (FR-006).
 * Shared by the upload UI and by `details.allowed` of `invalid_name` responses.
 */
export const NAME_ALLOWED_DESCRIPTION =
  "名前は半角英数字で始まり、半角英数字・ピリオド・アンダースコア・ハイフンのみを使用し、" +
  ".html または .htm で終わる必要があります(拡張子を除く部分は64文字以内)。" +
  "連続したピリオド(..)は使用できず、アンダースコアで始めることはできません。";

/** Reason codes for an invalid name, so callers can branch without parsing text. */
export const NameValidationErrors = {
  /** Does not match the allowed pattern (charset, leading character, extension, length). */
  PATTERN_MISMATCH: "pattern_mismatch",
  /** Contains `..` (path traversal shaped). */
  CONSECUTIVE_DOTS: "consecutive_dots",
  /** Starts with `_`, which is reserved for future prefixes. */
  RESERVED_PREFIX: "reserved_prefix",
} as const;

export type NameValidationError = (typeof NameValidationErrors)[keyof typeof NameValidationErrors];

export type NameValidationResult =
  | { readonly ok: true; readonly name: string }
  | {
      readonly ok: false;
      readonly reason: NameValidationError;
      readonly message: string;
      readonly allowed: string;
    };

const NAME_ERROR_MESSAGES: Record<NameValidationError, string> = {
  [NameValidationErrors.PATTERN_MISMATCH]: "名前に使用できない文字、または不正な形式が含まれています。",
  [NameValidationErrors.CONSECUTIVE_DOTS]: "名前に連続したピリオド(..)を含めることはできません。",
  [NameValidationErrors.RESERVED_PREFIX]: "名前をアンダースコア(_)で始めることはできません。",
};

/**
 * Validates an artifact name.
 *
 * Returns a discriminated result instead of throwing, so that callers can map
 * the reason straight onto an `invalid_name` error response.
 */
export function validateName(name: string): NameValidationResult {
  if (name.startsWith("_")) {
    return invalid(NameValidationErrors.RESERVED_PREFIX);
  }

  if (name.includes("..")) {
    return invalid(NameValidationErrors.CONSECUTIVE_DOTS);
  }

  if (!NAME_PATTERN.test(name)) {
    return invalid(NameValidationErrors.PATTERN_MISMATCH);
  }

  return { ok: true, name };
}

function invalid(reason: NameValidationError): NameValidationResult {
  return {
    ok: false,
    reason,
    message: NAME_ERROR_MESSAGES[reason],
    allowed: NAME_ALLOWED_DESCRIPTION,
  };
}

/** Longest allowed length before the extension, from NAME_PATTERN. */
const NAME_STEM_MAX_LENGTH = 64;

/** How many candidates are probed before giving up (FR-007). */
const SUGGESTION_PROBE_LIMIT = 100;

/** How many usable candidates are returned at most. */
const SUGGESTION_COUNT = 3;

/**
 * Splits `report.html` into its stem and its extension.
 *
 * Only called with names that already passed `validateName`, so the extension is
 * always present; the fallback keeps the function total anyway.
 */
function splitName(name: string): { stem: string; extension: string } {
  const dot = name.lastIndexOf(".");
  return dot <= 0
    ? { stem: name, extension: "" }
    : { stem: name.slice(0, dot), extension: name.slice(dot) };
}

/**
 * Proposes names that do not collide, in the `<stem>-2`, `<stem>-3`, … order
 * described by FR-007.
 *
 * `isTaken` is injected rather than importing the database layer, which keeps
 * this module free of bindings and lets the ordering be tested without D1.
 * Probing stops after SUGGESTION_PROBE_LIMIT candidates so a namespace full of
 * collisions cannot turn one upload into unbounded work.
 */
export async function suggestAlternativeNames(
  name: string,
  isTaken: (candidate: string) => Promise<boolean>,
  max: number = SUGGESTION_COUNT,
): Promise<string[]> {
  const { stem, extension } = splitName(name);
  const suggestions: string[] = [];

  for (let n = 2; n < 2 + SUGGESTION_PROBE_LIMIT && suggestions.length < max; n += 1) {
    const suffix = `-${n}`;
    // Truncating the stem keeps long names within the pattern's length limit
    // instead of silently producing candidates that validateName would reject.
    const candidate = `${stem.slice(0, NAME_STEM_MAX_LENGTH - suffix.length)}${suffix}${extension}`;
    if (!validateName(candidate).ok) {
      continue;
    }

    if (!(await isTaken(candidate))) {
      suggestions.push(candidate);
    }
  }

  return suggestions;
}
