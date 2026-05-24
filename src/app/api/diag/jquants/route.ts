/**
 * J-Quants 接続診断（一時的）
 * 認証・データ取得が正常か確認するためのエンドポイント
 */
import { NextResponse } from 'next/server'

export const maxDuration = 30

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const code = searchParams.get('code') ?? '72030'
  const apiKey = process.env.JQUANTS_REFRESH_TOKEN

  const result: Record<string, unknown> = {
    hasKey: !!apiKey,
    keyLength: apiKey?.length ?? 0,
  }

  if (!apiKey) {
    return NextResponse.json(result)
  }

  // 1. 日付指定なし
  try {
    const res1 = await fetch(`https://api.jquants.com/v1/prices/daily_quotes?code=${code}`, {
      headers: { 'X-API-Key': apiKey },
      signal: AbortSignal.timeout(10000),
    })
    const text1 = await res1.text()
    result.noDate = {
      status: res1.status,
      bodyLength: text1.length,
      bodyHead: text1.slice(0, 300),
    }
  } catch (e) {
    result.noDate = { error: String(e) }
  }

  // 2. 過去6ヶ月の範囲指定
  const to = new Date()
  const from = new Date()
  from.setDate(from.getDate() - 180)
  const fromStr = from.toISOString().slice(0, 10)
  const toStr = to.toISOString().slice(0, 10)
  try {
    const res2 = await fetch(
      `https://api.jquants.com/v1/prices/daily_quotes?code=${code}&from=${fromStr}&to=${toStr}`,
      { headers: { 'X-API-Key': apiKey }, signal: AbortSignal.timeout(10000) }
    )
    const text2 = await res2.text()
    result.withDate = {
      status: res2.status,
      from: fromStr,
      to: toStr,
      bodyLength: text2.length,
      bodyHead: text2.slice(0, 300),
    }
  } catch (e) {
    result.withDate = { error: String(e) }
  }

  // 3. /v1/listed/info — 全プラン共通の上場銘柄一覧
  try {
    const res3 = await fetch(`https://api.jquants.com/v1/listed/info?code=${code}`, {
      headers: { 'X-API-Key': apiKey },
      signal: AbortSignal.timeout(10000),
    })
    result.listedInfo = {
      status: res3.status,
      bodyHead: (await res3.text()).slice(0, 300),
    }
  } catch (e) {
    result.listedInfo = { error: String(e) }
  }

  // 4. 試しに refresh_token として使ってみる
  try {
    const res4 = await fetch(
      `https://api.jquants.com/v1/token/auth_refresh?refreshtoken=${encodeURIComponent(apiKey)}`,
      { method: 'POST', signal: AbortSignal.timeout(10000) }
    )
    result.asRefreshToken = {
      status: res4.status,
      bodyHead: (await res4.text()).slice(0, 300),
    }
  } catch (e) {
    result.asRefreshToken = { error: String(e) }
  }

  // 5. 過去12週間以前の日付で試す（Free plan 制限）
  const oldTo = new Date()
  oldTo.setDate(oldTo.getDate() - 90)  // 90日前
  const oldFrom = new Date(oldTo)
  oldFrom.setDate(oldFrom.getDate() - 90)
  try {
    const res5 = await fetch(
      `https://api.jquants.com/v1/prices/daily_quotes?code=${code}&from=${oldFrom.toISOString().slice(0,10)}&to=${oldTo.toISOString().slice(0,10)}`,
      { headers: { 'X-API-Key': apiKey }, signal: AbortSignal.timeout(10000) }
    )
    result.oldDateRange = {
      status: res5.status,
      from: oldFrom.toISOString().slice(0,10),
      to: oldTo.toISOString().slice(0,10),
      bodyHead: (await res5.text()).slice(0, 300),
    }
  } catch (e) {
    result.oldDateRange = { error: String(e) }
  }

  return NextResponse.json(result)
}
