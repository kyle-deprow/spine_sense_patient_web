# SpineSense Patient Web — Next.js gateway for the exported patient app

FROM node:20-alpine AS base
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
ARG PATIENT_APP_ENVIRONMENT=production
ARG PATIENT_APP_API_BASE_URL=/api/proxy/api/v1
RUN EXPO_PUBLIC_ENVIRONMENT="$PATIENT_APP_ENVIRONMENT" \
    EXPO_PUBLIC_API_BASE_URL="$PATIENT_APP_API_BASE_URL" \
    pnpm --dir ../spine_sense_app build:web -- --output-dir ../spine_sense_patient_web/patient-app-export
RUN pnpm build

# ── Production ───────────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

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
