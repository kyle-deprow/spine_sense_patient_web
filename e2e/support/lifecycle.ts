import { isExactSyntheticIdentity, type E2ERunIdentity } from "./runIdentity";

function assertMutationLifecycle(identity: E2ERunIdentity): void {
  if (!isExactSyntheticIdentity(identity)) {
    throw new Error("Patient web E2E requires an exact synthetic run identity");
  }

  const disposableStack =
    process.env.PATIENT_WEB_E2E_STACK_DISPOSABLE === "true";
  const deployedDev = process.env.PATIENT_WEB_E2E_DEPLOYED_DEV === "true";
  const deployedProd = process.env.PATIENT_WEB_E2E_DEPLOYED_PROD === "true";
  const enabledModes = [disposableStack, deployedDev, deployedProd].filter(
    Boolean,
  ).length;
  if (enabledModes > 1) {
    throw new Error(
      "Patient web E2E lifecycle must be exactly one of disposable local, retained Azure dev, or retained production",
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
    // The VM-estate dev deployment serves the patient web app directly at
    // app.dev.spinesense.ai (no Front Door in dev); accept it alongside the
    // legacy dev Front Door endpoint.
    const devVmOrigin = target.hostname === "app.dev.spinesense.ai";
    const devOrigin =
      devVmOrigin ||
      (target.hostname.endsWith(".azurefd.net") && devFrontDoorEndpoint);
    if (
      target.protocol !== "https:" ||
      target.hostname.length === 0 ||
      !devOrigin ||
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

  if (
    deployedProd &&
    process.env.PATIENT_WEB_E2E_RETAIN_SYNTHETIC_RUN === "true"
  ) {
    const baseUrl = process.env.PATIENT_WEB_BASE_URL ?? "";
    let target: URL;
    try {
      target = new URL(baseUrl);
    } catch {
      throw new Error(
        "Retained production E2E requires an absolute PATIENT_WEB_BASE_URL",
      );
    }
    if (
      baseUrl !== "https://app.spinesense.ai/" ||
      target.protocol !== "https:" ||
      target.hostname !== "app.spinesense.ai" ||
      target.port.length > 0 ||
      target.pathname !== "/" ||
      target.search.length > 0 ||
      target.hash.length > 0 ||
      target.username.length > 0 ||
      target.password.length > 0
    ) {
      throw new Error(
        "Retained production E2E requires the exact https://app.spinesense.ai/ origin",
      );
    }
    return;
  }

  throw new Error(
    "Patient web E2E requires a disposable local stack or an explicitly retained deployed synthetic run",
  );
}

/**
 * Guard browser mutation behind either an isolated local stack owned by the
 * root lifecycle or an explicitly authorized deployed environment's
 * retained-synthetic-data contract. Arbitrary remote targets remain fail
 * closed.
 */
export async function withAuthorizedE2eLifecycle<T>(options: {
  identity: E2ERunIdentity;
  action: () => Promise<T>;
}): Promise<T> {
  assertMutationLifecycle(options.identity);
  return options.action();
}
