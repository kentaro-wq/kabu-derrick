import { NextResponse } from 'next/server'
import { claudeGenerate, ClaudeMessage } from '@/lib/claude'
import { geminiGenerate } from '@/lib/gemini' // orders/parse等の画像解析で引き続き使用
import { adminSupabase } from '@/lib/supabase'
import { fetchMentionedPrices } from '@/lib/stock-price'

// ─── 共通禁止ルール ───────────────────────────────────────────────
// BANNED_PHRASES: MAIN_SYSTEM・全ペルソナで共通使用
const BANNED_PHRASES = `禁止フレーズ（1語でも出力した時点でその回答は失敗）:
「申し訳」「お詫び」「失礼」「ご指摘ありがとう」「おっしゃる通り」「確かに」「なるほど」「ご質問ありがとう」「ご理解いただき」「お気持ちはわかります」「改めて」「重ね重ね」`

// ─── 株価・取引ルール ─────────────────────────────────────────────
const PRICE_RULES = `【株価ルール（絶対厳守）】
・コンテキストに記載された価格のみ使用。記載のない銘柄の株価・金額を推測・提示するのは絶対禁止。
・銘柄を推奨する場合は価格を書かず、証券コードだけ案内して「楽天証券でご確認ください」と伝える。
・価格不明で計算が止まったら「証券コード○○の現在値を教えてください」と一言で止める。

【日本株取引ルール】
・100株単元制。購入提案は「100株 × ○○円 = ○○万円」の形で。金額ベース（「○万円分」）は禁止。
・NISA成長投資枠: 年間240万円上限。つみたて投資枠: 年間120万円上限。生涯1,800万円。
・楽天証券指値の有効期限: 最長90日。単元未満株（かぶミニ）は指値不可・スプレッドあり。`

// ─── ペルソナ設定（円卓モード用）────────────────────────────────
const PERSONA_BASE = `200字以内で答える。本題の1文目から始める。前置き・同調・クッションフレーズは書かない。
${BANNED_PHRASES}
${PRICE_RULES}`

const PERSONAS = {
  conservative: {
    label: '守りの分析家',
    system: `慎重派の投資アナリスト。資本保全最優先、リスクを徹底列挙、データと事実で話す。\n${PERSONA_BASE}`,
  },
  growth: {
    label: '成長論者',
    system: `積極的な成長投資家。上値余地と機会を重視、強気の目線で助言する。\n${PERSONA_BASE}`,
  },
  contrarian: {
    label: '逆張り屋',
    system: `逆張り投資家。市場の常識に疑問を呈し、反対意見を積極的に述べる。\n${PERSONA_BASE}`,
  },
  longterm: {
    label: '長期思考家',
    system: `長期投資家。5〜10年スパンで考え、配当・複利・時間の力を重視する。\n${PERSONA_BASE}`,
  },
}

// ─── メインシステムプロンプト ─────────────────────────────────────
const MAIN_SYSTEM = `# 絶対禁止（破った回答は全て失敗）
${BANNED_PHRASES}

# 出力スタイル
- 500字以内で答える。長くなるなら箇条書きで圧縮する
- 本題の1文目から始める。前置き・クッション・同調フレーズは一切書かない
- 間違いを修正するときは「修正:」と書いてすぐ正しい内容へ。謝罪なし
- コンテキストにある情報（保有目的・売買ルール・合意事項）をユーザーに再確認・再説明させない

# 役割
投資アドバイザー。守りの分析家・成長論者・逆張り屋・長期思考家の視点を統合し、
山田さん（50歳）の個別株投資をサポートする。コンテキストを全て読んだうえで回答すること。

${PRICE_RULES}`

