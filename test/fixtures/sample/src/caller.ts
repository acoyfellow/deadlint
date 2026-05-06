// Calls into ServerDO via a stub — exercises every reachability signal:
//   - Pattern A direct dispatch:    `.readObject(`
//   - Pattern A bracket dispatch:   `["handleEvent"](`
//   - Pattern B string-key dispatch: `client.call("processViaCallApi", ...)`

import type { ServerDO } from "./server.ts";
import type { Stub } from "./shims.ts";

declare const stub: Stub<ServerDO>;

// Minimal Agents-SDK-shaped client used by the frontend in real apps.
declare const client: {
  call: <R = unknown>(method: string, args: unknown[]) => Promise<R>;
};

export async function doRead(): Promise<string | null> {
  // Plain dot-call: token-grep matches `.readObject(`
  return stub.readObject("abc");
}

export async function doDispatch(): Promise<void> {
  // Dynamic dispatch: token-grep matches `["handleEvent"](`
  await stub["handleEvent"]("evt");
}

export async function doStringDispatch(): Promise<string> {
  // Agents SDK pattern: token-grep matches `.call("processViaCallApi"`.
  // Without the new string-key signal, this method would be flagged dead.
  return await client.call<string>("processViaCallApi", ["payload"]);
}
