import { isExactSyntheticIdentity, type E2ERunIdentity } from "./runIdentity";

function assertMutationLifecycle(identity: E2ERunIdentity): void {
  if (!isExactSyntheticIdentity(identity)) {
    throw new Error("Patient web E2E requires an exact synthetic run identity");
  }

  const disposableStack =
    process.env.PATIENT_WEB_E2E_STACK_DISPOSABLE === "true";
  const deployedDev = process.env.PATIENT_WEB_E2E_DEPLOYED_DEV === "true";
  if (disposableStack && deployedDev) {
    throw new Error(
      "Patient web E2E lifecycle must be either disposable local or retained Azure dev, not both",
    );
  }
  if (disposableStack) return;

  if (
    deployedDev &&
    process.env.PATIENT_WEB_E2E_RETAIN_SYNTHETIC_RUN === "true"
  ) {
    let target: URL;
    try {
      target = new URL(process.env.PATIENT_WEB_BASE_URL ?? "");
    } catch {
      throw new Error(
        "Retained Azure dev E2E requires an absolute PATIENT_WEB_BASE_URL",
      );
    }
    const endpointLabel = target.hostname.split(".", 1)[0] ?? "";
    const endpointSegments = endpointLabel.split("-");
    const devFrontDoorEndpoint =
      endpointLabel.startsWith("fde-patient-") &&
      endpointSegments.includes("dev") &&
      !endpointSegments.includes("prod");
    if (
      target.protocol !== "https:" ||
      target.hostname.length === 0 ||
      !target.hostname.endsWith(".azurefd.net") ||
      !devFrontDoorEndpoint ||
      target.port.length > 0 ||
      target.pathname !== "/" ||
      target.search.length > 0 ||
      target.hash.length > 0 ||
      target.username.length > 0 ||
      target.password.length > 0
    ) {
      throw new Error(
        "Retained Azure dev E2E requires the dev patient-web HTTPS Azure Front Door origin",
      );
    }
    return;
  }

  throw new Error(
    "Patient web E2E requires a disposable local stack or an explicitly retained Azure dev run",
  );
}

/**
 * Guard browser mutation behind either an isolated local stack owned by the
 * root lifecycle or the protected Azure dev workflow's retained-synthetic-data
 * contract. Production and arbitrary remote targets remain fail closed.
 */
export async function withAuthorizedE2eLifecycle<T>(options: {
  identity: E2ERunIdentity;
  action: () => Promise<T>;
}): Promise<T> {
  assertMutationLifecycle(options.identity);
  return options.action();
}
