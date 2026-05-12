import { NextResponse } from 'next/server'

export const maxDuration = 60
import { geminiGenerate } from '@/lib/gemini'
import { adminSupabase } from '@/lib/supabase'
import { getNisaStatus } from '@/lib/nisa'
import { fetchMarketStats } from '@/lib/kabutan'

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

  const profile = profileRes.data
  if (!profile) {
    return NextResponse.json({ error: 'プロフィールが未設定です。' }, { status: 400 })
  }

  const holdings = holdingsRes.data ?? []
  const orders = ordersRes.data ?? []
  const tsumitate = tsumitateRes.data ?? []
  const policy = policyRes.data?.content ?? ''
  const rules = rulesRes.data ?? []
  const nisaStatus = getNisaStatus(profile)
  const totalAsset = holdings.reduce((sum, h) => sum + (h.evaluation_amount ?? 0), 0)

  let ctx = `【NISA残枠】成長枠:${toMan(nisaStatus.growthRemaining)}(残${nisaStatus.growthMonthsLeft}ヶ月,月${toMan(nisaStatus.growthMonthlyTarget)}) つみたて:${toMan(nisaStatus.tsumitateRemaining)}(残${nisaStatus.tsumitateMonthsLeft}ヶ月,月${toMan(nisaStatus.tsumitateMonthlyTarget)})\n`
  ctx += `【資産】総評価額:${toMan(totalAsset)} 積立:${toMan(tsumitate.reduce((s, t) => s + (t.monthly_amount ?? 0), 0))}/月\n`

  if (policy) ctx += `【投資方針】${policy.slice(0, 300)}\n`

  ctx += `【保有銘柄】\n`
  holdings.forEach(h => {
    const gain = h.unrealized_gain != null ? `損益${h.unrealized_gain >= 0 ? '+' : ''}${toMan(h.unrealized_gain)}` : ''
    ctx += `・${h.name}(${formatAccountType(h.account_type)}) 評価${toMan(h.evaluation_amount ?? 0)} ${gain}\n`
  })

  if (orders.length > 0) {
    ctx += `【注文中】${orders.map(o => `${o.name}${o.order_type === 'sell' ? '売' : '買'}${o.price}円×${o.quantity}株 期限${o.deadline}`).join(' / ')}\n`
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

  const prompt = `あなたはNISA優先・機械的ルール遵守の投資アドバイザーです。以下の状況を深く分析し、具体的で実践的な戦略をJSONで返してください。

${ctx}
【重要前提】
- NISA成長枠は長期優良株を置く枠（非課税メリット最大化）
- 特定口座は試し買い・高回転・NISA枠超過分の受け皿
- ユーザーは個別株初心者。感情を排し機械的ルールで動く方針

以下のJSON形式のみで返答:
{"headline":"戦略の核心を一言で","nisaStrategy":"NISA枠の具体的な使い方（残枠・期間・優先順位）","tokuteiStrategy":"NISA使い切り後の特定口座の補完方針","nextActions":["今すぐやること1","今すぐやること2","今すぐやること3","今すぐやること4","今すぐやること5"],"riskNotes":"現在のポートフォリオの主なリスクと注意点"}`

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
        nisa_strategy: proposal.nisaStrategy ?? null,
        tokutei_strategy: proposal.tokuteiStrategy ?? null,
        next_actions: proposal.nextActions ?? [],
        risk_notes: proposal.riskNotes ?? null,
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
