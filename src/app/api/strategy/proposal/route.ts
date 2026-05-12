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
    adminSupabase.from('holding_rules').select('ticker,name,purpose,policy_basis,sell_conditions,dividend_notes,timeline_notes,raw_agreement').eq('is_active', true),
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
  const nisaHoldings = holdings.filter(h => ['nisa_growth', 'nisa_tsumitate', 'old_tsumitate'].includes(h.account_type))
  const tokuteiHoldings = holdings.filter(h => h.account_type === 'tokutei')

  let context = `あなたは、NISA枠を最優先して使い切り、その後特定口座で戦略的に補完することを目指す投資アドバイザーです。ユーザーは個別株初心者で、感情を排して機械的なルールに従う方針です。現在の状況に基づき、最も効果的な戦略を提案してください。\n\n`
  context += `・NISA保有銘柄数: ${nisaHoldings.length}件\n`
  context += `・特定口座保有銘柄数: ${tokuteiHoldings.length}件\n`
  context += `【ユーザー情報】\n`
  context += `・投資目標: 65歳までに3000万円（DC別）\n`
  context += `・NISA成長枠: ${toMan(nisaStatus.growthRemaining)} 残り${nisaStatus.growthMonthsLeft}ヶ月、月${toMan(nisaStatus.growthMonthlyTarget)}ペース\n`
  context += `・つみたてNISA残り: ${toMan(nisaStatus.tsumitateRemaining)} 残り${nisaStatus.tsumitateMonthsLeft}ヶ月、月${toMan(nisaStatus.tsumitateMonthlyTarget)}ペース\n`
  context += `・積立設定: ${toMan(tsumitate.reduce((sum, t) => sum + (t.monthly_amount ?? 0), 0))}／月\n`
  context += `・合計保有評価額: ${toMan(totalAsset)}\n`

  if (policy) {
    context += `【現在の投資方針】\n${policy}\n\n`
  }

  context += `【保有銘柄と口座区分】\n`
  holdings.forEach(h => {
    const accountText = formatAccountType(h.account_type)
    const priceText = h.current_price != null ? `現在値${h.current_price.toLocaleString()}円` : '現在値不明'
    const evalText = h.evaluation_amount != null ? `評価額${toMan(h.evaluation_amount)}` : '評価額不明'
    const gainText = h.unrealized_gain != null ? `含み損益${h.unrealized_gain >= 0 ? '+' : ''}${toMan(h.unrealized_gain)}` : '含み損益不明'
    context += `・${h.name}(${h.ticker ?? '---'}): ${accountText} / ${priceText} / ${evalText} / ${gainText}\n`
  })

  if (orders.length > 0) {
    context += `\n【執行中の注文】\n`
    orders.forEach(o => {
      context += `・${o.name} ${o.order_type === 'sell' ? '売り' : '買い'}指値${o.price ?? '不明'}円 ${o.quantity}株 期限${o.deadline}\n`
    })
  }

  if (tsumitate.length > 0) {
    context += `\n【積立設定】\n`
    tsumitate.forEach((t: { name: string; monthly_amount: number; account_type: string }) => {
      context += `・${t.name} (${formatAccountType(t.account_type)}): 月${t.monthly_amount.toLocaleString()}円\n`
    })
  }

  if (rules.length > 0) {
    context += `\n【銘柄別ルール】\n`
    rules.forEach(r => {
      context += `・${r.name}(${r.ticker})\n`
      if (r.purpose) context += `  目的: ${r.purpose}\n`
      if (r.sell_conditions) context += `  売却条件: ${r.sell_conditions}\n`
      if (r.timeline_notes) context += `  期限: ${r.timeline_notes}\n`
    })
  }

  if (marketStats) {
    context += `\n【市場センチメント】\n`
    if (marketStats.marketSentiment) {
      context += `・市場心理: ${marketStats.marketSentiment}\n`
    }
    if (Array.isArray(marketStats.stopUpStocks) && marketStats.stopUpStocks.length > 0) {
      const top = marketStats.stopUpStocks.slice(0, 3).map(s => `${s.ticker}:${s.changePct.toFixed(1)}%`).join(' ') || ''
      context += `・上昇注目銘柄: ${top}\n`
    }
  }

  const instruction = `以下を出力してください。\n1. NISA枠優先の戦略概要（買付/積立優先度、リスク管理、残り枠の使い方）\n2. NISA枠を使い切ったあとの特定口座の補完戦略\n3. 具体的な次の取るべき行動リスト（3〜5項目）\n4. 保有銘柄に対する簡潔な見方（必要ならNISA/特定別に）\n5. 追加で必要なデータや確認事項\n\n必ずJSONのみで返してください。形式: {"headline":"...","nisaStrategy":"...","tokuteiStrategy":"...","nextActions":["..."],"riskNotes":"..."}`

  const prompt = `${context}\n\n${instruction}`

  const text = await geminiGenerate({
    model: 'gemini-2.0-flash',
    system: 'あなたは日本語の資産運用アドバイザーです。回答は簡潔かつ論理的に、JSON形式で正確に出力してください。',
    maxTokens: 4096,
    timeoutMs: 20000,
    messages: [{ role: 'user', parts: [{ text: prompt }] }],
  })

  try {
    // ```json ... ``` ブロックがあれば中身を取り出し、なければ最初の{...}を探す
    const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/)
    const jsonStr = codeBlock ? codeBlock[1].trim() : (text.match(/\{[\s\S]*\}/) ?? [''])[0]
    if (!jsonStr) {
      return NextResponse.json({ error: 'AIの応答がJSON形式ではありません。', raw: text }, { status: 500 })
    }
    const proposal = JSON.parse(jsonStr)

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
