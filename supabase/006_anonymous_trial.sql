-- Anonymous daily trial. Apply after 005; never merge this namespace with a
-- Supabase account. Browser/session issuance is stateless. Only an admitted,
-- Turnstile-verified generation creates a guest, inside the budget transaction.
begin;
alter table public.users add column if not exists is_guest boolean not null default false;
do $$ begin
  if not exists(select 1 from pg_constraint where conname='dialogos_guest_identity' and conrelid='public.users'::regclass) then
    alter table public.users add constraint dialogos_guest_identity check(not is_guest or
      (auth_user_id='guest:v6:'||id::text and guest_id='guest_v6_'||id::text
       and credits=0 and reserved_credits=0 and email is null and stripe_customer_id is null
       and subscription_id is null and trial_google_subject is null and trial_eligible));
  end if;
end $$;

create table if not exists public.dialogos_guest_attempts(
  request_id uuid primary key references public.dialogos_requests(id),
  network_hash text not null check(network_hash ~ '^[A-Za-z0-9_-]{43}$'),
  proof_hash text not null unique check(proof_hash ~ '^[a-f0-9]{64}$'),
  quota_day date not null,
  admitted_at timestamptz not null default clock_timestamp());
create index if not exists dialogos_guest_network_day on public.dialogos_guest_attempts(network_hash,quota_day);
create index if not exists dialogos_guest_network_time on public.dialogos_guest_attempts(network_hash,admitted_at desc);
alter table public.dialogos_guest_attempts enable row level security;
revoke all on public.dialogos_guest_attempts from public,anon,authenticated;
grant all on public.dialogos_guest_attempts to service_role;

-- Preserve 005's paid/Google behavior, but remove direct guest access to its
-- reservation primitive. The service role can only admit guests through the
-- network + proof gate below. Reapplying this migration retains the original core.
do $$ begin
  if to_regprocedure('public.dialogos_v5_reserve_core(uuid,uuid,text,uuid,text,text,bigint,bigint,bigint,boolean,boolean,bigint,bigint,text)') is null then
    alter function public.dialogos_v5_reserve(uuid,uuid,text,uuid,text,text,bigint,bigint,bigint,boolean,boolean,bigint,bigint,text) rename to dialogos_v5_reserve_core;
  end if;
