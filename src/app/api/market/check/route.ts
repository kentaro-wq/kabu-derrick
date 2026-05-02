import { NextResponse } from 'next/server'
import { sendLineMessage } from '@/lib/line'

interface YahooChartMeta {
  regularMarketPrice: number
  previousClose: number
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
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) }
    )
    if (!res.ok) return null
    const data: YahooChartResult = await res.json()
    const meta = data.chart?.result?.[0]?.meta
    if (!meta) return null
    const changePct = meta.previousClose > 0
      ? ((meta.regularMarketPrice - meta.previousClose) / meta.previousClose) * 100
      : 0
    return { price: meta.regularMarketPrice, prevClose: meta.previousClose, changePct }
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

// 市場インデックスの急落チェックと暴落時パニック防止通知
export async function POST() {
  const [nikkei, topix] = await Promise.all([
    fetchIndex('^N225'),
    fetchIndex('^TOPX'),
  ])

  const nikkeiLevel = nikkei ? classifyLevel(nikkei.changePct) : 'none'
  const topixLevel = topix ? classifyLevel(topix.changePct) : 'none'

  // 2指標のうち悪い方を採用
  const levelOrder: CrashLevel[] = ['none', 'caution', 'drop', 'crash']
  const worstLevel = levelOrder[Math.max(levelOrder.indexOf(nikkeiLevel), levelOrder.indexOf(topixLevel))]

  const today = new Date().toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' })

  const indexLine = [
    nikkei ? `日経225: ${nikkei.price.toLocaleString()}円 (${nikkei.changePct >= 0 ? '+' : ''}${nikkei.changePct.toFixed(2)}%)` : null,
    topix ? `TOPIX: ${topix.price.toFixed(2)} (${topix.changePct >= 0 ? '+' : ''}${topix.changePct.toFixed(2)}%)` : null,
  ].filter(Boolean).join(' / ')

  if (worstLevel === 'none') {
    return NextResponse.json({ level: 'none', indexLine, notified: false })
  }

  // 暴落レベルに応じたメッセージ
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
  if (!cfg) return NextResponse.json({ level: worstLevel, indexLine, notified: false })
  const lineMsg = `${cfg.icon} マイ株デリック 市場${cfg.headline}\n${today}\n\n${indexLine}\n\n${cfg.guidance}`

  await sendLineMessage(lineMsg)

  return NextResponse.json({
    level: worstLevel,
    indexLine,
    nikkei,
    topix,
    notified: true,
  })
}
