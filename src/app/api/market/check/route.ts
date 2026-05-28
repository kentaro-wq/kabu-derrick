import { NextRequest, NextResponse } from 'next/server'
import { sendLineMessage } from '@/lib/line'

interface YahooChartMeta {
  regularMarketPrice: number
  // Yahoo Finance API は `previousClose` を常に null で返す（仕様変更済み）
  // 代わりに `chartPreviousClose` を使う必要がある。range=2d で前営業日終値を取得。
  previousClose: number | null
  chartPreviousClose: number | null
  shortName?: string
}

interface YahooChartResult {
  chart: {
    result: Array<{ meta: YahooChartMeta }> | null
    error: unknown
  }
}

type CrashLevel = 'none' | 'caution' | 'drop' | 'crash'

async function fetchIndex(symbol: string): Promise<{ price: number; prevClose: number; changePct: number } | null> {
  try {
    // range=2d: chartPreviousClose が前営業日の終値になる（range=1dだと当日のopenになる）
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=2d`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) }
    )
    if (!res.ok) return null
    const data: YahooChartResult = await res.json()
    const meta = data.chart?.result?.[0]?.meta
    if (!meta) return null
    // previousClose は廃止済みのため chartPreviousClose を優先採用
    const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? 0
    if (!prevClose || prevClose <= 0 || !meta.regularMarketPrice) return null
    const changePct = ((meta.regularMarketPrice - prevClose) / prevClose) * 100
    return { price: meta.regularMarketPrice, prevClose, changePct }
  } catch {
    return null
  }
}

function classifyLevel(changePct: number): CrashLevel {
  if (changePct <= -5) return 'crash'
  if (changePct <= -3) return 'drop'
  if (changePct <= -2) return 'caution'
  return 'none'
}

// 寄り付き前ギャップ予測用: 先物 or 米株の絶対値変動を「ギャップ警戒」に分類
// 上方ギャップも下方ギャップも、寄り付き直後の値動きが荒れるため事前通知の価値がある
type GapLevel = 'none' | 'watch' | 'large'
function classifyGap(changePct: number): GapLevel {
  const abs = Math.abs(changePct)
  if (abs >= 3) return 'large'
  if (abs >= 1.5) return 'watch'
  return 'none'
}

function formatIndex(label: string, data: { price: number; changePct: number } | null, unit = ''): string | null {
  if (!data) return null
  const sign = data.changePct >= 0 ? '+' : ''
  const price = unit === '円'
    ? data.price.toLocaleString()
    : data.price.toFixed(2)
  return `${label}: ${price}${unit} (${sign}${data.changePct.toFixed(2)}%)`
}

// === intraday mode: 取引時間中・引け後の急落検知 ===
async function runIntraday() {
  const [nikkei, topix] = await Promise.all([
    fetchIndex('^N225'),
    fetchIndex('^TOPX'),
  ])

  const nikkeiLevel = nikkei ? classifyLevel(nikkei.changePct) : 'none'
  const topixLevel = topix ? classifyLevel(topix.changePct) : 'none'

  const levelOrder: CrashLevel[] = ['none', 'caution', 'drop', 'crash']
  const worstLevel = levelOrder[Math.max(levelOrder.indexOf(nikkeiLevel), levelOrder.indexOf(topixLevel))]

  const today = new Date().toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' })

  const indexLine = [
    formatIndex('日経225', nikkei, '円'),
    formatIndex('TOPIX', topix),
  ].filter(Boolean).join(' / ')

  if (worstLevel === 'none') {
    return NextResponse.json({ mode: 'intraday', level: 'none', indexLine, notified: false })
  }

  const levelConfig: Record<Exclude<CrashLevel, 'none'>, { icon: string; headline: string; guidance: string }> = {
    caution: {
      icon: '⚠️',
      headline: '市場急落警戒',
      guidance: '市場が軟調です。積立（NISA/DC）は継続が原則。個別株はルールに従い冷静に判断してください。',
    },
    drop: {
      icon: '🔴',
      headline: '市場急落',
      guidance: '大きな下落が出ています。底値での感情的な売りは禁物です。損切りはルールの数値に達した場合のみ実行してください。',
    },
    crash: {
      icon: '🚨',
      headline: '市場暴落',
      guidance: [
        'パニック売りは絶対に避けてください。',
        '① 積立（NISA/DC）は継続 — 安値を拾う機会です',
        '② 個別株の損切りはルールの数値に達した場合のみ',
        '③ 追加購入は現金余力がある場合のみ・分割で',
        '④ 全売りは最悪の選択です — まず1銘柄ずつ判断を',
      ].join('\n'),
    },
  }

  const cfg = levelConfig[worstLevel as Exclude<CrashLevel, 'none'>]
  if (!cfg) return NextResponse.json({ mode: 'intraday', level: worstLevel, indexLine, notified: false })
  const lineMsg = `${cfg.icon} マイ株デリック 市場${cfg.headline}\n${today}\n\n${indexLine}\n\n${cfg.guidance}`

  await sendLineMessage(lineMsg)

  return NextResponse.json({
    mode: 'intraday',
    level: worstLevel,
    indexLine,
    nikkei,
    topix,
    notified: true,
  })
}

// === overnight mode: 米市場引け後・日本寄り付き前のギャップ予測 ===
// 目的: 非取引時間に起きた変化を可視化し、寄り付き直後のパニック売買を防ぐ。
//       特に月曜朝は土日2日分の米市場変動が反映されるため、ここで一度状況確認を入れる。
// 日経225先物の取得: 複数シンボルでフォールバック
// Yahoo Finance のシンボルは時期により変動・廃止があるため冗長化
// 候補: NIY=F (JPY建てCME), NKD=F (USD建てCME), ^N225 (現物指数=休場時はnull)
async function fetchNikkeiFuture(): Promise<{ price: number; prevClose: number; changePct: number; source: string } | null> {
  const candidates: Array<{ symbol: string; label: string }> = [
    { symbol: 'NIY=F', label: 'CME日経225(JPY)' },
    { symbol: 'NKD=F', label: 'CME日経225(USD)' },
  ]
  for (const c of candidates) {
    const data = await fetchIndex(c.symbol)
    if (data && data.price > 0 && data.prevClose > 0) {
      return { ...data, source: c.label }
    }
  }
  return null
}

// 日本株主要銘柄 → 米国上場ADR のマッピング
// ADR は米国時間で取引されるため、米国引け値が翌朝の日本市場の予兆になる
// 出典: Yahoo Finance / SBI証券国際ADR一覧
const ADR_MAP: Record<string, { adr: string; name: string }> = {
  '7203': { adr: 'TM',    name: 'トヨタ' },
  '7267': { adr: 'HMC',   name: 'ホンダ' },
  '8001': { adr: 'ITOCY', name: '伊藤忠' },
  '8002': { adr: 'MARUY', name: '丸紅' },
  '8031': { adr: 'MITSY', name: '三井物産' },
  '8053': { adr: 'SSUMY', name: '住友商事' },
  '8058': { adr: 'MSBHY', name: '三菱商事' },
  '8306': { adr: 'MUFG',  name: '三菱UFJ' },
  '8316': { adr: 'SMFG',  name: '三井住友FG' },
  '8411': { adr: 'MFG',   name: 'みずほFG' },
  '8766': { adr: 'TKOMY', name: '東京海上HD' },
  '6758': { adr: 'SONY',  name: 'ソニー' },
  '6861': { adr: 'KYCCF', name: 'キーエンス' },
}

// 保有銘柄の ADR を取得して当日米株引け値からの変動を取得
async function fetchHoldingADRs(): Promise<Array<{
  ticker: string; name: string; adrSymbol: string; price: number; changePct: number
}>> {
  try {
    const { createClient } = await import('@supabase/supabase-js')
    const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)
    const { data: holdings } = await sb.from('holdings').select('ticker, name')
    const candidates = (holdings ?? []).filter(h => ADR_MAP[h.ticker])
    if (candidates.length === 0) return []

    const results = await Promise.all(
      candidates.map(async h => {
        const adr = ADR_MAP[h.ticker]
        const data = await fetchIndex(adr.adr)
        return data ? { ticker: h.ticker, name: h.name, adrSymbol: adr.adr, price: data.price, changePct: data.changePct } : null
      })
    )
    return results.filter((r): r is NonNullable<typeof r> => r !== null)
  } catch {
    return []
  }
}

async function runOvernight() {
  const [sp500, nasdaq, dow, n225fut, adrs] = await Promise.all([
    fetchIndex('^GSPC'),  // S&P500
    fetchIndex('^IXIC'),  // NASDAQ
    fetchIndex('^DJI'),   // ダウ
    fetchNikkeiFuture(),  // CME日経225先物（複数シンボルフォールバック）
    fetchHoldingADRs(),   // 保有銘柄のADR (米国引け値)
  ])

  // 寄り付きギャップの予測は「日経先物」を最重要視
  // 米株は背景情報として表示するが、判定は先物の動きで行う
  const futGapLevel = n225fut ? classifyGap(n225fut.changePct) : 'none'
  const usAvgChange = [sp500, nasdaq, dow]
    .map(x => x?.changePct)
    .filter((x): x is number => typeof x === 'number')
  const usAvg = usAvgChange.length > 0
    ? usAvgChange.reduce((a, b) => a + b, 0) / usAvgChange.length
    : 0
  const usGapLevel = classifyGap(usAvg)

  // 先物 or 米平均のどちらかが警戒以上なら通知
  const gapOrder: GapLevel[] = ['none', 'watch', 'large']
  const worstGap = gapOrder[Math.max(gapOrder.indexOf(futGapLevel), gapOrder.indexOf(usGapLevel))]

  const today = new Date().toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' })

  const usLine = [
    formatIndex('S&P500', sp500),
    formatIndex('NASDAQ', nasdaq),
    formatIndex('ダウ', dow),
  ].filter(Boolean).join(' / ')
  const futLine = n225fut
    ? formatIndex(`日経225先物(${n225fut.source})`, n225fut, '円')
    : null

  // 月曜朝判定（JST基準: getDay()はサーバーUTCだが、JST 7:00 = UTC 22:00 前日 のため曜日ズレあり）
  // ここでは「直近3日の変動」として全曜日で意味のある通知にする
  const now = new Date()
  const jstHour = (now.getUTCHours() + 9) % 24
  const jstDay = (now.getUTCDay() + (now.getUTCHours() + 9 >= 24 ? 1 : 0)) % 7
  const isMondayMorning = jstDay === 1 && jstHour < 12

  if (worstGap === 'none') {
    return NextResponse.json({
      mode: 'overnight',
      gap: 'none',
      usLine,
      futLine,
      notified: false,
    })
  }

  const direction = (n225fut?.changePct ?? usAvg) >= 0 ? '上方' : '下方'
  const icon = worstGap === 'large' ? '🚨' : '⚠️'
  const headline = `寄り付き${direction}ギャップ警戒`

  const guidance = [
    `${isMondayMorning ? '週明け月曜の寄り付き前です。土日明けで価格が大きく動く可能性があります。\n' : ''}寄り付き直後は値動きが荒くなります。`,
    direction === '下方'
      ? '・成行売り注文を入れている場合は、開始10〜15分は様子見が無難'
      : '・上昇に飛びついての高値掴みに注意。買いは押し目を待つ',
    '・損切り・利確ルールは「寄り付きの瞬間値」ではなく前日終値・始値で評価する方が安全',
    '・NISA枠の売却は枠の翌年復活なし。ギャップだけで判断しない',
  ].join('\n')

  // 保有銘柄ADR セクション (大きく動いた銘柄のみ表示)
  const adrLines = adrs
    .filter(a => Math.abs(a.changePct) >= 1)
    .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))
    .map(a => `${a.changePct >= 0 ? '🟢' : '🔴'} ${a.name}(${a.ticker}) ADR ${a.adrSymbol}: ${a.changePct >= 0 ? '+' : ''}${a.changePct.toFixed(2)}%`)

  const adrSection = adrLines.length > 0
    ? `\n【保有銘柄ADR (米国引け)】\n${adrLines.join('\n')}\n`
    : ''

  const lineMsg = [
    `${icon} マイ株デリック ${headline}`,
    today,
    '',
    `【先物・米市場】`,
    futLine ?? '日経先物: 取得失敗',
    usLine || '米市場: 取得失敗',
    adrSection.trim(),
    '',
    guidance,
  ].filter(Boolean).join('\n')

  await sendLineMessage(lineMsg)

  return NextResponse.json({
    mode: 'overnight',
    gap: worstGap,
    direction,
    sp500, nasdaq, dow, n225fut,
    isMondayMorning,
    notified: true,
  })
}

// 市場インデックスの急落チェック
// - 既定: intraday（日本市場の取引時間中・引け後）
// - ?mode=overnight: 米市場引け後・寄り付き前のギャップ予測
export async function POST(req: NextRequest) {
  const mode = req.nextUrl.searchParams.get('mode') === 'overnight' ? 'overnight' : 'intraday'
  if (mode === 'overnight') return runOvernight()
  return runIntraday()
}

// Vercel cron は GET でも叩けるように
export async function GET(req: NextRequest) {
  return POST(req)
}
