-- المرحلة التاسعة (تعزيز إضافي): لا تكفي علامة المراجع وحدها لتفعيل الموافقة.
-- شغّل مرة واحدة بعد migration 007.
create or replace function public.require_reconciled_payment_for_approval()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_payment public.financial_payments%rowtype;
  v_transaction public.financial_transactions%rowtype;
begin
  if new.status = 'approved' and old.status is distinct from 'approved' then
    select * into v_payment from public.financial_payments where application_id = new.id;
    if not found or v_payment.reconciliation_status <> 'matched'
       or v_payment.checked_against_statement is not true
       or v_payment.received_amount_syp is distinct from new.amount_syp
       or coalesce(btrim(v_payment.transaction_reference), '') = ''
       or v_payment.transfer_at is null then
      raise exception 'PAYMENT_NOT_RECONCILED: يجب مطابقة التحويل الفعلي قبل الموافقة.';
    end if;
    select * into v_transaction
      from public.financial_transactions t
     where t.matched_application_id = new.id
       and t.match_status = 'matched'
       and upper(btrim(t.transaction_reference)) = upper(btrim(v_payment.transaction_reference))
       and t.amount_syp = new.amount_syp
       and t.transaction_kind = 'graduation_payment'
     for update;
    if not found then
      raise exception 'PAYMENT_NOT_IN_LEDGER: يجب تسجيل الحركة الفعلية في دفتر الواردات ومطابقة الرمز والمبلغ قبل الموافقة.';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.require_reconciled_payment_for_approval() from public, anon, authenticated;
