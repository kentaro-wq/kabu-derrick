import { NextResponse } from 'next/server'
import { adminSupabase } from '@/lib/supabase'

export async function GET() {
  const { data, error } = await adminSupabase
    .from('holdings')
    .select('*')
    .order('evaluation_amount', { ascending: false })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

export async function POST(req: Request) {
  const body = await req.json()
  const { data, error } = await adminSupabase.from('holdings').insert(body).select().single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

// スクショ解析結果で全件置き換え → ルールチェックも非同期実行
export async function PUT(req: Request) {
  const { holdings } = await req.json()
  await adminSupabase.from('holdings').delete().neq('id', '00000000-0000-0000-0000-000000000000')
  const rows = holdings.map((h: Record<string, unknown>) => ({ ...h, updated_at: new Date().toISOString() }))
  const { data, error } = await adminSupabase.from('holdings').insert(rows).select()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // バックグラウンド: ルールチェック + 未設定銘柄のルール自動抽出
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://kabu-derrick.vercel.app'
  const savedHoldings = data as { ticker: string; name: string }[]
  ;(async () => {
    // 既存ルール一覧を取得して、ルール未設定の銘柄だけ抽出を試みる
    const { data: existingRules } = await adminSupabase
      .from('holding_rules')
      .select('ticker')
    const ruleSet = new Set((existingRules ?? []).map((r: { ticker: string }) => r.ticker))

    const noRuleHoldings = savedHoldings.filter(h => !ruleSet.has(h.ticker))
    await Promise.all(
      noRuleHoldings.map(h =>
        fetch(`${baseUrl}/api/holding-rules/extract`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ticker: h.ticker, name: h.name }),
        }).catch(() => {})
      )
    )
    // 全銘柄のルールチェックも実行
    const authHeaders = { Authorization: `Bearer ${process.env.APP_SECRET}` }
    fetch(`${baseUrl}/api/holding-rules/check`, { method: 'POST', headers: authHeaders }).catch(() => {})
  })()

  return NextResponse.json(data)
}

export async function PATCH(req: Request) {
  const body = await req.json()
  const { id, ...updates } = body
  const { data, error } = await adminSupabase
    .from('holdings')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}
