import { NextResponse } from 'next/server'
import { fetchTradingVolumeRankings } from '@/lib/kabutan'

// 売買代金ランキングを取得
export async function GET() {
  try {
    const rankings = await fetchTradingVolumeRankings()

    if (rankings.length === 0) {
      return NextResponse.json(
        { error: 'ランキングデータの取得に失敗しました' },
        { status: 503 }
      )
    }

    return NextResponse.json({
      timestamp: new Date().toISOString(),
      count: rankings.length,
      rankings: rankings.slice(0, 30),
    })
  } catch (error) {
    console.error('売買代金ランキング取得エラー:', error)
    return NextResponse.json(
      { error: 'ランキングデータの取得に失敗しました' },
      { status: 500 }
    )
  }
}
