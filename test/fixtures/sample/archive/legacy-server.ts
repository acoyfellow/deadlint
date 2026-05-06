// This file is intentionally a near-perfect copy of src/server.ts.
//
// It lives in archive/, which is excluded by the fixture's tsconfig.json.
// deadlint MUST NOT scan it: a correct run produces no clone pairs between
// `archive/legacy-server.ts` and `src/server.ts`. If clones turn up here,
// it's the bug we shipped a fix for in v0.0.1.

import { DurableObject } from "../src/shims.ts";

export class LegacyServerDO extends DurableObject {
  async readObject(hash: string): Promise<string | null> {
    return hash.length > 0 ? hash : null;
  }

  async writeObject(hash: string, body: string): Promise<void> {
    void hash;
    void body;
  }

  async handleEvent(name: string): Promise<void> {
    await this.writeObject(name, name);
  }

  async processViaCallApi(payload: string): Promise<string> {
    return payload.toUpperCase();
  }
}
