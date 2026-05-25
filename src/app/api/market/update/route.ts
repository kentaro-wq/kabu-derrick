/**
 * 株価日次自動更新エンドポイント（株探スクレイピング・無料）
 * Vercel Cron: 平日15:40 JST（06:40 UTC）に自動実行
 * 手動: POST /api/market/update
 */
import { NextResponse } from 'next/server'
import { fetchStockInfo } from '@/lib/kabutan'
import { adminSupabase } from '@/lib/supabase'
import { recalcNisaUsed } from '@/lib/nisa-sync'

export const maxDuration = 60

async function updateAllHoldingPrices(): Promise<{ updated: number; skipped: number; details: string[] }> {
  const { data: holdings, error } = await adminSupabase
    .from('holdings')
    .select('id, ticker, name, quantity, purchase_price')

  if (error || !holdings) return { updated: 0, skipped: 0, details: ['holdings取得失敗'] }

  // 個別株（4桁コード）のみ対象。投資信託はスキップ
  const targets = holdings.filter((h: { ticker: string }) => /^\d{4}$/.test(h.ticker))

  let updated = 0
  let skipped = 0
  const details: string[] = []

  // 株探への負荷を考慮して順次取得（並列だとブロックされる可能性）
  for (const h of targets) {
    const info = await fetchStockInfo(h.ticker)
    if (!info?.price) {
      skipped++
      details.push(`${h.name}(${h.ticker}): 株価取得失敗`)
      continue
    }

    const qty = Number(h.quantity)
    const purchasePrice = Number(h.purchase_price)
    const evaluation = Math.round(info.price * qty)
    const costBasis = Math.round(purchasePrice * qty)
    const unrealizedGain = evaluation - costBasis
    const unrealizedGainPct = costBasis > 0
      ? Math.round((unrealizedGain / costBasis) * 1000) / 10
      : null

    const { error: upErr } = await adminSupabase
      .from('holdings')
      .update({
        current_price: info.price,
        evaluation_amount: evaluation,
        unrealized_gain: unrealizedGain,
        unrealized_gain_pct: unrealizedGainPct,
        updated_at: new Date().toISOString(),
      })
      .eq('id', h.id)

    if (!upErr) {
      updated++
      details.push(`${h.name}: ${info.price.toLocaleString()}円 (${unrealizedGainPct != null ? (unrealizedGainPct >= 0 ? '+' : '') + unrealizedGainPct + '%' : '—'})`)
    } else {
      skipped++
      details.push(`${h.name}: DB更新失敗`)
    }

    // 株探への過剰アクセスを防ぐため500ms待機
    await new Promise(r => setTimeout(r, 500))
  }

  if (updated > 0) {
    await recalcNisaUsed().catch(console.error)
  }

  // 株価更新後、AI出口判定も自動実行（Hobby plan cron制約への対応：相乗り）
  // fire-and-forget（await しない）でタイムアウト連鎖を防止
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://kabu-derrick.vercel.app'
  fetch(`${baseUrl}/api/exit-judgment`, {
    method: 'POST',
    signal: AbortSignal.timeout(5000),  // 自身のtimeoutは短く（応答待ちで縛られない）
  }).catch(e => console.error('[market/update] exit-judgment trigger failed:', e))
  details.push('AI出口判定を非同期トリガー')

  return { updated, skipped, details }
}

export async function POST() {
  const result = await updateAllHoldingPrices()
  return NextResponse.json({
    ok: result.updated > 0,
    ...result,
    timestamp: new Date().toISOString(),
  })
}

// Vercel Cron からの GET 呼び出しにも対応
export async function GET() {
  return POST()
}
