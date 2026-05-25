/**
 * 銘柄セグメント分類 + セグメント別最適戦略
 *
 * バックテスト分析の結果（fired 447件 ベース）から、
 * セグメントごとに最適な出口戦略が異なることが判明。
 * このモジュールはセグメント判定とその戦略推奨を担う。
 */
import type { OHLCVBar } from '@/lib/technicals'

export type PriceTier = 'low' | 'mid' | 'high'
export type VolTier = 'low' | 'mid' | 'high'

export interface Segment {
  priceTier: PriceTier
  volTier: VolTier
  label: string
  recommendedStrategy: ExitStrategy
  expectedAvgReturn: number  // バックテスト実測値
  expectedWinRate: number    // バックテスト実測値
  rationale: string
}

export type ExitStrategy =
  | 'fixed_20d'           // 固定20日保有 (中位×低ボラ)
  | 'adaptive_ai_exit'    // -8%損切 + 含み益5%超でAI毎日判定（「上がる勢いを伸ばす」哲学）
  | 'trailing_10'         // トレーリング-10% (高位)
  | 'consecutive_down'    // 連続陰線で売り (低位×低ボラ)
  | 'unknown'             // 未分類セグメント → 安全側 fixed_20d

const SEGMENT_TABLE: Record<string, Omit<Segment, 'priceTier' | 'volTier'>> = {
  'low_low':   { label: '低位×低ボラ', recommendedStrategy: 'consecutive_down',   expectedAvgReturn: 5.8, expectedWinRate: 75.5, rationale: '低位低ボラ群はじわじわ上昇する傾向。+5%超えた後の3日連続陰線で売却が最強(F戦略)' },
  'mid_low':   { label: '中位×低ボラ', recommendedStrategy: 'fixed_20d',          expectedAvgReturn: 3.7, expectedWinRate: 65.5, rationale: '中位低ボラ群はゆっくり動く。固定20日保有が最も安定。連続陰線は罠で大損率23%' },
  'mid_mid':   { label: '中位×中ボラ🔥', recommendedStrategy: 'adaptive_ai_exit', expectedAvgReturn: 17.2, expectedWinRate: 89.5, rationale: '【黄金セグメント】-8%損切+AI継続判定。「損は早く、利益は伸ばす」を実装。大勝チャンス(+30%超)を逃さない' },
  'high_low':  { label: '高位×低ボラ', recommendedStrategy: 'trailing_10',        expectedAvgReturn: 7.2, expectedWinRate: 75.7, rationale: '高位低ボラ群は機関がゆっくり押し上げる。トレーリング-10%でトレンドに乗る' },
  'high_mid':  { label: '高位×中ボラ', recommendedStrategy: 'trailing_10',        expectedAvgReturn: 10.0, expectedWinRate: 100.0, rationale: '高位中ボラ群も同様にトレーリング有効。サンプル数少 (n=11) なので参考値' },
  // 高ボラ系と未検証セグメントは fixed_20d (安全側) に倒す
  'low_mid':   { label: '低位×中ボラ', recommendedStrategy: 'fixed_20d',          expectedAvgReturn: 0, expectedWinRate: 0, rationale: 'バックテスト未検証セグメント。安全側で固定20日保有' },
  'low_high':  { label: '低位×高ボラ', recommendedStrategy: 'fixed_20d',          expectedAvgReturn: 0, expectedWinRate: 0, rationale: 'バックテスト未検証。安全側で固定20日。ユニバース拡張で要追加' },
  'mid_high':  { label: '中位×高ボラ', recommendedStrategy: 'fixed_20d',          expectedAvgReturn: 0, expectedWinRate: 0, rationale: 'バックテスト未検証。安全側で固定20日' },
  'high_high': { label: '高位×高ボラ', recommendedStrategy: 'fixed_20d',          expectedAvgReturn: 0, expectedWinRate: 0, rationale: 'バックテスト未検証。安全側で固定20日' },
}

/** 価格帯分類 */
export function classifyPriceTier(price: number): PriceTier {
  if (price < 1000) return 'low'
  if (price < 3000) return 'mid'
  return 'high'
}

/** ボラティリティ分類（過去N日の日次標準偏差%） */
export function classifyVolTier(vol: number): VolTier {
  if (vol < 2) return 'low'
  if (vol < 4) return 'mid'
  return 'high'
}

/** 過去bars からボラティリティを計算（日次リターン標準偏差 %） */
export function calcVolatility(pastBars: OHLCVBar[]): number {
  if (pastBars.length < 2) return 0
  const returns: number[] = []
  for (let i = 1; i < pastBars.length; i++) {
    returns.push((pastBars[i].close - pastBars[i - 1].close) / pastBars[i - 1].close)
  }
  const mean = returns.reduce((s, v) => s + v, 0) / returns.length
  const variance = returns.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / returns.length
  return Math.sqrt(variance) * 100
}

/** セグメント判定 */
export function classifySegment(price: number, vol: number): Segment {
  const priceTier = classifyPriceTier(price)
  const volTier = classifyVolTier(vol)
  const key = `${priceTier}_${volTier}`
  const meta = SEGMENT_TABLE[key]
  return {
    priceTier,
    volTier,
    label: meta.label,
    recommendedStrategy: meta.recommendedStrategy,
    expectedAvgReturn: meta.expectedAvgReturn,
    expectedWinRate: meta.expectedWinRate,
    rationale: meta.rationale,
  }
}

