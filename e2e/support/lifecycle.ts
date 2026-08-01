import type { E2ERunIdentity } from "./runIdentity";

/**
 * Run one E2E journey inside the disposable stack owned by the Make
 * lifecycle. Application-level DB/cache cleanup is intentionally not a
 * browser-test responsibility.
 */
export async function withStackOwnedE2eLifecycle<T>(options: {
  identity: E2ERunIdentity;
  action: () => Promise<T>;
}): Promise<T> {
  // Keep the exact identity in the lifecycle contract so callers cannot
  // accidentally fall back to a shared/default patient identity. Disposal is
  // performed by `docker compose down --volumes` in the isolated Make stack.
  void options.identity;
  return options.action();
}
