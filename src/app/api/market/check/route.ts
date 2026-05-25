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

async function runOvernight() {
  const [sp500, nasdaq, dow, n225fut] = await Promise.all([
    fetchIndex('^GSPC'),  // S&P500
    fetchIndex('^IXIC'),  // NASDAQ
    fetchIndex('^DJI'),   // ダウ
    fetchNikkeiFuture(),  // CME日経225先物（複数シンボルフォールバック）
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

  const lineMsg = [
    `${icon} マイ株デリック ${headline}`,
    today,
    '',
    `【先物・米市場】`,
    futLine ?? '日経先物: 取得失敗',
    usLine || '米市場: 取得失敗',
    '',
    guidance,
  ].join('\n')

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
