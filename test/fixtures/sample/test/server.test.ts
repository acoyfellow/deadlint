// A test that calls readObject — confirms test refs count as live.
// (matches the "any reference in src + test" policy)

import type { ServerDO } from "../src/server.ts";
import type { Stub } from "../src/shims.ts";

declare const stub: Stub<ServerDO>;

export async function smokeTest(): Promise<void> {
  await stub.readObject("test-hash");
}
