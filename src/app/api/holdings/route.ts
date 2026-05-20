import { NextResponse } from 'next/server'
import { adminSupabase } from '@/lib/supabase'
import { recalcNisaUsed } from '@/lib/nisa-sync'

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

// スクショ解析結果で該当銘柄のみ更新（写真にない銘柄は削除しない）
export async function PUT(req: Request) {
  const { holdings } = await req.json()
  const rows = holdings
    .filter((h: Record<string, unknown>) => h.name && !String(h.name).includes('合計') && !String(h.name).includes('小計'))
    .map((h: Record<string, unknown>) => {
      const ticker = h.ticker || String(h.name).replace(/[^\w]/g, '').slice(0, 12).toUpperCase() || 'UNKNOWN'
      return {
        ...h,
        ticker,
        asset_type: h.asset_type ?? (typeof ticker === 'string' && /^\d{4}$/.test(ticker) ? 'domestic_stock' : 'fund'),
        updated_at: new Date().toISOString(),
      }
    })

  if (rows.length === 0) return NextResponse.json([])

  // 写真に写っている銘柄のtickerリスト
  const tickers = rows.map((r: Record<string, unknown>) => r.ticker as string).filter(Boolean)

  // 該当tickerの既存行を取得（account_type引継ぎ用）
  const { data: existing } = await adminSupabase
    .from('holdings')
    .select('id, ticker, account_type')
    .in('ticker', tickers)
  const existingMap = new Map((existing ?? []).map((e: { ticker: string; id: string; account_type: string }) => [e.ticker, e]))

  // upsert: 既存行はupdate、なければinsert
  const results = []
  for (const row of rows) {
    const ticker = row.ticker as string
    const found = existingMap.get(ticker)
    if (found) {
      // 既存行を更新（account_typeは既存を保持、写真から取れる場合は上書き）
      const { data, error } = await adminSupabase
        .from('holdings')
        .update({
          ...row,
          account_type: row.account_type ?? found.account_type,
        })
        .eq('id', found.id)
        .select()
        .single()
      if (!error && data) results.push(data)
    } else {
      // 新規insert
      const { data, error } = await adminSupabase
        .from('holdings')
        .insert(row)
        .select()
        .single()
      if (!error && data) results.push(data)
      else if (error) console.error('[holdings PUT] insert error:', error.message)
    }
  }

  // バックグラウンド: ルールチェック + 未設定銘柄のルール自動抽出
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://kabu-derrick.vercel.app'
  ;(async () => {
    const { data: existingRules } = await adminSupabase.from('holding_rules').select('ticker')
    const ruleSet = new Set((existingRules ?? []).map((r: { ticker: string }) => r.ticker))
    const noRuleHoldings = results.filter((h: { ticker: string }) => !ruleSet.has(h.ticker))
    await Promise.all(
      noRuleHoldings.map((h: { ticker: string; name: string }) =>
        fetch(`${baseUrl}/api/holding-rules/extract`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ticker: h.ticker, name: h.name }),
        }).catch(() => {})
      )
    )
    fetch(`${baseUrl}/api/holding-rules/check`, { method: 'POST' }).catch(() => {})
  })()

  recalcNisaUsed().catch(console.error)
  return NextResponse.json(results)
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
