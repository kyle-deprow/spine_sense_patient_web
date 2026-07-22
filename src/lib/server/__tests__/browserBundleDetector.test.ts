import { createRequire } from 'node:module'

import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { scanSource } = require('../../../../scripts/check-browser-bundle.cjs') as {
  scanSource: (source: string) => Array<{ filePath: string; label: string }>
}

function labelsFor(source: string): string[] {
  return scanSource(source).map(({ label }) => label)
}

describe('browser bundle detector', () => {
  it('allows fail-closed platform capability identifiers', () => {
    expect(
      labelsFor(`
        const capabilities = {
          secure_token_storage: { supported: false, reason: 'disabled_by_policy' },
          persistent_phi_storage: { supported: false, reason: 'disabled_by_policy' },
        }
      `),
    ).toEqual([])
  })

  it.each([
    ["import * as SecureStore from 'expo-secure-store'", 'expo-secure-store'],
    ["import { MMKV } from 'react-native-mmkv'", 'react-native-mmkv'],
    ['SecureStore.getItemAsync(key)', 'SecureStore browser path'],
    ['new MMKV()', 'MMKV browser path'],
    ['window.localStorage.getItem(key)', 'durable browser storage API'],
    ['window.sessionStorage.setItem(key, value)', 'durable browser storage API'],
    ['window.indexedDB.open(name)', 'durable browser storage API'],
    ["const field = 'access_token'", 'JS-readable backend token field'],
    ["const field = 'refresh_token'", 'JS-readable backend token field'],
  ])('rejects %s', (source, expectedLabel) => {
    expect(labelsFor(source)).toContain(expectedLabel)
  })
})
