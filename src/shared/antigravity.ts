export const DEFAULT_ANTIGRAVITY_WEB_CALLS = 4
export const MAX_ANTIGRAVITY_WEB_CALLS = 12

export function antigravityWebCallLimit(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.min(MAX_ANTIGRAVITY_WEB_CALLS, Math.floor(value)))
    : DEFAULT_ANTIGRAVITY_WEB_CALLS
}
