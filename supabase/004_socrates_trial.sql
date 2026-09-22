-- Apply after 003_paid_v3.sql. Add lifetime Google-account Socrates trial.
-- Existing paid balances, requests, history and legacy free_count are untouched.
begin;
alter table public.users add column if not exists trial_remaining integer not null default 3 check(trial_remaining between 0 and 3);
alter table public.users add column if not exists trial_reserved integer not null default 0 check(trial_reserved between 0 and 1);
alter table public.users add column if not exists trial_google_subject text;
alter table public.users add column if not exists trial_eligible boolean not null default false;
create unique index if not exists dialogos_trial_google_once on public.users(trial_google_subject) where trial_google_subject is not null;
alter table public.dialogos_requests add column if not exists usage_source text not null default 'paid' check(usage_source in ('paid','trial'));
create table if not exists public.dialogos_trial_budgets(
  period text not null check(period in ('day','month')),starts_on date not null,
  spent_micro bigint not null default 0 check(spent_micro>=0),reserved_micro bigint not null default 0 check(reserved_micro>=0),
  primary key(period,starts_on));
alter table public.dialogos_trial_budgets enable row level security;
revoke all on public.dialogos_trial_budgets from anon,authenticated;
grant all on public.dialogos_trial_budgets to service_role;

create or replace function public.dialogos_v4_immutable_source()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  if new.usage_source is distinct from old.usage_source then raise exception 'IMMUTABLE_USAGE_SOURCE'; end if;
  return new;
end $$;
drop trigger if exists dialogos_usage_source_immutable on public.dialogos_requests;
create trigger dialogos_usage_source_immutable before update on public.dialogos_requests for each row execute function public.dialogos_v4_immutable_source();

