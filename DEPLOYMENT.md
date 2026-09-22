# Dialogos v3 公開前チェックと運用

この変更はローカル実装です。自動的に本番のDB・Stripe・Vercel設定を更新するものではありません。
無料枠・新規販売停止・持ち帰り機能を変える移行なので、既存利用者への案内を準備してから公開してください。

## 1. 本番を止めずに移行準備

- 現行コードとDBをバックアップ。購入残高・旧月額契約・auth_user_idとStripe顧客の紐付けを確認。
- 別DBとStripe test modeで検証。旧ゲストIDやメールの一致だけで既存購入を新しいログインへ自動移管しない。
- 既存DBに `supabase/003_paid_v3.sql`、`supabase/004_socrates_trial.sql`、`supabase/005_daily_trial.sql`、`supabase/006_anonymous_trial.sql` を順に適用。適用済みの003〜005は変更しない。新規DBのみ先に `schema.sql` を適用。匿名経路には006が必要。
- RLSを有効にするだけでなく、既存の公開書き込みポリシーがないこと、v3 RPCをanon/authenticatedが実行できないことを確認。service_roleだけが実行する。
- 旧版の無料残高列は削除せず、新しい日次台帳とは分離。無料枠は匿名ブラウザまたはGoogle確認済みアカウントごとに全14人共通で1日3往復、日本時間0時更新。旧004の未確定リクエストは旧枠で精算し、日付をまたいだ新枠リクエストは予約日で精算する。匿名ユーザーへ既存購入分を自動移管しない。

本番DBの内容と規模はこの実装作業では検証していません。既存契約の移行前後比較を省略しないでください。

## 2. Vercelと環境変数

