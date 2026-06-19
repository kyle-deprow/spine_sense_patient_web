import { spawnSync } from 'node:child_process'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(__dirname, '../..')
const scriptPath = path.join(repoRoot, 'scripts/check-playwright-evidence.cjs')
const exampleEvidencePath = path.join(repoRoot, 'e2e/playwright-evidence.example.json')

function runVerifier(
  args: string[] = [],
  env: Record<string, string | undefined> = {},
) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CI: undefined,
      PATIENT_WEB_PLAYWRIGHT_EVIDENCE: undefined,
      PATIENT_WEB_RELEASE_VALIDATION: undefined,
      ...env,
    },
    encoding: 'utf8',
  })
}

describe('Playwright evidence verifier', () => {
  it('fails closed when no evidence path is provided', () => {
    const result = runVerifier()

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('No Playwright security evidence path provided.')
  })

  it('verifies the complete example evidence file', () => {
    const result = runVerifier([exampleEvidencePath])

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('12 gates verified')
  })
})
