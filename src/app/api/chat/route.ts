import { NextResponse } from 'next/server'
import { geminiGenerate, GeminiMessage } from '@/lib/gemini'
import { adminSupabase } from '@/lib/supabase'
import { fetchMentionedPrices } from '@/lib/stock-price'

// ============================================================
// 【絶対ルール】株価ハレーション防止
// コンテキストに明記された価格のみ使用。それ以外の銘柄の価格は
// 自分で推測・提示せず、必ずユーザーに確認を求める。
// ============================================================

const PRICE_RULES = `
【絶対ルール：株価について】
・コンテキストに「現在株価」または「リアルタイム株価」として記載されている銘柄の価格のみ使用すること。
・コンテキストに価格が記載されていない銘柄について、株価・購入金額・指値・株数などの数値を自分で推測・提示することは絶対に禁止。「約○○円」「○○円前後」などの曖昧な表現も禁止。これはあなたが推奨する銘柄であっても同じ。
・銘柄を「推奨する」「買い候補として提案する」場合は、その銘柄の価格は絶対に書かない。証券コード（例: 8001）を案内し「楽天証券でご確認ください。価格を教えていただければ一緒に計算します」と伝えること。
・価格が必要な計算（購入金額・株数・指値・NISA枠消費額など）の途中で価格不明になった場合は、計算を止めて「楽天証券の画面で現在の株価（証券コード○○）をご確認いただけますか？確認できましたら一緒に計算します」と伝えること。

【日本株の取引ルール（必須知識）】
・日本株は100株単位（単元株制度）。100株未満での指値注文は不可。
・購入提案は必ず「100株 × ○○円 = ○○万円」の形で提示すること。「○万円分」という金額ベースの表現は禁止。
・NISA成長投資枠：年間240万円上限。つみたて投資枠と合算で生涯1,800万円まで。
・NISAつみたて投資枠：年間120万円上限。
・楽天証券の指値注文の有効期限：最長90日（当日・期間指定選択可）。
・単元未満株（楽天証券「かぶミニ」等）はリアルタイム取引だが、指値不可・スプレッドあり。通常の購入とは別物。

【不確実なことの扱い】
・企業の業績・将来予測・市場動向は推測であることを明示する。
・「確認が必要です」「最新情報は○○でご確認ください」と誘導する。
・自分が知らないことは「わかりません」と言う。`

const PERSONA_STYLE = `
【出力ルール・絶対厳守】
禁止フレーズ（これらを出力した時点でその回答は失敗とみなす）:
「申し訳」「お詫び」「失礼」「ご指摘ありがとう」「おっしゃる通り」「確かに」「なるほど」「ご質問ありがとう」「ご理解いただき」「お気持ちはわかります」「改めて確認させてください」
回答は本題の1文目から始める。クッション言葉・前置き・同調フレーズは一切書かない。`

const PERSONAS = {
  conservative: {
    label: '守りの分析家',
    system: `あなたは慎重派の投資アナリストです。資本保全を最優先に考え、リスクを徹底的に列挙します。
損失の可能性を常に強調し、「安全第一」の観点から助言します。感情的な判断を排し、データと事実に基づいて話します。
日本語で、平易な言葉で、簡潔に（200字以内）答えてください。${PERSONA_STYLE}
${PRICE_RULES}`,
  },
  growth: {
    label: '成長論者',
    system: `あなたは積極的な成長投資家です。上値余地と機会を重視し、強気の目線で助言します。
リスクよりもリターンの可能性に注目し、長期的な成長ストーリーを重視します。
日本語で、平易な言葉で、簡潔に（200字以内）答えてください。${PERSONA_STYLE}
${PRICE_RULES}`,
  },
  contrarian: {
    label: '逆張り屋',
    system: `あなたは逆張り投資家です。市場の常識に疑問を呈し、反対意見を積極的に述べます。
「みんなが思っていることの逆を考えよ」が信条です。思い込みを崩す役割を担います。
日本語で、平易な言葉で、簡潔に（200字以内）答えてください。${PERSONA_STYLE}
${PRICE_RULES}`,
  },
  longterm: {
    label: '長期思考家',
    system: `あなたは長期投資家です。5年・10年スパンで物事を考え、短期のノイズを無視します。
配当・複利・時間の力を重視し、「今日の判断が10年後にどう影響するか」を軸に話します。
日本語で、平易な言葉で、簡潔に（200字以内）答えてください。${PERSONA_STYLE}
${PRICE_RULES}`,
  },
}

