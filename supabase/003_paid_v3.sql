-- Apply after schema.sql. Preserve paid balances, history and subscriptions.
-- No external Stripe changes and no automatic guest/email account merging.
begin;
alter table public.users alter column free_count set default 0;
alter table public.users add column if not exists reserved_credits integer not null default 0;
alter table public.conversations add column if not exists dialogue_state jsonb not null default '{}'::jsonb;
create table if not exists public.dialogos_v3_schema(version integer primary key,installed_at timestamptz not null default now());
insert into public.dialogos_v3_schema(version) values(3) on conflict do nothing;
create table if not exists public.dialogos_budgets(
  period text not null check(period in ('day','month')),starts_on date not null,
  spent_micro bigint not null default 0 check(spent_micro>=0),reserved_micro bigint not null default 0 check(reserved_micro>=0),
  primary key(period,starts_on));
create table if not exists public.dialogos_requests(
  id uuid primary key,user_id uuid not null references public.users(id),fingerprint text not null,
  conversation_id uuid not null references public.conversations(id),philosopher_id text not null,user_message text not null,
  status text not null check(status in ('reserved','unknown','completed','failed')),
  reserve_micro bigint not null check(reserve_micro>0),actual_micro bigint,budget_day date not null,budget_month date not null,
  provider_response_id text,response_body jsonb,token_usage jsonb,failure_code text,
  created_at timestamptz not null default now(),updated_at timestamptz not null default now());
create unique index if not exists dialogos_one_inflight_per_user on public.dialogos_requests(user_id) where status in ('reserved','unknown');
create index if not exists dialogos_requests_user_created on public.dialogos_requests(user_id,created_at desc);
alter table public.dialogos_requests add column if not exists estimated_micro bigint;
alter table public.messages add column if not exists request_id uuid references public.dialogos_requests(id);
create unique index if not exists dialogos_messages_request_role on public.messages(request_id,role) where request_id is not null;
alter table public.dialogos_v3_schema enable row level security;
alter table public.dialogos_budgets enable row level security;
alter table public.dialogos_requests enable row level security;

