export type AccountType =
  | 'nisa_growth'
  | 'nisa_tsumitate'
  | 'nisa_tsumitate_old'
  | 'tokutei'
  | 'dc'

export type AssetType = 'stock' | 'fund' | 'dc'

export type OrderStatus = 'active' | 'executed' | 'expired' | 'cancelled'

export type OrderType = 'sell' | 'buy'

export interface Holding {
  id: string
  ticker: string
  name: string
  account_type: AccountType
  asset_type: AssetType
  quantity: number | null
  purchase_price: number | null
  current_price: number | null
  evaluation_amount: number | null
  unrealized_gain: number | null
  unrealized_gain_pct: number | null
  updated_at: string
  created_at: string
}

export interface Order {
  id: string
  ticker: string
  name: string
  order_type: OrderType
  order_method: string
  price: number | null
  quantity: number
  account_type: AccountType
  deadline: string | null
  order_number: string | null
  status: OrderStatus
  alert_days: number[]
  notes: string | null
  created_at: string
  updated_at: string
}

export interface Profile {
  id: string
  birth_year: number
  target_amount: number
  education_reserve: number
  cash_reserve: number
  bank_balance: number
  dc_balance: number
  nisa_growth_used: number
  nisa_growth_limit: number
  nisa_tsumitate_used: number
  nisa_tsumitate_limit: number
  line_user_id: string | null
  updated_at: string
}

export interface PortfolioSnapshot {
  id: string
  snapshot_date: string
  raw_data: Record<string, unknown> | null
  total_evaluation: number | null
  total_unrealized_gain: number | null
  created_at: string
}
