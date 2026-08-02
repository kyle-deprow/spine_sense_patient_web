import { isExactSyntheticIdentity, type E2ERunIdentity } from "./runIdentity";

function assertDisposableStack(identity: E2ERunIdentity): void {
  if (!isExactSyntheticIdentity(identity)) {
    throw new Error("Patient web E2E requires an exact synthetic run identity");
  }
  if (process.env.PATIENT_WEB_E2E_STACK_DISPOSABLE !== "true") {
    throw new Error(
      "Patient web E2E refuses to mutate data unless PATIENT_WEB_E2E_STACK_DISPOSABLE=true",
    );
  }
}

/**
 * Guard browser mutation behind the disposable stack owned by the root Make
 * lifecycle. The outer process owns pre/post volume disposal, including when
 * Playwright times out or is interrupted.
 */
export async function withStackOwnedE2eLifecycle<T>(options: {
  identity: E2ERunIdentity;
  action: () => Promise<T>;
}): Promise<T> {
  assertDisposableStack(options.identity);
  return options.action();
}
