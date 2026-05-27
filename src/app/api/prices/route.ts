import { NextResponse } from 'next/server'
import { adminSupabase } from '@/lib/supabase'
import { fetchPrice } from '@/lib/stock-price'
import { sendLineMessage } from '@/lib/line'

// データ整合性: 前回 current_price と新規取得値の乖離が ±この%を超えたら警告
// 営業日の通常変動は ±10% 程度に収まる（ストップ高/安は ±20% 前後）
// ストップ高/安級の乖離 = 異常 or 株式分割未反映 の可能性が高い
const PRICE_DIVERGENCE_THRESHOLD_PCT = 15

// 全保有銘柄の株価を取得してDBを更新し、ルールチェックを実行
export async function POST() {
  const { data: holdings, error } = await adminSupabase
    .from('holdings')
    .select('id, ticker, name, quantity, purchase_price, current_price, evaluation_amount, unrealized_gain, unrealized_gain_pct, updated_at')

  if (error || !holdings || holdings.length === 0) {
    return NextResponse.json({ error: '保有銘柄なし', updated: 0 })
  }

  const divergenceAlerts: string[] = []

  const results = await Promise.all(
    holdings.map(async h => {
      const price = await fetchPrice(h.ticker)
      if (price == null) return { ticker: h.ticker, name: h.name, price: null, updated: false, divergencePct: null as number | null }

      // === データ整合性チェック ===
      // 前回 current_price との乖離率を計算（前回値が有意な場合のみ）
      let divergencePct: number | null = null
      if (h.current_price != null && h.current_price > 0) {
        divergencePct = ((price - h.current_price) / h.current_price) * 100
        const absDiv = Math.abs(divergencePct)
        if (absDiv >= PRICE_DIVERGENCE_THRESHOLD_PCT) {
          // 前回更新から十分時間が経っている場合は除外（休場明けは大きく動くことがある）
          const hoursSinceUpdate = h.updated_at
            ? (Date.now() - new Date(h.updated_at).getTime()) / 3600000
            : 999
          // 24時間以内の更新 vs 新規取得で15%超の乖離 = 真に異常
          if (hoursSinceUpdate < 24) {
            divergenceAlerts.push(
              `${h.name}(${h.ticker}): 前回${h.current_price.toLocaleString()}円 → 取得${price.toLocaleString()}円 (${divergencePct >= 0 ? '+' : ''}${divergencePct.toFixed(1)}%)`
            )
          }
        }
      }

      if (h.quantity == null) {
        await adminSupabase
          .from('holdings')
          .update({ current_price: price, updated_at: new Date().toISOString() })
          .eq('id', h.id)
      } else {
        const purchasePrice = h.purchase_price ?? 0
        const evaluationAmount = price * h.quantity
        const unrealizedGain = purchasePrice > 0 ? evaluationAmount - purchasePrice * h.quantity : null
        const unrealizedGainPct = purchasePrice > 0 ? ((price - purchasePrice) / purchasePrice) * 100 : null
        await adminSupabase
          .from('holdings')
          .update({
            current_price: price,
            evaluation_amount: evaluationAmount,
            unrealized_gain: unrealizedGain,
            unrealized_gain_pct: unrealizedGainPct,
            updated_at: new Date().toISOString(),
          })
          .eq('id', h.id)
      }

      return { ticker: h.ticker, name: h.name, price, updated: true, divergencePct }
    })
  )

  // 整合性警告がある場合は LINE 通知
  // 目的: 株式分割の見落とし・データソース異常・単元数誤入力の早期検知
  if (divergenceAlerts.length > 0) {
    const msg = [
      '⚠️ マイ株デリック データ整合性警告',
      `前回保存値と新規取得値に ±${PRICE_DIVERGENCE_THRESHOLD_PCT}% 超の乖離`,
      '',
      ...divergenceAlerts,
      '',
      '考えられる原因:',
      '・株式分割/併合の未反映 → holdings の quantity 確認',
      '・データソース異常 → 翌朝再取得で解消するか確認',
      '・単元数の入力ミス → 証券会社画面と照合',
    ].join('\n')
    await sendLineMessage(msg).catch(() => { /* 通知失敗は無視 */ })
  }

  const updated = results.filter(r => r.updated).length
  const failed = results.filter(r => !r.updated).map(r => r.ticker)

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://kabu-derrick.vercel.app'
  const [checkRes, marketRes] = await Promise.all([
    fetch(`${baseUrl}/api/holding-rules/check`, { method: 'POST' }),
    fetch(`${baseUrl}/api/market/check`, { method: 'POST' }),
  ])
  const [checkData, marketData] = await Promise.all([
    checkRes.json().catch(() => ({})),
    marketRes.json().catch(() => ({})),
  ])

  return NextResponse.json({
    updated,
    failed,
    divergenceAlerts,
    results: results.map(r => ({ ticker: r.ticker, name: r.name, price: r.price, divergencePct: r.divergencePct })),
    ruleCheck: checkData,
    marketCheck: marketData,
  })
}
