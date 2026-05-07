// Simulates committed build output (a la npm packages that ship a /dist
// next to /src for github-spec consumers). This file is intentionally a
// near-duplicate of src/clones.ts. The default --exclude list includes
// `dist`, so deadlint must NOT scan this file. If it does, ai-connect-
// style false positives come back.

type Item = { id: string; weight: number; tags: string[]; meta: { createdAt: number; ttl: number } };
type Result = { id: string; total: number; flagged: boolean; expired: boolean };

export function cloneA_built(items: Item[], now: number): Result[] {
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
