export const CAMPAIGN_QUERY_KEYS = [
  'c',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
] as const

type CampaignQueryKey = (typeof CAMPAIGN_QUERY_KEYS)[number]

// `c` matches the analytics store's normalized campaign limit. UTM values are
// descriptive, so they get more room, but remain bounded before a second URL
// and access-log entry can be created.
const CAMPAIGN_QUERY_VALUE_LIMITS: Record<CampaignQueryKey, number> = {
  c: 32,
  utm_source: 128,
  utm_medium: 128,
  utm_campaign: 128,
  utm_term: 128,
  utm_content: 128,
}

export function normalizeCampaignQueryValue(
  key: CampaignQueryKey,
  value: string | undefined,
): string | null {
  const normalized = value?.trim().slice(0, CAMPAIGN_QUERY_VALUE_LIMITS[key])
  return normalized || null
}

export function campaignQuery(
  searchParams: Record<string, string | string[] | undefined>,
): string {
  const params = new URLSearchParams()
  for (const key of CAMPAIGN_QUERY_KEYS) {
    const value = searchParams[key]
    const firstValue = typeof value === 'string' ? value : value?.[0]
    const normalized = normalizeCampaignQueryValue(key, firstValue)
    if (normalized !== null) params.set(key, normalized)
  }
  return params.toString()
}

/** Keep analytics grouping precedence identical to the existing Expo-shell tracker. */
export function selectLandingCampaign(params: URLSearchParams): string {
  for (const key of ['c', 'utm_content', 'utm_campaign'] as const) {
    const normalized = normalizeCampaignQueryValue(key, params.get(key) ?? undefined)
    if (normalized !== null) return normalized
  }
  return ''
}
