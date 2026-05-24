import { NextResponse } from 'next/server'

export const maxDuration = 30

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const code = searchParams.get('code') ?? '72030'
  const apiKey = process.env.JQUANTS_REFRESH_TOKEN

  const result: Record<string, unknown> = { hasKey: !!apiKey, keyLength: apiKey?.length ?? 0 }
  if (!apiKey) return NextResponse.json(result)

  const headers = { 'x-api-key': apiKey }

  // 1. 日付指定なし
  const r1 = await fetch(`https://api.jquants.com/v2/equities/bars/daily?code=${code}`, { headers })
  const j1 = await r1.json()
  result.noDate = {
    status: r1.status,
    bars: j1.data?.length ?? 0,
    paginationKey: j1.pagination_key ?? null,
    firstDate: j1.data?.[0]?.Date ?? null,
    lastDate: j1.data?.[j1.data.length - 1]?.Date ?? null,
  }

  // 2. from/to パラメータあり
  const r2 = await fetch(`https://api.jquants.com/v2/equities/bars/daily?code=${code}&from=2024-09-01&to=2026-05-24`, { headers })
  const j2 = await r2.json()
  result.withDate = {
    status: r2.status,
    bars: j2.data?.length ?? 0,
    paginationKey: j2.pagination_key ?? null,
    rawKeys: Object.keys(j2),
    bodySnippet: JSON.stringify(j2).slice(0, 400),
  }

  // 3. 別のパラメータ名: start_date/end_date
  const r3 = await fetch(`https://api.jquants.com/v2/equities/bars/daily?code=${code}&start_date=2024-09-01&end_date=2026-05-24`, { headers })
  const j3 = await r3.json()
  result.startEndDate = {
    status: r3.status,
    bars: j3.data?.length ?? 0,
    bodySnippet: JSON.stringify(j3).slice(0, 400),
  }

  // 4. 別のパラメータ名: date_from/date_to
  const r4 = await fetch(`https://api.jquants.com/v2/equities/bars/daily?code=${code}&date_from=2024-09-01&date_to=2026-05-24`, { headers })
  const j4 = await r4.json()
  result.dateFromTo = {
    status: r4.status,
    bars: j4.data?.length ?? 0,
    bodySnippet: JSON.stringify(j4).slice(0, 400),
  }

  return NextResponse.json(result)
}
