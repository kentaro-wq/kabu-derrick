This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Supabase テーブルのセットアップ

このアプリでは `strategy_proposals` テーブルを使って AI 戦略提案の履歴を保存します。リポジトリには `strategy_proposals_table.sql` が含まれているので、Supabase の SQL エディタで以下を実行してください。

```sql
create table if not exists strategy_proposals (
  id uuid primary key default uuid_generate_v4(),
  headline text,
  nisa_strategy text,
  tokutei_strategy text,
  next_actions text[],
  risk_notes text,
  raw_response text,
  created_at timestamptz not null default now()
);
```

テーブルが存在しない場合でも、提案生成自体は動作しますが、履歴保存と履歴表示機能は利用できません。

`npm run setup:strategy-table` を実行すると、SQL を表示すると同時に `strategy_proposals` テーブルの有無をチェックします。テーブルが存在しない場合は、Supabase の SQL エディタで上記 SQL を実行してください。

このスクリプトは `NEXT_PUBLIC_SUPABASE_URL` と `NEXT_PUBLIC_SUPABASE_ANON_KEY` を `.env.local` から読み込みます。自動作成には `SUPABASE_SERVICE_ROLE_KEY` が必要ですが、現在のスクリプトでは手動実行でのテーブル作成のみサポートしています。

## 環境変数の例

例ファイル `.env.example` を参考に、必要な環境変数を `.env` に設定してください。

## SQL の実行

テーブルを作成するには、Supabase コンソールの SQL エディタで `strategy_proposals_table.sql` を実行します。

または、以下のコマンドで補助スクリプトを表示できます。

```bash
npm run setup:strategy-table
```

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
