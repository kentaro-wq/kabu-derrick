/**
 * スプリント開始 — 予算を指定して連続実行を開始
 */
import { NextResponse } from 'next/server'
import { after } from 'next/server'
import { adminSupabase } from '@/lib/supabase'

export const maxDuration = 30

export async function POST(req: Request) {
  let body: { budgetYen?: number; useFewShot?: boolean; name?: string } = {}
  try { body = await req.json() } catch {}

  const budgetYen = Math.max(50, Math.min(10000, body.budgetYen ?? 600))
  const useFewShot = body.useFewShot ?? false
  const name = body.name ?? `Sprint ¥${budgetYen} ${new Date().toISOString().slice(0, 16)}`

  // 既存のactiveスプリントがあれば拒否（多重実行防止）
  const { data: existing } = await adminSupabase
    .from('sprint_sessions')
    .select('id')
    .eq('status', 'active')
    .limit(1)

  if (existing && existing.length > 0) {
    return NextResponse.json({
      error: '既にactiveなスプリントが存在します。先に停止または完了させてください。',
      activeId: existing[0].id,
    }, { status: 409 })
  }

  const { data: sprint, error } = await adminSupabase
    .from('sprint_sessions')
    .insert({
      name, budget_yen: budgetYen, use_few_shot: useFewShot, status: 'active',
    })
    .select()
    .single()

  if (error || !sprint) {
    return NextResponse.json({ error: error?.message ?? 'sprint作成失敗' }, { status: 500 })
  }

  // レスポンス送信後にtickを発火（ユーザーは待たない）
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://kabu-derrick.vercel.app'
  after(async () => {
    try {
      await fetch(`${baseUrl}/api/backtest/sprint/tick`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sprintId: sprint.id }),
      })
    } catch (e) {
      console.error('[sprint/start] tick fire-and-forget failed:', e)
    }
  })

  return NextResponse.json({ ok: true, sprintId: sprint.id, sprint })
}
