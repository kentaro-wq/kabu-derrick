/**
 * 株価日次自動更新エンドポイント
 * Vercel Cron: 平日15:40 JST（06:40 UTC）に自動実行
 * 手動: POST /api/market/update
 */
import { NextResponse } from 'next/server'
import { updateAllHoldingPrices, isJQuantsConfigured } from '@/lib/jquants'

export const maxDuration = 60

export async function POST() {
  if (!isJQuantsConfigured) {
    return NextResponse.json({
      ok: false,
      message: 'J-Quants未設定。JQUANTS_REFRESH_TOKEN を Vercel 環境変数に追加してください。',
    }, { status: 503 })
  }

  const result = await updateAllHoldingPrices()

  return NextResponse.json({
    ok: result.error === null,
    ...result,
    timestamp: new Date().toISOString(),
  })
}

// Vercel Cron からの GET 呼び出しにも対応
export async function GET() {
  return POST()
}
