-- Supabase 用の strategy_proposals テーブル定義
-- このテーブルが存在しない場合、以下を Supabase SQL エディタで実行してください。

create table if not exists strategy_proposals (
  id uuid primary key default uuid_generate_v4(),
  headline text,
  nisa_strategy text,
  tokutei_strategy text,
  next_actions text[],
  risk_notes text,
  raw_response text,
  created_at timestamptz not null default now()
);

-- 必要に応じて index を追加
create index if not exists idx_strategy_proposals_created_at on strategy_proposals (created_at desc);