end $$;
revoke all on function public.dialogos_v5_reserve_core(uuid,uuid,text,uuid,text,text,bigint,bigint,bigint,boolean,boolean,bigint,bigint,text) from public,anon,authenticated,service_role;
create or replace function public.dialogos_v5_reserve(p_user_id uuid,p_request_id uuid,p_fingerprint text,p_conversation_id uuid,
  p_philosopher_id text,p_message text,p_reserve_micro bigint,p_daily_limit_micro bigint,p_monthly_limit_micro bigint,
  p_trial_enabled boolean,p_paid_enabled boolean,p_trial_daily_limit_micro bigint,p_trial_monthly_limit_micro bigint,p_expected_source text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if exists(select 1 from public.users where id=p_user_id and is_guest) then raise exception 'AUTH_REQUIRED'; end if;
  return public.dialogos_v5_reserve_core(p_user_id,p_request_id,p_fingerprint,p_conversation_id,p_philosopher_id,p_message,
    p_reserve_micro,p_daily_limit_micro,p_monthly_limit_micro,p_trial_enabled,p_paid_enabled,
    p_trial_daily_limit_micro,p_trial_monthly_limit_micro,p_expected_source);
end $$;

create or replace function public.dialogos_v6_guest_reserve(p_guest_id uuid,p_request_id uuid,p_fingerprint text,p_conversation_id uuid,
  p_philosopher_id text,p_message text,p_reserve_micro bigint,p_daily_limit_micro bigint,p_monthly_limit_micro bigint,
  p_trial_daily_limit_micro bigint,p_trial_monthly_limit_micro bigint,p_network_hash text,p_proof_hash text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare u public.users;r public.dialogos_requests;result jsonb;j date;t timestamptz;
begin
  if p_guest_id is null or p_request_id is null then raise exception 'INVALID_REQUEST'; end if;
  perform pg_advisory_xact_lock(hashtextextended('dialogos-guest-v6:'||p_guest_id::text,0));
  select * into u from public.users where id=p_guest_id for update;
  if found and (not u.is_guest or u.auth_user_id is distinct from 'guest:v6:'||p_guest_id::text) then raise exception 'AUTH_REQUIRED'; end if;
  select * into r from public.dialogos_requests where id=p_request_id;
  if found then
    if r.user_id<>p_guest_id or r.fingerprint is distinct from p_fingerprint then raise exception 'REQUEST_CONFLICT'; end if;
    return to_jsonb(r);
  end if;
  if p_network_hash is null or p_network_hash !~ '^[A-Za-z0-9_-]{43}$'
    or p_proof_hash is null or p_proof_hash !~ '^[a-f0-9]{64}$' then raise exception 'TURNSTILE_REQUIRED'; end if;
  -- Serialized by network across all guests/server instances. Failed and unknown
  -- requests retain this admission attempt; free quota refunds do not reset it.
  perform pg_advisory_xact_lock(hashtextextended('dialogos-network-v6:'||p_network_hash,0));
  t:=clock_timestamp();j:=public.dialogos_jst_day(t);
  if(select count(*) from public.dialogos_guest_attempts where network_hash=p_network_hash and quota_day=j)>=30
    or(select count(*) from public.dialogos_guest_attempts where network_hash=p_network_hash and admitted_at>=t-interval '60 seconds')>=6 then raise exception 'NETWORK_RATE_LIMITED'; end if;
  if exists(select 1 from public.dialogos_guest_attempts where proof_hash=p_proof_hash) then raise exception 'TURNSTILE_FAILED'; end if;
  insert into public.users(id,guest_id,auth_user_id,is_guest,free_count,credits,trial_eligible)
    values(p_guest_id,'guest_v6_'||p_guest_id::text,'guest:v6:'||p_guest_id::text,true,0,0,true)
    on conflict(id) do nothing;
  -- Free-only: no paid fallback even if a caller supplied forged balance/source.
  if(select (public.dialogos_v5_user_state(p_guest_id)->>'trial_remaining')::integer
      -(public.dialogos_v5_user_state(p_guest_id)->>'trial_reserved')::integer)<=0 then raise exception 'LOCKED'; end if;
  result:=public.dialogos_v5_reserve_core(p_guest_id,p_request_id,p_fingerprint,p_conversation_id,p_philosopher_id,p_message,
    p_reserve_micro,p_daily_limit_micro,p_monthly_limit_micro,true,false,
    p_trial_daily_limit_micro,p_trial_monthly_limit_micro,'trial');
  insert into public.dialogos_guest_attempts(request_id,network_hash,proof_hash,quota_day,admitted_at)
    values(p_request_id,p_network_hash,p_proof_hash,j,t);
  return result;
end $$;

revoke all on function public.dialogos_v5_reserve(uuid,uuid,text,uuid,text,text,bigint,bigint,bigint,boolean,boolean,bigint,bigint,text) from public,anon,authenticated;
revoke all on function public.dialogos_v6_guest_reserve(uuid,uuid,text,uuid,text,text,bigint,bigint,bigint,bigint,bigint,text,text) from public,anon,authenticated;
grant execute on function public.dialogos_v5_reserve(uuid,uuid,text,uuid,text,text,bigint,bigint,bigint,boolean,boolean,bigint,bigint,text) to service_role;
grant execute on function public.dialogos_v6_guest_reserve(uuid,uuid,text,uuid,text,text,bigint,bigint,bigint,bigint,bigint,text,text) to service_role;
insert into public.dialogos_v3_schema(version) values(6) on conflict do nothing;
commit;
