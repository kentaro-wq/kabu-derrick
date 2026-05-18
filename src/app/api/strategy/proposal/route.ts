import { NextResponse } from 'next/server'

export const maxDuration = 60
import { geminiGenerate } from '@/lib/gemini'
import { adminSupabase } from '@/lib/supabase'
import { getNisaStatus } from '@/lib/nisa'
import { fetchMarketStats } from '@/lib/kabutan'

function toMan(yen: number) { return `${Math.round(yen / 10000)}万円` }

function formatAccountType(type: string) {
  if (type === 'nisa_growth') return 'NISA成長'
  if (type === 'nisa_tsumitate') return 'つみたてNISA'
  if (type === 'old_tsumitate') return '旧つみたてNISA'
  if (type === 'tokutei') return '特定口座'
  if (type === 'mochikabu') return '持株会'
  if (type === 'dc') return 'DC'
  return 'その他'
}

export async function POST() {
  const [holdingsRes, ordersRes, tsumitateRes, policyRes, rulesRes, profileRes, marketStats] = await Promise.all([
    adminSupabase.from('holdings').select('*'),
    adminSupabase.from('orders').select('*').eq('status', 'active'),
    adminSupabase.from('tsumitate_settings').select('*'),
    adminSupabase.from('investment_policy').select('content').order('updated_at', { ascending: false }).limit(1).single(),
    adminSupabase.from('holding_rules').select('ticker,name,purpose,sell_conditions').eq('is_active', true),
    adminSupabase.from('profile').select('*').single(),
    fetchMarketStats().catch(() => null),
  ])

  const profile = profileRes.data
  if (!profile) return NextResponse.json({ error: 'プロフィールが未設定です。' }, { status: 400 })

  const holdings = holdingsRes.data ?? []
  const orders = ordersRes.data ?? []
  const tsumitate = tsumitateRes.data ?? []
  const policy = policyRes.data?.content ?? ''
  const rules = rulesRes.data ?? []
  const tsumitateMonthly = tsumitate.reduce((s: number, t: { monthly_amount: number }) => s + (t.monthly_amount ?? 0), 0)
  const nisaStatus = getNisaStatus(profile, tsumitateMonthly)
  const totalAsset = holdings.reduce((sum, h) => sum + (h.evaluation_amount ?? 0), 0)

  let ctx = `総資産${toMan(totalAsset)} NISA成長枠残${toMan(nisaStatus.growthRemaining)}(残${nisaStatus.growthMonthsLeft}ヶ月) つみたて残${toMan(nisaStatus.tsumitateRemaining)}\n`
  if (policy) ctx += `方針: ${policy.slice(0, 200)}\n`
  if (marketStats?.marketSentiment) ctx += `市場: ${marketStats.marketSentiment}\n`

  ctx += `保有: `
  ctx += holdings.map((h: { name: string; account_type: string; unrealized_gain_pct: number | null }) => {
    const pct = h.unrealized_gain_pct != null ? `(${h.unrealized_gain_pct >= 0 ? '+' : ''}${h.unrealized_gain_pct.toFixed(1)}%)` : ''
    return `${h.name}[${formatAccountType(h.account_type)}]${pct}`
  }).join(' / ')
  ctx += '\n'

  if (rules.length > 0) {
    ctx += `ルール: `
    ctx += rules.map(r => `${r.name}→売却条件=${r.sell_conditions?.slice(0, 40) ?? 'なし'}`).join(' / ')
    ctx += '\n'
  }

  if (orders.length > 0) {
    ctx += `注文中: `
    ctx += orders.map((o: { name: string; order_type: string; price: number }) =>
      `${o.name}${o.order_type === 'buy' ? '買' : '売'}${o.price.toLocaleString()}円`
    ).join(' / ')
    ctx += '\n'
  }

  const prompt = `以下は個人投資家の現在の運用状況です。
${ctx}
この状況を踏まえ、今の運用状態について2〜3文で簡潔にコメントしてください。
また、今最も注目すべき点を15字以内で表してください。

JSON形式のみで返答:
{"comment":"2〜3文のコメント","focusPoint":"注目ポイント（15字以内）"}`

  const text = await geminiGenerate({
    model: 'gemini-2.5-flash',
    system: 'あなたは日本の個人投資家向けアドバイザーです。簡潔で実践的なコメントをJSON形式のみで返してください。',
    maxTokens: 400,
    timeoutMs: 12000,
    disableThinking: true,
    messages: [{ role: 'user', parts: [{ text: prompt }] }],
  })

  try {
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) throw new Error('no json')
    const proposal = JSON.parse(match[0])

    await adminSupabase.from('strategy_proposals').insert({
      headline: proposal.focusPoint ?? null,
      nisa_strategy: null,
      tokutei_strategy: null,
      next_actions: [],
      risk_notes: null,
      raw_response: JSON.stringify(proposal),
      created_at: new Date().toISOString(),
    })

    return NextResponse.json({ proposal })
  } catch {
    return NextResponse.json({ error: 'コメント生成に失敗しました。', raw: text }, { status: 500 })
  }
}
