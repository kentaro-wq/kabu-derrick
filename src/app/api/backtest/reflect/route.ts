/**
 * 自己反省実行 + 教訓取得 API
 *
 * POST: バックテスト失敗データから教訓を抽出して DB に保存
 *  body: { sprintId?: string, label?: string }
 *
 * GET: 最新の教訓を取得
 */
import { NextResponse } from 'next/server'
import { extractLessons, saveLessons, getLatestLessons } from '@/lib/reflection'

export const maxDuration = 60

export async function POST(req: Request) {
  let body: { sprintId?: string; label?: string } = {}
  try { body = await req.json() } catch {}

  const lessons = await extractLessons(body.sprintId)
  if (lessons.length === 0) {
    return NextResponse.json({ ok: false, message: '失敗例が不足 or 抽出失敗', lessons: [] })
  }

  const id = await saveLessons(
    lessons,
    body.label ?? `Reflection ${new Date().toISOString().slice(0, 16)}${body.sprintId ? ` (sprint=${body.sprintId.slice(0, 8)})` : ''}`,
  )

  return NextResponse.json({ ok: true, id, count: lessons.length, lessons })
}

export async function GET() {
  const lessons = await getLatestLessons()
  return NextResponse.json({ lessons })
}