// ─── ポートフォリオコンテキスト生成 ─────────────────────────────
async function getPortfolioContext(realtimePrices?: Record<string, number>): Promise<string> {
  const [holdingsRes, ordersRes, tsumitateRes, policyRes, rulesRes] = await Promise.all([
    adminSupabase.from('holdings').select('*'),
    adminSupabase.from('orders').select('*').eq('status', 'active'),
    adminSupabase.from('tsumitate_settings').select('*'),
    adminSupabase.from('investment_policy').select('content').limit(1).single(),
    adminSupabase.from('holding_rules').select('ticker,name,purpose,policy_basis,sell_conditions,dividend_notes,timeline_notes,raw_agreement').eq('is_active', true),
  ])
  const holdings = holdingsRes.data ?? []
  const orders = ordersRes.data ?? []
  const tsumitate = tsumitateRes.data ?? []
  const policy = policyRes.data?.content ?? ''
  const rules = rulesRes.data ?? []

  const toMan = (yen: number) => `${Math.round(yen / 10000)}万円`
  const total = holdings.reduce((s, h) => s + (h.evaluation_amount ?? 0), 0)
  const tsumitateTotal = tsumitate.reduce((s: number, t: { monthly_amount: number }) => s + t.monthly_amount, 0)
  const indexTotal = holdings.filter(h => !h.ticker || !/^\d{4}$/.test(h.ticker)).reduce((s, h) => s + (h.evaluation_amount ?? 0), 0)
  const stockTotal = holdings.filter(h => h.ticker && /^\d{4}$/.test(h.ticker)).reduce((s, h) => s + (h.evaluation_amount ?? 0), 0)

  let ctx = `【ユーザーの状況】
・山田さん、50歳（1975年生）、子ども小4
・投資目標: 15年後（65歳）にDC別3,000万円
・投資経験: インデックス積立は長年のベテラン、個別株は2026年から開始
・銀行預金: 約970万円（投資可能額: 約670万円）\n\n`

  if (policy && !policy.includes('まだ方針')) {
    ctx += `【現在の投資方針】\n${policy}\n\n`
  }

  ctx += `【ポートフォリオ概要（※全て万円単位・合計は1億円未満）】
・合計: ${toMan(total)}（インデックス投信 ${toMan(indexTotal)} ＋ 個別株 ${toMan(stockTotal)}）\n\n`

  ctx += `【保有銘柄明細（この価格は信頼できる最新データ・AIは自力換算しないこと）】\n`
  holdings.forEach(h => {
    const price = h.current_price != null ? `現在値${h.current_price.toLocaleString()}円` : '現在値不明'
    const evalMan = h.evaluation_amount != null ? `評価額${toMan(h.evaluation_amount)}` : '評価額不明'
    const gain = h.unrealized_gain != null ? `損益${h.unrealized_gain >= 0 ? '+' : ''}${toMan(h.unrealized_gain)}` : '損益不明'
    ctx += `・${h.name}(${h.ticker ?? 'インデックス'}) ${h.account_type === 'tokutei' ? '特定口座' : 'NISA'}: ${price} ${evalMan} ${gain}\n`
  })

  if (realtimePrices && Object.keys(realtimePrices).length > 0) {
    ctx += `\n【リアルタイム株価（Yahoo Finance取得・計算に使用すること）】\n`
    for (const [ticker, price] of Object.entries(realtimePrices)) {
      if (!holdings.some(h => h.ticker === ticker)) {
        ctx += `・${ticker}: ${price.toLocaleString()}円\n`
      }
    }
  }

  if (tsumitate.length > 0) {
    ctx += `\n【NISA積立設定（毎月${toMan(tsumitateTotal)}）】\n`
    tsumitate.forEach((t: { name: string; monthly_amount: number }) => {
      ctx += `・${t.name}: 月${t.monthly_amount.toLocaleString()}円\n`
    })
  }

  if (rules.length > 0) {
    ctx += `\n【銘柄別の保有目的・売買ルール（この内容を前提に話すこと）】\n`
    rules.forEach(r => {
      ctx += `・${r.name}(${r.ticker})\n`
      if (r.purpose) ctx += `  目的: ${r.purpose}\n`
      if (r.sell_conditions) ctx += `  売却条件: ${r.sell_conditions}\n`
      if (r.timeline_notes) ctx += `  タイムライン: ${r.timeline_notes}\n`
      if (r.dividend_notes) ctx += `  配当: ${r.dividend_notes}\n`
      if (r.raw_agreement) ctx += `  合意: ${r.raw_agreement}\n`
    })
  }

  if (orders.length > 0) {
    ctx += `\n【執行中の注文】\n`
    orders.forEach(o => {
      ctx += `・${o.name} ${o.order_type === 'sell' ? '売り' : '買い'}指値${o.price}円 ${o.quantity}株 期限${o.deadline}\n`
    })
  }

  return ctx
}

