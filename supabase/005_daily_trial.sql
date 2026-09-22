-- Daily trial across all philosophers. Apply after 003 and 004, which remain
-- unchanged. Legacy lifetime-trial requests keep NULL trial_day and settle
-- against their original bucket; new requests fix their admission day in JST.
begin;
create table if not exists public.dialogos_daily_trials(
  user_id uuid not null references public.users(id),
  trial_day date not null,
  used integer not null default 0 check(used between 0 and 3),
  reserved integer not null default 0 check(reserved between 0 and 1),
  primary key(user_id,trial_day),
  check(used+reserved<=3));
alter table public.dialogos_requests add column if not exists trial_day date;
alter table public.dialogos_daily_trials enable row level security;
revoke all on public.dialogos_daily_trials from anon,authenticated;
grant all on public.dialogos_daily_trials to service_role;

create or replace function public.dialogos_jst_day(p_at timestamptz)
returns date language sql immutable strict set search_path=public,pg_temp as $$
  select(p_at at time zone 'Asia/Tokyo')::date;
$$;
create or replace function public.dialogos_v4_immutable_source()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  if new.usage_source is distinct from old.usage_source then raise exception 'IMMUTABLE_USAGE_SOURCE'; end if;
  if new.trial_day is distinct from old.trial_day then raise exception 'IMMUTABLE_TRIAL_DAY'; end if;
  return new;
end $$;

