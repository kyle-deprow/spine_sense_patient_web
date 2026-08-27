import { describe, expect, it } from "vitest";
import {
  isPatientAssessmentDocumentDeleteTarget,
  isPatientDocumentDeleteTarget,
  validateProxyTarget,
} from "@/lib/proxy/allowlist";

describe("proxy allowlist", () => {
  it("allows canonical patient routes under /api/proxy/api/v1", () => {
    expect(
      validateProxyTarget(
        ["api", "v1", "patients", "me", "assessments"],
        "POST",
        "/api/proxy/api/v1/patients/me/assessments",
      ),
    ).toEqual({ ok: true, targetPath: "/api/v1/patients/me/assessments/" });
  });

  it("blocks retired assessment phase routes at the BFF boundary", () => {
    expect(
      validateProxyTarget(
        [
          "api",
          "v1",
          "patients",
          "me",
          "assessments",
          "10000000-0000-4000-8000-000000000001",
          "refinement",
          "run",
        ],
        "POST",
        "/api/proxy/api/v1/patients/me/assessments/10000000-0000-4000-8000-000000000001/refinement/run",
      ),
    ).toEqual({ ok: false, status: 404, code: "proxy_path_not_allowed" });
  });

  it("allows canonical assessment question-note live transcription session token minting", () => {
    const assessmentId = "10000000-0000-4000-8000-000000000001";
    const questionId = "R_NEURO-2";

    expect(
      validateProxyTarget(
        [
          "api",
          "v1",
          "patients",
          "me",
          "assessments",
          assessmentId,
          "questions",
          questionId,
          "note",
          "live-transcription-session",
        ],
        "POST",
        `/api/proxy/api/v1/patients/me/assessments/${assessmentId}/questions/${questionId}/note/live-transcription-session`,
      ),
    ).toEqual({
      ok: true,
      targetPath: `/api/v1/patients/me/assessments/${assessmentId}/questions/${questionId}/note/live-transcription-session`,
    });
  });

  it("allows combined adaptive answer save and completion through the assessment proxy", () => {
    const assessmentId = "10000000-0000-4000-8000-000000000001";
    const targetPath = `/api/v1/patients/me/assessments/${assessmentId}/adaptive/complete-with-answers`;

    expect(
      validateProxyTarget(
        targetPath.slice(1).split("/"),
        "POST",
        `/api/proxy${targetPath}`,
      ),
    ).toEqual({
      ok: true,
      targetPath,
    });
  });

  it("blocks retired story voice aliases and arbitrary question-note live transcription child routes", () => {
    const assessmentId = "10000000-0000-4000-8000-000000000001";
    const cases = [
      `/api/v1/patients/me/assessments/${assessmentId}/story/live-transcription`,
      `/api/v1/patients/me/assessments/${assessmentId}/story/live-transcription-session`,
      `/api/v1/patients/me/assessments/${assessmentId}/story/live-transcription-session/extra`,
      `/api/v1/patients/me/assessments/${assessmentId}/story/voice-upload-url`,
      `/api/v1/patients/me/assessments/${assessmentId}/story/transcribe`,
      `/api/v1/patients/me/assessments/${assessmentId}/question-notes/live-transcription`,
      `/api/v1/patients/me/assessments/${assessmentId}/question-notes/live-transcription-session/extra`,
      `/api/v1/patients/me/assessments/${assessmentId}/questions/R01/note/live-transcription`,
      `/api/v1/patients/me/assessments/${assessmentId}/questions/R01/note/live-transcription-session/extra`,
      `/api/v1/patients/me/assessments/${assessmentId}/questions/not.valid/note/live-transcription-session`,
    ] as const;

    for (const targetPath of cases) {
      expect(
        validateProxyTarget(
          targetPath.slice(1).split("/"),
          "POST",
          `/api/proxy${targetPath}`,
        ),
      ).toEqual({
        ok: false,
        status: 404,
        code: "proxy_path_not_allowed",
      });
    }
  });

  it("allows assessment document list reads when a POST-only document route also matches the path", () => {
    const assessmentId = "10000000-0000-4000-8000-000000000001";
    const targetPath = `/api/v1/patients/me/assessments/${assessmentId}/documents`;

    expect(
      validateProxyTarget(
        targetPath.slice(1).split("/"),
        "GET",
        `/api/proxy${targetPath}`,
      ),
    ).toEqual({
      ok: true,
      targetPath,
    });
  });

  it("allows only canonical completed-file onboarding story audio routes", () => {
    const cases = [
      "/api/v1/patients/me/intake/story/audio-uploads",
      "/api/v1/patients/me/intake/story/transcriptions",
      "/api/v1/patients/me/intake/story/transcriptions/audio",
    ] as const;

    for (const targetPath of cases) {
      expect(
        validateProxyTarget(
          targetPath.slice(1).split("/"),
          "POST",
          `/api/proxy${targetPath}`,
        ),
      ).toEqual({
        ok: true,
        targetPath,
      });
    }
  });

  it("allows only the exact intake live-story HTTP control-plane shapes", () => {
    const cases = [
      ["POST", "/api/v1/patients/me/intake/story/live-transcription-session"],
      ["GET", "/api/v1/patients/me/intake/story"],
      ["PUT", "/api/v1/patients/me/intake/story"],
      ["POST", "/api/v1/patients/me/intake/route"],
    ] as const;

    for (const [method, targetPath] of cases) {
      expect(
        validateProxyTarget(
          targetPath.slice(1).split("/"),
          method,
          `/api/proxy${targetPath}`,
        ),
      ).toEqual({ ok: true, targetPath });
    }
  });

  it("keeps the intake websocket and suffix/traversal aliases outside the BFF", () => {
    const cases = [
      [
        "/ws/patients/me/intake/story/live-transcription",
        { ok: false, status: 404, code: "proxy_prefix_not_allowed" },
      ],
      [
        "/api/v1/patients/me/intake/story/live-transcription-session/extra",
        { ok: false, status: 404, code: "proxy_path_not_allowed" },
      ],
      [
        "/api/v1/patients/me/intake/story/live-transcription-session%2fextra",
        { ok: false, status: 400, code: "proxy_path_invalid" },
      ],
      [
        "/api/v1/patients/me/intake/story/../route",
        { ok: false, status: 400, code: "proxy_path_invalid" },
      ],
    ] as const;

    for (const [targetPath, expected] of cases) {
      expect(
        validateProxyTarget(
          targetPath.slice(1).split("/"),
          "POST",
          `/api/proxy${targetPath}`,
        ),
      ).toEqual(expected);
    }
  });

  it("rejects method mismatches on exact intake live-story shapes", () => {
    const cases = [
      ["GET", "/api/v1/patients/me/intake/story/live-transcription-session"],
      ["POST", "/api/v1/patients/me/intake/story"],
      ["PUT", "/api/v1/patients/me/intake/route"],
    ] as const;

    for (const [method, targetPath] of cases) {
      expect(
        validateProxyTarget(
          targetPath.slice(1).split("/"),
          method,
          `/api/proxy${targetPath}`,
        ),
      ).toEqual({
        ok: false,
        status: 405,
        code: "proxy_method_not_allowed",
      });
    }
  });

  it("blocks retired intake voice aliases and malformed story recording routes", () => {
    const cases = [
      "/api/v1/patients/me/intake/voice-upload-url",
      "/api/v1/patients/me/intake/transcribe",
      "/api/v1/patients/me/intake/story/live-transcription",
      "/api/v1/patients/me/intake/story/recordings",
      "/api/v1/patients/me/intake/story/recordings/not-a-uuid/transcription",
      "/api/v1/patients/me/intake/story/recordings/10000000-0000-4000-8000-000000000001/transcription/extra",
      "/api/v1/patients/me/intake/story/audio-uploads/extra",
      "/api/v1/patients/me/intake/story/transcriptions/extra",
      "/api/v1/patients/me/intake/story/transcriptions/audio/extra",
    ] as const;

    for (const targetPath of cases) {
      expect(
        validateProxyTarget(
          targetPath.slice(1).split("/"),
          "POST",
          `/api/proxy${targetPath}`,
        ),
      ).toEqual({
        ok: false,
        status: 404,
        code: "proxy_path_not_allowed",
      });
    }
  });

  it("blocks method mismatches on canonical onboarding story audio routes", () => {
    const cases = [
      ["GET", "/api/v1/patients/me/intake/story/audio-uploads"],
      ["GET", "/api/v1/patients/me/intake/story/transcriptions"],
      ["GET", "/api/v1/patients/me/intake/story/transcriptions/audio"],
    ] as const;

    for (const [method, targetPath] of cases) {
      expect(
        validateProxyTarget(
          targetPath.slice(1).split("/"),
          method,
          `/api/proxy${targetPath}`,
        ),
      ).toEqual({
        ok: false,
        status: 405,
        code: "proxy_method_not_allowed",
      });
    }
  });

  it("allows patient symptom trend reads used by the home dashboard", () => {
    expect(
      validateProxyTarget(
        ["api", "v1", "patients", "me", "symptom-trends"],
        "GET",
        "/api/proxy/api/v1/patients/me/symptom-trends",
      ),
    ).toEqual({ ok: true, targetPath: "/api/v1/patients/me/symptom-trends" });
  });

  it("allows tracked symptom routes explicitly", () => {
    const trackerId = "10000000-0000-4000-8000-000000000001";

    expect(
      validateProxyTarget(
        ["api", "v1", "patients", "me", "tracked-symptoms"],
        "GET",
        "/api/proxy/api/v1/patients/me/tracked-symptoms",
      ),
    ).toEqual({
      ok: true,
      targetPath: "/api/v1/patients/me/tracked-symptoms/",
    });

    expect(
      validateProxyTarget(
        ["api", "v1", "patients", "me", "tracked-symptoms", "checkin"],
        "POST",
        "/api/proxy/api/v1/patients/me/tracked-symptoms/checkin",
      ),
    ).toEqual({
      ok: true,
      targetPath: "/api/v1/patients/me/tracked-symptoms/checkin",
    });

    expect(
      validateProxyTarget(
        ["api", "v1", "patients", "me", "tracked-symptoms", trackerId, "logs"],
        "POST",
        `/api/proxy/api/v1/patients/me/tracked-symptoms/${trackerId}/logs`,
      ),
    ).toEqual({
      ok: true,
      targetPath: `/api/v1/patients/me/tracked-symptoms/${trackerId}/logs`,
    });
  });

  it("blocks unknown tracked symptom children at the BFF boundary", () => {
    expect(
      validateProxyTarget(
        ["api", "v1", "patients", "me", "tracked-symptoms", "unknown-child"],
        "GET",
        "/api/proxy/api/v1/patients/me/tracked-symptoms/unknown-child",
      ),
    ).toEqual({ ok: false, status: 404, code: "proxy_path_not_allowed" });

    expect(
      validateProxyTarget(
        [
          "api",
          "v1",
          "patients",
          "me",
          "tracked-symptoms",
          "not-a-uuid",
          "logs",
        ],
        "POST",
        "/api/proxy/api/v1/patients/me/tracked-symptoms/not-a-uuid/logs",
      ),
    ).toEqual({ ok: false, status: 404, code: "proxy_path_not_allowed" });
  });

  it("allows assessment report routes explicitly", () => {
    const assessmentId = "10000000-0000-4000-8000-000000000001";
    const reportId = "10000000-0000-4000-8000-000000000002";

    expect(
      validateProxyTarget(
        ["api", "v1", "patients", "me", "assessments", assessmentId, "reports"],
        "POST",
        `/api/proxy/api/v1/patients/me/assessments/${assessmentId}/reports`,
      ),
    ).toEqual({
      ok: true,
      targetPath: `/api/v1/patients/me/assessments/${assessmentId}/reports`,
    });

    expect(
      validateProxyTarget(
        ["api", "v1", "patients", "me", "reports", reportId],
        "GET",
        `/api/proxy/api/v1/patients/me/reports/${reportId}`,
      ),
    ).toEqual({
      ok: true,
      targetPath: `/api/v1/patients/me/reports/${reportId}`,
    });

    expect(
      validateProxyTarget(
        ["api", "v1", "patients", "me", "reports", reportId, "download-url"],
        "POST",
        `/api/proxy/api/v1/patients/me/reports/${reportId}/download-url`,
      ),
    ).toEqual({
      ok: true,
      targetPath: `/api/v1/patients/me/reports/${reportId}/download-url`,
    });
  });

  it("blocks malformed assessment report routes at the BFF boundary", () => {
    expect(
      validateProxyTarget(
        ["api", "v1", "patients", "me", "assessments", "not-a-uuid", "reports"],
        "POST",
        "/api/proxy/api/v1/patients/me/assessments/not-a-uuid/reports",
      ),
    ).toEqual({ ok: false, status: 404, code: "proxy_path_not_allowed" });

    expect(
      validateProxyTarget(
        ["api", "v1", "patients", "me", "reports", "not-a-uuid"],
        "GET",
        "/api/proxy/api/v1/patients/me/reports/not-a-uuid",
      ),
    ).toEqual({ ok: false, status: 404, code: "proxy_path_not_allowed" });
  });

  it("allows report email-self and third-party share creation for the web app", () => {
    const reportId = "10000000-0000-4000-8000-000000000002";

    expect(
      validateProxyTarget(
        ["api", "v1", "patients", "me", "reports", reportId, "email-self"],
        "POST",
        `/api/proxy/api/v1/patients/me/reports/${reportId}/email-self`,
      ),
    ).toEqual({
      ok: true,
      targetPath: `/api/v1/patients/me/reports/${reportId}/email-self`,
    });

    expect(
      validateProxyTarget(
        ["api", "v1", "shares"],
        "POST",
        "/api/proxy/api/v1/shares",
      ),
    ).toEqual({
      ok: true,
      targetPath: "/api/v1/shares",
    });
  });

  it("keeps report email-self and share creation narrow at the BFF boundary", () => {
    const reportId = "10000000-0000-4000-8000-000000000002";

    // Wrong method on email-self must not be forwarded.
    expect(
      validateProxyTarget(
        ["api", "v1", "patients", "me", "reports", reportId, "email-self"],
        "GET",
        `/api/proxy/api/v1/patients/me/reports/${reportId}/email-self`,
      ),
    ).toEqual({ ok: false, status: 405, code: "proxy_method_not_allowed" });

    // Malformed report id on email-self must be rejected.
    expect(
      validateProxyTarget(
        ["api", "v1", "patients", "me", "reports", "not-a-uuid", "email-self"],
        "POST",
        "/api/proxy/api/v1/patients/me/reports/not-a-uuid/email-self",
      ),
    ).toEqual({ ok: false, status: 404, code: "proxy_path_not_allowed" });

    // Wrong method on the share collection must not be forwarded.
    expect(
      validateProxyTarget(
        ["api", "v1", "shares"],
        "GET",
        "/api/proxy/api/v1/shares",
      ),
    ).toEqual({
      ok: false,
      status: 405,
      code: "proxy_method_not_allowed",
    });

    // `match: 'exact'` must not open child paths under the share collection.
    expect(
      validateProxyTarget(
        ["api", "v1", "shares", "some-token"],
        "GET",
        "/api/proxy/api/v1/shares/some-token",
      ),
    ).toEqual({ ok: false, status: 404, code: "proxy_path_not_allowed" });

    // The public recipient serve route (singular /share/{token}/report) is a
    // direct-to-API path and must never be reachable through the patient BFF.
    expect(
      validateProxyTarget(
        ["api", "v1", "share", "some-token", "report"],
        "GET",
        "/api/proxy/api/v1/share/some-token/report",
      ),
    ).toEqual({ ok: false, status: 404, code: "proxy_path_not_allowed" });
  });

  it("allows only implemented patient document routes and methods", () => {
    const documentId = "10000000-0000-4000-8000-000000000001";
    const routes = [
      ["GET", "/api/v1/patients/me/documents"],
      ["GET", "/api/v1/patients/me/documents/overview"],
      ["POST", "/api/v1/patients/me/documents/text"],
      ["POST", "/api/v1/patients/me/documents/upload-url"],
      ["POST", `/api/v1/patients/me/documents/${documentId}/confirm`],
      ["GET", `/api/v1/patients/me/documents/${documentId}/download-url`],
      ["GET", `/api/v1/patients/me/documents/${documentId}/findings`],
      ["DELETE", `/api/v1/patients/me/documents/${documentId}`],
      ["PATCH", `/api/v1/patients/me/documents/${documentId}/text`],
      ["PATCH", `/api/v1/patients/me/documents/${documentId}/extracted-text`],
    ] as const;

    for (const [method, targetPath] of routes) {
      expect(
        validateProxyTarget(
          targetPath.slice(1).split("/"),
          method,
          `/api/proxy${targetPath}`,
        ),
      ).toEqual({
        ok: true,
        targetPath,
      });
    }
  });

  it("limits bodyless DELETE support to exact patient document targets", () => {
    const documentPath =
      "/api/v1/patients/me/documents/10000000-0000-4000-8000-000000000001";
    const assessmentDocumentPath =
      "/api/v1/patients/me/assessments/10000000-0000-4000-8000-000000000001/documents/10000000-0000-4000-8000-000000000002";

    expect(isPatientDocumentDeleteTarget("DELETE", documentPath)).toBe(true);
    expect(isPatientDocumentDeleteTarget("POST", documentPath)).toBe(false);
    expect(
      isPatientAssessmentDocumentDeleteTarget("DELETE", assessmentDocumentPath),
    ).toBe(true);
    expect(
      isPatientAssessmentDocumentDeleteTarget("POST", assessmentDocumentPath),
    ).toBe(false);
    expect(
      isPatientDocumentDeleteTarget(
        "DELETE",
        "/api/v1/patients/me/assessments/10000000-0000-4000-8000-000000000001",
      ),
    ).toBe(false);
    expect(
      isPatientDocumentDeleteTarget("DELETE", `${documentPath}/findings`),
    ).toBe(false);
    expect(
      isPatientAssessmentDocumentDeleteTarget(
        "DELETE",
        `${assessmentDocumentPath}/confirm`,
      ),
    ).toBe(false);
  });

  it("blocks arbitrary patient document children at the BFF boundary", () => {
    const documentId = "10000000-0000-4000-8000-000000000001";
    const cases = [
      ["GET", "/api/v1/patients/me/documents/recent"],
      ["GET", "/api/v1/patients/me/documents/not-a-uuid/findings"],
      ["POST", `/api/v1/patients/me/documents/${documentId}/share`],
    ] as const;

    for (const [method, targetPath] of cases) {
      expect(
        validateProxyTarget(
          targetPath.slice(1).split("/"),
          method,
          `/api/proxy${targetPath}`,
        ),
      ).toEqual({
        ok: false,
        status: 404,
        code: "proxy_path_not_allowed",
      });
    }
  });

  it("blocks method mismatches on patient document routes before forwarding", () => {
    const documentId = "10000000-0000-4000-8000-000000000001";
    const cases = [
      ["POST", "/api/v1/patients/me/documents"],
      ["POST", "/api/v1/patients/me/documents/overview"],
      ["PUT", "/api/v1/patients/me/documents/upload-url"],
      ["PUT", `/api/v1/patients/me/documents/${documentId}`],
      ["GET", `/api/v1/patients/me/documents/${documentId}/confirm`],
      ["POST", `/api/v1/patients/me/documents/${documentId}/download-url`],
      ["POST", `/api/v1/patients/me/documents/${documentId}/findings`],
      ["DELETE", `/api/v1/patients/me/documents/${documentId}/findings`],
      ["POST", `/api/v1/patients/me/documents/${documentId}/extracted-text`],
    ] as const;

    for (const [method, targetPath] of cases) {
      expect(
        validateProxyTarget(
          targetPath.slice(1).split("/"),
          method,
          `/api/proxy${targetPath}`,
        ),
      ).toEqual({
        ok: false,
        status: 405,
        code: "proxy_method_not_allowed",
      });
    }
  });

  it("does not allow arbitrary patient child routes through the patient profile route", () => {
    expect(
      validateProxyTarget(
        ["api", "v1", "patients", "me", "unknown-child"],
        "GET",
        "/api/proxy/api/v1/patients/me/unknown-child",
      ),
    ).toEqual({ ok: false, status: 404, code: "proxy_path_not_allowed" });
  });

  it("normalizes exact backend root routes to avoid auth-losing redirects", () => {
    expect(
      validateProxyTarget(
        ["api", "v1", "patients", "me"],
        "GET",
        "/api/proxy/api/v1/patients/me",
      ),
    ).toEqual({
      ok: true,
      targetPath: "/api/v1/patients/me/",
    });

    expect(
      validateProxyTarget(
        ["api", "v1", "patients", "me", "symptoms"],
        "GET",
        "/api/proxy/api/v1/patients/me/symptoms",
      ),
    ).toEqual({ ok: true, targetPath: "/api/v1/patients/me/symptoms/" });
  });

  it("allows patient intake onboarding calls", () => {
    for (const targetPath of [
      "/api/v1/patients/me/intake/steps/profile",
      "/api/v1/patients/me/intake/steps/profile/draft",
    ]) {
      expect(
        validateProxyTarget(
          targetPath.slice(1).split("/"),
          "PUT",
          `/api/proxy${targetPath}`,
        ),
      ).toEqual({ ok: true, targetPath });
    }

    expect(
      validateProxyTarget(
        ["api", "v1", "patients", "me", "intake", "route"],
        "POST",
        "/api/proxy/api/v1/patients/me/intake/route",
      ),
    ).toEqual({ ok: true, targetPath: "/api/v1/patients/me/intake/route" });

    expect(
      validateProxyTarget(
        ["api", "v1", "patients", "me", "intake", "progress", "complete"],
        "POST",
        "/api/proxy/api/v1/patients/me/intake/progress/complete",
      ),
    ).toEqual({
      ok: true,
      targetPath: "/api/v1/patients/me/intake/progress/complete",
    });
  });

  it("keeps intake draft routes exact-match only", () => {
    expect(
      validateProxyTarget(
        [
          "api",
          "v1",
          "patients",
          "me",
          "intake",
          "steps",
          "profile",
          "draft",
          "extra",
        ],
        "PUT",
        "/api/proxy/api/v1/patients/me/intake/steps/profile/draft/extra",
      ),
    ).toEqual({ ok: false, status: 404, code: "proxy_path_not_allowed" });
  });

  it("allows only the idempotency-protected treatment creation routes", () => {
    const treatmentId = "10000000-0000-4000-8000-000000000001";
    for (const targetPath of [
      "/api/v1/patients/me/treatments",
      `/api/v1/patients/me/treatments/${treatmentId}/followups`,
    ]) {
      expect(
        validateProxyTarget(
          targetPath.slice(1).split("/"),
          "POST",
          `/api/proxy${targetPath}`,
        ),
      ).toEqual({
        ok: true,
        targetPath,
      });
    }

    for (const targetPath of [
      `/api/v1/patients/me/treatments/${treatmentId}`,
      "/api/v1/patients/me/treatments/not-a-uuid/followups",
      `/api/v1/patients/me/treatments/${treatmentId}/unknown`,
    ]) {
      expect(
        validateProxyTarget(
          targetPath.slice(1).split("/"),
          "POST",
          `/api/proxy${targetPath}`,
        ),
      ).toEqual({
        ok: false,
        status: 405,
        code: "proxy_method_not_allowed",
      });
    }
  });

  it("allows only the implemented MyScribe route and method combinations", () => {
    const recordingId = "10000000-0000-4000-8000-000000000001";
    const routes = [
      ["GET", "/api/v1/patients/me/miscribe/recording-policy"],
      ["GET", "/api/v1/patients/me/miscribe/recordings"],
      ["POST", "/api/v1/patients/me/miscribe/recordings/setup"],
      [
        "POST",
        `/api/v1/patients/me/miscribe/recordings/${recordingId}/all-party-attestation`,
      ],
      ["POST", `/api/v1/patients/me/miscribe/recordings/${recordingId}/begin`],
      [
        "POST",
        `/api/v1/patients/me/miscribe/recordings/${recordingId}/abandon`,
      ],
      [
        "POST",
        `/api/v1/patients/me/miscribe/recordings/${recordingId}/upload-url`,
      ],
      [
        "POST",
        `/api/v1/patients/me/miscribe/recordings/${recordingId}/upload-complete`,
      ],
      [
        "POST",
        `/api/v1/patients/me/miscribe/recordings/${recordingId}/process`,
      ],
      ["GET", `/api/v1/patients/me/miscribe/recordings/${recordingId}`],
      ["GET", `/api/v1/patients/me/miscribe/recordings/${recordingId}/summary`],
      ["DELETE", `/api/v1/patients/me/miscribe/recordings/${recordingId}`],
    ] as const;

    for (const [method, targetPath] of routes) {
      expect(
        validateProxyTarget(
          targetPath.slice(1).split("/"),
          method,
          `/api/proxy${targetPath}`,
        ),
      ).toEqual({
        ok: true,
        targetPath,
      });
    }
  });

  it("blocks unimplemented or malformed MyScribe paths", () => {
    const cases = [
      ["POST", "/api/v1/patients/me/miscribe/recordings/not-a-uuid/process"],
      [
        "POST",
        "/api/v1/patients/me/miscribe/recordings/10000000-0000-4000-8000-000000000001/share",
      ],
      ["GET", "/api/v1/patients/me/miscribe/summaries"],
    ] as const;

    for (const [method, targetPath] of cases) {
      expect(
        validateProxyTarget(
          targetPath.slice(1).split("/"),
          method,
          `/api/proxy${targetPath}`,
        ),
      ).toEqual({
        ok: false,
        status: 404,
        code: "proxy_path_not_allowed",
      });
    }
  });

  it("blocks method mismatches on implemented MyScribe paths", () => {
    const recordingId = "10000000-0000-4000-8000-000000000001";
    const cases = [
      ["POST", "/api/v1/patients/me/miscribe/recording-policy"],
      ["POST", "/api/v1/patients/me/miscribe/recordings"],
      ["DELETE", "/api/v1/patients/me/miscribe/recordings"],
      ["GET", "/api/v1/patients/me/miscribe/recordings/setup"],
      ["PUT", `/api/v1/patients/me/miscribe/recordings/${recordingId}`],
      ["GET", `/api/v1/patients/me/miscribe/recordings/${recordingId}/process`],
      [
        "DELETE",
        `/api/v1/patients/me/miscribe/recordings/${recordingId}/summary`,
      ],
    ] as const;

    for (const [method, targetPath] of cases) {
      expect(
        validateProxyTarget(
          targetPath.slice(1).split("/"),
          method,
          `/api/proxy${targetPath}`,
        ),
      ).toEqual({
        ok: false,
        status: 405,
        code: "proxy_method_not_allowed",
      });
    }
  });

  it("preserves explicit trailing slashes for FastAPI collection routes", () => {
    expect(
      validateProxyTarget(
        ["api", "v1", "patients", "me", "assessments"],
        "POST",
        "/api/proxy/api/v1/patients/me/assessments/",
      ),
    ).toEqual({ ok: true, targetPath: "/api/v1/patients/me/assessments/" });
  });

  it("blocks backend auth routes in the generic proxy", () => {
    expect(
      validateProxyTarget(
        ["api", "v1", "auth", "session"],
        "GET",
        "/api/proxy/api/v1/auth/session",
      ),
    ).toEqual({
      ok: false,
      status: 404,
      code: "proxy_auth_blocked",
    });
  });

  it("rejects encoded traversal and double slash prefix bypasses", () => {
    expect(
      validateProxyTarget(
        ["api", "v1", "patients", "me"],
        "GET",
        "/api/proxy/api/v1/patients/%2e%2e/me",
      ),
    ).toEqual({ ok: false, status: 400, code: "proxy_path_invalid" });

    expect(
      validateProxyTarget(
        ["api", "v1", "patients", "me"],
        "GET",
        "/api/proxy//api/v1/patients/me",
      ),
    ).toEqual({
      ok: false,
      status: 404,
      code: "proxy_prefix_not_allowed",
    });
  });

  it("blocks method mismatches before forwarding", () => {
    expect(
      validateProxyTarget(
        ["api", "v1", "patients", "me", "dashboard"],
        "POST",
        "/api/proxy/api/v1/patients/me/dashboard",
      ),
    ).toEqual({ ok: false, status: 405, code: "proxy_method_not_allowed" });
  });

  // The tester comment channel is reachable only through the BFF on web. The
  // backend mounts it at .../tester-comments/ (trailing slash), while the app
  // client posts without one, so the trailing-slash normalization is part of
  // the contract — without it every tester note save 404s in the browser.
  it("allows the tester comment channel and normalizes the backend trailing slash", () => {
    expect(
      validateProxyTarget(
        ["api", "v1", "patients", "me", "tester-comments"],
        "POST",
        "/api/proxy/api/v1/patients/me/tester-comments",
      ),
    ).toEqual({
      ok: true,
      targetPath: "/api/v1/patients/me/tester-comments/",
    });

    expect(
      validateProxyTarget(
        ["api", "v1", "patients", "me", "tester-comments"],
        "GET",
        "/api/proxy/api/v1/patients/me/tester-comments",
      ),
    ).toEqual({
      ok: true,
      targetPath: "/api/v1/patients/me/tester-comments/",
    });
  });

  it("keeps the tester comment channel narrow at the BFF boundary", () => {
    // Mutating verbs the backend does not expose must not be forwarded.
    expect(
      validateProxyTarget(
        ["api", "v1", "patients", "me", "tester-comments"],
        "DELETE",
        "/api/proxy/api/v1/patients/me/tester-comments",
      ),
    ).toEqual({ ok: false, status: 405, code: "proxy_method_not_allowed" });

    // `match: 'exact'` must not open sub-paths under the tester channel.
    expect(
      validateProxyTarget(
        ["api", "v1", "patients", "me", "tester-comments", "all"],
        "GET",
        "/api/proxy/api/v1/patients/me/tester-comments/all",
      ),
    ).toEqual({ ok: false, status: 404, code: "proxy_path_not_allowed" });
  });

  // The Track screen loads medications alongside treatments and fails closed
  // when either query errors, so a missing medications route blanks the whole
  // Treatments tab on web (observed live 2026-08-01: GET returned 404
  // proxy_path_not_allowed while treatments returned 200). The backend mounts
  // /patients/me/medications without a trailing slash, so no normalization.
  it("allows the medication routes the Track screen depends on", () => {
    const medicationId = "10000000-0000-4000-8000-000000000001";
    const cases = [
      ["GET", "/api/v1/patients/me/medications"],
      ["POST", "/api/v1/patients/me/medications"],
      ["PATCH", `/api/v1/patients/me/medications/${medicationId}`],
    ] as const;

    for (const [method, targetPath] of cases) {
      expect(
        validateProxyTarget(
          targetPath.slice(1).split("/"),
          method,
          `/api/proxy${targetPath}`,
        ),
      ).toEqual({
        ok: true,
        targetPath,
      });
    }
  });

  it("keeps the medication routes narrow at the BFF boundary", () => {
    const medicationId = "10000000-0000-4000-8000-000000000001";

    // Verbs the web app does not use must not be forwarded.
    expect(
      validateProxyTarget(
        ["api", "v1", "patients", "me", "medications"],
        "DELETE",
        "/api/proxy/api/v1/patients/me/medications",
      ),
    ).toEqual({ ok: false, status: 405, code: "proxy_method_not_allowed" });

    expect(
      validateProxyTarget(
        ["api", "v1", "patients", "me", "medications", medicationId],
        "GET",
        `/api/proxy/api/v1/patients/me/medications/${medicationId}`,
      ),
    ).toEqual({ ok: false, status: 405, code: "proxy_method_not_allowed" });

    // Malformed ids and unknown children must be rejected outright.
    expect(
      validateProxyTarget(
        ["api", "v1", "patients", "me", "medications", "not-a-uuid"],
        "PATCH",
        "/api/proxy/api/v1/patients/me/medications/not-a-uuid",
      ),
    ).toEqual({ ok: false, status: 404, code: "proxy_path_not_allowed" });

    expect(
      validateProxyTarget(
        ["api", "v1", "patients", "me", "medications", medicationId, "unknown"],
        "GET",
        `/api/proxy/api/v1/patients/me/medications/${medicationId}/unknown`,
      ),
    ).toEqual({ ok: false, status: 404, code: "proxy_path_not_allowed" });
  });

  it("allows patient-owned FHIR management and import routes through the PHI proxy", () => {
    const connectionId = "10000000-0000-4000-8000-000000000001";
    const importId = "10000000-0000-4000-8000-000000000002";
    const cases = [
      ["GET", "/api/v1/fhir/policy"],
      ["GET", "/api/v1/fhir/endpoints"],
      ["GET", "/api/v1/fhir/connections"],
      ["GET", `/api/v1/fhir/connections/${connectionId}`],
      ["DELETE", `/api/v1/fhir/connections/${connectionId}`],
      ["DELETE", `/api/v1/fhir/connections/${connectionId}/permission`],
      ["DELETE", `/api/v1/fhir/connections/${connectionId}/attempt`],
      ["POST", `/api/v1/fhir/connections/${connectionId}/sync`],
      ["GET", `/api/v1/fhir/connections/${connectionId}/import-status`],
      ["GET", `/api/v1/fhir/imports/${importId}/preview`],
      ["POST", `/api/v1/fhir/imports/${importId}/commit`],
      ["GET", "/api/v1/fhir/import-history"],
      ["GET", "/api/v1/fhir/import-history/export"],
    ] as const;

    for (const [method, targetPath] of cases) {
      expect(
        validateProxyTarget(
          targetPath.slice(1).split("/"),
          method,
          `/api/proxy${targetPath}`,
        ),
      ).toEqual({
        ok: true,
        targetPath,
      });
    }
  });

  it("keeps FHIR OAuth initiate and callback out of the generic PHI proxy", () => {
    const cases = [
      ["POST", "/api/v1/fhir/connections"],
      ["POST", "/api/v1/fhir/connections/callback"],
      ["POST", "/api/v1/fhir/connections/callback/denial"],
      ["GET", "/api/v1/fhir/connections/callback"],
    ] as const;

    for (const [method, targetPath] of cases) {
      expect(
        validateProxyTarget(
          targetPath.slice(1).split("/"),
          method,
          `/api/proxy${targetPath}`,
        ),
      ).toEqual({
        ok: false,
        status:
          method === "POST" && targetPath === "/api/v1/fhir/connections"
            ? 405
            : 404,
        code:
          method === "POST" && targetPath === "/api/v1/fhir/connections"
            ? "proxy_method_not_allowed"
            : "proxy_path_not_allowed",
      });
    }
  });

  it("allows patient provider linking routes through the PHI proxy", () => {
    const linkId = "10000000-0000-4000-8000-000000000001";
    const cases = [
      ["POST", "/api/v1/invite-codes/validate"],
      ["POST", "/api/v1/patients/me/link"],
      ["GET", "/api/v1/patients/me/providers"],
      ["POST", `/api/v1/patients/me/providers/${linkId}/revoke`],
    ] as const;

    for (const [method, targetPath] of cases) {
      expect(
        validateProxyTarget(
          targetPath.slice(1).split("/"),
          method,
          `/api/proxy${targetPath}`,
        ),
      ).toEqual({
        ok: true,
        targetPath,
      });
    }
  });

  it("keeps staff-only invite-code create and list off the patient proxy", () => {
    const cases = [
      ["POST", "/api/proxy/api/v1/invite-codes"],
      ["POST", "/api/proxy/api/v1/invite-codes/"],
      ["GET", "/api/proxy/api/v1/invite-codes"],
      ["GET", "/api/proxy/api/v1/invite-codes/"],
    ] as const;

    for (const [method, rawPathname] of cases) {
      expect(
        validateProxyTarget(["api", "v1", "invite-codes"], method, rawPathname),
      ).toEqual({ ok: false, status: 404, code: "proxy_path_not_allowed" });
    }
  });

  it("scopes the linking routes to their exact methods and UUID link ids", () => {
    // The exact-match POST entry makes the path itself known, so every other
    // verb on it is a method violation rather than an unknown path.
    for (const method of ["GET", "DELETE"] as const) {
      expect(
        validateProxyTarget(
          ["api", "v1", "patients", "me", "link"],
          method,
          "/api/proxy/api/v1/patients/me/link",
        ),
      ).toEqual({ ok: false, status: 405, code: "proxy_method_not_allowed" });
    }

    // A malformed link id never matches the anchored revoke pattern. The only
    // remaining match is the pre-existing read-only providers prefix entry, so
    // the write is rejected as a method violation and never reaches the API.
    expect(
      validateProxyTarget(
        ["api", "v1", "patients", "me", "providers", "not-a-uuid", "revoke"],
        "POST",
        "/api/proxy/api/v1/patients/me/providers/not-a-uuid/revoke",
      ),
    ).toEqual({ ok: false, status: 405, code: "proxy_method_not_allowed" });
  });
});
