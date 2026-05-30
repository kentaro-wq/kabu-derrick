/**
 * 出口判定の「正解基準」と「評価ホライズン」の一元管理
 *
 * 目的: evaluate (自己評価ジョブ) と reflect (自己改善ループ) が
 * 同じ正解基準を参照するようにし、片方だけ変えて評価と学習がズレる
 * ドリフト事故を防ぐ。
 *
 * 設計方針:
 *  - 戦略ごとに「決定の妥当性を測るべき時間軸」が異なる。
 *    固定20日保有は20営業日後で評価しないと、途中の一時下落で
 *    誤って「不正解」とラベルされ、自己改善ループに誤った lesson が入る。
 *  - ホライズンは全て「営業日(bar)」ベース。暦日との混在を排除する。
 */
import type { ExitStrategy } from '@/lib/segment'

/** 戦略別の評価ホライズン (営業日 = bars のインデックス差) */
export const EVAL_HORIZON_TRADING_DAYS: Record<ExitStrategy, number> = {
  fixed_20d: 20,         // 計画上の出口が20日 → 20営業日後で評価
  consecutive_down: 20,  // +5%到達まで時間がかかる傾向 → 20営業日後
  adaptive_ai_exit: 14,  // モメンタム伸ばし型 → 2〜3週間
  trailing_10: 14,       // トレーリング → 2〜3週間
  unknown: 14,
}

/** strategy 文字列(列値)からホライズン営業日数を返す。未知/null は 14。 */
export function evalHorizonDays(strategy: string | null | undefined): number {
  if (strategy && strategy in EVAL_HORIZON_TRADING_DAYS) {
    return EVAL_HORIZON_TRADING_DAYS[strategy as ExitStrategy]
  }
  return 14
}

/**
 * 判定が「結果的に正しかったか」を評価。
 * futurePrice はホライズン営業日後の終値。
 *
 * 正解基準:
 *  - hold: ホライズン後の価格が -3% より下がっていなければ正解 (下落を回避できた)
 *  - cut_loss: ホライズン後に +5% 超上がっていなければ正解 (損切が機会損失でない)
 *  - take_profit: ホライズン後に +10% 超上がっていなければ正解 (利確が早すぎない)
 */
export function evaluateDecision(
  decision: string,
  judgmentPrice: number,
  futurePrice: number,
): boolean {
  const pctChange = ((futurePrice - judgmentPrice) / judgmentPrice) * 100
  if (decision === 'hold') return pctChange >= -3
  if (decision === 'cut_loss') return pctChange < 5
  if (decision === 'take_profit') return pctChange < 10
  return true
}

/** reflect プロンプトに埋め込む正解基準テキスト (evaluateDecision と必ず一致させる) */
export const EVAL_CRITERIA_TEXT = `- hold: ホライズン営業日後の価格が -3% より下がっていなければ正解
- cut_loss: ホライズン営業日後の価格が +5% より上がっていなければ正解 (機会損失でない)
- take_profit: ホライズン営業日後の価格が +10% より上がっていなければ正解 (早すぎない)
※ホライズンは戦略別: 固定20日保有/連続陰線=20営業日, トレーリング/AI伸ばし型=14営業日`
