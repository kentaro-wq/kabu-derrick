import { NextResponse } from 'next/server'
import { claudeGenerate, ClaudeMessage } from '@/lib/claude'
import { geminiGenerate } from '@/lib/gemini' // orders/parse等の画像解析で引き続き使用
import { adminSupabase } from '@/lib/supabase'
import { fetchMentionedPrices, fetchPrice, fetchYahooBars, extractTickers } from '@/lib/stock-price'
import { fetchMarketStats, fetchMultipleStockInfo, fetchEarningsInfo } from '@/lib/kabutan'
import { recalcNisaUsed } from '@/lib/nisa-sync'
import { getNisaStatus } from '@/lib/nisa'

// ─── 共通禁止ルール ───────────────────────────────────────────────
// BANNED_PHRASES: MAIN_SYSTEM・全ペルソナで共通使用
const BANNED_PHRASES = `禁止フレーズ（1語でも出力した時点でその回答は失敗）:
「申し訳」「お詫び」「失礼」「ご指摘ありがとう」「おっしゃる通り」「確かに」「なるほど」「ご質問ありがとう」「ご理解いただき」「お気持ちはわかります」「改めて」「重ね重ね」`

// ─── 株価・取引ルール ─────────────────────────────────────────────
const PRICE_RULES = `【株価ルール（絶対厳守）】
・コンテキスト内の株価（保有銘柄の現在値・リアルタイム株価）は株探/Yahoo Finance取得の最新値。これを信頼して積極的に使うこと。
・「楽天証券で確認してください」「リアルタイム価格をご確認ください」は禁止。コンテキストに価格がある銘柄は必ずその価格を使って答える。
・コンテキストに記載のない銘柄の株価を推測・提示するのは絶対禁止。その場合のみ「現在値を教えてください」と一言で止める。

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

# 事実と仮定の区別（最重要・このAIの信用の核）
- 数値には3種類ある: ①コンテキスト/DB由来の確定値 ②過去会話で本人が述べた値 ③どこにも無い未確認の値。①②は使ってよい。
- **③の未確認値を計算に使うときは、必ずその数字に「（仮・要確認）」と付け、結論を断定しない。** 例:「奨励金率」「持株会の月拠出額」「将来の積立増額」などコンテキストに無い数字。
- 重要な判断（移管・売却・配分・タイミング）が未確認値に依存するなら、**計算で押し切らず、先に「○○はいくらですか?」と1問だけ聞く。**
- 確定値とぼかすべき推定を混ぜない。「たぶん」「おそらく」で数字を作って表に入れない。無い数字は「未確認」と書く。
- ユーザーが「変だ」と気づける余地を残すことが最優先。もっともらしさより、出所の明示。

# 取引状態の区別（最重要・絶対に取り違えない）
- 銘柄には4つの状態がある: ①検討中（まだ何もしていない）②注文中（指値発注済・未約定）③保有中（約定済で現在持っている）④売却済。
- **状態を勝手に進めない。** 「7868どう思う?」は①検討中。これを「既に保有」「もう注文した」と前提して答えるのは重大な誤り。
- 状態の判定根拠は2つだけ: (a)下記コンテキストの【保有銘柄明細】に載っている=保有中 (b)【執行中の注文】に載っている=注文中。**どちらにも無ければ①検討中**として扱う。
- ユーザーが「買った」「約定した」「注文した」と明言していない限り、勝手に実行済みにしない。会話の勢いや過去の議論で「もう持っている前提」にしない。
- 迷ったら状態を上げる方ではなく下げる方（検討中扱い）に倒し、「まだ未購入という理解でよいか」を一言確認する。
- 既存の保有・注文をユーザーに再確認・再説明させないこと（出力スタイル）と、状態を勝手に進めないことは両立する: コンテキストに在る事実は使い、無い行動は仮定しない。

# トレード検証の規律（特定口座=判断検証フェーズ・以下を必ず守る）
- **損益計算は実際の約定価格基準で行う。** 成行注文・逆指値→成行は約定価格が想定より跳ねうる。
  例: 「トリガー600円→成行」が620〜650円で約定したら、損切り534円までの損失は-10%でなく-13〜-18%。
  「最大損失は-10%」と固定で言わず、**跳ねた場合の損失も併記**する。下が固定という主張は指値約定時のみ成立。
- **入口の前提（買う根拠）が未確認なら、執行設計の精緻化より先にそこを問う。**
  材料駆動銘柄(M&A報道等)では「その材料が今も生きているか」が買いの大前提。
  これが未確認のまま指値・トリガー・利確値の詰めに進むのは本末転倒。先に「材料は継続中か」を確認する。
- **ユーザーの言葉を方針に当てはめて正当化しない。** 「暴騰を拾うのが特定口座の意義」等と言われても、
  特定口座の定義は「購入/出口判断が運用に耐えるかの検証」。投機色が強い提案には「それは検証の趣旨からやや外れる」と一言添える。追認ではなく検証者の立場を保つ。
- **「それ本当に買うべきか」を一歩引いて問う役割を捨てない。** 執行アシスタントに終始せず、期待値・前提・代替案(見送り含む)を提示する。

# 約定・注文のDB自動更新について（重要）
- ユーザーが約定・注文を伝えると、システムが自動でDB（注文履歴・保有銘柄）を更新する
- 「楽天証券の注文画面で確認してください」「注文画面で操作してください」は禁止
- 画像から約定を確認したら「[銘柄]が[価格]円で約定しました。DB更新中です。」と伝えるだけでよい
- DB上に注文が残っていても、自動更新処理が動くので「手動操作が必要」とは言わない

# 市場データの活用
- ストップ高銘柄が多い = 市場全体が強気 = 上昇トレンド継続のサイン
- 売買代金ランキング上位の新規銘柄 = 機関投資家の参入兆候 = 仕込みチャンス検討
- ホットストック（約定回数多い銘柄） = 流動性高い ＆ ボラティリティ大きい傾向
- 市場心理が「強気」の日は、個別株の上値期待が高まる傾向
- 保有銘柄が売買代金ランキングに入れば「注目度上昇」のサイン

# 役割
投資アドバイザー。守りの分析家・成長論者・逆張り屋・長期思考家の視点を統合し、
山田さん（50歳）の個別株投資をサポートする。コンテキストを全て読んだうえで回答すること。

${PRICE_RULES}`

