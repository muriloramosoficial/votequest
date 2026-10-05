-- VoteQuest backend storage.
-- Idempotent: safe to run on a fresh project or on a database that still carries the
-- legacy demonstrative/manual-vote/E2E objects (they are dropped in the teardown block below).
-- Client-side anon/authenticated roles have no table access; only the Edge Function uses the
-- service role key.
--
-- Payment proof model: the voter never types a bank transaction id. When the vote flow starts,
-- the Edge Function mints a short random reference code, embeds it in the Pix payload as the
-- TxID (field 62.05) and serves that per-vote QR. The code is what the payer sees in their bank
-- receipt and what the admin searches for in the statement, so it stays short while still being
-- bound to exactly one real payment.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Teardown of removed features (demonstrative scoreboard, manual votes, E2E flow).
-- ---------------------------------------------------------------------------
drop table if exists public.votequest_manual_adjustments;
drop table if exists public.votequest_manual_totals;
drop table if exists public.votequest_settings;
drop table if exists public.votequest_payments;
drop function if exists public.votequest_add_manual_votes(text, integer, text);
drop function if exists public.votequest_decide_payment(text, text);
drop function if exists public.votequest_confirm_payment(text);
drop function if exists public.votequest_expire_stale();
drop function if exists public.votequest_public_results();

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table if not exists public.votequest_verified_totals (
  candidate text primary key check (candidate in ('lula', 'flavio')),
  vote_count bigint not null default 0 check (vote_count >= 0),
  updated_at timestamptz not null default now()
);

insert into public.votequest_verified_totals (candidate, vote_count)
values ('lula', 0), ('flavio', 0)
on conflict (candidate) do nothing;

-- reference_code lives in the Pix TxID and is what the admin matches in the bank statement.
-- It is a random 8-char string with no personal data, so it is kept after the decision to
-- preserve the unique constraint that stops the same code from ever being minted twice.
create table if not exists public.votequest_payments (
  id uuid primary key default gen_random_uuid(),
  protocol text not null unique check (protocol ~ '^[A-F0-9]{32}$'),
  reference_code text not null unique check (reference_code ~ '^[23456789A-HJ-NP-Z]{8}$'),
  payment_hash text not null unique check (payment_hash ~ '^[a-f0-9]{64}$'),
  candidate text check (candidate is null or candidate in ('lula', 'flavio')),
  status text not null default 'pending'
    check (status in ('pending', 'review', 'approved', 'rejected', 'expired')),
  created_at timestamptz not null default now(),
  confirmed_at timestamptz,
  decided_at timestamptz,
  expires_at timestamptz not null default (now() + interval '60 minutes'),
  constraint votequest_payment_state check (
    (status in ('pending', 'review') and candidate is not null)
    or
    (status in ('approved', 'rejected', 'expired') and candidate is null)
  ),
  constraint votequest_payment_timeline check (
    (status = 'pending' and confirmed_at is null)
    or (status <> 'pending')
  )
);

create index if not exists votequest_payments_open_idx
  on public.votequest_payments (created_at)
  where status in ('pending', 'review');

create index if not exists votequest_payments_expires_idx
  on public.votequest_payments (expires_at)
  where status in ('pending', 'review');

-- ---------------------------------------------------------------------------
-- Row level security: the browser never reads or writes these tables directly.
-- ---------------------------------------------------------------------------
alter table public.votequest_verified_totals enable row level security;
alter table public.votequest_payments enable row level security;

revoke all on table public.votequest_verified_totals from anon, authenticated;
revoke all on table public.votequest_payments from anon, authenticated;

grant usage on schema public to service_role;
grant select, insert, update on table public.votequest_verified_totals to service_role;
grant select, insert, update on table public.votequest_payments to service_role;

-- ---------------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------------
create or replace function public.votequest_public_results()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'verifiedCounts', jsonb_build_object(
      'lula', coalesce((select vote_count from public.votequest_verified_totals where candidate = 'lula'), 0),
      'flavio', coalesce((select vote_count from public.votequest_verified_totals where candidate = 'flavio'), 0)
    )
  );
$$;

-- Moves open requests whose time window closed into the 'expired' state so they stop showing up
-- in the admin queue. Idempotent; the Edge Function calls it opportunistically.
create or replace function public.votequest_expire_stale()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  update public.votequest_payments
  set status = 'expired', candidate = null
  where status in ('pending', 'review') and expires_at <= now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Voter pressed "Já fiz o Pix". Records the confirmation timestamp so the admin can compare it
-- against the payment time in the statement.
create or replace function public.votequest_confirm_payment(p_protocol text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment public.votequest_payments%rowtype;
begin
  if p_protocol is null or p_protocol !~ '^[A-F0-9]{32}$' then
    raise exception using errcode = '22023', message = 'invalid_protocol';
  end if;

  select * into v_payment
  from public.votequest_payments
  where protocol = p_protocol
  for update;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- Idempotent: confirming twice keeps the original timestamp.
  if v_payment.status = 'review' then
    return jsonb_build_object('status', 'review', 'confirmedAt', v_payment.confirmed_at);
  end if;

  if v_payment.status <> 'pending' then
    return jsonb_build_object('status', v_payment.status);
  end if;

  if v_payment.expires_at <= now() then
    update public.votequest_payments
    set status = 'expired', candidate = null
    where id = v_payment.id;
    return jsonb_build_object('status', 'expired');
  end if;

  update public.votequest_payments
  set status = 'review', confirmed_at = now()
  where id = v_payment.id;

  return jsonb_build_object('status', 'review', 'confirmedAt', now());
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
  if p_protocol is null or p_protocol !~ '^[A-F0-9]{32}$' then
    raise exception using errcode = '22023', message = 'invalid_protocol';
  end if;
  if p_decision is null or p_decision not in ('approve', 'reject') then
    raise exception using errcode = '22023', message = 'invalid_decision';
  end if;

  select * into v_payment
  from public.votequest_payments
  where protocol = p_protocol
  for update;

  -- Only requests the voter actually confirmed can be decided.
  if not found or v_payment.status <> 'review' then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_payment.expires_at <= now() then
    update public.votequest_payments
    set status = 'expired', candidate = null, decided_at = now()
    where id = v_payment.id;
    return jsonb_build_object('status', 'expired');
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

  -- Drop the candidate association after the decision; the random reference code is kept only
  -- because it carries no personal data and the unique index depends on it.
  update public.votequest_payments
  set status = v_status, candidate = null, decided_at = now()
  where id = v_payment.id;

  return jsonb_build_object('status', v_status, 'referenceCode', v_payment.reference_code);
end;
$$;

revoke all on function public.votequest_public_results() from public, anon, authenticated;
revoke all on function public.votequest_expire_stale() from public, anon, authenticated;
revoke all on function public.votequest_confirm_payment(text) from public, anon, authenticated;
revoke all on function public.votequest_decide_payment(text, text) from public, anon, authenticated;
grant execute on function public.votequest_public_results() to service_role;
grant execute on function public.votequest_expire_stale() to service_role;
grant execute on function public.votequest_confirm_payment(text) to service_role;
grant execute on function public.votequest_decide_payment(text, text) to service_role;