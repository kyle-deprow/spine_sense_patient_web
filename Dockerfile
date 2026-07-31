# SpineSense Patient Web — Next.js gateway for the exported patient app

FROM node:24-alpine AS base
WORKDIR /workspace
RUN corepack enable pnpm

# ── Dependencies ─────────────────────────────────────────────────
FROM base AS deps
COPY spine_sense_app/package.json spine_sense_app/pnpm-lock.yaml ./spine_sense_app/
COPY spine_sense_patient_web/package.json spine_sense_patient_web/pnpm-lock.yaml ./spine_sense_patient_web/
RUN cd spine_sense_app && pnpm install --frozen-lockfile
RUN cd spine_sense_patient_web && pnpm install --frozen-lockfile

# ── Build ────────────────────────────────────────────────────────
FROM base AS builder
COPY --from=deps /workspace/spine_sense_app/node_modules ./spine_sense_app/node_modules
COPY --from=deps /workspace/spine_sense_patient_web/node_modules ./spine_sense_patient_web/node_modules
COPY spine_sense_app ./spine_sense_app
COPY spine_sense_patient_web ./spine_sense_patient_web
WORKDIR /workspace/spine_sense_patient_web
ENV NEXT_TELEMETRY_DISABLED=1
# Build-time deployment label, consumed only by the Expo web export
# (scripts/build-patient-app-export.cjs). Deliberately NOT promoted to a
# builder-wide ENV: `pnpm build` (next build) must keep running with ENVIRONMENT
# unset exactly as before, and the RUNTIME tier is supplied by the container app
# (Bicep sets ENVIRONMENT from runtimeEnvironment), never baked into the image.
ARG ENVIRONMENT=production
ARG PATIENT_APP_API_BASE_URL=/api/proxy/api/v1
ARG PATIENT_APP_EPIC_FHIR_ENABLED=false
ENV PATIENT_APP_API_BASE_URL=$PATIENT_APP_API_BASE_URL
ENV PATIENT_APP_EPIC_FHIR_ENABLED=$PATIENT_APP_EPIC_FHIR_ENABLED
RUN ENVIRONMENT="$ENVIRONMENT" pnpm build:patient-app
RUN test -f patient-app-export/index.html
RUN mkdir -p public
RUN pnpm build

# ── Production ───────────────────────────────────────────────────
FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# No ENVIRONMENT default here on purpose. The deployment tier is supplied at
# runtime by the container app; an image-baked default would silently override
# the deployed tier and reintroduce the drift this variable used to have.

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

COPY --from=builder /workspace/spine_sense_patient_web/public ./public
COPY --from=builder --chown=nextjs:nodejs /workspace/spine_sense_patient_web/patient-app-export ./patient-app-export
COPY --from=builder --chown=nextjs:nodejs /workspace/spine_sense_patient_web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /workspace/spine_sense_patient_web/.next/static ./.next/static

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
