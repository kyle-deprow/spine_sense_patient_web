import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    environment: 'node',
    env: {
      ENVIRONMENT: 'test',
      PATIENT_WEB_CLIENT_IP_MODE: 'single-bucket',
      PATIENT_WEB_ALLOWED_ORIGINS: 'https://patient.example.test',
      PATIENT_APP_ENVIRONMENT: 'test',
      NEXT_PUBLIC_STORAGE_DOMAINS:
        'https://patient-documents.example.test https://assets.example.test http://127.0.0.1:9000',
      PATIENT_WEB_LOCAL_MINIO_PUBLIC_ORIGIN: 'http://127.0.0.1:9000',
      PATIENT_WEB_AUDIT_ACTOR_SIGNING_CURRENT_KEY_ID: 'test-current',
      PATIENT_WEB_AUDIT_ACTOR_SIGNING_CURRENT_KEY: 'patient-web-test-actor-signing-key-32-bytes',
      PATIENT_WEB_AUDIT_ACTOR_SIGNING_PREVIOUS_KEY_ID: 'test-previous',
      PATIENT_WEB_AUDIT_ACTOR_SIGNING_PREVIOUS_KEY:
        'patient-web-previous-test-signing-key-32-bytes',
    },
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules', '.next'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/lib/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.ts'],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
