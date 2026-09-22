# Dialogos v3 セットアップ

販売版は Express + Supabase Auth/DB + Stripe + OpenAI Responses API。
Node.js 24で検証。好きな賢者で合計1日3往復（日本時間0時更新）のお試しを、Googleログインなしで提供します。匿名Cookie・Turnstile・DBの回数/予算制限を必要とし、誰でもAPIを無制限に呼べる方式ではありません。全14人の人格コピーはログイン不要・無制限。既存Googleアカウントの残高・履歴・契約管理も維持します。

## ローカル画面と自動テスト

```powershell
npm.cmd ci
npm.cmd run check
npm.cmd test
npm.cmd run build
npm.cmd start
```

http://127.0.0.1:5177/ を開きます。認証や決済が未設定でも、賢者・作例を閲覧し、人格を持ち帰れます。
サーバーはループバック専用。本番はVercel Functionと公開ビルドを使います。

設定ファイルがまだない場合だけ `.env.example` を `.env` にコピーし、値を設定してください。
既存の `.env` は上書きしないでください。`TRIAL_ENABLED=false`、`ANONYMOUS_TRIAL_ENABLED=false`、`BILLING_ENABLED=false`、`SALES_ENABLED=false` のまま準備を始めます。新規販売停止のためSALESはfalseを維持します。

## テスト環境の接続

1. 本番とは別のSupabaseで `supabase/schema.sql`、続けて `supabase/003_paid_v3.sql`、`supabase/004_socrates_trial.sql`、`supabase/005_daily_trial.sql`、`supabase/006_anonymous_trial.sql` を順に実行。
2. Supabase AuthのGoogleプロバイダーを設定し、アプリURLをリダイレクト先へ登録。
3. Supabase URL、公開anon key、サーバー専用service role keyを設定。
4. 既存の有料利用を検証する場合、Stripeのtest keyとテスト用Webhook secretを設定。新規販売は停止のまま。人格コピーと無料対話にStripeは不要。
5. OpenAIのこのアプリ専用プロジェクトキーを設定。
6. `ANONYMOUS_TRIAL.md` に従いTurnstileの2キー、署名用 `GUEST_SESSION_SECRET`、正しい `APP_URL` を設定。匿名識別・保存・全14人共有の日次3往復制限・日本時間0時の境界・無料予算停止を検証し、テスト環境だけ `TRIAL_ENABLED=true` と `ANONYMOUS_TRIAL_ENABLED=true` に変更。既存Google経路も回帰検証。
7. Stripe接続・金額・Webhook・購入者本人確認・有料予算制限を検証してから、テスト環境だけ `BILLING_ENABLED=true` に変更。

初期予算は全API合計で日次3ドル・月次30ドル。その内側で無料体験だけ日次0.50ドル・月次5ドルです。費用はUTC基準で予約中の最大額も含み、利用者枠の日本時間0時更新とは別です。計画原価では無料3往復を約37人分／日・370人分／月に提供する程度の設定です。同一利用者の翌日分も含み、ユニーク人数ではありません。コピーには生成APIを使いません。詳しくは `BUSINESS_MODEL.md`。

ブラウザが受け取る外部サービス設定はSupabase URL・公開anon key・Turnstileの公開site keyです。Stripe secret／OpenAI key／service role key／Turnstile secret／Cookie署名鍵はサーバー専用です。
`OPENAI_MODEL`、`FREE_COUNT`、旧モデルのtemperature設定はv3では使用しません。

## 実装の場所

- `lib/api-v3.js`：認証、価格、Checkout、Webhook、生成と費用管理。
- `shared/dialogue.js`：全14賢者の人格と短い対話状態。ブラウザからsystem promptは受け取りません。
- `supabase/003_paid_v3.sql`：残高・全体予算の予約、確定、復旧、重複決済防止。
- `supabase/004_socrates_trial.sql`：旧Google初回3往復・無料専用予算。旧未確定リクエストの精算に残す。
- `supabase/005_daily_trial.sql`：全14人共通の日本時間日別台帳・予約日固定・日次更新。003/004を書き換えず追加適用。
- `supabase/006_anonymous_trial.sql`：匿名識別・回線制限と生成予約。既存の費用台帳を共有。
- `ANONYMOUS_TRIAL.md`：匿名試用の信頼境界・限界・本番有効化手順。
- `js/app.js`：持ち帰り・対話UI、同一送信IDでの再確認、既存アカウント管理。
- `js/services/takeawayService.js`：公開人格と、本人が選んだ表示中の会話だけから持ち帰り文を生成。
- `js/services/metrics.js`：個人情報を含めないページ内の操作カウンタ。外部集計は未接続。
- `scripts/build-public.js`：UIだけをpublic/へ出力。SQLやサーバーソースを公開しません。
- `tests/`：API/画面/人格/実PostgreSQL互換環境での回帰テスト。
- `BUSINESS_MODEL.md` / `TAKEAWAY_STRATEGY.md`：現行の無料持ち帰り戦略・費用上限・計測範囲。
- `PROFIT_CAPACITY.md`：旧有料案の試算とVercel/Supabaseの容量・超過時の検討記録（現行の提供条件ではない）。
- `DEPLOYMENT.md`：公開前に必要な作業と停止・復旧。

`admin.html` と旧メールだけの復元経路は公開しません。旧ゲストの購入移行は、決済証跡を確認したサポート対応が必要です。

## 任意の有料AI動作試験

`scripts/live-quality.mjs` は架空質問専用。通常のnpm testでは実行されません。
`LIVE_DIALOGUE_QA=1` を指定した場合だけAPIへ送信し、1実行あたり最大0.25米ドルの生成予算枠で停止します。
`QA_REASONING=low` を指定すると本番設定と一致します。結果は非公開の `qa-output/` に保存します。
API側の価格変更時は、試験の原価定数も見直してください。
