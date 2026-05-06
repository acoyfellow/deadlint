// Fixture: a Durable Object with a mix of live and dead methods.
//
// Ground truth (used by tests):
//   LIVE   ServerDO.readObject         — called via stub in caller.ts (.readObject()) and in test/server.test.ts
//   LIVE   ServerDO.writeObject        — called by another method on this same class
//   LIVE   ServerDO.handleEvent        — called via dynamic dispatch in caller.ts (["handleEvent"]())
//   LIVE   ServerDO.processViaCallApi  — called via client.call("processViaCallApi", ...) in caller.ts
//                                          (Agents SDK string-key dispatch pattern)
//   DEAD   ServerDO.deprecatedFlush    — defined, never called anywhere
//   DEAD   ServerDO.legacyReset        — only referenced inside its own JSDoc; no callers
//   DEAD   ServerDO.unusedHelperRpc    — present but no caller reaches it
//   SKIP   ServerDO.fetch              — always-live (Worker entrypoint name)
//   SKIP   ServerDO.alarm              — always-live (DO alarm hook name)
//   SKIP   ServerDO.#privateField      — private, ignored

import { DurableObject } from "./shims.ts";

export class ServerDO extends DurableObject {
  // LIVE — referenced via stub call in caller.ts
  async readObject(hash: string): Promise<string | null> {
    return hash.length > 0 ? hash : null;
  }

  // LIVE — called by handleEvent below
  async writeObject(hash: string, body: string): Promise<void> {
    void hash;
    void body;
  }

  // LIVE — called via ["handleEvent"]() dynamic dispatch in caller.ts
  async handleEvent(name: string): Promise<void> {
    await this.writeObject(name, name);
  }

  // LIVE — called via client.call("processViaCallApi", ...) in caller.ts
  // This exercises the Agents SDK string-key dispatch signal added in v0.0.1.
  async processViaCallApi(payload: string): Promise<string> {
    return payload.toUpperCase();
  }

  // LIVE — called from a .svelte companion file (CallerComponent.svelte).
  // The TS project loader does not include .svelte files, but deadlint's
  // companion-file scanner reads them as plain text for token-grep.
  async frontendOnlyMethod(payload: string): Promise<string> {
    return payload.split("").reverse().join("");
  }

  // DEAD — no caller anywhere
  async deprecatedFlush(): Promise<void> {
    return;
  }

  // DEAD — only mentioned in its own doc string; not actually called
  /** legacyReset was the old reset path. */
  async legacyReset(): Promise<void> {
    return;
  }

  // DEAD — meant to be RPC, nobody wired it
  async unusedHelperRpc(payload: string): Promise<string> {
    return payload.toUpperCase();
  }

  // SKIP — Worker/DO conventional entry name, allow-listed in dead-rpc.ts
  fetch(_req: Request): Response {
    return new Response("ok");
  }

  // SKIP — DO alarm hook
  async alarm(): Promise<void> {
    return;
  }
}
