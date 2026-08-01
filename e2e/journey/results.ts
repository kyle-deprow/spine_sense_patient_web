import {
  expect,
  type APIRequestContext,
  type Locator,
  type Response as PlaywrightResponse,
} from "@playwright/test";
import { createHash } from "node:crypto";

import {
  ASSESSMENT_REPORT_PROXY_PATH_RE,
  EXPECT_SECURE_COOKIES,
  type AssessmentReportGenerationPayload,
  type AssessmentReportRequestPayload,
} from "./context";

export function isAssessmentReportGenerationResponse(
  response: PlaywrightResponse,
): boolean {
  const url = new URL(response.url());
  return (
    response.request().method() === "POST" &&
    ASSESSMENT_REPORT_PROXY_PATH_RE.test(url.pathname)
  );
}

export async function expectRenderedAssessmentPdf(
  request: APIRequestContext,
  response: PlaywrightResponse,
): Promise<void> {
  let requestPayload: AssessmentReportRequestPayload;
  try {
    requestPayload = response
      .request()
      .postDataJSON() as AssessmentReportRequestPayload;
  } catch {
    requestPayload = {};
  }
  expect(requestPayload.format).toBe("pdf");
  expect(requestPayload.variant).toBe("summary");
  expect(requestPayload.include_documents).toBe(false);
  expect(requestPayload.include_trends).toBe(false);
  expect(requestPayload.delivery).toBe("download_url");

  const payload = (await response.json()) as AssessmentReportGenerationPayload;
  expect(typeof payload.id).toBe("string");
  expect(payload.format).toBe("pdf");
  expect(typeof payload.file_name).toBe("string");
  expect(payload.file_name).toMatch(
    /^spinesense-assessment-report-[0-9a-f]{8}\.pdf$/i,
  );
  expect(payload.content_type).toBe("application/pdf");
  expect(
    Number.isInteger(payload.byte_size) && Number(payload.byte_size) > 0,
  ).toBe(true);
  expect(payload.sha256).toMatch(/^[0-9a-f]{64}$/i);
  expect(
    Number.isInteger(payload.expires_in_seconds) &&
      Number(payload.expires_in_seconds) > 0,
  ).toBe(true);
  expect(typeof payload.download_url).toBe("string");

  const downloadUrl = new URL(String(payload.download_url));
  expect(["http:", "https:"]).toContain(downloadUrl.protocol);
  if (EXPECT_SECURE_COOKIES) expect(downloadUrl.protocol).toBe("https:");

  const download = await request.get(downloadUrl.toString(), {
    timeout: 60_000,
  });
  expect(download.status(), "generated report download failed").toBe(200);
  expect(download.headers()["content-type"]?.split(";", 1)[0]).toBe(
    "application/pdf",
  );
  expect(download.headers()["content-disposition"]).toContain("attachment;");
  expect(download.headers()["content-disposition"]).toContain(
    String(payload.file_name),
  );

  const pdf = await download.body();
  expect(pdf.byteLength).toBe(payload.byte_size);
  expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  expect(
    pdf
      .subarray(Math.max(0, pdf.byteLength - 1024))
      .toString("latin1")
      .trimEnd()
      .endsWith("%%EOF"),
  ).toBe(true);
  expect(createHash("sha256").update(pdf).digest("hex")).toBe(payload.sha256);
}

export async function expectOptionalReportSwitchCanOnlySubmitWhenAvailable(
  switchLocator: Locator,
  label: string,
): Promise<void> {
  await expect(
    switchLocator,
    `${label} option must start unchecked`,
  ).not.toBeChecked();
  if (await switchLocator.isDisabled()) {
    await expect(
      switchLocator,
      `${label} option must be disabled when unavailable`,
    ).toBeDisabled();
    return;
  }

  await expect(
    switchLocator,
    `${label} option must be enabled when available`,
  ).toBeEnabled();
  await switchLocator.click();
  await expect(
    switchLocator,
    `${label} option must be selectable when available`,
  ).toBeChecked();
  await switchLocator.click();
  await expect(
    switchLocator,
    `${label} option must be clearable before core download`,
  ).not.toBeChecked();
}
