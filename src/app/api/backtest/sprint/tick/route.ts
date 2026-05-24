/**
 * スプリントtick — 1回呼ばれるごとにミニ・バックテストを複数回実行し、
 * Vercel timeout 直前に次のtickを発火（連続稼働）
 *
 * cronからもfire-and-forgetからも安全に呼べる：
 * 多重起動防止のため、activeスプリントが既にtick処理中なら早期return
 */
import { NextResponse } from 'next/server'
import { after } from 'next/server'
import { adminSupabase } from '@/lib/supabase'
import { runSprintTick } from '@/lib/sprint'

export const maxDuration = 300

export async function POST(req: Request) {
  let body: { sprintId?: string } = {}
  try { body = await req.json() } catch {}

  // sprintId が無ければ active なスプリントを自動探索（cron用）
  let sprintId = body.sprintId
  if (!sprintId) {
    const { data: active } = await adminSupabase
      .from('sprint_sessions')
      .select('id')
      .eq('status', 'active')
      .order('started_at', { ascending: false })
      .limit(1)
    sprintId = active?.[0]?.id
  }

  if (!sprintId) {
    return NextResponse.json({ skipped: true, reason: 'no active sprint' })
  }

  // 実行（最大3runs/tick、各5日×5候補=25評価）
  const result = await runSprintTick(sprintId, 3, 5, 5)

  // 継続が必要なら次のtickを発火
  if (!result.done) {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://kabu-derrick.vercel.app'
    after(async () => {
      try {
        await fetch(`${baseUrl}/api/backtest/sprint/tick`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sprintId }),
        })
      } catch (e) {
        console.error('[sprint/tick] chain failed:', e)
      }
    })
  }

  return NextResponse.json({
    sprintId,
    ...result,
  })
}

// Vercel cron 安全網（チェーンが切れても継続できるよう）
export async function GET() {
  return POST(new Request('http://localhost', { method: 'POST', body: '{}' }))
}
