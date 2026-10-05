-- VoteQuest backend storage. Run once in the Supabase SQL Editor or with `supabase db push`.
-- Client-side anon/authenticated roles have no table access; only the Supabase Edge Function uses the service role key.

create extension if not exists pgcrypto;

create table if not exists public.votequest_settings (
  id smallint primary key check (id = 1),
  demo_mode boolean not null default true,
  updated_at timestamptz not null default now()
);

insert into public.votequest_settings (id, demo_mode)
values (1, true)
on conflict (id) do nothing;

create table if not exists public.votequest_verified_totals (
  candidate text primary key check (candidate in ('lula', 'flavio')),
  vote_count bigint not null default 0 check (vote_count >= 0),
  updated_at timestamptz not null default now()
);

insert into public.votequest_verified_totals (candidate, vote_count)
values ('lula', 0), ('flavio', 0)
on conflict (candidate) do nothing;

create table if not exists public.votequest_manual_totals (
  candidate text primary key check (candidate in ('lula', 'flavio')),
  vote_count bigint not null default 0 check (vote_count >= 0),
  updated_at timestamptz not null default now()
);

insert into public.votequest_manual_totals (candidate, vote_count)
values ('lula', 0), ('flavio', 0)
on conflict (candidate) do nothing;

create table if not exists public.votequest_payments (
  id uuid primary key default gen_random_uuid(),
  protocol text not null unique check (protocol ~ '^[A-F0-9]{32}$'),
  candidate text check (candidate is null or candidate in ('lula', 'flavio')),
  end_to_end_id text,
  payment_hash text not null unique check (payment_hash ~ '^[a-f0-9]{64}$'),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  constraint votequest_payment_private_fields check (
    (status = 'pending' and candidate is not null and end_to_end_id is not null)
    or
    (status in ('approved', 'rejected') and candidate is null and end_to_end_id is null)
  )
);

create index if not exists votequest_payments_pending_created_idx
  on public.votequest_payments (created_at)
  where status = 'pending';

create table if not exists public.votequest_manual_adjustments (
  id uuid primary key default gen_random_uuid(),
  candidate text not null check (candidate in ('lula', 'flavio')),
  amount integer not null check (amount between 1 and 1000000),
  reason text not null check (char_length(trim(reason)) between 3 and 160),
  created_at timestamptz not null default now()
);

create index if not exists votequest_manual_adjustments_created_idx
  on public.votequest_manual_adjustments (created_at desc);

alter table public.votequest_settings enable row level security;
alter table public.votequest_verified_totals enable row level security;
alter table public.votequest_manual_totals enable row level security;
alter table public.votequest_payments enable row level security;
alter table public.votequest_manual_adjustments enable row level security;

revoke all on table public.votequest_settings from anon, authenticated;
revoke all on table public.votequest_verified_totals from anon, authenticated;
revoke all on table public.votequest_manual_totals from anon, authenticated;
revoke all on table public.votequest_payments from anon, authenticated;
revoke all on table public.votequest_manual_adjustments from anon, authenticated;

grant usage on schema public to service_role;
grant select, insert, update on table public.votequest_settings to service_role;
grant select, insert, update on table public.votequest_verified_totals to service_role;
grant select, insert, update on table public.votequest_manual_totals to service_role;
grant select, insert, update on table public.votequest_payments to service_role;
grant select, insert, update on table public.votequest_manual_adjustments to service_role;

create or replace function public.votequest_public_results()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'demoMode', coalesce((select demo_mode from public.votequest_settings where id = 1), true),
    'verifiedCounts', jsonb_build_object(
      'lula', coalesce((select vote_count from public.votequest_verified_totals where candidate = 'lula'), 0),
      'flavio', coalesce((select vote_count from public.votequest_verified_totals where candidate = 'flavio'), 0)
    ),
    'manualCounts', jsonb_build_object(
      'lula', coalesce((select vote_count from public.votequest_manual_totals where candidate = 'lula'), 0),
      'flavio', coalesce((select vote_count from public.votequest_manual_totals where candidate = 'flavio'), 0)
    )
  );
$$;

create or replace function public.votequest_add_manual_votes(
  p_candidate text,
  p_amount integer,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_adjustment public.votequest_manual_adjustments%rowtype;
begin
  if p_candidate is null or p_candidate not in ('lula', 'flavio') then
    raise exception using errcode = '22023', message = 'invalid_candidate';
  end if;
  if p_amount is null or p_amount < 1 or p_amount > 1000000 then
    raise exception using errcode = '22023', message = 'invalid_amount';
  end if;
  if p_reason is null or char_length(trim(p_reason)) < 3 or char_length(trim(p_reason)) > 160 then
    raise exception using errcode = '22023', message = 'invalid_reason';
  end if;

  insert into public.votequest_manual_adjustments (candidate, amount, reason)
  values (p_candidate, p_amount, trim(p_reason))
  returning * into v_adjustment;

  update public.votequest_manual_totals
  set vote_count = vote_count + p_amount, updated_at = now()
  where candidate = p_candidate;

  if not found then
    raise exception using errcode = 'P0002', message = 'manual_totals_missing';
  end if;

  return jsonb_build_object(
    'id', v_adjustment.id,
    'candidate', v_adjustment.candidate,
    'amount', v_adjustment.amount,
    'reason', v_adjustment.reason,
    'createdAt', v_adjustment.created_at
  );
end;
$$;

create or replace function public.votequest_decide_payment(
  p_protocol text,
  p_decision text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment public.votequest_payments%rowtype;
  v_status text;
begin
  if p_decision is null or p_decision not in ('approve', 'reject') then
    raise exception using errcode = '22023', message = 'invalid_decision';
  end if;

  select * into v_payment
  from public.votequest_payments
  where protocol = p_protocol
  for update;

  if not found or v_payment.status <> 'pending' then
    return jsonb_build_object('status', 'not_found');
  end if;

  if p_decision = 'approve' then
    update public.votequest_verified_totals
    set vote_count = vote_count + 1, updated_at = now()
    where candidate = v_payment.candidate;

    if not found then
      raise exception using errcode = 'P0002', message = 'verified_totals_missing';
    end if;

    v_status := 'approved';
  else
    v_status := 'rejected';
  end if;

  -- Remove the E2E ID and candidate/payment association after the manual decision.
  update public.votequest_payments
  set status = v_status, candidate = null, end_to_end_id = null, decided_at = now()
  where id = v_payment.id;

  return jsonb_build_object('status', v_status);
end;
$$;

revoke all on function public.votequest_public_results() from public, anon, authenticated;
revoke all on function public.votequest_add_manual_votes(text, integer, text) from public, anon, authenticated;
revoke all on function public.votequest_decide_payment(text, text) from public, anon, authenticated;
grant execute on function public.votequest_public_results() to service_role;
grant execute on function public.votequest_add_manual_votes(text, integer, text) to service_role;
grant execute on function public.votequest_decide_payment(text, text) to service_role;