async function getPortfolioContext(realtimePrices?: Record<string, number>): Promise<string> {
  const [holdingsRes, ordersRes, tsumitateRes, policyRes, judgmentsRes, rulesRes] = await Promise.all([
    adminSupabase.from('holdings').select('*'),
    adminSupabase.from('orders').select('*').eq('status', 'active'),
    adminSupabase.from('tsumitate_settings').select('*'),
    adminSupabase.from('investment_policy').select('content').limit(1).single(),
    adminSupabase.from('ai_judgment_log').select('name,ticker,judgment_type,ai_summary,price_at_time,created_at').order('created_at', { ascending: false }).limit(15),
    adminSupabase.from('holding_rules').select('ticker,name,purpose,policy_basis,sell_conditions,dividend_notes,timeline_notes,raw_agreement').eq('is_active', true),
  ])
  const holdings = holdingsRes.data ?? []
  const orders = ordersRes.data ?? []
  const tsumitate = tsumitateRes.data ?? []
  const policy = policyRes.data?.content ?? ''
  const judgments = judgmentsRes.data ?? []
  const rules = rulesRes.data ?? []
  const total = holdings.reduce((s, h) => s + (h.evaluation_amount ?? 0), 0)
  const tsumitateTotal = tsumitate.reduce((s: number, t: { monthly_amount: number }) => s + t.monthly_amount, 0)

  let ctx = `【ユーザーの現在の状況】\n`
  ctx += `・生年: 1975年（50歳）、子ども: 小4\n`
  ctx += `・投資目標: 15年後（65歳時）にDC別で3,000万円\n`
  ctx += `・投資経験: インデックス積立は長年のベテラン、個別株は2026年から始めたばかり\n`
  ctx += `・銀行預金: 約970万円（投資可能額: 約670万円）\n\n`

  if (policy && !policy.includes('まだ方針')) {
    ctx += `【現在の投資方針】\n${policy}\n\n`
  }

  ctx += `【保有銘柄（楽天証券、計約${Math.round(total / 10000)}万円）― この価格は信頼できる最新データ】\n`
  holdings.forEach(h => {
    const price = h.current_price != null ? `現在値${h.current_price.toLocaleString()}円` : '現在値不明'
    ctx += `・${h.name}(${h.ticker}) ${h.account_type === 'tokutei' ? '特定口座' : 'NISA'}: `
    ctx += `${price} 評価額${h.evaluation_amount?.toLocaleString() ?? '不明'}円 `
    ctx += `損益${h.unrealized_gain != null ? (h.unrealized_gain >= 0 ? '+' : '') + h.unrealized_gain.toLocaleString() + '円' : '不明'}\n`
  })

  // リアルタイム取得した株価（保有外の銘柄を含む）
  if (realtimePrices && Object.keys(realtimePrices).length > 0) {
    ctx += `\n【リアルタイム株価（今回の質問内の証券コードをYahoo Financeから取得・計算に使用すること）】\n`
    for (const [ticker, price] of Object.entries(realtimePrices)) {
      // 保有銘柄と重複しない場合のみ表示
      const alreadyInHoldings = holdings.some(h => h.ticker === ticker)
      if (!alreadyInHoldings) {
        ctx += `・${ticker}: ${price.toLocaleString()}円（市場が閉じている場合は前回終値）\n`
      }
    }
  }

  if (tsumitate.length > 0) {
    ctx += `\n【NISA積立設定（毎月${tsumitateTotal.toLocaleString()}円）】\n`
    tsumitate.forEach((t: { name: string; monthly_amount: number }) => {
      ctx += `・${t.name}: 月${t.monthly_amount.toLocaleString()}円\n`
    })
  }

  // 各銘柄の保有ルール・目的（AIが現状を把握するための最重要情報）
  if (rules.length > 0) {
    ctx += `\n【各銘柄の保有目的・売買ルール（この内容を前提に話すこと）】\n`
    rules.forEach(r => {
      ctx += `・${r.name}(${r.ticker})\n`
      if (r.purpose) ctx += `  保有目的: ${r.purpose}\n`
      if (r.policy_basis) ctx += `  方針根拠: ${r.policy_basis}\n`
      if (r.sell_conditions) ctx += `  売却条件: ${r.sell_conditions}\n`
      if (r.timeline_notes) ctx += `  タイムライン: ${r.timeline_notes}\n`
      if (r.dividend_notes) ctx += `  配当メモ: ${r.dividend_notes}\n`
      if (r.raw_agreement) ctx += `  合意内容: ${r.raw_agreement}\n`
    })
  }

  if (orders.length > 0) {
    ctx += `\n【執行中の注文】\n`
    orders.forEach(o => {
      ctx += `・${o.name} ${o.order_type === 'sell' ? '売り' : '買い'}指値${o.price}円 ${o.quantity}株 期限${o.deadline}\n`
    })
  }

  if (judgments.length > 0) {
    const typeLabel: Record<string, string> = { hold: '保有継続', sell: '売却', buy: '買い増し', watch: '様子見', caution: '警戒' }
    ctx += `\n【過去のAI判断履歴（直近${judgments.length}件）】\n`
    ctx += `※ あなた自身が過去に下した判断です。その後の状況と照らし合わせ、必要なら前回の見解を修正・深化させてください。\n`
    judgments.forEach(j => {
      const date = new Date(j.created_at).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' })
      const price = j.price_at_time ? `（当時${j.price_at_time.toLocaleString()}円）` : ''
      ctx += `・[${date}] ${j.name}${j.ticker ? `(${j.ticker})` : ''}: ${typeLabel[j.judgment_type] ?? j.judgment_type}推奨${price} — ${j.ai_summary}\n`
    })
  }

  return ctx
}

