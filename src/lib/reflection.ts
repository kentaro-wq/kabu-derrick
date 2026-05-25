/**
 * 自己反省 AI システム
 *
 * 目的: バックテストで得た「失敗例」を AI に分析させ、
 * 個別事例 → 一般原則 を抽出する。それを次のプロンプトに混ぜることで
 * AI 自身が時間とともに賢くなる。
 *
 * 設計の鍵:
 *  - 個別事例の暗記ではなく「一般化された教訓」を作る
 *  - 教訓は5〜10個の短いルールに集約（プロンプト肥大化を避ける）
 *  - 「外れた」だけでなく「大損した」「見逃した大当たり」も題材に
 */
import { adminSupabase } from '@/lib/supabase'
import Anthropic from '@anthropic-ai/sdk'

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export interface ReflectionLesson {
  principle: string   // 一般化された教訓（短文）
  evidence: string    // 何件のサンプルに基づくか
  category: 'avoid' | 'prefer' | 'context'  // どんな性質か
}

/**
 * バックテスト失敗例を分析して「一般原則」を抽出
 *
 * @param sprintId 対象のスプリント（指定なし＝全データ）
 * @returns 教訓のリスト
 */
export async function extractLessons(sprintId?: string): Promise<ReflectionLesson[]> {
  // 失敗例 (大損 + 見逃し) を抽出
  let baseQuery = adminSupabase
    .from('backtest_signals')
    .select('ticker, name, claude_fire, claude_score, conditions_met, reasoning, narrative, crowd_position, volume_ratio, rsi14, golden_cross, above_ma25, above_ma75, ma5, ma25, ma75, price_at_signal, pct_10d, pct_20d, hit_10d, hit_20d, run_id')
    .not('pct_20d', 'is', null)

  if (sprintId) {
    const { data: runs } = await adminSupabase.from('backtest_runs').select('id').eq('sprint_id', sprintId)
    const ids = (runs ?? []).map(r => r.id)
    if (ids.length === 0) return []
    baseQuery = baseQuery.in('run_id', ids)
  }

  const { data } = await baseQuery.limit(2000)
  const all = data ?? []

  if (all.length === 0) return []

  // 3カテゴリの失敗例を集める
  type SignalRow = typeof all[number]
  const bigLossOnFire = all.filter((s: SignalRow) => s.claude_fire === true && (s.pct_20d ?? 0) < -5)
  const missedBigWin  = all.filter((s: SignalRow) => s.claude_fire === false && (s.pct_20d ?? 0) >= 15)
  const wrongDirection = all.filter((s: SignalRow) => s.claude_fire === true && (s.pct_20d ?? 0) < 0)

  // 各カテゴリを最大10件サンプリング
  const sample = <T>(arr: T[], n: number) => arr.slice(0, n)
  const samples = {
    bigLoss: sample(bigLossOnFire, 10),
    missedWin: sample(missedBigWin, 10),
    wrongDir: sample(wrongDirection, 10),
  }

  // 全部空ならスキップ
  if (samples.bigLoss.length === 0 && samples.missedWin.length === 0 && samples.wrongDir.length === 0) {
    return []
  }

  // Claude に「一般原則」を抽出させる
  const formatExamples = (examples: SignalRow[], label: string) => {
    if (examples.length === 0) return ''
    const rows = examples.map((e: SignalRow) => {
      const parts: string[] = []
      if (e.volume_ratio != null) parts.push(`出来高${e.volume_ratio}x`)
      if (e.rsi14 != null) parts.push(`RSI${e.rsi14}`)
      if (e.golden_cross) parts.push('GC')
      if (e.above_ma25) parts.push('MA25↑')
      if (e.above_ma75) parts.push('MA75↑')
      if (e.narrative) parts.push(`narrative=${e.narrative.slice(0, 60)}`)
      return `- ${e.name}(${e.ticker}) score=${e.claude_score} 条件:[${parts.join(', ')}] → 20日後 ${e.pct_20d}%`
    }).join('\n')
    return `\n${label}:\n${rows}`
  }

  const prompt = `あなたは投資AIの「自己反省者」です。
過去のバックテスト判断から、一般化できる教訓を抽出してください。

${formatExamples(samples.bigLoss, '【発火したのに大損 (-5%以下)】')}
${formatExamples(samples.wrongDir, '【発火したのにマイナス】')}
${formatExamples(samples.missedWin, '【発火しなかったのに+15%以上の爆上がり】')}

---
これらの失敗例を分析し、以下の形式で 5〜10個の一般原則を抽出してください:

- 個別事例の暗記ではなく、共通パターンを抽象化する
- 「○○の局面では発火を避ける」「○○なら発火を考慮」という行動指針の形で
- 短く（1原則1〜2文）
- 統計的裏付けがあるものを優先（n=1の偶然は除外）

JSON配列で回答:
[
  {
    "principle": "RSIが65以上の局面では発火を避ける（過熱の罠）",
    "evidence": "n=8の発火大損例のうち6件がRSI65以上だった",
    "category": "avoid"
  },
  ...
]

category は "avoid" (避けるべき), "prefer" (好むべき), "context" (文脈判断) のいずれか。`

  try {
    const res = await claude.messages.create({
      model: 'claude-sonnet-4-6',  // 反省は重要なので Sonnet を使う
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    })
    const text = res.content[0].type === 'text' ? res.content[0].text : ''
    const m = text.match(/\[[\s\S]*\]/)
    if (!m) return []
    const lessons = JSON.parse(m[0]) as ReflectionLesson[]
    return lessons.slice(0, 10)  // 念のため上限
  } catch (e) {
    console.error('[reflection] extract error:', e)
    return []
  }
}

/**
 * 抽出した教訓を DB に保存（履歴・バージョン管理）
 */
export async function saveLessons(
  lessons: ReflectionLesson[],
  sourceLabel: string,
): Promise<string | null> {
  const { data, error } = await adminSupabase
    .from('reflection_lessons')
    .insert({
      lessons,
      source_label: sourceLabel,
      created_at: new Date().toISOString(),
    })
    .select('id')
    .single()
  if (error) {
    console.error('[reflection] save error:', error.message)
    return null
  }
  return data?.id ?? null
}

/**
 * 最新の教訓セットを取得（プロンプトに混ぜる用）
 */
export async function getLatestLessons(): Promise<ReflectionLesson[]> {
  const { data } = await adminSupabase
    .from('reflection_lessons')
    .select('lessons')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return (data?.lessons as ReflectionLesson[]) ?? []
}

/**
 * 教訓をプロンプト用のテキストブロックに整形
 */
export function formatLessonsForPrompt(lessons: ReflectionLesson[]): string {
  if (lessons.length === 0) return ''
  const lines: string[] = ['【過去の失敗から抽出した教訓】']
  for (const l of lessons) {
    const tag = l.category === 'avoid' ? '⛔' : l.category === 'prefer' ? '✓' : '※'
    lines.push(`${tag} ${l.principle}`)
  }
  return lines.join('\n')
}
