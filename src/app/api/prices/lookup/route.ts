import { NextResponse } from 'next/server'
import { fetchPrice, extractTickers } from '@/lib/stock-price'

export const runtime = 'nodejs'

// GET /api/prices/lookup?tickers=8001,8316
// AI返答に含まれる証券コードのリアルタイム株価を返す
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const raw = searchParams.get('tickers') ?? ''
  const tickers = raw.split(',').map(t => t.trim()).filter(t => /^\d{4}$/.test(t)).slice(0, 10)

  if (tickers.length === 0) return NextResponse.json({})

  const entries = await Promise.all(
    tickers.map(async ticker => {
      const price = await fetchPrice(ticker)
      return price != null ? [ticker, price] as [string, number] : null
    })
  )
  const result = Object.fromEntries(entries.filter((e): e is [string, number] => e !== null))
  return NextResponse.json(result)
}

// POST /api/prices/lookup  { text: "...AI返答テキスト..." }
// テキストから証券コードを抽出してリアルタイム株価を返す
export async function POST(req: Request) {
  const { text } = await req.json()
  if (!text) return NextResponse.json({})

  const tickers = extractTickers(String(text)).slice(0, 10)
  if (tickers.length === 0) return NextResponse.json({})

  const entries = await Promise.all(
    tickers.map(async ticker => {
      const price = await fetchPrice(ticker)
      return price != null ? [ticker, price] as [string, number] : null
    })
  )
  const result = Object.fromEntries(entries.filter((e): e is [string, number] => e !== null))
  return NextResponse.json(result)
}