-- Public application fields are a projection of today's ledger. Lifetime fields
-- stay physically unchanged in users for settling pre-migration requests.
create or replace function public.dialogos_v5_user_state(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare u public.users;q public.dialogos_daily_trials;d date:=public.dialogos_jst_day(now());
begin
  select * into u from public.users where id=p_user_id;
  if not found then raise exception 'USER_NOT_FOUND'; end if;
  select * into q from public.dialogos_daily_trials where user_id=p_user_id and trial_day=d;
  return to_jsonb(u)||jsonb_build_object(
    'trial_remaining',3-coalesce(q.used,0),'trial_reserved',coalesce(q.reserved,0),
    'trial_used_today',coalesce(q.used,0),'trial_day',d,
    'trial_resets_at',((d+1)::timestamp at time zone 'Asia/Tokyo'));
end $$;
create or replace function public.dialogos_v5_user(p_auth_id text,p_email text,p_avatar text,p_google_subject text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare identity jsonb;
begin
  identity:=public.dialogos_v4_user(p_auth_id,p_email,p_avatar,p_google_subject);
  return public.dialogos_v5_user_state((identity->>'id')::uuid);
end $$;

create or replace function public.dialogos_v5_reserve(p_user_id uuid,p_request_id uuid,p_fingerprint text,p_conversation_id uuid,
  p_philosopher_id text,p_message text,p_reserve_micro bigint,p_daily_limit_micro bigint,p_monthly_limit_micro bigint,
  p_trial_enabled boolean,p_paid_enabled boolean,p_trial_daily_limit_micro bigint,p_trial_monthly_limit_micro bigint,p_expected_source text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare u public.users;r public.dialogos_requests;c public.conversations;source text;j date;quota public.dialogos_daily_trials;
  d date:=(now() at time zone 'UTC')::date;m date:=date_trunc('month',now() at time zone 'UTC')::date;
  db public.dialogos_budgets;mb public.dialogos_budgets;td public.dialogos_trial_budgets;tm public.dialogos_trial_budgets;
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
  if p_message is null or p_fingerprint is null or char_length(p_message) not between 1 and 1000 or length(p_fingerprint)<>64 then raise exception 'INVALID_REQUEST'; end if;
  if(select count(*) from public.dialogos_requests where user_id=p_user_id and created_at>=now()-interval '60 seconds')>=6 then raise exception 'RATE_LIMIT'; end if;
  if exists(select 1 from public.dialogos_requests where user_id=p_user_id and status in ('reserved','unknown')) then raise exception 'IN_FLIGHT'; end if;
  -- Admission day is captured AFTER acquiring the user lock. All philosophers
  -- share this day's three replies. An old in-flight request blocks new work
  -- until it completes/settles but can never debit the next day's quota.
  j:=public.dialogos_jst_day(clock_timestamp());
  insert into public.dialogos_daily_trials(user_id,trial_day) values(p_user_id,j) on conflict do nothing;
  select * into quota from public.dialogos_daily_trials where user_id=p_user_id and trial_day=j for update;
  if u.trial_eligible and 3-quota.used-quota.reserved>0 then
    if p_expected_source is null then raise exception 'CHARGE_SOURCE_REQUIRED'; end if;
    if p_expected_source<>'trial' then raise exception 'BALANCE_CHANGED'; end if;
    if p_trial_enabled is not true then raise exception 'TRIAL_NOT_READY'; end if;
    source:='trial';
    if p_trial_daily_limit_micro is null or p_trial_monthly_limit_micro is null or p_trial_daily_limit_micro<=0 or p_trial_monthly_limit_micro<=0 then raise exception 'INVALID_BUDGET'; end if;
  else
    source:='paid';
    if p_expected_source is null then raise exception 'CHARGE_SOURCE_REQUIRED'; end if;
    if p_expected_source<>'paid' then raise exception 'BALANCE_CHANGED'; end if;
    if u.credits-u.reserved_credits<1 then raise exception 'LOCKED'; end if;
    if p_paid_enabled is not true then raise exception 'BILLING_NOT_READY'; end if;
  end if;
  if p_conversation_id is not null then
    select * into c from public.conversations where id=p_conversation_id and user_id=p_user_id for update;
    if not found or c.philosopher_id<>p_philosopher_id then raise exception 'CONVERSATION_NOT_FOUND'; end if;
  end if;
  insert into public.dialogos_budgets(period,starts_on) values('day',d),('month',m) on conflict do nothing;
  select * into db from public.dialogos_budgets where period='day' and starts_on=d for update;
  select * into mb from public.dialogos_budgets where period='month' and starts_on=m for update;
  if db.spent_micro+db.reserved_micro+p_reserve_micro>p_daily_limit_micro or mb.spent_micro+mb.reserved_micro+p_reserve_micro>p_monthly_limit_micro then raise exception 'BUDGET_EXHAUSTED'; end if;
  if source='trial' then
    insert into public.dialogos_trial_budgets(period,starts_on) values('day',d),('month',m) on conflict do nothing;
    select * into td from public.dialogos_trial_budgets where period='day' and starts_on=d for update;
    select * into tm from public.dialogos_trial_budgets where period='month' and starts_on=m for update;
    if td.spent_micro+td.reserved_micro+p_reserve_micro>p_trial_daily_limit_micro or tm.spent_micro+tm.reserved_micro+p_reserve_micro>p_trial_monthly_limit_micro then raise exception 'TRIAL_BUDGET_EXHAUSTED'; end if;
    update public.dialogos_trial_budgets set reserved_micro=reserved_micro+p_reserve_micro where(period='day' and starts_on=d)or(period='month' and starts_on=m);
    update public.dialogos_daily_trials set reserved=reserved+1 where user_id=p_user_id and trial_day=j;
  else
    update public.users set reserved_credits=reserved_credits+1 where id=p_user_id;
  end if;
  if p_conversation_id is null then insert into public.conversations(user_id,philosopher_id) values(p_user_id,p_philosopher_id) returning * into c; end if;
  update public.dialogos_budgets set reserved_micro=reserved_micro+p_reserve_micro where(period='day' and starts_on=d)or(period='month' and starts_on=m);
  insert into public.dialogos_requests(id,user_id,fingerprint,conversation_id,philosopher_id,user_message,status,reserve_micro,budget_day,budget_month,usage_source,trial_day)
    values(p_request_id,p_user_id,p_fingerprint,c.id,p_philosopher_id,p_message,'reserved',p_reserve_micro,d,m,source,case when source='trial' then j else null end) returning * into r;
  return to_jsonb(r)||jsonb_build_object('new_reservation',true);
end $$;

create or replace function public.dialogos_v5_settle_bucket(r public.dialogos_requests,p_charge boolean)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if r.usage_source='trial' and r.trial_day is not null then
    update public.dialogos_daily_trials set used=used+case when p_charge then 1 else 0 end,reserved=reserved-1
      where user_id=r.user_id and trial_day=r.trial_day and reserved>=1 and used<3;
    if not found then raise exception 'TRIAL_DAY_INVARIANT'; end if;
  else
    -- Both already-purchased credit and pre-005 lifetime-trial requests retain
    -- their original semantics, even when finalized after the migration.
    perform public.dialogos_v4_settle_bucket(r.user_id,r.usage_source,p_charge);
  end if;
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
  perform public.dialogos_v4_settle_budgets(r,p_actual_micro);
  insert into public.messages(conversation_id,role,content,created_at,request_id)
    values(r.conversation_id,'user',r.user_message,clock_timestamp(),r.id),(r.conversation_id,'assistant',p_reply,clock_timestamp(),r.id);
  update public.conversations set dialogue_state=p_state,updated_at=now() where id=r.conversation_id and user_id=p_user_id;
  perform public.dialogos_v5_settle_bucket(r,true);
  insert into public.usage_events(user_id) values(p_user_id);
  result:=jsonb_build_object('requestId',r.id,'conversationId',r.conversation_id,'reply',p_reply,'state',p_state,'usageSource',r.usage_source,'trialDay',r.trial_day);
  update public.dialogos_requests set status='completed',actual_micro=p_actual_micro,token_usage=p_usage,provider_response_id=p_provider_id,response_body=result,updated_at=now() where id=r.id;
  return result;
end $$;

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
  perform public.dialogos_v4_settle_budgets(r,p_actual_micro);
  perform public.dialogos_v5_settle_bucket(r,false);
  update public.dialogos_requests set status='failed',actual_micro=p_actual_micro,token_usage=p_usage,failure_code=left(p_code,80),updated_at=now() where id=r.id returning * into r;
  return to_jsonb(r);
end $$;

create or replace function public.dialogos_v3_release_stale(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.dialogos_requests;released integer:=0;
begin
  perform 1 from public.users where id=p_user_id for update;
  if not found then raise exception 'USER_NOT_FOUND'; end if;
  for r in select * from public.dialogos_requests where user_id=p_user_id
    and status in ('reserved','unknown') and created_at<=now()-interval '10 minutes' for update
  loop
    perform public.dialogos_v4_settle_budgets(r,r.reserve_micro);
    perform public.dialogos_v5_settle_bucket(r,false);
    update public.dialogos_requests set status='failed',failure_code='STALE_ESTIMATED_COST',actual_micro=null,
      estimated_micro=r.reserve_micro,token_usage=coalesce(token_usage,'{}'::jsonb)||jsonb_build_object('cost_estimated',true,'estimation_basis','reserved_maximum'),updated_at=now()
      where id=r.id;
    released:=released+1;
  end loop;
  return jsonb_build_object('released',released);
end $$;

revoke all on function public.dialogos_v5_user_state(uuid) from public,anon,authenticated;
revoke all on function public.dialogos_v5_user(text,text,text,text) from public,anon,authenticated;
revoke all on function public.dialogos_v5_reserve(uuid,uuid,text,uuid,text,text,bigint,bigint,bigint,boolean,boolean,bigint,bigint,text) from public,anon,authenticated;
revoke all on function public.dialogos_v5_settle_bucket(public.dialogos_requests,boolean) from public,anon,authenticated,service_role;
grant execute on function public.dialogos_v5_user_state(uuid) to service_role;
grant execute on function public.dialogos_v5_user(text,text,text,text) to service_role;
grant execute on function public.dialogos_v5_reserve(uuid,uuid,text,uuid,text,text,bigint,bigint,bigint,boolean,boolean,bigint,bigint,text) to service_role;
-- Old reservation entry points must not open new daily/lifetime buckets. They
-- remain defined for audit/migration compatibility, but only v5 may reserve.
revoke execute on function public.dialogos_v3_reserve(uuid,uuid,text,uuid,text,text,bigint,bigint,bigint) from service_role;
revoke execute on function public.dialogos_v4_reserve(uuid,uuid,text,uuid,text,text,bigint,bigint,bigint,boolean,boolean,bigint,bigint,text) from service_role;
insert into public.dialogos_v3_schema(version) values(5) on conflict do nothing;
commit;
