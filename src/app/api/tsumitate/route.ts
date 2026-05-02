import { NextResponse } from 'next/server'
import { adminSupabase } from '@/lib/supabase'

export async function GET() {
  const { data, error } = await adminSupabase
    .from('tsumitate_settings')
    .select('id, name, monthly_amount, account_type')
    .order('monthly_amount', { ascending: false })
  if (error) return NextResponse.json({ settings: [] })
  return NextResponse.json({ settings: data ?? [] })
}
