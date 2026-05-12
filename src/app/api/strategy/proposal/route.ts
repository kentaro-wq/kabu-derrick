import { NextResponse } from 'next/server'

export const maxDuration = 60
import { geminiGenerate } from '@/lib/gemini'
import { adminSupabase } from '@/lib/supabase'
import { getNisaStatus } from '@/lib/nisa'
import { fetchMarketStats, fetchMultipleStockInfo } from '@/lib/kabutan'

function toMan(yen: number) {
  return `${Math.round(yen / 10000)}万円`
}

function formatAccountType(type: string) {
  if (type === 'nisa_growth') return 'NISA成長'
  if (type === 'nisa_tsumitate') return 'つみたてNISA'
  if (type === 'old_tsumitate') return '旧つみたてNISA'
  if (type === 'tokutei') return '特定口座'
  if (type === 'dc') return 'DC'
  return 'その他'
}

export async function POST() {
  const [holdingsRes, ordersRes, tsumitateRes, policyRes, rulesRes, profileRes, marketStats] = await Promise.all([
    adminSupabase.from('holdings').select('*'),
    adminSupabase.from('orders').select('*').eq('status', 'active'),
    adminSupabase.from('tsumitate_settings').select('*'),
    adminSupabase.from('investment_policy').select('content').order('updated_at', { ascending: false }).limit(1).single(),
    adminSupabase.from('holding_rules').select('ticker,name,purpose,sell_conditions,timeline_notes').eq('is_active', true),
    adminSupabase.from('profile').select('*').single(),
    fetchMarketStats().catch(() => null),
  ])

  // 個別株の株探データを並列取得
  const holdings = holdingsRes.data ?? []
  const orders = ordersRes.data ?? []
  const allTickers = [
    ...holdings.map((h: { ticker: string }) => h.ticker),
    ...orders.filter((o: { order_type: string; status: string }) => o.order_type === 'buy' && o.status === 'active')
      .map((o: { ticker: string }) => o.ticker),
  ]
  const stockInfoMap: Record<string, import('@/lib/kabutan').StockInfo> = await fetchMultipleStockInfo(allTickers).catch(() => ({}))

  const profile = profileRes.data
  if (!profile) {
    return NextResponse.json({ error: 'プロフィールが未設定です。' }, { status: 400 })
  }

  const tsumitate = tsumitateRes.data ?? []
  const policy = policyRes.data?.content ?? ''
  const rules = rulesRes.data ?? []
  const tsumitateMonthly = tsumitate.reduce((s: number, t: { monthly_amount: number }) => s + (t.monthly_amount ?? 0), 0)
  const nisaStatus = getNisaStatus(profile, tsumitateMonthly)
  const totalAsset = holdings.reduce((sum, h) => sum + (h.evaluation_amount ?? 0), 0)

  let ctx = `【NISA残枠】成長枠:${toMan(nisaStatus.growthRemaining)}(残${nisaStatus.growthMonthsLeft}ヶ月,月${toMan(nisaStatus.growthMonthlyTarget)}) つみたて:${toMan(nisaStatus.tsumitateRemaining)}(残${nisaStatus.tsumitateMonthsLeft}ヶ月,月${toMan(nisaStatus.tsumitateMonthlyTarget)})\n`
  ctx += `【資産】総評価額:${toMan(totalAsset)} 積立:${toMan(tsumitate.reduce((s, t) => s + (t.monthly_amount ?? 0), 0))}/月\n`

  if (policy) ctx += `【投資方針】${policy.slice(0, 300)}\n`

  ctx += `【保有銘柄】\n`
  holdings.forEach((h: { name: string; ticker: string; account_type: string; evaluation_amount: number | null; unrealized_gain: number | null }) => {
    const gain = h.unrealized_gain != null ? `損益${h.unrealized_gain >= 0 ? '+' : ''}${toMan(h.unrealized_gain)}` : ''
    const si = stockInfoMap[h.ticker]
    let siStr = ''
    if (si) {
      const parts: string[] = []
      if (si.price) parts.push(`株価${si.price.toLocaleString()}円`)
      if (si.changePct != null) parts.push(`(${si.changePct >= 0 ? '+' : ''}${si.changePct}%)`)
      if (si.per != null) parts.push(`PER${si.per}`)
      if (si.pbr != null) parts.push(`PBR${si.pbr}`)
      if (si.dividendYield != null) parts.push(`配当${si.dividendYield}%`)
      if (si.revenueGrowthPct != null) parts.push(`売上前期比${si.revenueGrowthPct >= 0 ? '+' : ''}${si.revenueGrowthPct}%`)
      if (si.profitGrowthPct != null) parts.push(`経常益前期比${si.profitGrowthPct >= 0 ? '+' : ''}${si.profitGrowthPct}%`)
      if (si.dps != null) parts.push(`1株配当${si.dps}円予想`)
      if (parts.length > 0) siStr = `  [${parts.join(' ')}]`
    }
    ctx += `・${h.name}(${formatAccountType(h.account_type)}) 評価${toMan(h.evaluation_amount ?? 0)} ${gain}${siStr}\n`
  })

  if (orders.length > 0) {
    ctx += `【注文中】\n`
    orders.forEach((o: { name: string; ticker: string; order_type: string; price: number; quantity: number; deadline: string }) => {
      const si = stockInfoMap[o.ticker]
      let siStr = ''
      if (si) {
        const parts: string[] = []
        if (si.price) parts.push(`現在値${si.price.toLocaleString()}円`)
        if (si.per != null) parts.push(`PER${si.per}`)
        if (si.dividendYield != null) parts.push(`配当${si.dividendYield}%`)
        if (parts.length > 0) siStr = `  [${parts.join(' ')}]`
      }
      ctx += `・${o.name}${o.order_type === 'sell' ? '売' : '買'}${o.price}円×${o.quantity}株 期限${o.deadline}${siStr}\n`
    })
  }

  if (tsumitate.length > 0) {
    ctx += `【積立設定】${tsumitate.map((t: { name: string; monthly_amount: number; account_type: string }) => `${t.name}(${formatAccountType(t.account_type)})月${t.monthly_amount.toLocaleString()}円`).join(' / ')}\n`
  }

  if (rules.length > 0) {
    ctx += `【銘柄ルール】\n`
    rules.forEach(r => {
      ctx += `・${r.name}: 目的=${r.purpose ?? 'なし'} 売却条件=${r.sell_conditions ?? 'なし'} 期限=${r.timeline_notes ?? 'なし'}\n`
    })
  }

  if (marketStats?.marketSentiment) {
    ctx += `【市場】${marketStats.marketSentiment}\n`
  }

  const prompt = `NISA優先・機械的ルール遵守の投資アドバイザーとして以下の状況を分析し、JSONで返してください。

${ctx}
【前提】
- NISA成長枠=長期優良株（非課税メリット最大化）、特定口座=試し買い・NISA枠超過分
- ユーザーは個別株初心者。感情を排し機械的ルールで動く方針

【出力ルール】
- headline: 15字以内の核心フレーズ
- nisaPoints: NISA戦略の要点を箇条書き3〜4件（各30字以内）
- tokuteiPoints: 特定口座の方針を箇条書き2〜3件（各30字以内）
- nextActions: 今週中にやること5件（各40字以内・動詞で始める具体的な行動）
- riskPoints: 現状のリスク・注意点を箇条書き2〜3件（各30字以内）
- urgency: "high"|"medium"|"low"（今すぐ動く必要があるか）

JSON形式のみで返答:
{"headline":"","nisaPoints":["","",""],"tokuteiPoints":["",""],"nextActions":["","","","",""],"riskPoints":["",""],"urgency":"medium"}`

  const text = await geminiGenerate({
    model: 'gemini-2.5-flash',
    system: 'あなたは日本の個人投資家向けアドバイザーです。保有銘柄・ルール・NISA残枠を踏まえた具体的で実践的な提案をJSON形式のみで返してください。',
    maxTokens: 2000,
    timeoutMs: 15000,
    disableThinking: true,
    messages: [{ role: 'user', parts: [{ text: prompt }] }],
  })

  try {
    const proposal = JSON.parse(text)

    try {
      const { error: insertError } = await adminSupabase.from('strategy_proposals').insert({
        headline: proposal.headline ?? null,
        nisa_strategy: Array.isArray(proposal.nisaPoints) ? proposal.nisaPoints.join('\n') : (proposal.nisaStrategy ?? null),
        tokutei_strategy: Array.isArray(proposal.tokuteiPoints) ? proposal.tokuteiPoints.join('\n') : (proposal.tokuteiStrategy ?? null),
        next_actions: proposal.nextActions ?? [],
        risk_notes: Array.isArray(proposal.riskPoints) ? proposal.riskPoints.join('\n') : (proposal.riskNotes ?? null),
        raw_response: text,
        created_at: new Date().toISOString(),
      })
      if (insertError) {
        console.error('[strategy/proposal] failed to save proposal', insertError)
      }
    } catch (saveErr) {
      console.error('[strategy/proposal] insert error', saveErr)
    }

    return NextResponse.json({ proposal })
  } catch {
    return NextResponse.json({ error: 'JSON解析に失敗しました。', raw: text }, { status: 500 })
  }
}
