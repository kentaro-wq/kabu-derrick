import type { Profile } from '@/types'

export type NisaStatus = {
  growthRemaining: number
  tsumitateRemaining: number
  growthMonthsLeft: number
  tsumitateMonthsLeft: number
  growthMonthlyTarget: number
  tsumitateMonthlyTarget: number
}

export function getNisaStatus(profile: Profile): NisaStatus {
  const now = new Date()
  const growthRemaining = Math.max(0, profile.nisa_growth_limit - profile.nisa_growth_used)
  const tsumitateRemaining = Math.max(0, profile.nisa_tsumitate_limit - profile.nisa_tsumitate_used)
  const growthMonthsLeft = Math.max(1, 12 - now.getMonth())
  const tsumitateMonthsLeft = Math.max(1, 12 - now.getMonth())
  const growthMonthlyTarget = Math.ceil(growthRemaining / growthMonthsLeft)
  const tsumitateMonthlyTarget = Math.ceil(tsumitateRemaining / tsumitateMonthsLeft)
  return {
    growthRemaining,
    tsumitateRemaining,
    growthMonthsLeft,
    tsumitateMonthsLeft,
    growthMonthlyTarget,
    tsumitateMonthlyTarget,
  }
}