// ─── ポートフォリオコンテキスト生成 ─────────────────────────────
async function getPortfolioContext(realtimePrices?: Record<string, number>): Promise<string> {
  const [holdingsRes, ordersRes, tsumitateRes, policyRes, rulesRes, profileRes, marketStats] = await Promise.all([
    adminSupabase.from('holdings').select('*'),
    adminSupabase.from('orders').select('*').eq('status', 'active'),
    adminSupabase.from('tsumitate_settings').select('*'),
    adminSupabase.from('investment_policy').select('content').limit(1).single(),
    adminSupabase.from('holding_rules').select('ticker,name,purpose,policy_basis,sell_conditions,dividend_notes,timeline_notes,raw_agreement').eq('is_active', true),
    adminSupabase.from('profile').select('*').limit(1).single(),
    fetchMarketStats().catch(() => null),
  ])
  const holdings = holdingsRes.data ?? []
  const orders = ordersRes.data ?? []
  const tsumitate = tsumitateRes.data ?? []
  const policy = policyRes.data?.content ?? ''
  const rules = rulesRes.data ?? []
  const profile = profileRes.data ?? null

  const toMan = (yen: number) => `${Math.round(yen / 10000)}万円`
  const total = holdings.reduce((s, h) => s + (h.evaluation_amount ?? 0), 0)
  const tsumitateTotal = tsumitate.reduce((s: number, t: { monthly_amount: number }) => s + t.monthly_amount, 0)
  const indexTotal = holdings.filter(h => !h.ticker || !/^\d{4}$/.test(h.ticker)).reduce((s, h) => s + (h.evaluation_amount ?? 0), 0)
  const stockTotal = holdings.filter(h => h.ticker && /^\d{4}$/.test(h.ticker)).reduce((s, h) => s + (h.evaluation_amount ?? 0), 0)

  const now = new Date()
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000)
  const weekdays = ['日', '月', '火', '水', '木', '金', '土']
  const jstH = jst.getUTCHours()
  const jstM = jst.getUTCMinutes()
  const timeStr = `${String(jstH).padStart(2, '0')}:${String(jstM).padStart(2, '0')}`
  const dateStr = `${jst.getUTCFullYear()}年${jst.getUTCMonth() + 1}月${jst.getUTCDate()}日（${weekdays[jst.getUTCDay()]}） ${timeStr} JST`
  const isWeekday = jst.getUTCDay() >= 1 && jst.getUTCDay() <= 5
  const totalMin = jstH * 60 + jstM
  const isMarketOpen = isWeekday && ((totalMin >= 9 * 60 && totalMin < 11 * 60 + 30) || (totalMin >= 12 * 60 + 30 && totalMin < 15 * 60 + 30))
  const isPreMarket = isWeekday && totalMin >= 8 * 60 && totalMin < 9 * 60
  const isAfterMarket = isWeekday && totalMin >= 15 * 60 + 30 && totalMin < 16 * 60
  const marketStatus = !isWeekday
    ? '🔴 休場（土日）'
    : isPreMarket ? '🟡 取引前（寄付待ち）'
    : isMarketOpen
      ? (totalMin < 11 * 60 + 30 ? `🟢 前場（${11 * 60 + 30 - totalMin}分後に前引け）` : `🟢 後場（${15 * 60 + 30 - totalMin}分後に大引け）`)
    : isAfterMarket ? '🟡 取引後（PTSあり）'
    : totalMin >= 11 * 60 + 30 && totalMin < 12 * 60 + 30 ? '🟡 昼休み（後場待ち）'
    : '🔴 時間外'

  const bankBalance = profile?.bank_balance != null ? Number(profile.bank_balance) : null
  const cashReserve = profile?.cash_reserve != null ? Number(profile.cash_reserve) : null
  const investable = bankBalance != null && cashReserve != null ? Math.max(0, bankBalance - cashReserve) : null

  let ctx = `【現在日時】${dateStr}
【市場状況】${marketStatus}

【ユーザーの状況】
・山田さん、50歳（1975年生）、子ども小4
・投資目標: 15年後（65歳）にDC別・現金別で3,000万円以上（投資資産のみでカウント）
・iDeCo: 2026年5月申請済み（企業型DCと併用・掛け金上限2万円/月）
・投資経験: インデックス積立は長年のベテラン、個別株は2026年から開始
・銀行預金: ${bankBalance != null ? `${toMan(bankBalance)}` : '不明'}${cashReserve != null ? `（うち生活防衛 ${toMan(cashReserve)} は死守・投資可能額: ${investable != null ? toMan(investable) : '不明'}）` : ''}\n\n`

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
    const accountLabel =
      h.account_type === 'tokutei' ? '特定口座' :
      h.account_type === 'mochikabu' ? '持株会（売却には移管手続き必要・NISA・特定口座とは別管理）' :
      h.account_type === 'nisa_growth' ? 'NISA成長枠' :
      h.account_type === 'nisa_tsumitate' ? 'NISAつみたて枠' :
      h.account_type ?? 'その他'
    ctx += `・${h.name}(${h.ticker ?? 'インデックス'}) ${accountLabel}: ${price} ${evalMan} ${gain}\n`
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

  // NISA枠の使用状況（確定値・DB由来）。「枠がある前提」の幻想を防ぐため必ず明示する。
  // 楽天証券の表示と一致させる: 残り = 上限 − 利用済（積立予定は別建てで示す）。
  if (profile) {
    const growthLimit = Number(profile.nisa_growth_limit)
    const growthUsed = Number(profile.nisa_growth_used)
    const growthRemaining = Math.max(0, growthLimit - growthUsed)
    const tsumitateLimit = Number(profile.nisa_tsumitate_limit)
    const tsumitateUsed = Number(profile.nisa_tsumitate_used)
    const tsumitateRemaining = Math.max(0, tsumitateLimit - tsumitateUsed)
    const nisa = getNisaStatus(profile, tsumitateTotal)  // 積立予定・最終残の算出用
    ctx += `\n【NISA枠の使用状況（今年・DB確定値=楽天証券と一致。この数字だけを計算の前提にすること）】\n`
    ctx += `・成長枠: 年間上限${toMan(growthLimit)} / 利用済${toMan(growthUsed)}（注文中含む） → 残り ${toMan(growthRemaining)}\n`
    ctx += `・つみたて枠: 年間上限${toMan(tsumitateLimit)} / 利用済${toMan(tsumitateUsed)} → 残り ${toMan(tsumitateRemaining)}（うち積立予定${toMan(nisa.tsumitateScheduled)}を消化すると最終残${toMan(nisa.tsumitateRemaining)}）\n`
    ctx += `※ 年内に売っても年間枠は復活しない（簿価枠の復活は翌年）。NISA枠を使う提案は必ずこの残額の範囲内で行うこと。これを超える追加投入は不可と明言すること。\n`
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
    // 注文銘柄のうち保有銘柄にないものの現在値を取得
    const holdingTickers = new Set(holdings.map(h => h.ticker).filter(Boolean))
    const orderOnlyTickers = [...new Set(
      orders.map(o => o.ticker).filter((t): t is string => !!t && /^\d{4}$/.test(t) && !holdingTickers.has(t))
    )]
    const orderPrices: Record<string, number> = {}
    await Promise.all(
      orderOnlyTickers.map(async ticker => {
        const price = await fetchPrice(ticker)
        if (price != null) orderPrices[ticker] = price
      })
    )

    ctx += `\n【執行中の注文（現在値は株探/Yahoo Finance取得・この価格を使うこと）】\n`
    orders.forEach(o => {
      const currentPrice = o.ticker && orderPrices[o.ticker]
        ? `現在値${orderPrices[o.ticker].toLocaleString()}円 `
        : (o.ticker && holdingTickers.has(o.ticker) ? '' : '現在値不明 ')
      const diff = o.ticker && orderPrices[o.ticker] && o.price
        ? (() => {
            const pct = ((orderPrices[o.ticker] - o.price) / o.price * 100).toFixed(1)
            return `(指値まで${parseFloat(pct) >= 0 ? '+' : ''}${pct}%) `
          })()
        : ''
      ctx += `・${o.name}(${o.ticker ?? '-'}) ${o.order_type === 'sell' ? '売り' : '買い'}指値${o.price}円 ${o.quantity}株 期限${o.deadline} ${currentPrice}${diff}\n`
    })
  }

  // 市場統計の追加
  if (marketStats) {
    ctx += `\n【市場センチメント・ホットトピック】`
    ctx += `\n・市場心理: ${
      marketStats.marketSentiment === 'very-bullish' ? '非常に強気（ストップ高30銘柄以上）' :
      marketStats.marketSentiment === 'bullish' ? '強気（ストップ高15銘柄以上）' :
      marketStats.marketSentiment === 'neutral' ? 'ニュートラル' : '弱気'
    }`
    
    if (marketStats.stopUpCount > 0) {
      ctx += `\n・ストップ高銘柄: ${marketStats.stopUpCount}銘柄`
      if (marketStats.stopUpStocks && marketStats.stopUpStocks.length > 0) {
        const topStopUp = marketStats.stopUpStocks.slice(0, 5)
        ctx += ` (${topStopUp.map(s => `${s.ticker}:${s.changePct.toFixed(1)}%`).join(' ')})`
      }
    }

    if (marketStats.tradingVolumeRankings && marketStats.tradingVolumeRankings.length > 0) {
      ctx += `\n・売買代金ランキング Top 5:\n`
      marketStats.tradingVolumeRankings.slice(0, 5).forEach((r, i) => {
        ctx += `  ${i + 1}. ${r.ticker}(${r.name.slice(0, 8)}): ${r.changePct.toFixed(1)}% ${r.amount || ''}\n`
      })
    }

    if (marketStats.hotStocks && marketStats.hotStocks.length > 0) {
      ctx += `\n・活況銘柄 Top 5:\n`
      marketStats.hotStocks.slice(0, 5).forEach((h, i) => {
        ctx += `  ${i + 1}. ${h.ticker}(${h.name.slice(0, 8)}): ${h.changePct.toFixed(1)}%\n`
      })
    }
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

// ─── 約定検知・ポートフォリオ自動更新 ─────────────────────────────

type PortfolioAction =
  | { action: 'none' }
  | { action: 'order_placed'; name: string; ticker?: string | null; order_type: 'buy' | 'sell'; price: number | null; quantity: number | null; account_type: string; deadline?: string | null }
  | { action: 'buy_executed'; name: string; ticker?: string | null; quantity: number | null; price: number | null; account_type: string }
  | { action: 'sell_executed'; name: string; ticker?: string | null; quantity?: number | null; price?: number | null }

async function detectPortfolioAction(
  question: string,
  history: Array<{ role: string; content: string }>
): Promise<PortfolioAction> {
  // 直近8ターン＋今回の発言を結合してキーワード判定
  const recentMsgs = history.slice(-8)
  const allText = [
    ...recentMsgs.map(m => `${m.role === 'user' ? 'ユーザー' : 'AI'}: ${m.content.slice(0, 300)}`),
    `ユーザー: ${question}`,
  ].join('\n')

  // 「確定・完了」を示す言葉が直近にあるかを軽量チェック
  // 「反映して」「更新して」も含む（AIが前ターンで約定確認済みの場合に対応）
  const actionKeywords = [
    '注文', '指値', '発注', '約定', '買えた', '購入', '売れた', '売却', '利確', '損切',
    '入れた', '入れてきた', '置いてきた', 'してきた', 'しておいた', 'できた',
    '反映', '更新して', 'データに入れ', '登録して',
  ]
  if (!actionKeywords.some(k => allText.includes(k))) return { action: 'none' }

  // 見送り・中止の明示があれば抽出しない (相談が「進めない」結論に達したケース)。
  // 直近のユーザー発言＋今回の発言に否定・見送り語があれば none。
  // 注: ここで弾けなくても後段プロンプトと execute 層の重複防止が二重の安全網になる。
  const latestUserText = [
    ...recentMsgs.filter(m => m.role === 'user').slice(-2).map(m => m.content),
    question,
  ].join(' ')
  const cancelKeywords = [
    '見送', 'やめた', 'やめる', 'やめとく', 'やめておく', '見合わせ', '保留',
    '買わない', '売らない', '注文しない', '発注しない', 'キャンセル', '取り消',
    '見送り', '今回はパス', 'スルー', '様子見', 'まだ買わ', 'まだ売ら',
  ]
  if (cancelKeywords.some(k => latestUserText.includes(k))) return { action: 'none' }

  // 純粋な相談・検討の問いかけで終わっている場合は実行と誤認しない（DB書き込みの暴発防止）。
  // 「どう思う/どうだろう/検討/迷っている/まだ何もしていない」等が最新発言にあり、
  // 完了の明示（〜した/してきた/約定/反映して 等）が無ければ none に倒す二重安全網。
  const consultKeywords = [
    'どう思う', 'どうだろう', 'どうかな', 'どうか', '検討', '迷っ', 'いいかな', 'べきか',
    'まだ何も', 'まだ買って', 'まだ注文', 'これから', '考えている', '考えてる', '相談',
  ]
  const doneKeywords = ['した', 'してきた', 'しておいた', 'できた', '約定', '買えた', '売れた', '反映', '入れた', '登録して', '更新して']
  const looksConsult = consultKeywords.some(k => question.includes(k))
  const looksDone = doneKeywords.some(k => question.includes(k))
  if (looksConsult && !looksDone) return { action: 'none' }

  // 重複防止: DBの既存注文（active + 直近14日のexecuted）・保有・実現済みを取得
  const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()
  const [ordersActiveRes, ordersRecentRes, holdingsRes, realizedRes] = await Promise.all([
    adminSupabase.from('orders').select('name, ticker, price, quantity, order_type').eq('status', 'active'),
    adminSupabase.from('orders').select('name, ticker, price, quantity, order_type, status').eq('status', 'executed').gte('updated_at', cutoff),
    adminSupabase.from('holdings').select('name, ticker, account_type'),
    adminSupabase.from('realized_trades').select('name, ticker, sell_date').gte('sell_date', cutoff.slice(0, 10)),
  ])
  const existingOrders = [
    ...(ordersActiveRes.data ?? []).map(o => `${o.name} ${o.order_type === 'buy' ? '買い' : '売り'} ${o.price}円 ${o.quantity}株（注文中）`),
    ...(ordersRecentRes.data ?? []).map(o => `${o.name} ${o.order_type === 'buy' ? '買い' : '売り'} ${o.price}円 ${o.quantity}株（14日以内に約定済み・再登録不可）`),
  ].join(' / ')
  const existingHoldings = (holdingsRes.data ?? []).map(h => `${h.name}(${h.account_type})`).join(' / ')
  const recentSold = (realizedRes.data ?? []).map(r => `${r.name}（${r.sell_date}売却済み・再登録不可）`).join(' / ')

  const today = new Date().toISOString().slice(0, 10)
  const defaultDeadline = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

  try {
    const result = await claudeGenerate({
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 300,
      messages: [{
        role: 'user',
        parts: [{ text: `以下の会話から、ユーザーが実際に「完了・確定した」取引行動を1件だけJSONで抽出。

【抽出ルール】
- 「〜した」「〜してきた」「〜できた」「〜しておいた」など完了形のみ対象
- 「〜しようかな」「〜どう思う？」「〜検討中」は対象外（まだ実行していない）
- 【最重要】相談の結論が「見送り」「やめる」「買わない」「売らない」「様子見」「保留」なら、過去にどれだけ価格や株数を議論していても必ず {"action":"none"}。検討の途中経過を注文と誤認しないこと
- 【最重要】1件の注文について確認スクショや会話を複数回繰り返している場合でも、抽出するのは「最終的に確定した1件」のみ。同じ注文を何度も別件として抽出しない。下記【登録済み注文】に同一銘柄・同方向が既にあれば原則 {"action":"none"}（価格・株数の訂正がある場合のみ同一銘柄を再抽出してよい）
- 会話の流れから銘柄・価格・株数・口座を推測してよい
- 既に登録済みの注文・約定済み・保有中の内容は重複登録しない（「14日以内に約定済み」の注文は絶対に再登録しない）
- 既に保有中の銘柄をbuy_executedで再登録するのは「追加購入した」と明言された場合のみ
- sell_executedは「保有銘柄」に存在する銘柄に対してのみ有効。保有にない銘柄のsell_executedは{"action":"none"}
- 【重要】AIが直前のターンで「[銘柄]が約定」「[銘柄]を約定確認」と述べており、ユーザーが「反映して」「更新して」「データに入れて」「登録して」と言っている場合 → AIが確認した銘柄・価格・株数でbuy_executed/sell_executedを抽出する
- 「約定したね」「約定したよ」など、どの銘柄か不明な場合は直前の会話（AIのターン含む）から銘柄を特定する

【登録済み注文・約定済み（重複不可）】${existingOrders || 'なし'}
【現在の保有銘柄（口座付き）】${existingHoldings || 'なし'}
【直近14日の売却済み（再登録不可）】${recentSold || 'なし'}

【抽出形式】
注文した: {"action":"order_placed","name":"銘柄名","ticker":"4桁コードまたはnull","order_type":"buy|sell","price":指値価格またはnull,"quantity":株数またはnull,"account_type":"nisa_growth|tokutei","deadline":"${defaultDeadline}"}
買い約定: {"action":"buy_executed","name":"銘柄名","ticker":"4桁コードまたはnull","quantity":株数またはnull,"price":約定価格またはnull,"account_type":"nisa_growth|tokutei"}
売り約定: {"action":"sell_executed","name":"銘柄名","ticker":"4桁コードまたはnull","quantity":株数またはnull,"price":売却価格またはnull}
該当なし: {"action":"none"}

今日: ${today}
JSONのみ返答:

【会話】
${allText}` }],
      }],
    })
    const cleaned = result.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
    const parsed = JSON.parse(cleaned) as PortfolioAction
    // ticker 正規化: AI が文字列 "null"/"NULL"/"なし" や非4桁を返した場合に
    // 素通りして DB に混入し、後段の holdings 照合(ticker完全一致)を壊すのを防ぐ。
    // 4桁数字でなければ null に倒し、name ベース照合にフォールバックさせる。
    if ('ticker' in parsed && parsed.ticker != null) {
      const t = String(parsed.ticker).trim()
      parsed.ticker = /^\d{4}$/.test(t) ? t : null
    }
    return parsed
  } catch {
    return { action: 'none' }
  }
}

async function executePortfolioAction(action: PortfolioAction): Promise<string[]> {
  if (action.action === 'none') return []
  const logs: string[] = []

  if (action.action === 'order_placed') {
    const defaultDeadline = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    const typeLabel = action.order_type === 'buy' ? '買い' : '売り'
    const priceStr = action.price ? `${action.price.toLocaleString()}円` : '価格未定'
    const qtyStr = action.quantity ? `${action.quantity}株` : '株数未定'
    const acctLabel = action.account_type === 'nisa_growth' ? 'NISA成長' : '特定口座'

    // 重複防止: 同一銘柄・同売買方向の active 注文が既にあれば、新規INSERTせず
    // 最新内容で1件に集約する。
    // (1注文の確認スクショを複数回アップロードした際に、文脈が割れて
    //  毎ターン抽出され重複登録される問題への対策。exit_judgments/decision_log
    //  と同じ「DBレベル重複チェック」パターンを orders にも適用する)
    const dupQuery = adminSupabase
      .from('orders')
      .select('id, price, quantity')
      .eq('status', 'active')
      .eq('order_type', action.order_type)
    const dupFinal = action.ticker
      ? dupQuery.eq('ticker', action.ticker)
      : dupQuery.ilike('name', `%${action.name}%`)
    const { data: existingActive } = await dupFinal

    if (existingActive && existingActive.length > 0) {
      // 既存 active 注文を最新内容で更新（価格・株数が判明していれば反映）。
      // 余剰の重複行があればまとめて同内容に揃える（集約）。
      const ids = existingActive.map(o => o.id)
      const keepId = ids[0]
      await adminSupabase.from('orders').update({
        name: action.name,
        ticker: action.ticker ?? '',
        order_method: 'limit',
        price: action.price ?? existingActive[0].price,
        quantity: action.quantity ?? existingActive[0].quantity,
        account_type: action.account_type ?? 'nisa_growth',
        deadline: action.deadline ?? defaultDeadline,
        updated_at: new Date().toISOString(),
      }).eq('id', keepId)
      // 同一銘柄・同方向の余剰重複は cancelled にして記録を1本化
      const surplus = ids.slice(1)
      if (surplus.length > 0) {
        await adminSupabase.from('orders')
          .update({ status: 'cancelled', updated_at: new Date().toISOString() })
          .in('id', surplus)
      }
      logs.push(`✅ 既存の注文「${action.name}」を最新内容で更新（重複登録を防止${surplus.length > 0 ? `・重複${surplus.length}件を統合` : ''}）`)
      return logs
    }

    const { error } = await adminSupabase.from('orders').insert({
      name: action.name,
      ticker: action.ticker ?? '',
      order_type: action.order_type,
      order_method: 'limit',
      price: action.price,
      quantity: action.quantity,
      account_type: action.account_type ?? 'nisa_growth',
      deadline: action.deadline ?? defaultDeadline,
      status: 'active',
    })
    if (!error) {
      logs.push(`✅ 注文登録「${action.name}」${typeLabel}指値 ${priceStr} ${qtyStr}（${acctLabel}）`)
    } else {
      logs.push(`⚠️ 注文登録に失敗しました: ${error.message}`)
    }
  }

  if (action.action === 'buy_executed') {
    // 1. 対応する注文を約定済みに更新
    const baseOrderQuery = adminSupabase
      .from('orders')
      .update({ status: 'executed', updated_at: new Date().toISOString() })
      .eq('status', 'active')
      .eq('order_type', 'buy')
    const orderFinal = action.ticker
      ? baseOrderQuery.eq('ticker', action.ticker)
      : baseOrderQuery.ilike('name', `%${action.name}%`)
    const { error: orderErr } = await orderFinal
    if (!orderErr) logs.push(`✅ 注文「${action.name}」を約定済みに更新`)

    // 2. 保有を追加/更新（価格・株数が判明している場合のみ）
    if (action.quantity && action.price) {
      const qty = action.quantity
      const price = action.price
      const evalAmount = qty * price

      const baseHoldingQuery = adminSupabase
        .from('holdings')
        .select('*')
        .eq('account_type', action.account_type ?? 'nisa_growth')
      const holdingFinal = action.ticker
        ? baseHoldingQuery.eq('ticker', action.ticker)
        : baseHoldingQuery.ilike('name', `%${action.name}%`)
      const { data: existing } = await holdingFinal.maybeSingle()

      if (existing) {
        const prevQty = Number(existing.quantity ?? 0)
        const prevPurchase = Number(existing.purchase_price ?? price)
        const newQty = prevQty + qty
        const newAvg = newQty > 0 ? (prevQty * prevPurchase + qty * price) / newQty : price
        const newEval = newQty * price
        await adminSupabase.from('holdings').update({
          quantity: newQty,
          purchase_price: Math.round(newAvg),
          current_price: price,
          evaluation_amount: newEval,
          unrealized_gain: Math.round(newEval - newQty * newAvg),
          updated_at: new Date().toISOString(),
        }).eq('id', existing.id)
        logs.push(`✅ 保有「${action.name}」追加購入で更新（${prevQty}株→${newQty}株 平均@${Math.round(newAvg).toLocaleString()}円）`)
      } else {
        await adminSupabase.from('holdings').insert({
          name: action.name,
          ticker: action.ticker ?? '',
          account_type: action.account_type ?? 'tokutei',
          asset_type: 'stock',
          quantity: qty,
          purchase_price: price,
          current_price: price,
          evaluation_amount: evalAmount,
          unrealized_gain: 0,
          unrealized_gain_pct: 0,
        })
        logs.push(`✅ 保有「${action.name}」新規追加（${qty}株 @${price.toLocaleString()}円 計${Math.round(evalAmount / 10000)}万円）`)
      }
    } else {
      logs.push(`⚠️ 株数・価格が不明のため保有は手動更新してください`)
    }
  }

  if (action.action === 'sell_executed') {
    // 売り注文を約定済みに更新
    const baseOrderQuery = adminSupabase
      .from('orders')
      .update({ status: 'executed', updated_at: new Date().toISOString() })
      .eq('status', 'active')
      .eq('order_type', 'sell')
    const orderFinal = action.ticker
      ? baseOrderQuery.eq('ticker', action.ticker)
      : baseOrderQuery.ilike('name', `%${action.name}%`)
    const { error: orderErr } = await orderFinal
    if (!orderErr) logs.push(`✅ 売り注文「${action.name}」を約定済みに更新`)

    // 削除前に保有データを取得（損益計算用）
    const holdingQuery = adminSupabase.from('holdings').select('*')
    const holdingResult = action.ticker
      ? await holdingQuery.eq('ticker', action.ticker).maybeSingle()
      : await holdingQuery.ilike('name', `%${action.name}%`).maybeSingle()
    const holding = holdingResult.data

    // 保有を削除
    if (action.ticker) {
      await adminSupabase.from('holdings').delete().eq('ticker', action.ticker)
    } else {
      await adminSupabase.from('holdings').delete().ilike('name', `%${action.name}%`)
    }

    // 実現損益を記録
    const sellPrice = action.price ?? holding?.current_price ?? null
    const buyPrice = holding?.purchase_price ?? null
    const quantity = action.quantity ?? holding?.quantity ?? null
    if (sellPrice && quantity) {
      const gain = buyPrice ? (sellPrice - buyPrice) * quantity : null
      await adminSupabase.from('realized_trades').insert({
        ticker: action.ticker ?? holding?.ticker ?? '',
        name: action.name,
        sell_date: new Date().toISOString().slice(0, 10),
        sell_price: sellPrice,
        buy_price: buyPrice,
        quantity,
        account_type: holding?.account_type ?? null,
      })
      const gainStr = gain != null
        ? `（損益${gain >= 0 ? '+' : ''}${Math.round(gain / 10000)}万円）`
        : ''
      logs.push(`✅ 保有「${action.name}」を売却済みとして削除・収支に記録${gainStr}`)
    } else {
      logs.push(`✅ 保有「${action.name}」を売却済みとして削除`)
    }

    // NISA利用済を再計算
    recalcNisaUsed().catch(console.error)
  }

  return logs
}

// ─── ルール変更検知・自動保存 ─────────────────────────────────────

async function detectAndSaveRules(
  question: string,
  aiAnswer: string,
  history: Array<{ role: string; content: string }>
): Promise<string[]> {
  const ruleKeywords = [
    '損切', '利確', '売却条件', '保有目的', '売却ライン', '損切りライン',
    '目標株価', '保有方針', '配当目的', 'ホールド', 'まで保有',
    'になったら売', '以上になったら', 'にする', 'と決めた', 'ルールは',
    '方針は', '条件は', 'で売る', 'で利確', '超えたら売',
  ]
  const allText = question + ' ' + aiAnswer
  if (!ruleKeywords.some(k => allText.includes(k))) return []

  const recentText = [
    ...history.slice(-6).map(m => `${m.role === 'user' ? 'ユーザー' : 'AI'}: ${m.content.slice(0, 400)}`),
    `ユーザー: ${question}`,
    `AI: ${aiAnswer}`,
  ].join('\n')

  try {
    const result = await claudeGenerate({
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 600,
      messages: [{
        role: 'user',
        parts: [{ text: `以下の会話で「特定の銘柄に対して明確に合意・確定した運用ルール」を抽出してください。
曖昧な会話・一般論・まだ決まっていない内容は対象外です。
「〜にする」「〜と決めた」「〜で売る」など、具体的に確定した内容のみ抽出してください。

返却形式（JSONのみ。対象がなければ {"rules": []} を返す）:
{
  "rules": [
    {
      "ticker": "4桁の証券コード（わかる場合のみ。不明はnull）",
      "name": "銘柄名（必須）",
      "purpose": "保有目的（確定した場合のみ、不明はnull）",
      "sell_conditions": "売却・損切り条件（確定した場合のみ、不明はnull）",
      "dividend_notes": "配当に関する内容（不明はnull）",
      "timeline_notes": "期限付き方針（不明はnull）",
      "raw_agreement": "合意した要点を60字以内で（必須）"
    }
  ]
}

【会話】
${recentText}` }],
      }],
    })
    const cleaned = result.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
    const parsed = JSON.parse(cleaned) as {
      rules: Array<{
        ticker: string | null; name: string
        purpose?: string | null; sell_conditions?: string | null
        dividend_notes?: string | null; timeline_notes?: string | null
        raw_agreement: string
      }>
    }

    const logs: string[] = []
    for (const rule of parsed.rules ?? []) {
      if (!rule.name || !rule.raw_agreement) continue

      // tickerが不明な場合は保有銘柄テーブルから名前で補完
      let ticker = rule.ticker && /^\d{4}$/.test(rule.ticker) ? rule.ticker : null
      if (!ticker) {
        const { data: matched } = await adminSupabase
          .from('holdings').select('ticker').ilike('name', `%${rule.name.slice(0, 6)}%`).limit(1).single()
        if (matched?.ticker) ticker = matched.ticker
      }
      if (!ticker) continue // tickerなしは保存しない（onConflict keyが必要）

      // 既存ルールを取得
      const { data: existing } = await adminSupabase
        .from('holding_rules').select('*').eq('ticker', ticker).single()

      // 【重要】手動で設定済みのフィールドはAIで上書きしない
      // AIが書けるのは「まだ空のフィールド」のみ
      // ユーザーが手動で書いた内容を保護するため、既存値があればそちらを優先
      const { error } = await adminSupabase.from('holding_rules').upsert({
        ticker,
        name: rule.name,
        purpose: existing?.purpose || rule.purpose || null,
        sell_conditions: existing?.sell_conditions || rule.sell_conditions || null,
        dividend_notes: existing?.dividend_notes || rule.dividend_notes || null,
        timeline_notes: existing?.timeline_notes || rule.timeline_notes || null,
        raw_agreement: existing?.raw_agreement || rule.raw_agreement,
        is_active: true,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'ticker' })

      if (!error) logs.push(`📋 ルール保存「${rule.name}」: ${rule.raw_agreement}`)
    }
    return logs
  } catch {
    return []
  }
}

// ─── 銘柄リサーチコンテキスト生成 ─────────────────────────────────
// 相談に出た銘柄を AI が自力でデータ収集する。ユーザーのスクショ依存=恣意的な
// 検討材料の偏りを防ぐ目的。特定口座でイベント駆動を試す局面ほどデータ収集が重要。
// 質問 + 直近履歴から4桁ティッカーを抽出し、ファンダ(kabutan)+値動き(Yahoo)を取得する。

// 値動きサマリー: 3ヶ月bars から直近終値・高安・移動平均位置・期間騰落を算出
function summarizeBars(bars: Array<{ date: string; close: number }>): string | null {
  if (bars.length < 5) return null
  const closes = bars.map(b => b.close)
  const last = closes[closes.length - 1]
  const high = Math.max(...closes)
  const low = Math.min(...closes)
  const first = closes[0]
  const periodPct = ((last - first) / first) * 100
  // 直近高値からの位置（高値圏か押し目か）
  const fromHighPct = ((last - high) / high) * 100
  const fromLowPct = ((last - low) / low) * 100
  // 25日移動平均（営業日近似）
  const ma25 = closes.slice(-25).reduce((s, c) => s + c, 0) / Math.min(25, closes.length)
  const ma25Pos = ((last - ma25) / ma25) * 100
  return `3ヶ月騰落${periodPct >= 0 ? '+' : ''}${periodPct.toFixed(1)}% / 期間高値${high.toLocaleString()}円(現在は高値比${fromHighPct.toFixed(1)}%) / 期間安値${low.toLocaleString()}円(安値比+${fromLowPct.toFixed(1)}%) / 25日線${ma25Pos >= 0 ? '上' : '下'}方${Math.abs(ma25Pos).toFixed(1)}%`
}

async function buildResearchContext(
  question: string,
  history: Array<{ role: string; content: string }>,
  holdingTickers: Set<string>,
): Promise<string> {
  // 質問 + 直近4ターンのテキストからティッカー抽出
  const recentText = [question, ...history.slice(-4).map(m => m.content)].join(' ')
  const tickers = extractTickers(recentText)
  if (tickers.length === 0) return ''

  // 保有銘柄は既にポートフォリオ明細にあるので、新規検討銘柄を優先（最大4件に制限=レイテンシ対策）
  const fresh = tickers.filter(t => !holdingTickers.has(t)).slice(0, 4)
  if (fresh.length === 0) return ''

  const [infoMap, barsResults, earningsResults] = await Promise.all([
    fetchMultipleStockInfo(fresh).catch(() => ({})),
    Promise.allSettled(fresh.map(t => fetchYahooBars(t, '3mo'))),
    Promise.allSettled(fresh.map(t => fetchEarningsInfo(t))),
  ])

  const lines: string[] = []
  fresh.forEach((ticker, i) => {
    const info = (infoMap as Record<string, { price: number | null; changePct: number | null; per: number | null; pbr: number | null; dividendYield: number | null; revenueGrowthPct: number | null; profitGrowthPct: number | null; eps: number | null; dps: number | null }>)[ticker]
    const barsRes = barsResults[i]
    const bars = barsRes.status === 'fulfilled' ? barsRes.value.map(b => ({ date: b.date, close: b.close })) : []
    const earnRes = earningsResults[i]
    const earn = earnRes.status === 'fulfilled' ? earnRes.value : null

    const parts: string[] = []
    if (info) {
      if (info.per != null) parts.push(`PER${info.per}倍`)
      if (info.pbr != null) parts.push(`PBR${info.pbr}倍`)
      if (info.dividendYield != null) parts.push(`配当利回り${info.dividendYield}%`)
      if (info.revenueGrowthPct != null) parts.push(`売上前期比${info.revenueGrowthPct >= 0 ? '+' : ''}${info.revenueGrowthPct}%`)
      if (info.profitGrowthPct != null) parts.push(`経常益前期比${info.profitGrowthPct >= 0 ? '+' : ''}${info.profitGrowthPct}%`)
      if (info.eps != null) parts.push(`予想EPS${info.eps}円`)
      if (info.dps != null) parts.push(`予想配当${info.dps}円`)
    }
    const barSummary = summarizeBars(bars)
    if (parts.length === 0 && !barSummary) return  // データ皆無ならスキップ

    lines.push(`・${ticker}:`)
    if (parts.length > 0) lines.push(`  ファンダ: ${parts.join(' / ')}`)
    if (barSummary) lines.push(`  値動き: ${barSummary}`)
    if (earn && earn.daysToNext >= 0 && earn.daysToNext <= 30) {
      lines.push(`  決算: 次回${earn.nextEstimated}(あと${earn.daysToNext}日)・値動き急変注意`)
    }
  })

  if (lines.length === 0) return ''
  return `\n【検討中の未保有銘柄・自動収集データ（kabutan/Yahoo Finance取得）】\n※ 以下は【保有銘柄明細】にも【執行中の注文】にも無い=ユーザーは保有も注文もしていない検討段階の銘柄。データが詳しくても「保有している」と誤解しないこと。スクショ依存を避け自分で確認した数値なので分析に使ってよい。\n${lines.join('\n')}\n※ これらは確定データ。ただし材料・ニュース性（M&A報道等）は別途ユーザーに確認すること。\n`
}

// ─── メインハンドラ ───────────────────────────────────────────────
export async function POST(req: Request) {
  const body = await req.json()
  const { question, mode, round1, history, imageData, imageType } = body
  try {

  const [realtimePrices, confirmedDecisions, detectedAction] = await Promise.all([
    question ? fetchMentionedPrices(question) : Promise.resolve({}),
    mode === 'main' && history?.length >= 8
      ? extractConfirmedDecisions(history)
      : Promise.resolve(''),
    mode === 'main' ? detectPortfolioAction(question ?? '', history ?? []) : Promise.resolve({ action: 'none' as const }),
  ])

  // 約定処理を先に実行してからコンテキスト取得（更新後データをAIに渡す）
  const actionsLog = await executePortfolioAction(detectedAction)
  if (actionsLog.length > 0) recalcNisaUsed().catch(console.error) // 約定後にNISA利用済を再計算

  // 保有tickerを取得し、検討銘柄(保有外)のリサーチデータを自動収集
  const { data: holdingRows } = await adminSupabase.from('holdings').select('ticker')
  const holdingTickers = new Set((holdingRows ?? []).map(h => h.ticker).filter((t): t is string => !!t))
  const researchContext = mode === 'main'
    ? await buildResearchContext(question ?? '', history ?? [], holdingTickers).catch(() => '')
    : ''

  const context = await getPortfolioContext(realtimePrices) + researchContext

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

    const contextContent = `${decisionBlock}${context}`
    const questionContent = `\n\n質問: ${question}`
    if (imageData && imageType) {
      // 画像あり: キャッシュ分割なし（画像と一緒に送る）
      priorMessages.push({
        role: 'user',
        parts: [
          { inline_data: { mime_type: imageType as string, data: imageData } },
          { text: contextContent + questionContent },
        ],
      })
    } else {
      // テキストのみ: コンテキストをキャッシュ対象、質問は毎回送信
      priorMessages.push({
        role: 'user',
        parts: [
          { text: contextContent, cache_control: { type: 'ephemeral' } },
          { text: questionContent },
        ],
      })
    }

    const content = await claudeGenerate({
      model: 'claude-opus-4-8',  // メイン相談は系の核。最高知能で誤認・論理破綻を抑える
      maxTokens: 1200,
      system: MAIN_SYSTEM,
      messages: priorMessages,
    })

    // ルール変更を非同期で検知・保存（返答をブロックしない）
    const rulesLog = await detectAndSaveRules(question, content, history ?? [])

    return NextResponse.json({ content, actionsLog: [...actionsLog, ...rulesLog] })
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
      model: 'claude-opus-4-8',  // 円卓の統合見解もユーザーが読む結論。メインと同格に上げる
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
  } catch (err: unknown) {
    console.error('[chat] handler error:', err)
    return NextResponse.json({ error: 'internal server error' }, { status: 500 })
  }
}