// 会話履歴から確定済み決定事項をliteモデルで高速抽出
async function extractConfirmedDecisions(
  history: Array<{ role: string; content: string }>
): Promise<string> {
  if (history.length < 4) return ''
  // 最新20ターンを対象（古すぎる履歴は除外）
  const recent = history.slice(-20)
  const historyText = recent
    .map(m => `${m.role === 'user' ? 'ユーザー' : 'AI'}: ${m.content.slice(0, 300)}`)
    .join('\n')
  try {
    const result = await geminiGenerate({
      model: 'gemini-2.5-flash-lite',
      maxTokens: 400,
      timeoutMs: 8000,
      messages: [{
        role: 'user',
        parts: [{ text: `以下の投資相談の会話から「ユーザーとAIが合意・確定した具体的な決定事項」のみを箇条書きで最大8件抽出してください。

抽出対象：
- 具体的な行動・注文の合意（いつ・何を・いくらで・何株、など）
- ユーザーが明示した制約・優先順位（「これはサブテーマ」「第一目標は〜」など）
- 数値的に合意した水準（指値価格・損切りライン・購入株数など）

抽出しないもの：
- まだ検討中の内容・仮定の話
- AIの一方的な提案（ユーザーが同意していないもの）
- 一般的な説明・教育的な内容

決定事項がなければ「なし」と返してください。箇条書きのみ・他の文章不要。

会話:
${historyText}` }],
      }],
    })
    const trimmed = result.trim()
    return trimmed === 'なし' ? '' : trimmed
  } catch {
    return ''
  }
}

