// NOTE: getClientIp trusts x-forwarded-for unconditionally. This assumes
// deployment behind a trusted reverse proxy that sets the real client IP.
import type { NextRequest } from 'next/server'

const MAX_KEYS = 10_000

// Map<key, timestamps[]> — timestamps are ms since epoch, sorted ascending
const store = new Map<string, number[]>()

export function rateLimit(key: string, opts: { limit: number; windowMs: number }): boolean {
  const now = Date.now()
  const windowStart = now - opts.windowMs

  let timestamps = store.get(key)

  if (timestamps === undefined) {
    // Evict the oldest entry when at capacity before inserting a new key
    if (store.size >= MAX_KEYS) {
      const oldestKey = store.keys().next().value
      if (oldestKey !== undefined) {
        store.delete(oldestKey)
      }
    }
    timestamps = []
    store.set(key, timestamps)
  }

  // Sliding window: drop timestamps that have fallen outside the window
  let start = 0
  while (start < timestamps.length && timestamps[start]! < windowStart) {
    start++
  }
  if (start > 0) {
    timestamps.splice(0, start)
  }

  if (timestamps.length >= opts.limit) {
    // At limit — do not record this attempt
    if (timestamps.length === 0) {
      store.delete(key)
    }
    return false
  }

  timestamps.push(now)
  return true
}

export function getClientIp(request: NextRequest): string {
  try {
    const forwarded = request.headers.get('x-forwarded-for')
    if (forwarded) {
      const first = forwarded.split(',')[0]!.trim()
      if (first) return first
    }
    const realIp = request.headers.get('x-real-ip')
    if (realIp) {
      const trimmed = realIp.trim()
      if (trimmed) return trimmed
    }
  } catch {
    // Never fail
  }
  return 'unknown'
}
