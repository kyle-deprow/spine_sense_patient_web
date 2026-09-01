import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getGoogleOAuthConfig,
  getPatientWebConfig,
  parseAllowedOrigins,
  parseClientIpMode,
  parseCredentialRateLimitConfig,
} from "@/lib/server/config";

describe("patient web config", () => {
  beforeEach(() => {
    vi.stubEnv("BACKEND_INTERNAL_URL", "https://api.example.test");
    vi.stubEnv(
      "PATIENT_WEB_CSRF_SECRET",
      "test-patient-web-csrf-secret-at-least-32-bytes",
    );
    vi.stubEnv("PATIENT_WEB_CREDENTIAL_RATE_LIMIT_STORE", "redis");
    vi.stubEnv(
      "REDIS_URL",
      "rediss://:test-password@redis.example.test:6380/0",
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts an explicitly enabled complete Google OAuth configuration", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ENVIRONMENT", "production");
    vi.stubEnv("PATIENT_WEB_CLIENT_IP_MODE", "azure-front-door");
    vi.stubEnv("FRONT_DOOR_ORIGIN_GUARD_MODE", "enforce");
    vi.stubEnv("AZURE_FRONT_DOOR_ID", "12345678-1234-1234-1234-123456789abc");
    vi.stubEnv("PATIENT_WEB_ALLOWED_ORIGINS", "https://patient.example.test");
    vi.stubEnv("PATIENT_WEB_PUBLIC_URL", "https://patient.example.test");
    vi.stubEnv("GOOGLE_CLIENT_ID", "google-web-client-id");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "google-web-client-secret");
    vi.stubEnv("GOOGLE_OAUTH_ENABLED", "True");

    expect(getGoogleOAuthConfig()).toEqual({
      clientId: "google-web-client-id",
      clientSecret: "google-web-client-secret",
      enabled: true,
      publicUrl: "https://patient.example.test",
    });
  });

  it("keeps the BFF available when disabled Google settings are incomplete", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ENVIRONMENT", "production");
    vi.stubEnv("PATIENT_WEB_CLIENT_IP_MODE", "unavailable");
    vi.stubEnv("GOOGLE_CLIENT_ID", "google-web-client-id");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "");
    vi.stubEnv("GOOGLE_OAUTH_ENABLED", "false");

    expect(() => getPatientWebConfig()).not.toThrow();
    expect(() => getGoogleOAuthConfig()).toThrow(
      "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together",
    );
  });

  it("requires credentials and an exact public URL only on Google routes", () => {
    vi.stubEnv("GOOGLE_OAUTH_ENABLED", "true");
    vi.stubEnv("GOOGLE_CLIENT_ID", "google-web-client-id");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "google-web-client-secret");
    vi.stubEnv("PATIENT_WEB_PUBLIC_URL", "");

    expect(() => getPatientWebConfig()).not.toThrow();
    expect(() => getGoogleOAuthConfig()).toThrow(
      "PATIENT_WEB_PUBLIC_URL is required",
    );
  });

  it("never treats a hosted dev label as local Google configuration", () => {
    vi.stubEnv("ENVIRONMENT", "dev");
    vi.stubEnv("PATIENT_WEB_CLIENT_IP_MODE", "unavailable");
    vi.stubEnv("GOOGLE_OAUTH_ENABLED", "true");
    vi.stubEnv("GOOGLE_CLIENT_ID", "google-web-client-id");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "google-web-client-secret");
    vi.stubEnv(
      "PATIENT_WEB_ALLOWED_ORIGINS",
      "https://patient-dev.example.test",
    );
    vi.stubEnv("PATIENT_WEB_PUBLIC_URL", "https://patient-dev.example.test");

    expect(() => getGoogleOAuthConfig()).toThrow(
      "Hosted Google OAuth requires the Front Door origin guard in enforce mode",
    );
  });

  it("includes the explicit Front Door origin guard configuration", () => {
    vi.stubEnv("ENVIRONMENT", "production");
    vi.stubEnv("PATIENT_WEB_CLIENT_IP_MODE", "azure-front-door");
    vi.stubEnv("FRONT_DOOR_ORIGIN_GUARD_MODE", "enforce");
    vi.stubEnv("AZURE_FRONT_DOOR_ID", "12345678-1234-1234-1234-123456789abc");

    expect(getPatientWebConfig()).toMatchObject({
      environment: "production",
      frontDoorOriginGuardMode: "enforce",
      azureFrontDoorId: "12345678-1234-1234-1234-123456789abc",
    });
  });

  it("fails startup config validation for an active guard without a canonical ID", () => {
    vi.stubEnv("ENVIRONMENT", "staging");
    vi.stubEnv("FRONT_DOOR_ORIGIN_GUARD_MODE", "audit");
    vi.stubEnv("AZURE_FRONT_DOOR_ID", "");

    expect(() => getPatientWebConfig()).toThrow(
      "AZURE_FRONT_DOOR_ID is required when the Front Door origin guard is active",
    );
  });

  it.each([undefined, "", "   "])(
    "rejects an unset or blank allowed-origin list (%s)",
    (value) => {
      expect(() => parseAllowedOrigins(value, "test")).toThrow(
        "PATIENT_WEB_ALLOWED_ORIGINS",
      );
    },
  );

  it.each([
    "*",
    "https://*.example.test",
    "https://user:pass@patient.example.test",
    "https://patient.example.test/path",
    "https://patient.example.test?query=1",
    "https://patient.example.test#fragment",
    "https://patient.example.test/",
    "http://patient.example.test",
  ])("rejects a non-exact or insecure allowed origin: %s", (origin) => {
    expect(() => parseAllowedOrigins(origin, "production")).toThrow(
      "PATIENT_WEB_ALLOWED_ORIGINS",
    );
  });

  it("accepts exact HTTPS origins and deduplicates them", () => {
    expect(
      parseAllowedOrigins(
        "https://patient.example.test, https://patient.example.test https://other.example.test:8443",
        "production",
      ),
    ).toEqual([
      "https://patient.example.test",
      "https://other.example.test:8443",
    ]);
  });

  it.each(["local", "development", "test", "e2e"])(
    "accepts HTTP loopback in explicit %s",
    (environment) => {
      expect(
        parseAllowedOrigins(
          "http://localhost:3000 http://127.0.0.1:43101 http://[::1]:43101",
          environment,
        ),
      ).toEqual([
        "http://localhost:3000",
        "http://127.0.0.1:43101",
        "http://[::1]:43101",
      ]);
    },
  );

  it.each([undefined, "", "production", "staging"])(
    "rejects HTTP loopback in hosted or unknown %s",
    (environment) => {
      expect(() =>
        parseAllowedOrigins("http://127.0.0.1:43101", environment),
      ).toThrow("PATIENT_WEB_ALLOWED_ORIGINS");
    },
  );

  it.each(["local", "development", "dev", "test", "e2e"])(
    "permits single-bucket rate limiting only for explicit local label %s",
    (environment) => {
      expect(parseClientIpMode("single-bucket", environment)).toBe(
        "single-bucket",
      );
    },
  );

  it.each(["production", "prod", "staging", "unknown", ""])(
    "rejects single-bucket rate limiting for hosted or unknown label %s",
    (environment) => {
      expect(() => parseClientIpMode("single-bucket", environment)).toThrow();
    },
  );

  it.each(["production", "prod", "staging", "dev", "development"])(
    "permits unavailable and Azure Front Door modes for hosted label %s",
    (environment) => {
      expect(parseClientIpMode("unavailable", environment)).toBe("unavailable");
      expect(parseClientIpMode("azure-front-door", environment)).toBe(
        "azure-front-door",
      );
    },
  );

  it.each(["local", "test", "e2e", "unknown", undefined])(
    "rejects hosted rate-limit modes for local or unknown label %s",
    (environment) => {
      expect(() => parseClientIpMode("unavailable", environment)).toThrow();
      expect(() =>
        parseClientIpMode("azure-front-door", environment),
      ).toThrow();
    },
  );

  it.each([undefined, "", "forwarded", "Azure-Front-Door"])(
    "rejects invalid or missing client IP mode %s",
    (mode) => {
      expect(() => parseClientIpMode(mode, "production")).toThrow(
        "PATIENT_WEB_CLIENT_IP_MODE",
      );
    },
  );

  it("requires a TLS Redis store for hosted credential throttling", () => {
    expect(() =>
      parseCredentialRateLimitConfig(
        "redis",
        "redis://:password@redis.example.test:6379/0",
        "production",
      ),
    ).toThrow("requires a rediss://");
    expect(
      parseCredentialRateLimitConfig(
        "redis",
        "rediss://:password@redis.example.test:6380/0",
        "production",
      ),
    ).toEqual({
      store: "redis",
      redisUrl: "rediss://:password@redis.example.test:6380/0",
    });
  });

  it("allows the bounded in-memory store only when explicitly local", () => {
    expect(parseCredentialRateLimitConfig("memory", "", "test")).toEqual({
      store: "memory",
      redisUrl: null,
    });
    expect(() =>
      parseCredentialRateLimitConfig("memory", "", "production"),
    ).toThrow("only in local environments");
  });

  it("rejects a CSRF secret shorter than 32 UTF-8 bytes", () => {
    vi.stubEnv("PATIENT_WEB_CSRF_SECRET", "too-short");
    expect(() => getPatientWebConfig()).toThrow(
      "PATIENT_WEB_CSRF_SECRET must be at least 32 bytes",
    );
  });

  it("requires an exact Front Door ID in Azure client-IP mode", () => {
    vi.stubEnv("ENVIRONMENT", "production");
    vi.stubEnv("PATIENT_WEB_CLIENT_IP_MODE", "azure-front-door");
    vi.stubEnv("AZURE_FRONT_DOOR_ID", "");
    expect(() => getPatientWebConfig()).toThrow(
      "AZURE_FRONT_DOOR_ID is required for azure-front-door client IP mode",
    );
  });
});
