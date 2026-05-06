// Minimal shims so the fixture compiles without depending on real Workers types.
// We only need *names* to exist as base classes — deadlint matches by base
// class name, not type identity.

export class DurableObject<_Env = unknown> {}
export class WorkerEntrypoint<_Env = unknown> {
  fetch(_req: Request): Response {
    return new Response();
  }
}
export class RpcTarget {}

export type Stub<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never;
};