// ─── 確定済み決定事項の抽出 ──────────────────────────────────────
async function extractConfirmedDecisions(
  history: Array<{ role: string; content: string }>
): Promise<string> {
  if (history.length < 4) return ''
  const historyText = history.slice(-20)
    .map(m => `${m.role === 'user' ? 'ユーザー' : 'AI'}: ${m.content.slice(0, 300)}`)
    .join('\n')
  try {
    const result = await claudeGenerate({
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 400,
      messages: [{
        role: 'user',
        parts: [{ text: `以下の会話から「ユーザーとAIが合意・確定した決定事項」のみ箇条書きで最大8件抽出。
対象: 具体的な行動・数値合意（指値価格・株数・損切りラインなど）・ユーザーが明示した制約や優先順位。
対象外: 検討中の内容・AIの一方的提案・一般的な説明。
決定事項がなければ「なし」とだけ返す。箇条書きのみ。\n\n会話:\n${historyText}` }],
      }],
    })
    const trimmed = result.trim()
    return trimmed === 'なし' ? '' : trimmed
  } catch {
    return ''
  }
}

// ─── メインハンドラ ───────────────────────────────────────────────
export async function POST(req: Request) {
  const body = await req.json()
  const { question, mode, round1, history, imageData, imageType } = body

  const [realtimePrices, confirmedDecisions] = await Promise.all([
    question ? fetchMentionedPrices(question) : Promise.resolve({}),
    mode === 'main' && history?.length >= 4
      ? extractConfirmedDecisions(history)
      : Promise.resolve(''),
  ])

  const context = await getPortfolioContext(realtimePrices)

  if (mode === 'main') {
    const priorMessages: ClaudeMessage[] = (history ?? []).map(
      (m: { role: string; content: string }) => ({
        role: (m.role === 'user' ? 'user' : 'model') as 'user' | 'model',
        parts: [{ text: m.content }],
      })
    )

    const decisionBlock = confirmedDecisions
      ? `【この会話で確定した事項（以下に反する提案・計算は絶対にしないこと）】\n${confirmedDecisions}\n\n`
      : ''

    const textContent = `${decisionBlock}${context}\n\n質問: ${question}`
    if (imageData && imageType) {
      priorMessages.push({
        role: 'user',
        parts: [
          { inline_data: { mime_type: imageType as string, data: imageData } },
          { text: textContent },
        ],
      })
    } else {
      priorMessages.push({ role: 'user', parts: [{ text: textContent }] })
    }

    const content = await claudeGenerate({
      model: 'claude-sonnet-4-6',
      maxTokens: 1200,
      system: MAIN_SYSTEM,
      messages: priorMessages,
    })
    return NextResponse.json({ content })
  }

  if (mode === 'round1') {
    const responses = await Promise.all(
      Object.entries(PERSONAS).map(async ([id, persona]) => {
        const content = await claudeGenerate({
          model: 'claude-haiku-4-5-20251001',
          maxTokens: 400,
          system: persona.system,
          messages: [{ role: 'user', parts: [{ text: `${context}\n\n質問: ${question}` }] }],
        })
        return { persona: id, label: persona.label, content }
      })
    )
    return NextResponse.json({ responses })
  }

  if (mode === 'round2' && round1) {
    const othersText = round1.map((r: { label: string; content: string }) => `【${r.label}の意見】\n${r.content}`).join('\n\n')
    const persona = PERSONAS.contrarian
    const content = await claudeGenerate({
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 400,
      system: persona.system,
      messages: [{
        role: 'user',
        parts: [{ text: `${context}\n\n質問: ${question}\n\n他のAIの意見:\n${othersText}\n\nあなたの立場から補足・反論・同意を述べてください。` }],
      }],
    })
    return NextResponse.json({ responses: [{ persona: 'contrarian', label: persona.label, content }] })
  }

  if (mode === 'synthesis' && round1 && body.round2) {
    const allOpinions = [
      ...round1.map((r: { label: string; content: string }) => `【${r.label}（初回）】\n${r.content}`),
      ...body.round2.map((r: { label: string; content: string }) => `【${r.label}（再考）】\n${r.content}`),
    ].join('\n\n')

    const content = await claudeGenerate({
      model: 'claude-sonnet-4-6',
      maxTokens: 1000,
      system: MAIN_SYSTEM,
      messages: [{
        role: 'user',
        parts: [{ text: `${context}\n\n質問: ${question}\n\n【円卓での議論】\n${allOpinions}\n\n統合見解と具体的な結論をまとめてください。` }],
      }],
    })
    return NextResponse.json({ content })
  }

  return NextResponse.json({ error: 'invalid mode' }, { status: 400 })
}
