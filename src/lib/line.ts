const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN!
const USER_ID = process.env.LINE_USER_ID!

export async function sendLineMessage(message: string): Promise<boolean> {
  if (!CHANNEL_ACCESS_TOKEN || !USER_ID) return false
  try {
    const res = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({
        to: USER_ID,
        messages: [{ type: 'text', text: message }],
      }),
    })
    return res.ok
  } catch {
    return false
  }
}

export function formatImportantNotification(params: {
  title: string
  summary: string
  details: string[]
}): string {
  const { title, summary, details } = params
  const date = new Date().toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' })
  let msg = `📣 マイ株デリック ${title}\n${date}\n\n`
  if (summary) msg += `${summary}\n\n`
  if (details.length > 0) {
    msg += details.map(d => `・${d}`).join('\n') + '\n\n'
  }
  msg += `アプリで確認 →`
  return msg
}

/**
 * AI出口判定通知 — 売却/損切推奨が出た時のみ通知
 * 「継続」だけの日はノイズなので通知しない
 */
export function formatExitJudgmentAlert(judgments: Array<{
  name: string
  ticker: string
  decision: 'hold' | 'take_profit' | 'cut_loss'
  gainPct: number
  reasoning: string
  segment?: string
  strategy?: string
}>): string | null {
  const actionables = judgments.filter(j => j.decision !== 'hold')
  if (actionables.length === 0) return null

  const date = new Date().toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' })
  let msg = `🎯 AI出口判定 アラート\n${date}\n\n`
  msg += `売却/損切の推奨が出ています:\n\n`

  for (const j of actionables) {
    const icon = j.decision === 'take_profit' ? '💰' : '✂️'
    const action = j.decision === 'take_profit' ? '利確推奨' : '損切推奨'
    const gainStr = `${j.gainPct >= 0 ? '+' : ''}${j.gainPct.toFixed(1)}%`
    msg += `${icon} ${j.name}(${j.ticker})  ${gainStr}\n`
    msg += `【${action}】\n`
    msg += `理由: ${j.reasoning}\n\n`
  }

  msg += `楽天証券で実行をご検討ください。\nアプリで詳細確認 →`
  return msg
}

export function formatMorningReport(params: {
  totalAssets: number
  totalGain: number
  activeOrders: Array<{ name: string; deadline: string; daysLeft: number; price: number }>
  alerts: string[]
}): string {
  const { totalAssets, totalGain, activeOrders, alerts } = params
  const date = new Date().toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' })
  const gainSign = totalGain >= 0 ? '+' : ''

  let msg = `🌅 マイ株デリック 朝レポート\n${date}\n\n`
  msg += `📊 投資資産合計\n${totalAssets.toLocaleString()}円\n評価損益 ${gainSign}${totalGain.toLocaleString()}円\n`

  if (alerts.length > 0) {
    msg += `\n⚠️ アラート\n`
    alerts.forEach(a => { msg += `・${a}\n` })
  }

  if (activeOrders.length > 0) {
    msg += `\n📋 執行中の注文\n`
    activeOrders.forEach(o => {
      const urgency = o.daysLeft <= 3 ? '🔴' : o.daysLeft <= 7 ? '🟡' : '🟢'
      msg += `${urgency} ${o.name} 指値${o.price}円\n   期限まであと${o.daysLeft}日 (${o.deadline})\n`
    })
  }

  msg += `\nアプリで詳細確認 →`
  return msg
}
