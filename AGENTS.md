<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# 運用哲学・データソース

このプロジェクトは資産管理として既に**本番運用中**。判断ミスは許されない。
ユーザーは「AI判断に機械的に従う」運用なので、判定不能ケースも含めて
**全て LINE 通知**で気づける設計にする必要がある。silent skip は禁忌。

## データソース
- **メイン**: Yahoo Finance (リアルタイム / `fetchYahooBars`, `fetchIndex`)
- **補助**: J-Quants (12週間遅延・Free プラン / バックテスト用途中心)
- **API バグ注意**: Yahoo の `previousClose` は常に null → `chartPreviousClose + range=2d` を使う
- **株式分割**: J-Quants は AdjC で対応、Yahoo は素値なのでジャンプ注意

# Supabase 接続

- Project ID: `oqvkollqrnhxclyqgvjp`
- 既存パターン: `adminSupabase` は anon key + permissive RLS で運用中
  (将来 Service Role Key 移行予定)
- DDL は `apply_migration`、読み取りは `execute_sql`

# Vercel 接続

- Project ID: `prj_WT06Ok8zdSAFG8NJwEislCEBrSqD`
- Team ID: `team_9Z9CYyQKgFlm6Cr02YMAsJpY`

# cron 設計 (vercel.json)

| 時刻 (JST) | エンドポイント | 役割 |
|---|---|---|
| 平日 07:00 | `/api/market/check?mode=overnight` | 米株+先物+保有銘柄ADR |
| 平日 08:30 | `/api/notify?type=morning` | 朝レポート (注文・配当・決算・集中度) + exit-judgment trigger |
| 平日 15:40 | `/api/market/update` | 株価更新 + exit-judgment trigger |
| 平日 15:45 | `/api/notify?type=evening` | 損益・NISA アラート |
| 平日 16:30 | `/api/signals/generate` | シグナル生成 |
| 平日 16:50 | `/api/signals/track` | シグナル追跡 |
| 月曜 08:00 | `/api/nanpin-check` | ナンピン候補 AI判定 |
| 土曜 09:00 | `/api/exit-judgment/evaluate` | 過去判定の自己評価 |
| 月初 08:30 | `/api/notify?type=monthly` | 月次パフォーマンス |
| 毎日 02:00 | `/api/backtest/cron` | バックテスト |

# 設計上の注意

- `exit-judgment` は同日重複防止: `exit_judgments.judgment_date + ticker` で existing チェック
- `decision_log` は logDecision 内で同日同ticker同actionの重複チェックあり
- 集中度計算は **mochikabu (持株会) 除外** の自由売買口座のみ
- バックテスト戦略 (segment.ts) は 2026-05 検証で5セグメント中4で最強と実証済み
