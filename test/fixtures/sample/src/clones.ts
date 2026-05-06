// Clone fixtures — first half of the planted clone pair lives here, the
// other half in clones-other.ts.
//
// The clone is intentionally large (~50 lines, well over similarity-ts's
// default size-penalty floor) so that BOTH the inline ts-morph engine and
// similarity-ts surface it. Smaller clones may only show up in the inline
// engine — that's by design (similarity-ts trades recall for precision).
//
// Ground truth:
//   CLONE PAIR    cloneA (this file) / cloneB (clones-other.ts)
//   NOT A CLONE   uniqueA / uniqueB

type Item = { id: string; weight: number; tags: string[]; meta: { createdAt: number; ttl: number } };
type Result = { id: string; total: number; flagged: boolean; expired: boolean };

export function cloneA(items: Item[], now: number): Result[] {
  const out: Result[] = [];
  for (const item of items) {
    if (item.weight <= 0) {
      continue;
    }
    let total = item.weight * 2;
    for (const tag of item.tags) {
      if (tag.startsWith("bonus")) {
        total += 5;
      } else if (tag.startsWith("penalty")) {
        total -= 3;
      } else if (tag === "double") {
        total *= 2;
      } else if (tag === "halve") {
        total = Math.floor(total / 2);
      }
    }
    const expired = item.meta.createdAt + item.meta.ttl < now;
    if (expired) {
      total = 0;
    }
    if (total < 0) {
      total = 0;
    }
    out.push({
      id: item.id,
      total,
      flagged: total > 100,
      expired,
    });
  }
  return out;
}

export function uniqueA(input: string): string {
  return input.split("").reverse().join("");
}

export function uniqueB(n: number): number[] {
  const out: number[] = [];
  while (n > 1) {
    out.push(n);
    n = n % 2 === 0 ? n / 2 : 3 * n + 1;
  }
  return out;
}

export type { Item, Result };
