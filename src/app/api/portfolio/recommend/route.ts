/**
 * ポートフォリオ配分 AI 提案
 *
 * 目的:
 * 「次に何を買うべきか」を AI が月次で提案。具体銘柄ではなく
 * 「補強すべきセクター + 推奨条件」レベルで返す (過信を避け、最終判断は人)。
 *
 * 入力:
 * - 現状の holdings (集中度・セクター推定)
 * - profile (NISA残枠・現金余力・目標額・生年)
 * - 直近の reflection_lessons (任意)
 *
 * 出力:
 * - 強化すべきセクター3つ + 理由
 * - 避けるべき行動 (集中度悪化につながる買い増し等)
 * - NISA残枠の最適配分
 * - LINE 通知 + 結果保存 (strategy_proposals)
 */
import { NextResponse } from 'next/server'
import { adminSupabase } from '@/lib/supabase'
import { sendLineMessage } from '@/lib/line'
import Anthropic from '@anthropic-ai/sdk'

export const maxDuration = 60

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// 主要銘柄のセクター推定 (拡張可)
const SECTOR_MAP: Record<string, string> = {
  '4028': '化学', '6929': '電子部品', '7012': '機械・防衛', '7203': '自動車',
  '7267': '自動車', '7974': 'ゲーム', '8001': '商社', '8002': '商社',
  '8031': '商社', '8053': '商社', '8058': '商社', '8306': '銀行',
  '8316': '銀行', '8411': '銀行', '8766': '保険', '9432': '通信',
  '9433': '通信', '9434': '通信', '6758': '電機', '6861': '電子部品',
  '3289': '不動産',
}
function inferSector(ticker: string): string {
  return SECTOR_MAP[ticker] ?? 'その他'
}