/** 戦略名の人間可読ラベル */
export function strategyLabel(s: ExitStrategy): string {
  switch (s) {
    case 'fixed_20d': return '固定20日保有'
    case 'adaptive_ai_exit': return '損切-8% + AI継続判定（伸ばし型）'
    case 'trailing_10': return 'トレーリングストップ-10%'
    case 'consecutive_down': return '利益+5%後の3日連続陰線で売り'
    case 'unknown': return '不明'
  }
}

/**
 * 戦略の現状トリガー判定
 * @returns 売却すべきかどうかと理由
 */
export interface StrategyTrigger {
  shouldExit: boolean
  reason: string
  triggerType?: 'take_profit' | 'cut_loss' | 'trailing_stop' | 'time_up' | 'pattern'
}

export function checkStrategyTrigger(
  strategy: ExitStrategy,
  entry: number,
  current: number,
  daysHeld: number,
  recentBars: OHLCVBar[],  // 直近30日程度
  peakSinceEntry: number,
): StrategyTrigger {
  const gainPct = (current - entry) / entry * 100

  switch (strategy) {
    case 'fixed_20d':
      // 最終防衛線: -15% で機械強制
      if (gainPct <= -15) {
        return { shouldExit: true, reason: `🚨 -15%最終防衛線 (実${gainPct.toFixed(1)}%) 機械強制`, triggerType: 'cut_loss' }
      }
      // 第一防衛線: -8% で AI に深く問う（NISA文脈考慮）
      if (gainPct <= -8) {
        return { shouldExit: true, reason: `-8%損切第一線 (実${gainPct.toFixed(1)}%) AI判断`, triggerType: 'pattern' }
      }
      if (daysHeld >= 20) {
        return { shouldExit: true, reason: `固定20日保有完了 (含み益${gainPct.toFixed(1)}%)`, triggerType: 'time_up' }
      }
      return { shouldExit: false, reason: `保有${daysHeld}/20日` }

    case 'adaptive_ai_exit':
      // 最終防衛線: -15% で機械強制
      if (gainPct <= -15) {
        return { shouldExit: true, reason: `🚨 -15%最終防衛線 (実${gainPct.toFixed(1)}%) 機械強制`, triggerType: 'cut_loss' }
      }
      // 第一防衛線: -8% で AI に NISA文脈含め深く問う
      if (gainPct <= -8) {
        return { shouldExit: true, reason: `-8%損切第一線 (実${gainPct.toFixed(1)}%) AI判断`, triggerType: 'pattern' }
      }
      // 利確: 含み益+5%超なら毎日AIに「伸ばす？確定？」を聞く
      if (gainPct >= 5) {
        return { shouldExit: true, reason: `+${gainPct.toFixed(1)}%含み益、AIで継続判定`, triggerType: 'pattern' }
      }
      // それ未満は保有継続
      return { shouldExit: false, reason: `保有中 (${gainPct.toFixed(1)}%、-8%でAI判断/-15%強制/+5%超でAI判定)` }

    case 'trailing_10':
      if (gainPct <= -15) {
        return { shouldExit: true, reason: `🚨 -15%最終防衛線 (実${gainPct.toFixed(1)}%) 機械強制`, triggerType: 'cut_loss' }
      }
      if (gainPct <= -8) {
        return { shouldExit: true, reason: `-8%損切第一線 (実${gainPct.toFixed(1)}%) AI判断`, triggerType: 'pattern' }
      }
      const dropFromPeak = (current - peakSinceEntry) / peakSinceEntry * 100
      if (dropFromPeak <= -10) {
        return { shouldExit: true, reason: `高値${peakSinceEntry}から-10%下落`, triggerType: 'trailing_stop' }
      }
      return { shouldExit: false, reason: `高値${peakSinceEntry}から${dropFromPeak.toFixed(1)}%` }

    case 'consecutive_down':
      if (gainPct <= -15) {
        return { shouldExit: true, reason: `🚨 -15%最終防衛線 (実${gainPct.toFixed(1)}%) 機械強制`, triggerType: 'cut_loss' }
      }
      if (gainPct <= -8) {
        return { shouldExit: true, reason: `-8%損切第一線 (実${gainPct.toFixed(1)}%) AI判断`, triggerType: 'pattern' }
      }
      if (gainPct < 5) {
        return { shouldExit: false, reason: `+5%未達 (現${gainPct.toFixed(1)}%)、まだ売らない` }
      }
      // 直近3日連続陰線判定
      if (recentBars.length < 3) return { shouldExit: false, reason: 'データ不足' }
      const last3 = recentBars.slice(-3)
      const allDown = last3.every(b => b.close < b.open)
      if (allDown) {
        return { shouldExit: true, reason: `+5%達成済み + 3日連続陰線で売却`, triggerType: 'pattern' }
      }
      return { shouldExit: false, reason: `+5%達成済み、連続陰線監視中` }

    case 'unknown':
      return { shouldExit: false, reason: '未分類セグメント、判定不可' }
  }
}
