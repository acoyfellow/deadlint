// Calls into ServerDO via a stub — exercises both reference-resolver and
// token-grep paths.

import type { ServerDO } from "./server.ts";
import type { Stub } from "./shims.ts";

declare const stub: Stub<ServerDO>;

export async function doRead(): Promise<string | null> {
  // Plain dot-call: token-grep matches `.readObject(`
  return stub.readObject("abc");
}

export async function doDispatch(): Promise<void> {
  // Dynamic dispatch: token-grep matches `["handleEvent"](`
  await stub["handleEvent"]("evt");
}
