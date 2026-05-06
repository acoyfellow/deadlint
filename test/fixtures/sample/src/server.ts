// Fixture: a Durable Object with a mix of live and dead methods.
//
// Ground truth (used by tests):
//   LIVE   ServerDO.readObject       — called via stub in caller.ts (.readObject()) and in test/server.test.ts
//   LIVE   ServerDO.writeObject      — called by another method on this same class
//   LIVE   ServerDO.handleEvent      — called via dynamic dispatch in caller.ts (["handleEvent"]())
//   DEAD   ServerDO.deprecatedFlush  — defined, never called anywhere
//   DEAD   ServerDO.legacyReset      — only referenced inside its own JSDoc; no callers
//   DEAD   ServerDO.unusedHelperRpc  — present but no caller reaches it
//   SKIP   ServerDO.fetch            — always-live (Worker entrypoint name)
//   SKIP   ServerDO.alarm            — always-live (DO alarm hook name)
//   SKIP   ServerDO.#privateField    — private, ignored

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
