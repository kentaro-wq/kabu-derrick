import { NextResponse } from 'next/server'

export const maxDuration = 60
import { geminiGenerate } from '@/lib/gemini'
import { adminSupabase } from '@/lib/supabase'
import { getNisaStatus } from '@/lib/nisa'

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
  const [holdingsRes, ordersRes, tsumitateRes, profileRes] = await Promise.all([
    adminSupabase.from('holdings').select('name,ticker,account_type,evaluation_amount,unrealized_gain'),
    adminSupabase.from('orders').select('name,order_type,price,quantity').eq('status', 'active'),
    adminSupabase.from('tsumitate_settings').select('name,monthly_amount,account_type'),
    adminSupabase.from('profile').select('*').single(),
  ])

  const profile = profileRes.data
  if (!profile) {
    return NextResponse.json({ error: 'プロフィールが未設定です。' }, { status: 400 })
  }

  const holdings = holdingsRes.data ?? []
  const orders = ordersRes.data ?? []
  const tsumitate = tsumitateRes.data ?? []
  const nisaStatus = getNisaStatus(profile)
  const totalAsset = holdings.reduce((sum, h) => sum + (h.evaluation_amount ?? 0), 0)

  const holdingsSummary = holdings.map(h =>
    `${h.name}(${formatAccountType(h.account_type)}) 評価${toMan(h.evaluation_amount ?? 0)} 損益${h.unrealized_gain != null ? (h.unrealized_gain >= 0 ? '+' : '') + toMan(h.unrealized_gain) : '不明'}`
  ).join(', ')

  const ordersSummary = orders.length > 0
    ? orders.map(o => `${o.name}${o.order_type === 'sell' ? '売' : '買'}${o.price}円×${o.quantity}株`).join(', ')
    : 'なし'

  const tsumitateTotal = toMan(tsumitate.reduce((sum, t) => sum + (t.monthly_amount ?? 0), 0))

  const prompt = `投資アドバイザーとして以下の状況を分析し、簡潔な戦略をJSONで返せ。

NISA成長枠残: ${toMan(nisaStatus.growthRemaining)}(残${nisaStatus.growthMonthsLeft}ヶ月,月${toMan(nisaStatus.growthMonthlyTarget)})
つみたてNISA残: ${toMan(nisaStatus.tsumitateRemaining)}(残${nisaStatus.tsumitateMonthsLeft}ヶ月,月${toMan(nisaStatus.tsumitateMonthlyTarget)})
積立設定: ${tsumitateTotal}/月 | 総評価額: ${toMan(totalAsset)}
保有: ${holdingsSummary}
注文中: ${ordersSummary}

JSON形式のみで返答(前後に余分なテキスト不要):
{"headline":"30字以内","nisaStrategy":"50字以内","tokuteiStrategy":"50字以内","nextActions":["行動1","行動2","行動3"],"riskNotes":"30字以内"}`

  const text = await geminiGenerate({
    model: 'gemini-2.5-flash',
    system: '日本語の投資アドバイザー。JSONのみ返答。',
    maxTokens: 800,
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
