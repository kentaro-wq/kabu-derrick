import { createClient, SupabaseClient } from '@supabase/supabase-js'

let _client: SupabaseClient | null = null

function getClient() {
  if (!_client) {
    _client = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    )
  }
  return _client
}

// RLSに全許可ポリシーを設定済み（個人用アプリ）のためanonキーで統一
export const adminSupabase = {
  from: (table: string) => getClient().from(table),
}
