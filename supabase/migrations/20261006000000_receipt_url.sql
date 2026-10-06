-- Receipt URL (votequest.com.br/<reference code>) and admin decisions on unconfirmed requests.
--
-- Two changes, both needed for the receipt:
--
--   1. The candidate now survives the decision. Approving used to null it, so a receipt for a
--      validated vote could not say which option it counted. The row never held personal data
--      (no CPF, no name, no document) and the code is random, so keeping it costs nothing and
--      is exactly what the payer comes to verify. Nulling happened only where the caller relied
--      on the old constraint, so the constraint is dropped rather than rewritten.
--
--   2. The admin can decide a request the voter never confirmed. Someone who paid and then
--      closed the dialog left the row in 'pending'; votequest_decide_payment refused anything
--      other than 'review', so the queue rendered approve/reject buttons that always failed
--      with 404 and the item sat there forever.

alter table public.votequest_payments
  drop constraint if exists votequest_payment_state;

-- ---------------------------------------------------------------------------
-- Expire stale requests without discarding the option.
-- ---------------------------------------------------------------------------
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
  set status = 'expired'
  where status in ('pending', 'review') and expires_at <= now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Voter pressed "Já fiz o Pix", possibly from the receipt page after closing the dialog.
-- ---------------------------------------------------------------------------
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
    set status = 'expired'
    where id = v_payment.id;
    return jsonb_build_object('status', 'expired');
  end if;

  update public.votequest_payments
  set status = 'review', confirmed_at = now()
  where id = v_payment.id;

  return jsonb_build_object('status', 'review', 'confirmedAt', now());
end;
$$;

-- ---------------------------------------------------------------------------
-- Admin decision. 'pending' is now decidable as well as 'review'.
-- ---------------------------------------------------------------------------
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

  -- Anything still in the queue can be decided, whether or not the payer pressed the button.
  if not found or v_payment.status not in ('pending', 'review') then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_payment.expires_at <= now() then
    update public.votequest_payments
    set status = 'expired', decided_at = now()
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

  update public.votequest_payments
  set status = v_status, decided_at = now()
  where id = v_payment.id;

  return jsonb_build_object('status', v_status, 'referenceCode', v_payment.reference_code);
end;
$$;

revoke all on function public.votequest_expire_stale() from public, anon, authenticated;
revoke all on function public.votequest_confirm_payment(text) from public, anon, authenticated;
revoke all on function public.votequest_decide_payment(text, text) from public, anon, authenticated;
grant execute on function public.votequest_expire_stale() to service_role;
grant execute on function public.votequest_confirm_payment(text) to service_role;
grant execute on function public.votequest_decide_payment(text, text) to service_role;
