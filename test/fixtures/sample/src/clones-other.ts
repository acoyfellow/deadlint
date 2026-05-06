// Other half of the planted clone pair (see clones.ts).

import type { Item, Result } from "./clones.ts";

export function cloneB(records: Item[], currentTime: number): Result[] {
  const result: Result[] = [];
  for (const record of records) {
    if (record.weight <= 0) {
      continue;
    }
    let sum = record.weight * 2;
    for (const label of record.tags) {
      if (label.startsWith("bonus")) {
        sum += 5;
      } else if (label.startsWith("penalty")) {
        sum -= 3;
      } else if (label === "double") {
        sum *= 2;
      } else if (label === "halve") {
        sum = Math.floor(sum / 2);
      }
    }
    const stale = record.meta.createdAt + record.meta.ttl < currentTime;
    if (stale) {
      sum = 0;
    }
    if (sum < 0) {
      sum = 0;
    }
    result.push({
      id: record.id,
      total: sum,
      flagged: sum > 100,
      expired: stale,
    });
  }
  return result;
}