create or replace function public.dialogos_v3_user(p_auth_id text,p_email text,p_avatar text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare u public.users;
begin
  if p_auth_id is null or length(p_auth_id)>100 then raise exception 'INVALID_AUTH'; end if;
  perform pg_advisory_xact_lock(hashtextextended('dialogos-auth:'||p_auth_id,0));
  select * into u from public.users where auth_user_id=p_auth_id;
  if not found then
    insert into public.users(guest_id,auth_user_id,email,avatar_url,free_count,credits)
      values('auth_'||gen_random_uuid()::text,p_auth_id,left(p_email,320),left(p_avatar,2048),0,0) returning * into u;
  end if;
  return to_jsonb(u);
end $$;

create or replace function public.dialogos_v3_reserve(p_user_id uuid,p_request_id uuid,p_fingerprint text,p_conversation_id uuid,
  p_philosopher_id text,p_message text,p_reserve_micro bigint,p_daily_limit_micro bigint,p_monthly_limit_micro bigint)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare u public.users;r public.dialogos_requests;c public.conversations;
  d date:=(now() at time zone 'UTC')::date;m date:=date_trunc('month',now() at time zone 'UTC')::date;
  db public.dialogos_budgets;mb public.dialogos_budgets;
begin
  select * into u from public.users where id=p_user_id for update;
  if not found or u.auth_user_id is null then raise exception 'AUTH_REQUIRED'; end if;
  select * into r from public.dialogos_requests where id=p_request_id;
  if found then
    if r.user_id<>p_user_id or r.fingerprint<>p_fingerprint then raise exception 'REQUEST_CONFLICT'; end if;
    return to_jsonb(r);
  end if;
  if p_reserve_micro is null or p_daily_limit_micro is null or p_monthly_limit_micro is null
    or p_reserve_micro<8550 or p_daily_limit_micro<=0 or p_monthly_limit_micro<=0 then raise exception 'INVALID_BUDGET'; end if;
  if char_length(p_message) not between 1 and 1000 or length(p_fingerprint)<>64 then raise exception 'INVALID_REQUEST'; end if;
  -- User row lock serializes this shared limiter across all API instances.
  -- Terminal failures still count; exact-ID retries returned above do not.
  if(select count(*) from public.dialogos_requests where user_id=p_user_id and created_at>=now()-interval '60 seconds')>=6 then raise exception 'RATE_LIMIT'; end if;
  if exists(select 1 from public.dialogos_requests where user_id=p_user_id and status in ('reserved','unknown')) then raise exception 'IN_FLIGHT'; end if;
  if u.credits-u.reserved_credits<1 then raise exception 'LOCKED'; end if;
  if p_conversation_id is not null then
    select * into c from public.conversations where id=p_conversation_id and user_id=p_user_id for update;
    if not found or c.philosopher_id<>p_philosopher_id then raise exception 'CONVERSATION_NOT_FOUND'; end if;
  end if;
  insert into public.dialogos_budgets(period,starts_on) values('day',d),('month',m) on conflict do nothing;
  select * into db from public.dialogos_budgets where period='day' and starts_on=d for update;
  select * into mb from public.dialogos_budgets where period='month' and starts_on=m for update;
  if db.spent_micro+db.reserved_micro+p_reserve_micro>p_daily_limit_micro or mb.spent_micro+mb.reserved_micro+p_reserve_micro>p_monthly_limit_micro then raise exception 'BUDGET_EXHAUSTED'; end if;
  if p_conversation_id is null then insert into public.conversations(user_id,philosopher_id) values(p_user_id,p_philosopher_id) returning * into c; end if;
  update public.dialogos_budgets set reserved_micro=reserved_micro+p_reserve_micro where (period='day' and starts_on=d) or (period='month' and starts_on=m);
  update public.users set reserved_credits=reserved_credits+1 where id=p_user_id;
  insert into public.dialogos_requests(id,user_id,fingerprint,conversation_id,philosopher_id,user_message,status,reserve_micro,budget_day,budget_month)
    values(p_request_id,p_user_id,p_fingerprint,c.id,p_philosopher_id,p_message,'reserved',p_reserve_micro,d,m) returning * into r;
  return to_jsonb(r)||jsonb_build_object('new_reservation',true);
end $$;

create or replace function public.dialogos_v3_finalize(p_user_id uuid,p_request_id uuid,p_reply text,p_state jsonb,p_usage jsonb,p_actual_micro bigint,p_provider_id text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.dialogos_requests;result jsonb;
begin
  perform 1 from public.users where id=p_user_id for update;
  select * into r from public.dialogos_requests where id=p_request_id and user_id=p_user_id for update;
  if not found then raise exception 'REQUEST_NOT_FOUND'; end if;
  if r.status='completed' then return r.response_body; end if;
  if r.status not in ('reserved','unknown') then raise exception 'REQUEST_CLOSED'; end if;
  if p_actual_micro<0 or p_actual_micro is null or p_state is null or char_length(p_reply) not between 1 and 6000 or jsonb_typeof(p_state)<>'object' then raise exception 'INVALID_FINALIZATION'; end if;
  perform 1 from public.dialogos_budgets where period='day' and starts_on=r.budget_day for update;
  perform 1 from public.dialogos_budgets where period='month' and starts_on=r.budget_month for update;
  update public.dialogos_budgets set reserved_micro=reserved_micro-r.reserve_micro,spent_micro=spent_micro+p_actual_micro
    where (period='day' and starts_on=r.budget_day) or (period='month' and starts_on=r.budget_month);
  insert into public.messages(conversation_id,role,content,created_at,request_id)
    values(r.conversation_id,'user',r.user_message,clock_timestamp(),r.id),(r.conversation_id,'assistant',p_reply,clock_timestamp(),r.id);
  update public.conversations set dialogue_state=p_state,updated_at=now() where id=r.conversation_id and user_id=p_user_id;
  update public.users set credits=credits-1,reserved_credits=reserved_credits-1 where id=p_user_id and credits>=1 and reserved_credits>=1;
  if not found then raise exception 'CREDIT_INVARIANT'; end if;
  insert into public.usage_events(user_id) values(p_user_id);
  result:=jsonb_build_object('requestId',r.id,'conversationId',r.conversation_id,'reply',p_reply,'state',p_state);
  update public.dialogos_requests set status='completed',actual_micro=p_actual_micro,token_usage=p_usage,provider_response_id=p_provider_id,response_body=result,updated_at=now() where id=r.id;
  return result;
end $$;

-- Unknown charge outcomes hold both reservations until reconciliation or stale
-- recovery expenses the full maximum. The same request ID never regenerates.
create or replace function public.dialogos_v3_fail(p_user_id uuid,p_request_id uuid,p_actual_micro bigint,p_usage jsonb,p_code text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.dialogos_requests;
begin
  perform 1 from public.users where id=p_user_id for update;
  select * into r from public.dialogos_requests where id=p_request_id and user_id=p_user_id for update;
  if not found then raise exception 'REQUEST_NOT_FOUND'; end if;
  if r.status in ('completed','failed') then return to_jsonb(r); end if;
  if p_actual_micro is null then
    update public.dialogos_requests set status='unknown',failure_code=left(p_code,80),updated_at=now() where id=r.id returning * into r;
    return to_jsonb(r);
  end if;
  if p_actual_micro<0 then raise exception 'INVALID_COST'; end if;
  perform 1 from public.dialogos_budgets where period='day' and starts_on=r.budget_day for update;
  perform 1 from public.dialogos_budgets where period='month' and starts_on=r.budget_month for update;
  update public.dialogos_budgets set reserved_micro=reserved_micro-r.reserve_micro,spent_micro=spent_micro+p_actual_micro
    where (period='day' and starts_on=r.budget_day) or (period='month' and starts_on=r.budget_month);
  update public.users set reserved_credits=reserved_credits-1 where id=p_user_id and reserved_credits>=1;
  if not found then raise exception 'CREDIT_INVARIANT'; end if;
  update public.dialogos_requests set status='failed',actual_micro=p_actual_micro,token_usage=p_usage,failure_code=left(p_code,80),updated_at=now() where id=r.id returning * into r;
  return to_jsonb(r);
end $$;

-- User-facing recovery after a crashed/timed-out generation. Never return the
-- unknown provider cost to the budget: expense the full reserved maximum. The
-- original UUID becomes terminal so a late worker cannot save/charge it again.
create or replace function public.dialogos_v3_release_stale(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.dialogos_requests;released integer:=0;
begin
  perform 1 from public.users where id=p_user_id for update;
  if not found then raise exception 'USER_NOT_FOUND'; end if;
  for r in select * from public.dialogos_requests where user_id=p_user_id
    and status in ('reserved','unknown') and created_at<=now()-interval '10 minutes' for update
  loop
    perform 1 from public.dialogos_budgets where period='day' and starts_on=r.budget_day for update;
    perform 1 from public.dialogos_budgets where period='month' and starts_on=r.budget_month for update;
    update public.dialogos_budgets set reserved_micro=reserved_micro-r.reserve_micro,spent_micro=spent_micro+r.reserve_micro
      where(period='day' and starts_on=r.budget_day)or(period='month' and starts_on=r.budget_month);
    update public.users set reserved_credits=reserved_credits-1 where id=p_user_id and reserved_credits>=1;
    if not found then raise exception 'CREDIT_INVARIANT'; end if;
    update public.dialogos_requests set status='failed',failure_code='STALE_ESTIMATED_COST',actual_micro=null,
      estimated_micro=r.reserve_micro,token_usage=coalesce(token_usage,'{}'::jsonb)||jsonb_build_object('cost_estimated',true,'estimation_basis','reserved_maximum'),updated_at=now()
      where id=r.id;
    released:=released+1;
  end loop;
  return jsonb_build_object('released',released);
end $$;

-- The server verifies signature, currency, exact amount and ownership; the SQL
-- validates pack values and atomically inserts the payment ledger and credits.
create or replace function public.dialogos_v3_grant(p_user_id uuid,p_payment_key text,p_customer_id text,p_package_id text,p_amount_jpy integer,p_credits integer,p_kind text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare u public.users;old_purchase public.purchases;
begin
  select * into u from public.users where id=p_user_id for update;
  if not found then raise exception 'USER_NOT_FOUND'; end if;
  if not ((p_package_id='v3_40' and p_amount_jpy=100 and p_credits=40 and p_kind='credits')
    or(p_package_id='v3_140' and p_amount_jpy=300 and p_credits=140 and p_kind='credits')
    or(p_package_id='v3_500' and p_amount_jpy=1000 and p_credits=500 and p_kind='credits')
    or(p_package_id='memory_book_monthly' and p_amount_jpy between 0 and 680 and p_credits=60 and p_kind='subscription')
    or(p_package_id='embers_150' and p_amount_jpy between 0 and 500 and p_credits=20 and p_kind='credits')
    or(p_package_id='embers_400' and p_amount_jpy between 0 and 1000 and p_credits=60 and p_kind='credits')
    or(p_package_id='embers_1000' and p_amount_jpy between 0 and 2000 and p_credits=160 and p_kind='credits')) then raise exception 'INVALID_PAYMENT'; end if;
  if p_customer_id is null or(u.stripe_customer_id is not null and u.stripe_customer_id<>p_customer_id) then raise exception 'CUSTOMER_MISMATCH'; end if;
  select * into old_purchase from public.purchases where stripe_session_id=p_payment_key;
  if found then
    if old_purchase.user_id is distinct from p_user_id or old_purchase.credits_added<>p_credits or old_purchase.package_id<>p_package_id then raise exception 'PAYMENT_CONFLICT'; end if;
    return jsonb_build_object('already_applied',true);
  end if;
  insert into public.purchases(user_id,guest_id,stripe_session_id,stripe_customer_id,package_id,kind,amount_jpy,credits_added,status,completed_at)
    values(u.id,u.guest_id,p_payment_key,p_customer_id,p_package_id,p_kind,p_amount_jpy,p_credits,'completed',now());
  update public.users set credits=credits+p_credits,stripe_customer_id=p_customer_id where id=p_user_id;
  return jsonb_build_object('already_applied',false);
end $$;

revoke all on function public.dialogos_v3_user(text,text,text) from public,anon,authenticated;
revoke all on function public.dialogos_v3_reserve(uuid,uuid,text,uuid,text,text,bigint,bigint,bigint) from public,anon,authenticated;
revoke all on function public.dialogos_v3_finalize(uuid,uuid,text,jsonb,jsonb,bigint,text) from public,anon,authenticated;
revoke all on function public.dialogos_v3_fail(uuid,uuid,bigint,jsonb,text) from public,anon,authenticated;
revoke all on function public.dialogos_v3_release_stale(uuid) from public,anon,authenticated;
revoke all on function public.dialogos_v3_grant(uuid,text,text,text,integer,integer,text) from public,anon,authenticated;
grant execute on function public.dialogos_v3_user(text,text,text) to service_role;
grant execute on function public.dialogos_v3_reserve(uuid,uuid,text,uuid,text,text,bigint,bigint,bigint) to service_role;
grant execute on function public.dialogos_v3_finalize(uuid,uuid,text,jsonb,jsonb,bigint,text) to service_role;
grant execute on function public.dialogos_v3_fail(uuid,uuid,bigint,jsonb,text) to service_role;
grant execute on function public.dialogos_v3_release_stale(uuid) to service_role;
grant execute on function public.dialogos_v3_grant(uuid,text,text,text,integer,integer,text) to service_role;
revoke all on public.dialogos_v3_schema,public.dialogos_budgets,public.dialogos_requests from anon,authenticated;
grant all on public.dialogos_v3_schema,public.dialogos_budgets,public.dialogos_requests to service_role;
commit;
