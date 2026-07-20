import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  auditFrontDoorOriginRejection,
  frontDoorOriginRejectionReason,
  getFrontDoorOriginGuardConfig,
  resetFrontDoorOriginAuditWindowForTests,
  type FrontDoorOriginGuardAuditRecord,
} from '@/lib/front-door-origin-guard'

const FRONT_DOOR_ID = '12345678-1234-1234-1234-123456789abc'

describe('Front Door origin guard', () => {
  beforeEach(() => {
    resetFrontDoorOriginAuditWindowForTests()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('defaults a standalone production Node process to a local, disabled guard', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('ENVIRONMENT', '')
    vi.stubEnv('FRONT_DOOR_ORIGIN_GUARD_MODE', '')
    vi.stubEnv('AZURE_FRONT_DOOR_ID', '')

    expect(getFrontDoorOriginGuardConfig()).toEqual({
      environment: 'local',
      mode: 'off',
      expectedFrontDoorId: null,
    })
  })

  it('accepts an explicit active configuration', () => {
    expect(getFrontDoorOriginGuardConfig('staging', 'audit', FRONT_DOOR_ID)).toEqual({
      environment: 'staging',
      mode: 'audit',
      expectedFrontDoorId: FRONT_DOOR_ID,
    })
  })

  it.each([
    ['bad mode', 'production', 'enabled', FRONT_DOOR_ID],
    ['bad environment', 'Production', 'enforce', FRONT_DOOR_ID],
    ['missing ID', 'production', 'enforce', undefined],
    ['uppercase ID', 'production', 'enforce', FRONT_DOOR_ID.toUpperCase()],
    ['noncanonical ID', 'production', 'audit', 'not-a-uuid'],
  ])('rejects %s', (_label, environment, mode, id) => {
    expect(() => getFrontDoorOriginGuardConfig(environment, mode, id)).toThrow()
  })

  it('classifies missing, combined, malformed, mismatched, and exact values', () => {
    expect(frontDoorOriginRejectionReason(new Headers(), FRONT_DOOR_ID)).toBe('missing')
    expect(
      frontDoorOriginRejectionReason(
        new Headers({ 'x-azure-fdid': `${FRONT_DOOR_ID}, ${FRONT_DOOR_ID}` }),
        FRONT_DOOR_ID,
      ),
    ).toBe('malformed')
    expect(
      frontDoorOriginRejectionReason(
        new Headers({ 'x-azure-fdid': FRONT_DOOR_ID.toUpperCase() }),
        FRONT_DOOR_ID,
      ),
    ).toBe('malformed')
    expect(
      frontDoorOriginRejectionReason(
        new Headers({ 'x-azure-fdid': 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }),
        FRONT_DOOR_ID,
      ),
    ).toBe('mismatch')
    expect(
      frontDoorOriginRejectionReason(new Headers({ 'x-azure-fdid': FRONT_DOOR_ID }), FRONT_DOOR_ID),
    ).toBeNull()
  })

  it('emits only bounded, fixed-schema audit records and resets on the next window', () => {
    const records: FrontDoorOriginGuardAuditRecord[] = []
    const logger = (record: FrontDoorOriginGuardAuditRecord) => records.push(record)
    const config = getFrontDoorOriginGuardConfig('production', 'audit', FRONT_DOOR_ID)

    for (let index = 0; index < 25; index += 1) {
      auditFrontDoorOriginRejection(config, 'mismatch', 1_000, logger)
    }
    expect(records).toHaveLength(10)
    expect(records[0]).toEqual({
      event: 'security.front_door_origin.rejected',
      app: 'patient-web',
      reason: 'mismatch',
      mode: 'audit',
      environment: 'production',
    })
    expect(Object.keys(records[0] ?? {})).toEqual([
      'event',
      'app',
      'reason',
      'mode',
      'environment',
    ])

    auditFrontDoorOriginRejection(config, 'missing', 61_000, logger)
    expect(records).toHaveLength(11)
    expect(records[10]?.reason).toBe('missing')
  })

  it('does not log in off or enforce mode', () => {
    const logger = vi.fn()
    auditFrontDoorOriginRejection(
      getFrontDoorOriginGuardConfig('local', 'off'),
      'missing',
      1_000,
      logger,
    )
    auditFrontDoorOriginRejection(
      getFrontDoorOriginGuardConfig('production', 'enforce', FRONT_DOOR_ID),
      'missing',
      1_000,
      logger,
    )
    expect(logger).not.toHaveBeenCalled()
  })
})
