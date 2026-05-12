import { NextResponse } from 'next/server'
import { fetchStopUpStocks } from '@/lib/kabutan'

// ストップ高銘柄を取得
export async function GET() {
  try {
    const stopUpStocks = await fetchStopUpStocks()

    return NextResponse.json({
      timestamp: new Date().toISOString(),
      count: stopUpStocks.length,
      stopUpStocks: stopUpStocks.slice(0, 30),
      marketSentiment:
        stopUpStocks.length > 30
          ? 'very-bullish'
          : stopUpStocks.length > 15
            ? 'bullish'
            : stopUpStocks.length > 5
              ? 'neutral'
              : 'bearish',
    })
  } catch (error) {
    console.error('ストップ高銘柄取得エラー:', error)
    return NextResponse.json(
      { error: 'ストップ高銘柄データの取得に失敗しました' },
      { status: 500 }
    )
  }
}
