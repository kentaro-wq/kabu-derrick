import { NextResponse } from 'next/server'
import { fetchMarketStats } from '@/lib/kabutan'

// 市場全体の統計情報を取得（ランキング、ストップ高、活況銘柄を統合）
export async function GET() {
  try {
    const stats = await fetchMarketStats()

    if (!stats) {
      return NextResponse.json(
        { error: '市場統計データの取得に失敗しました' },
        { status: 503 }
      )
    }

    return NextResponse.json(stats)
  } catch (error) {
    console.error('市場統計取得エラー:', error)
    return NextResponse.json(
      { error: '市場統計データの取得に失敗しました' },
      { status: 500 }
    )
  }
}
