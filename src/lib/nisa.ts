import type { Profile } from '@/types'

export type NisaStatus = {
  growthRemaining: number
  tsumitateRemaining: number
  tsumitateScheduled: number   // 利用予定（積立設定×残月数）
  growthMonthsLeft: number
  tsumitateMonthsLeft: number
  growthMonthlyTarget: number
  tsumitateMonthlyTarget: number
}

export function getNisaStatus(profile: Profile, tsumitateMonthly = 0): NisaStatus {
  const now = new Date()
  // 残り月数: 積立は毎月1日実行。今日が1日より後なら当月は処理済みなので翌月〜12月をカウント
  // 例: 5月12日 → 5月1日は処理済 → 残りは6〜12月の7ヶ月
  const currentMonthDone = now.getDate() > 1
  const monthsLeft = Math.max(1, 12 - now.getMonth() - (currentMonthDone ? 1 : 0))

  // 成長枠: 利用済（保有+注文中）をそのまま引く
  const growthRemaining = Math.max(0, profile.nisa_growth_limit - profile.nisa_growth_used)

  // つみたて枠: 利用済 + 利用予定（積立設定×残月数）を引く（楽天と同じ計算）
  const tsumitateScheduled = tsumitateMonthly * monthsLeft
  const tsumitateRemaining = Math.max(0, profile.nisa_tsumitate_limit - profile.nisa_tsumitate_used - tsumitateScheduled)

  const growthMonthlyTarget = Math.ceil(growthRemaining / monthsLeft)
  const tsumitateMonthlyTarget = tsumitateMonthly // 設定額そのもの

  return {
    growthRemaining,
    tsumitateRemaining,
    tsumitateScheduled,
    growthMonthsLeft: monthsLeft,
    tsumitateMonthsLeft: monthsLeft,
    growthMonthlyTarget,
    tsumitateMonthlyTarget,
  }
}
