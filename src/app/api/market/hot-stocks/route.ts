import { NextResponse } from 'next/server'
import { fetchHotStocks } from '@/lib/kabutan'

// 活況銘柄（約定回数が多い銘柄）を取得
export async function GET() {
  try {
    const hotStocks = await fetchHotStocks()

    if (hotStocks.length === 0) {
      return NextResponse.json(
        { error: '活況銘柄データの取得に失敗しました' },
        { status: 503 }
      )
    }

    return NextResponse.json({
      timestamp: new Date().toISOString(),
      count: hotStocks.length,
      hotStocks,
    })
  } catch (error) {
    console.error('活況銘柄取得エラー:', error)
    return NextResponse.json(
      { error: '活況銘柄データの取得に失敗しました' },
      { status: 500 }
    )
  }
}