export async function POST() {
  const [holdingsRes, profileRes, lessonsRes] = await Promise.all([
    adminSupabase.from('holdings').select('*'),
    adminSupabase.from('profile').select('*').single(),
    adminSupabase.from('reflection_lessons')
      .select('lessons')
      .like('source_label', 'exit_judgment_reflection%')
      .order('created_at', { ascending: false })
      .limit(1),
  ])

  const holdings = holdingsRes.data ?? []
  const profile = profileRes.data
  const lessons = lessonsRes.data?.[0]?.lessons ?? []

  if (!profile) {
    return NextResponse.json({ error: 'プロフィール未設定' }, { status: 400 })
  }

  // 集中度とセクター分布を計算
  const free = holdings.filter(h => ['nisa_growth', 'tokutei'].includes(h.account_type))
  const totalFreeEval = free.reduce((s, h) => s + Number(h.evaluation_amount ?? 0), 0)
  const totalAllEval = holdings.reduce((s, h) => s + Number(h.evaluation_amount ?? 0), 0)

  const sectorEval: Record<string, number> = {}
  const tickerShare: Array<{ ticker: string; name: string; sector: string; pct: number }> = []
  for (const h of free) {
    const sector = /^\d{4}$/.test(h.ticker ?? '') ? inferSector(h.ticker) : '投信'
    const evalAmt = Number(h.evaluation_amount ?? 0)
    sectorEval[sector] = (sectorEval[sector] ?? 0) + evalAmt
    if (totalFreeEval > 0 && evalAmt > 0) {
      tickerShare.push({
        ticker: h.ticker, name: h.name, sector,
        pct: (evalAmt / totalFreeEval) * 100,
      })
    }
  }
  const sectorPct = Object.entries(sectorEval)
    .map(([s, v]) => ({ sector: s, pct: totalFreeEval > 0 ? (v / totalFreeEval) * 100 : 0 }))
    .sort((a, b) => b.pct - a.pct)

  const nisaGrowthRemaining = Math.max(0, Number(profile.nisa_growth_limit ?? 0) - Number(profile.nisa_growth_used ?? 0))
  const nisaTsumitateRemaining = Math.max(0, Number(profile.nisa_tsumitate_limit ?? 0) - Number(profile.nisa_tsumitate_used ?? 0))
  const cashFree = Math.max(0, Number(profile.bank_balance ?? 0) - Number(profile.cash_reserve ?? 0))
  const targetAmount = Number(profile.target_amount ?? 0)
  const totalAssets = totalAllEval + Number(profile.bank_balance ?? 0) + Number(profile.dc_balance ?? 0)
  const progressPct = targetAmount > 0 ? (totalAssets / targetAmount) * 100 : 0
  const monthsLeftInYear = Math.max(0, 12 - new Date().getMonth() - 1)

  const lessonsText = Array.isArray(lessons) && lessons.length > 0
    ? lessons.slice(0, 3).map((l: { category: string; principle: string }) =>
        `- [${l.category}] ${l.principle}`).join('\n')
    : '(まだ蓄積なし)'

  const prompt = `あなたは中長期投資のポートフォリオ・アドバイザーです。
山田さんの現状を踏まえ、次の1ヶ月で「補強すべきセクター3つ + 推奨条件」を提案してください。
具体銘柄名は出さず、「セクター + 銘柄属性 (高配当・大型・成長等)」のレベルで返します。

【現状のポートフォリオ (自由売買口座)】
- 評価額合計: ${Math.round(totalFreeEval).toLocaleString()}円
- セクター分布 (上位):
${sectorPct.slice(0, 6).map(s => `  - ${s.sector}: ${s.pct.toFixed(1)}%`).join('\n')}
- 集中度上位:
${tickerShare.sort((a, b) => b.pct - a.pct).slice(0, 3).map(t => `  - ${t.name}(${t.ticker}) [${t.sector}]: ${t.pct.toFixed(1)}%`).join('\n')}

【資金状況】
- 総資産: ${Math.round(totalAssets).toLocaleString()}円
- 目標: ${Math.round(targetAmount).toLocaleString()}円 (進捗 ${progressPct.toFixed(1)}%)
- NISA成長枠 残り: ${nisaGrowthRemaining.toLocaleString()}円 (残${monthsLeftInYear}ヶ月)
- NISAつみたて枠 残り: ${nisaTsumitateRemaining.toLocaleString()}円
- 投資余力 (銀行残高−生活防衛資金): ${cashFree.toLocaleString()}円

【過去判定からの教訓 (任意)】
${lessonsText}

【提案の原則】
- NISA枠は長期保有・高配当銘柄を優先
- 集中度の高いセクターは「補強」ではなく「分散」を促す
- 集中度が低いセクターを優先的に補強
- 配当銘柄は NISA で税効果最大化
- 投資余力に対して NISA 残枠が多い場合: NISA 優先

JSON のみで回答:
{
  "should_avoid": "次の1ヶ月で避けるべき行動 (50字以内)",
  "recommendations": [
    {
      "sector": "セクター名",
      "rationale": "推奨理由 (集中度・現状との関係を含む、80字以内)",
      "preferred_attributes": "推奨銘柄属性 (例: 配当3%超・PER15以下、50字以内)",
      "account": "nisa_growth"|"nisa_tsumitate"|"tokutei",
      "suggested_amount_yen": 数値 (50000の倍数)
    }
  ],
  "nisa_growth_strategy": "NISA成長枠の残額${nisaGrowthRemaining.toLocaleString()}円の使い方 (80字以内)",
  "priority_action": "今月の最優先アクション (50字以内)"
}

recommendations は 3 件。`

  let result: {
    should_avoid: string
    recommendations: Array<{
      sector: string; rationale: string; preferred_attributes: string;
      account: string; suggested_amount_yen: number
    }>
    nisa_growth_strategy: string
    priority_action: string
  } | null = null

  try {
    const res = await claude.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    })
    const text = res.content[0].type === 'text' ? res.content[0].text : ''
    const m = text.match(/\{[\s\S]*\}/)
    if (m) result = JSON.parse(m[0])
  } catch (e) {
    console.error('[recommend] AI error:', e)
    return NextResponse.json({ error: 'AI failed', detail: String(e) }, { status: 500 })
  }

  if (!result) {
    return NextResponse.json({ error: 'no result' }, { status: 500 })
  }

  // strategy_proposals に保存
  try {
    await adminSupabase.from('strategy_proposals').insert({
      proposal_type: 'monthly_allocation',
      title: `${new Date().toISOString().slice(0, 7)} 月次配分提案`,
      content: result,
      status: 'pending',
    } as never)
  } catch (e) {
    console.error('[recommend] save fail:', e)
  }

  // LINE 通知
  const today = new Date().toLocaleDateString('ja-JP', { month: 'long', day: 'numeric' })
  let msg = `💼 マイ株デリック 月次配分提案 ${today}\n\n`
  msg += `【最優先アクション】\n${result.priority_action}\n\n`
  msg += `【避けるべき行動】\n${result.should_avoid}\n\n`
  msg += `【NISA成長枠戦略】\n${result.nisa_growth_strategy}\n\n`
  msg += `【補強推奨セクター】\n`
  for (const r of result.recommendations) {
    msg += `▶ ${r.sector} (${r.account}, 約${r.suggested_amount_yen.toLocaleString()}円)\n`
    msg += `  ${r.rationale}\n`
    msg += `  推奨属性: ${r.preferred_attributes}\n\n`
  }
  msg += `※具体的な銘柄選定は山田さんの最終判断で。`
  await sendLineMessage(msg).catch(() => {})

  return NextResponse.json({
    ok: true,
    totalFreeEval,
    sectorPct,
    nisaGrowthRemaining,
    nisaTsumitateRemaining,
    cashFree,
    progressPct,
    result,
  })
}

export async function GET() {
  return POST()
}
