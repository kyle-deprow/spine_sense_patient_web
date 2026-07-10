export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { auditWebVoicePolicyAtStartup } = await import('./lib/server/startupAudit')
    auditWebVoicePolicyAtStartup()
  }
}
