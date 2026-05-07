// Fixture for multi-tsconfig discovery: a Durable Object in packages/api/.
// The repo has NO root tsconfig.json — only one in packages/api/ and one
// in packages/web/. deadlint must find both and scan each.
//
// Ground truth: ApiDO.deadOnApi has no callers in this package OR the
// sibling package (the only reference is in this file's declaration).

declare class DurableObject<_Env = unknown> {}

export class ApiDO extends DurableObject {
  // DEAD — never called from anywhere in either tsconfig project
  async deadOnApi(): Promise<void> {
    return;
  }
}