const MAIN_SYSTEM = `# 絶対禁止（これを破った回答は全て失敗）
以下のフレーズを出力することは厳禁。1語でも含まれていたらその回答は無効:
「申し訳」「お詫び」「失礼しました」「ご指摘ありがとう」「おっしゃる通り」「確かに」「なるほど」「ご質問ありがとう」「ご理解いただき」「お気持ちはわかります」「改めて」「先ほどはご」「重ね重ね」

# 出力スタイル（絶対厳守）
- **400字以内**で答える。超えそうなら箇条書きで圧縮する
- 本題の1文目から始める。クッション・前置き・同調フレーズは書かない
- 間違いを修正する場合は「修正:」と書いてすぐ正しい内容へ。謝罪なし
- コンテキストに書いてある情報をユーザーに再確認・再説明させない（保有目的・売買ルール・既出の合意事項は全てコンテキストにある）
- 曖昧な株価・金額は書かない（コンテキストにない銘柄の価格は「証券コードXXXXで確認してください」のみ）

# 役割
投資アドバイザー。守りの分析家・成長論者・逆張り屋・長期思考家の視点を統合して山田さん（50歳）の個別株投資をサポートする。
コンテキストの情報を全て読んだうえで回答すること。回答は具体的・実践的、必要なら箇条書き・数値を使う。

${PRICE_RULES}`

export async function POST(req: Request) {
  const body = await req.json()
  const { question, mode, round1, history, imageData, imageType } = body

  // 質問文から証券コードを検出してリアルタイム株価を取得
  // 会話履歴から確定済み決定事項を抽出（mainモードのみ、並列実行）
  const [realtimePrices, confirmedDecisions] = await Promise.all([
    question ? fetchMentionedPrices(question) : Promise.resolve({}),
    mode === 'main' && history?.length >= 4
      ? extractConfirmedDecisions(history)
      : Promise.resolve(''),
  ])

  const context = await getPortfolioContext(realtimePrices)

  if (mode === 'main') {
    const priorMessages: GeminiMessage[] = (history ?? []).map(
      (m: { role: string; content: string }) => ({
        role: (m.role === 'user' ? 'user' : 'model') as 'user' | 'model',
        parts: [{ text: m.content }],
      })
    )

    // 確定済み事項を最優先ブロックとしてコンテキスト冒頭に注入
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

    const content = await geminiGenerate({
      model: 'gemini-2.5-flash',
      maxTokens: 1200,
      system: MAIN_SYSTEM,
      messages: priorMessages,
    })
    return NextResponse.json({ content })
  }

  if (mode === 'round1') {
    const personaIds = Object.keys(PERSONAS)
    const responses = await Promise.all(
      personaIds.map(async id => {
        const persona = PERSONAS[id as keyof typeof PERSONAS]
        const content = await geminiGenerate({
          model: 'gemini-2.5-flash',
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
    const content = await geminiGenerate({
      model: 'gemini-2.5-flash',
      maxTokens: 400,
      system: persona.system,
      messages: [{
        role: 'user',
        parts: [{ text: `${context}\n\n質問: ${question}\n\n他のAIの意見:\n${othersText}\n\n上記の意見を読んだうえで、あなたの立場から補足・反論・同意を述べてください。` }],
      }],
    })
    return NextResponse.json({
      responses: [{ persona: 'contrarian', label: persona.label, content }],
    })
  }

  if (mode === 'synthesis' && round1 && body.round2) {
    const allOpinions = [
      ...round1.map((r: { label: string; content: string }) => `【${r.label}（初回）】\n${r.content}`),
      ...body.round2.map((r: { label: string; content: string }) => `【${r.label}（再考）】\n${r.content}`),
    ].join('\n\n')

    const content = await geminiGenerate({
      model: 'gemini-2.5-flash',
      maxTokens: 1000,
      system: MAIN_SYSTEM,
      messages: [{
        role: 'user',
        parts: [{ text: `${context}\n\n質問: ${question}\n\n【円卓での議論】\n${allOpinions}\n\n以上の議論を踏まえて、山田さんへの統合見解・具体的な結論をまとめてください。どの意見が重要か、何をすべきかを明確に示してください。` }],
      }],
    })
    return NextResponse.json({ content })
  }

  return NextResponse.json({ error: 'invalid mode' }, { status: 400 })
}