実契約は今回の接続では未確認です。新規販売停止だけでHobby利用の可否を決めず、既存有料サービスや商用利用の実態を公式条件と照合してください。有料販売・商用運用はHobbyの対象外です。チームのBillingを確認し、必要な契約変更は運営者の承認で行います。この作業では契約を変更していません。
[商用利用の条件](https://vercel.com/docs/limits/fair-use-guidelines)、[Pro料金](https://vercel.com/docs/plans/pro-plan)

Vercelの予算通知だけでは従量課金を止めません。Spend Managementの停止動作を明示的に設定し、全本番プロジェクトが停止する影響を確認してください。CDNはFlat Rate CDNの有効化・tierと翌期の増額条件も確認。詳細は `PROFIT_CAPACITY.md`。

`.env.example` の変数を環境ごとに設定。`APP_URL` は固定のhttps公開URL（末尾パス・クエリなし）。
Google OAuthの戻り先も一致させます。プレビューに本番Stripe secretや本番DBのservice roleを流用しないでください。
X用のcanonical・OG・カード画像URLにも `APP_URL` を**ビルド時**に使用します。公開先を変更したら再ビルド・再デプロイしてください。ローカルURL・Vercel管理画面URL・一時的な認証回避URLをXに貼らないでください。詳細は `X_LAUNCH.md`。

`SALES_ENABLED=false` を本番にも明示設定し、新規Checkoutを停止します。`TRIAL_ENABLED` は無料生成、`BILLING_ENABLED` は既存購入分の有料生成を別々に制御します。人格コピーはこれらのフラグやログインに依存しません。

匿名試用はさらに `ANONYMOUS_TRIAL_ENABLED=true`、`TURNSTILE_SITE_KEY`、`TURNSTILE_SECRET_KEY`、32バイト以上の乱数による `GUEST_SESSION_SECRET` が必要です。秘密値は環境ごとに分離し、Git・ブラウザ・チャットへ公開しません。未設定では匿名生成を止めます。Cloudflare側の許可ホスト名と `APP_URL` の一致を実ドメインで確認。手順と制限の詳細は `ANONYMOUS_TRIAL.md`。

ビルドは `npm run build`、公開出力は `public/`、APIは `api/index.js`。
Functionの最大実行時間は180秒を設定。プランが対応することをプレビューで確認してください。
ビルド時に正本の人格から `js/data/takeawayPersonas.js` を生成します。この公開用データは意図的に配信しますが、内部JSON応答契約・会話メモ・認証情報は含めません。
肖像はあらかじめ作った128/320/640幅WebPを配信し、実行時の画像変換APIは使いません。元PNGは編集用として保持し、public/へ含めません。画像を差し替えた際は `npm run images:optimize` で再生成し、目視確認してからビルド。ビルドは既存public内の既知の重複PNGだけを元ファイルとのハッシュ照合後に取り除き、不明なファイルは削除せず停止します。
Framework検出がExpress構成へ設定を上書きする場合は、この静的出力＋API方式に合わせて設定し、公開ファイルを確認します。
[公式プロジェクト設定](https://vercel.com/docs/project-configuration)

公開URLで以下が404になることを確認：
`/.env`、`/server.js`、`/package.json`、`/supabase/schema.sql`、`/shared/dialogue.js`、`/admin.html`。

`/api/health` のokはHTTP疎通だけで、決済・DB・AIの全経路成功を保証しません。

## 3. Stripe

Webhook URLは `https://公開ドメイン/api/stripe/webhook`。

購読イベント：
- checkout.session.completed
- checkout.session.async_payment_succeeded
- invoice.paid
- invoice.payment_succeeded
- customer.subscription.updated
- customer.subscription.deleted

新規販売は停止。過去の一回払い（100円40灯火／300円140灯火／1,000円500灯火）の購入確認と付与経路は維持します。
クライアントに金額を決めさせません。成功ページへ戻っただけでは付与せず、署名またはStripeからの取得結果で支払い・商品・所有者を確認します。

既存月額のPrice IDと付与量はコード内のLEGACY_PACKAGESで維持します。既存契約を勝手に取り消したり、Webhookを新規一回払い用のイベントだけに減らしたりしないでください。
旧契約の決済リトライ、Webhook重複・順序入替・遅延をテストします。
返金・異議申立ては自動処理していないので、Stripeとアプリ残高の両方を照合してサポート対応してください。

## 4. 攻撃・費用対策は別々に設定

アプリには匿名ブラウザまたはGoogleアカウントごとに全14人共通で1日3往復の無料枠と認証済み購入残高、1識別子1生成、DBで毎分6新規送信、入力6,000／出力900トークン、全体予算と無料専用予算の先行予約があります。匿名経路にはTurnstileのサーバー検証と回線単位の上限（日本時間1日30新規予約・直近1分6新規予約）も追加。Cookieの削除と別回線による取得を同一人物だと完全に見抜くことはできません。
ただしこれだけでDDoSや全てのクラウド請求をなくせません。認証・DBアクセス・静的配信・Webhookなど、AI生成以外にも費用が発生します。

- Vercel Firewall等で `/api/*` のレート制限と異常アクセス対策を確認。特に匿名session/chatのPOSTをログ監視し、正常利用と共有回線の影響を確認した後、プレビューで遮断を試して運営者が本番公開する。Webhookを安易にボットチャレンジで遮断しない。
- Vercel/Supabase側の利用上限・通知・停止条件を確認。
- このアプリ専用のOpenAIプロジェクトとキーを使用。プロジェクト／組織の支出上限も設定。
- OpenAIのhard limitにも短い反映遅延があり得るため、アプリ側の予約を併用する。
[OpenAI公式の支出上限](https://developers.openai.com/api/docs/guides/spend-limits)

初期設定はUTCの日次3ドル・月次30ドル。これは検証・小規模開始の停止線であり、多売時の営業予算ではありません。
この合計の内側に無料専用の日次0.50ドル・月次5ドルを設定。別途5ドルを上乗せする意味ではありません。無料予算が尽きると新しい無料生成だけ停止し、無料残高や購入灯火を消費しません。有料生成は全体予算など他の条件が許せば継続します。
無料体験を1,000人に3往復ずつ提供する計画原価は13.50ドルなので、初期の無料月5ドルのままでは提供できません。同一利用者の翌日分もこの全体予算を使います。日本時間0時の無料回数更新で、UTC基準の費用予算はリセットしません。増額は運営者の別途判断です。
予約＋実測費用＋結果不明時の最大推定費用を合算します。売上・購入済み残高・使用率を見て十分な予算を確保し、賄えないときは新規販売を停止してください。

## 5. 障害時の振る舞い

- 正常に返答と会話をDB保存した時だけ、予約時に固定した無料回数または購入灯火を1減らす。
- 同じ送信IDはキャッシュした返答を返し、生成も消費も重複しない。
- 明確な失敗は灯火を返す。生成費用が分かる場合、そのAPI原価は運営側予算へ計上。
- 結果不明は一時予約し、10分後の残高確認／次の送信時に復旧。
- 復旧では灯火だけ返し、最大予約費用を推定費用として予算へ残す。元のIDは終了済みなので再生成しない。遅れた元応答も追加消費しない。
- 未確定予約をSQLで削除したり、費用ゼロでまとめて解放したりしない。
- 日付をまたいだ処理はリクエストに固定した `trial_day` の枠だけを精算し、新しい日の無料枠を増減させない。無料枠の未使用分は翌日に加算しない。

確認用の読み取りSQL：

```sql
select period, starts_on, spent_micro, reserved_micro
from public.dialogos_budgets order by starts_on desc;

select period, starts_on, spent_micro, reserved_micro
from public.dialogos_trial_budgets order by starts_on desc;

select id, status, actual_micro, estimated_micro, failure_code, created_at
from public.dialogos_requests
where status in ('reserved','unknown') or failure_code='STALE_ESTIMATED_COST'
order by created_at desc limit 100;
```

1,000,000 micro-USD＝1ドル。推定費用は実際のOpenAI請求額とは区別します。
問い合わせ対応で会話内容を大量にログへ出さないでください。

緊急時は `TRIAL_ENABLED=false`、`BILLING_ENABLED=false`、`SALES_ENABLED=false` を反映し、新しい無料生成・購入・有料生成を止めます。無料体験全体だけ止めるならTRIAL、匿名体験だけなら `ANONYMOUS_TRIAL_ENABLED=false` を変更します。静的な人格コピーは利用できます。
完了済み応答の再確認・購入反映・既存契約管理は、利用者保護のため可能な範囲で維持します。

## 6. 公開判定

テスト環境で次を満たしてから公開：
1. 未ログインで全14人の人格を確認・コピーでき、新規Checkoutは直接APIを呼んでも停止する。旧購入のWebhook／戻り先の二重到達でも一度だけ付与する。
2. 1返答で1灯火のみ減少、0残高でAPIを呼ばない。
   好きな賢者で合計3往復完了で当日分が終了し、3回目の回答と持ち帰り導線を読めること、購入残高0なら4回目を送れないことを確認。賢者変更・同時タブ・再ログイン・新規会話で無料回数が増えないこと、日本時間0時に更新し、日付またぎの完了・失敗・復旧は予約日の枠だけを精算することも確認する。
3. 同時タブ・リロード・通信断で重複課金しない。
4. 予算超過、DB障害、未適用migrationは生成前に停止。
5. 14人、スマホ、長い会話、訂正した定義、例外応答を確認。
   コピー成功／拒否時の手動コピー、会話同梱の初期OFF・表示中会話のみ同梱、固定のChatGPTリンク、本文の外部自動送信がないこと、API障害時の持ち帰りを確認する。
6. 旧購入・旧月額契約の継続と本人による解約を確認。
7. 特商法の事業者名・運営責任者・所在地等、返金・保存期間・有料残高の扱いを運営者として確認。既存の事業者表記はこの作業では実名検証していません。法的適合性の保証ではないため、必要に応じて専門家へ確認。
8. 利用者への無料枠・新規販売停止・持ち帰り・旧ゲスト移行案内を用意。サイト全体のコピー数集計は未接続。追加の外部計測を導入する場合は費用とプライバシーを別途確認。
9. Googleログインなしで3往復でき、Cookie未設定・改ざん・別Origin・無効Turnstileでは生成しない。匿名Cookieで購入・契約・アカウント履歴APIを利用できない。匿名→Googleの切替中の応答やボット判定が、別の利用状態へ反映されない。
10. 同じ回線の別Cookieにも回線上限が働き、無料予算停止時は新しいゲストDB行も作らない。無効な判定や設定不足で無制限生成へ迂回しない。本番ドメインでの実Turnstile・共有回線の誤制限も確認する。

この作業で本番へのデプロイ、実決済、Google OAuth完走、本番DB migration、WAF設定は実施していません。
