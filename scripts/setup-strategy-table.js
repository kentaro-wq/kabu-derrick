const fs = require('fs')
const path = require('path')
const { createClient } = require('@supabase/supabase-js')

const rootDir = path.join(__dirname, '..')
const sqlPath = path.join(rootDir, 'strategy_proposals_table.sql')
const envPath = path.join(rootDir, '.env.local')
const sql = fs.readFileSync(sqlPath, 'utf8')

function loadEnv(filePath) {
  const env = {}
  if (!fs.existsSync(filePath)) return env
  const text = fs.readFileSync(filePath, 'utf8')
  text.split(/\n/).forEach(line => {
    const match = line.match(/^([^=#]+)=(.*)$/)
    if (!match) return
    const key = match[1].trim()
    let value = match[2].trim()
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1)
    env[key] = value
  })
  return env
}

const env = loadEnv(envPath)
const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY

console.log('=== strategy_proposals テーブル作成 SQL ===\n')
console.log(sql)
console.log('\n=== 実行手順 ===')
console.log('1. Supabase コンソールにログインする')
console.log('2. SQL エディタを開く')
console.log('3. 上記 SQL をコピーして実行する')
console.log('\n環境変数が未設定の場合は .env.example を参考に .env.local に追加してください。')

if (!supabaseUrl || !anonKey) {
  console.log('\n=== 注意 ===')
  console.log('NEXT_PUBLIC_SUPABASE_URL または NEXT_PUBLIC_SUPABASE_ANON_KEY が .env.local にありません。')
  process.exit(0)
}

const supabase = createClient(supabaseUrl, anonKey)

;(async () => {
  try {
    const { error, status, data } = await supabase.from('strategy_proposals').select('id').limit(1)
    if (error) {
      if (status === 404) {
        console.log('\n=== 状態チェック ===')
        console.log('strategy_proposals テーブルは存在しません。上記 SQL を実行してください。')
      } else {
        console.log('\n=== 状態チェック ===')
        console.log('テーブルチェック中にエラーが発生しました。')
        console.log('status:', status)
        console.log('message:', error.message)
      }
    } else {
      console.log('\n=== 状態チェック ===')
      console.log('strategy_proposals テーブルはすでに存在します。')
      console.log('サンプル行:', JSON.stringify(data, null, 2))
    }
  } catch (err) {
    console.log('\n=== 例外 ===')
    console.log(err.message)
  }

  if (!serviceRoleKey || serviceRoleKey === 'your-service-role-key-here') {
    console.log('\n=== 注意 ===')
    console.log('SUPABASE_SERVICE_ROLE_KEY が設定されていないかプレースホルダーのままです。')
    console.log('自動テーブル作成はこのスクリプトではサポートしていません。')
  }
})()
