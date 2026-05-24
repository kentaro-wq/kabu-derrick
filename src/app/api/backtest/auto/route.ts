/**
 * バックテスト自動実行のオン/オフを切替・取得
 */
import { NextResponse } from 'next/server'
import { adminSupabase } from '@/lib/supabase'

export async function GET() {
  const { data } = await adminSupabase
    .from('bot_rules')
    .select('rule_value, updated_at')
    .eq('rule_key', 'backtest_auto_enabled')
    .single()

  return NextResponse.json({
    enabled: data?.rule_value !== 'false',
    updatedAt: data?.updated_at ?? null,
  })
}

export async function POST(req: Request) {
  const body = await req.json()
  const enabled = body?.enabled === true

  const { error } = await adminSupabase
    .from('bot_rules')
    .upsert(
      {
        rule_key: 'backtest_auto_enabled',
        rule_value: enabled ? 'true' : 'false',
        description: 'バックテスト自動実行のオン/オフ',
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'rule_key' }
    )

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, enabled })
}
