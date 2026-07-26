import { describe, expect, it } from "vitest";

import { UID_ALPHABET, UID_LENGTH, generateUid } from "../../src/ids";

/**
 * uid に規則性が現れないことの検証(T058, FR-036, SC-011)。
 *
 * uid は非公開アーティファクトのURLの一部であり、1つ知られたときに他を推測できて
 * はならない。ここでは「連番」「時刻順」「共通prefix」といった、実装がうっかり
 * 導入しがちな規則性が観測されないことを確かめる。
 *
 * 各assertionは偶然で落ちない余裕を持たせている(下のコメントに根拠を書いた)。
 */

const SAMPLE_COUNT = 10_000;

const uids = Array.from({ length: SAMPLE_COUNT }, () => generateUid());

/** 2つのuidで同じ位置に同じ文字が並んだ数 */
function matchingPositions(a: string, b: string): number {
  let matches = 0;
  for (let i = 0; i < UID_LENGTH; i += 1) {
    if (a[i] === b[i]) {
      matches += 1;
    }
  }
  return matches;
}

describe("連続して発行したuidに規則性が無い", () => {
  it("重複しない", () => {
    expect(new Set(uids).size).toBe(SAMPLE_COUNT);
  });

  it("発行順が辞書順になっていない(連番でも時刻順でもない)", () => {
    const sorted = [...uids].sort();

    // 10000件がたまたま昇順に並ぶ確率は事実上ゼロ。カウンタや時刻を混ぜた
    // 実装に変わった場合はここで落ちる。
    expect(uids).not.toEqual(sorted);
    expect(uids).not.toEqual([...sorted].reverse());
  });

  it("隣接するuidが末尾だけ違うことがない", () => {
    const counterLike = uids.filter(
      (uid, index) => index > 0 && matchingPositions(uids[index - 1] as string, uid) === UID_LENGTH - 1,
    );

    expect(counterLike).toEqual([]);
  });

  it("隣接するuidの一致位置数が偶然の範囲に収まる", () => {
    const total = uids
      .slice(1)
      .reduce((sum, uid, index) => sum + matchingPositions(uids[index] as string, uid), 0);
    const average = total / (SAMPLE_COUNT - 1);

    // 期待値は 10 / 36 ≒ 0.28。上限1.5は期待値の5倍以上で、乱数の揺れでは
    // 到達しない。prefixを共有する実装になると一気に超える。
    expect(average).toBeLessThan(1.5);
  });

  it("先頭6文字を共有するuidがほとんど無い", () => {
    const prefixes = new Map<string, number>();
    for (const uid of uids) {
      const prefix = uid.slice(0, 6);
      prefixes.set(prefix, (prefixes.get(prefix) ?? 0) + 1);
    }

    const collisions = [...prefixes.values()].filter((count) => count > 1).length;

    // 36^6 ≒ 2.2e9 に対して10000件なので、誕生日問題の期待衝突数は0.02件程度。
    // 5件までは許容し、prefix固定の実装(=一気に数千件)だけを落とす。
    expect(collisions).toBeLessThanOrEqual(5);
  });
});

describe("文字の分布が偏らない", () => {
  it("どの桁にも36種類すべてが現れる", () => {
    for (let position = 0; position < UID_LENGTH; position += 1) {
      const seen = new Set(uids.map((uid) => uid[position]));

      // 1桁あたり10000サンプル、1文字の期待出現は約278回。欠けることはない。
      expect(seen.size).toBe(UID_ALPHABET.length);
    }
  });

  it("特定の文字に偏らない", () => {
    const counts = new Map<string, number>();
    for (const uid of uids) {
      for (const character of uid) {
        counts.set(character, (counts.get(character) ?? 0) + 1);
      }
    }

    const expected = (SAMPLE_COUNT * UID_LENGTH) / UID_ALPHABET.length;
    for (const [character, count] of counts) {
      // 剰余バイアスを除いているので ±20% に収まる(実測は数%以内)。
      expect(count, `character ${character}`).toBeGreaterThan(expected * 0.8);
      expect(count, `character ${character}`).toBeLessThan(expected * 1.2);
    }
  });
});