-- Caller supplies SHA256 of verified Google's provider subject, never email.
-- A provider identity already claimed by a different app account gets no trial.
create or replace function public.dialogos_v4_user(p_auth_id text,p_email text,p_avatar text,p_google_subject text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare u public.users;
begin
  perform public.dialogos_v3_user(p_auth_id,p_email,p_avatar);
  if p_google_subject is not null and p_google_subject ~ '^[a-f0-9]{64}$' then
    perform pg_advisory_xact_lock(hashtextextended('dialogos-google:'||p_google_subject,0));
    select * into u from public.users where auth_user_id=p_auth_id for update;
    if (u.trial_google_subject is null or u.trial_google_subject=p_google_subject)
      and not exists(select 1 from public.users where trial_google_subject=p_google_subject and id<>u.id) then
      update public.users set trial_google_subject=p_google_subject,trial_eligible=true where id=u.id returning * into u;
    end if;
  else
    select * into u from public.users where auth_user_id=p_auth_id;
  end if;
  return to_jsonb(u);
end $$;

-- Remove the pre-intent internal RPC overload; HTTP legacy retries are handled
-- before reservation, while new requests must explicitly agree to their source.
drop function if exists public.dialogos_v4_reserve(uuid,uuid,text,uuid,text,text,bigint,bigint,bigint,boolean,boolean,bigint,bigint);
create or replace function public.dialogos_v4_reserve(p_user_id uuid,p_request_id uuid,p_fingerprint text,p_conversation_id uuid,
  p_philosopher_id text,p_message text,p_reserve_micro bigint,p_daily_limit_micro bigint,p_monthly_limit_micro bigint,
  p_trial_enabled boolean,p_paid_enabled boolean,p_trial_daily_limit_micro bigint,p_trial_monthly_limit_micro bigint,p_expected_source text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare u public.users;r public.dialogos_requests;c public.conversations;source text;
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
  -- Pick once under the user lock. Exhausted/disabled trial never silently
  -- becomes a paid request when the caller selected an eligible trial.
  if p_philosopher_id='socrates' and u.trial_eligible and u.trial_remaining-u.trial_reserved>0 then
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
    update public.users set trial_reserved=trial_reserved+1 where id=p_user_id;
  else
    update public.users set reserved_credits=reserved_credits+1 where id=p_user_id;
  end if;
  if p_conversation_id is null then insert into public.conversations(user_id,philosopher_id) values(p_user_id,p_philosopher_id) returning * into c; end if;
  update public.dialogos_budgets set reserved_micro=reserved_micro+p_reserve_micro where(period='day' and starts_on=d)or(period='month' and starts_on=m);
  insert into public.dialogos_requests(id,user_id,fingerprint,conversation_id,philosopher_id,user_message,status,reserve_micro,budget_day,budget_month,usage_source)
    values(p_request_id,p_user_id,p_fingerprint,c.id,p_philosopher_id,p_message,'reserved',p_reserve_micro,d,m,source) returning * into r;
  return to_jsonb(r)||jsonb_build_object('new_reservation',true);
end $$;

-- Internal helpers: no browser/service-role direct execution.
create or replace function public.dialogos_v4_settle_budgets(r public.dialogos_requests,p_actual_micro bigint)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
  perform 1 from public.dialogos_budgets where period='day' and starts_on=r.budget_day for update;
  perform 1 from public.dialogos_budgets where period='month' and starts_on=r.budget_month for update;
  update public.dialogos_budgets set reserved_micro=reserved_micro-r.reserve_micro,spent_micro=spent_micro+p_actual_micro
    where(period='day' and starts_on=r.budget_day)or(period='month' and starts_on=r.budget_month);
  if r.usage_source='trial' then
    perform 1 from public.dialogos_trial_budgets where period='day' and starts_on=r.budget_day for update;
    perform 1 from public.dialogos_trial_budgets where period='month' and starts_on=r.budget_month for update;
    update public.dialogos_trial_budgets set reserved_micro=reserved_micro-r.reserve_micro,spent_micro=spent_micro+p_actual_micro
      where(period='day' and starts_on=r.budget_day)or(period='month' and starts_on=r.budget_month);
  end if;
end $$;
create or replace function public.dialogos_v4_settle_bucket(p_user_id uuid,p_source text,p_charge boolean)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if p_source='trial' then
    update public.users set trial_remaining=trial_remaining-case when p_charge then 1 else 0 end,trial_reserved=trial_reserved-1
      where id=p_user_id and trial_remaining>=1 and trial_reserved>=1;
  else
    update public.users set credits=credits-case when p_charge then 1 else 0 end,reserved_credits=reserved_credits-1
      where id=p_user_id and credits>=case when p_charge then 1 else 0 end and reserved_credits>=1;
  end if;
  if not found then raise exception 'CREDIT_INVARIANT'; end if;
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
  perform public.dialogos_v4_settle_bucket(p_user_id,r.usage_source,true);
  insert into public.usage_events(user_id) values(p_user_id);
  result:=jsonb_build_object('requestId',r.id,'conversationId',r.conversation_id,'reply',p_reply,'state',p_state,'usageSource',r.usage_source);
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
  perform public.dialogos_v4_settle_bucket(p_user_id,r.usage_source,false);
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
    perform public.dialogos_v4_settle_bucket(p_user_id,r.usage_source,false);
    update public.dialogos_requests set status='failed',failure_code='STALE_ESTIMATED_COST',actual_micro=null,
      estimated_micro=r.reserve_micro,token_usage=coalesce(token_usage,'{}'::jsonb)||jsonb_build_object('cost_estimated',true,'estimation_basis','reserved_maximum'),updated_at=now()
      where id=r.id;
    released:=released+1;
  end loop;
  return jsonb_build_object('released',released);
end $$;

revoke all on function public.dialogos_v4_user(text,text,text,text) from public,anon,authenticated;
revoke all on function public.dialogos_v4_reserve(uuid,uuid,text,uuid,text,text,bigint,bigint,bigint,boolean,boolean,bigint,bigint,text) from public,anon,authenticated;
revoke all on function public.dialogos_v4_settle_budgets(public.dialogos_requests,bigint) from public,anon,authenticated,service_role;
revoke all on function public.dialogos_v4_settle_bucket(uuid,text,boolean) from public,anon,authenticated,service_role;
revoke all on function public.dialogos_v4_immutable_source() from public,anon,authenticated,service_role;
grant execute on function public.dialogos_v4_user(text,text,text,text) to service_role;
grant execute on function public.dialogos_v4_reserve(uuid,uuid,text,uuid,text,text,bigint,bigint,bigint,boolean,boolean,bigint,bigint,text) to service_role;
insert into public.dialogos_v3_schema(version) values(4) on conflict do nothing;
commit;
