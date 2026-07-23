import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const PROTECTED_UNSAFE_ROUTES = [
  "src/app/api/auth/[...path]/route.ts",
  "src/app/api/auth/login/route.ts",
  "src/app/api/auth/logout/route.ts",
  "src/app/api/auth/mfa/confirm/route.ts",
  "src/app/api/auth/mfa/disable/route.ts",
  "src/app/api/auth/mfa/enrollment/confirm/route.ts",
  "src/app/api/auth/mfa/enrollment/setup/route.ts",
  "src/app/api/auth/mfa/setup/route.ts",
  "src/app/api/auth/mfa/step-up/route.ts",
  "src/app/api/auth/mfa/verify/route.ts",
  "src/app/api/auth/refresh/route.ts",
  "src/app/api/auth/register/route.ts",
] as const;

describe("unsafe browser route origin-policy inventory", () => {
  it("enumerates every unsafe API route, including the explicit test-support exception", () => {
    const apiRoot = resolve(process.cwd(), "src/app/api");
    const unsafeRoutes = readdirSync(apiRoot, { recursive: true })
      .filter(
        (relativePath): relativePath is string =>
          typeof relativePath === "string" && relativePath.endsWith("route.ts"),
      )
      .filter((relativePath) => {
        const source = readFileSync(resolve(apiRoot, relativePath), "utf8");
        return (
          /export async function (?:POST|PUT|PATCH|DELETE)\b/u.test(source) ||
          /handler as (?:POST|PUT|PATCH|DELETE)\b/u.test(source)
        );
      })
      .map((relativePath) => `src/app/api/${relativePath}`)
      .sort();

    expect(unsafeRoutes).toEqual(
      [
        ...PROTECTED_UNSAFE_ROUTES,
        "src/app/api/proxy/[...path]/route.ts",
        "src/app/api/test/e2e-cleanup/route.ts",
      ].sort(),
    );
  });

  it.each(PROTECTED_UNSAFE_ROUTES)(
    "%s invokes the centralized auth mutation guard",
    (relativePath) => {
      const source = readFileSync(resolve(process.cwd(), relativePath), "utf8");
      expect(source).toContain("validateAuthMutation(request)");
    },
  );

  it("protects every unsafe PHI proxy method through the centralized validator", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/app/api/proxy/[...path]/route.ts"),
      "utf8",
    );
    expect(source).toMatch(/validateUnsafeRequest\(\s*request/u);
    expect(source).toContain("handler as DELETE");
    expect(source).toContain("handler as PATCH");
    expect(source).toContain("handler as POST");
    expect(source).toContain("handler as PUT");
  });

  it("keeps the cross-site OAuth callback GET outside unsafe-request validation", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/app/api/auth/google/callback/route.ts"),
      "utf8",
    );
    expect(source).not.toContain("validateAuthMutation");
    expect(source).toContain("validatePatientWebConfiguration");
  });
});
