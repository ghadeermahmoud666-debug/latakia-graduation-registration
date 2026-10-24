-- المرحلة الثامنة: سجل تدقيق، حضور QR للموظفين، مطابقة مالية وإقفال يومي، دعم النسخ الاحتياطي.
-- شغّل مرة واحدة بعد migrations 001-005.

-- صلاحيات إضافية للأدوار المنفصلة المالية وبوابة الحفل.
alter table public.staff_roles drop constraint if exists staff_roles_role_check;
alter table public.staff_roles add constraint staff_roles_role_check
  check (role in ('admin', 'reviewer', 'finance', 'gate'));

-- سجل تدقيق لا يمكن للمتصفح الكتابة فيه أو تعديل سجلاته.
create table if not exists public.admin_audit_logs (
  id bigint generated always as identity primary key,
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_email text not null default 'system',
  actor_role text,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  tracking_code text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists admin_audit_logs_created_at_idx on public.admin_audit_logs(created_at desc);
create index if not exists admin_audit_logs_entity_idx on public.admin_audit_logs(entity_type, entity_id, created_at desc);
alter table public.admin_audit_logs enable row level security;
revoke all on public.admin_audit_logs from anon, authenticated;
grant select on public.admin_audit_logs to authenticated;
drop policy if exists "Admins read audit log" on public.admin_audit_logs;
create policy "Admins read audit log" on public.admin_audit_logs for select to authenticated using (public.is_admin());

create or replace function public.audit_application_changes()
returns trigger language plpgsql security definer set search_path = public, auth as $$
declare
  v_actor uuid := auth.uid();
  v_role text;
  v_email text;
  v_action text;
begin
  -- تغييرات خدمة service_role تسجلها وظائف الخادم صراحةً لأنها لا تحمل auth.uid().
  if v_actor is null then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;
  select role into v_role from public.staff_roles where user_id = v_actor;
  v_email := coalesce(auth.jwt() ->> 'email', 'unknown');
  if tg_op = 'DELETE' then
    insert into public.admin_audit_logs(actor_user_id, actor_email, actor_role, action, entity_type, entity_id, tracking_code, details)
    values (v_actor, v_email, v_role, 'application_deleted', 'application', old.id, old.tracking_code,
      jsonb_build_object('full_name', old.full_name, 'status', old.status, 'department', old.department, 'specialization', old.specialization));
    return old;
  elsif tg_op = 'UPDATE' then
    if old.status is distinct from new.status then
      v_action := case when new.status = 'approved' then 'application_approved'
                       when new.status = 'rejected' then 'application_rejected'
                       else 'application_status_changed' end;
      insert into public.admin_audit_logs(actor_user_id, actor_email, actor_role, action, entity_type, entity_id, tracking_code, details)
      values (v_actor, v_email, v_role, v_action, 'application', new.id, new.tracking_code,
        jsonb_build_object('old_status', old.status, 'new_status', new.status, 'rejection_reason', new.rejection_reason,
          'department', new.department, 'specialization', new.specialization));
    end if;
    if old.receipt_path is distinct from new.receipt_path and new.receipt_path is null then
      insert into public.admin_audit_logs(actor_user_id, actor_email, actor_role, action, entity_type, entity_id, tracking_code, details)
      values (v_actor, v_email, v_role, 'receipt_path_cleared', 'application', new.id, new.tracking_code,
        jsonb_build_object('old_receipt_path', old.receipt_path, 'status', new.status));
    end if;
    return new;
  end if;
  return new;
end;
$$;
revoke all on function public.audit_application_changes() from public, anon, authenticated;
drop trigger if exists audit_application_changes on public.applications;
create trigger audit_application_changes after update or delete on public.applications
for each row execute function public.audit_application_changes();

-- سجل المصالحة المالية: رفع الإيصال لا يعني تأكيد الدفع.
create table if not exists public.financial_payments (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null unique references public.applications(id) on delete cascade,
  expected_amount_syp bigint not null check (expected_amount_syp >= 0),
  received_amount_syp bigint check (received_amount_syp is null or received_amount_syp >= 0),
  transaction_reference text,
  transfer_at timestamptz,
  payer_note text,
  reconciliation_status text not null default 'unverified'
    check (reconciliation_status in ('unverified', 'matched', 'mismatch', 'suspected', 'not_found')),
  checked_against_statement boolean not null default false,
  verification_notes text,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  verified_by uuid references auth.users(id) on delete set null,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists financial_payments_unique_transaction_ref
  on public.financial_payments (upper(btrim(transaction_reference)))
  where transaction_reference is not null and btrim(transaction_reference) <> '';
create index if not exists financial_payments_status_idx on public.financial_payments(reconciliation_status, created_at desc);
create index if not exists financial_payments_transfer_at_idx on public.financial_payments(transfer_at) where reconciliation_status = 'matched';
alter table public.financial_payments enable row level security;
revoke all on public.financial_payments from anon, authenticated;

-- إنشاء سجل مصالحة تلقائيًا عند رفع الإيصال، وتحديث السجلات القديمة.
create or replace function public.ensure_financial_payment_record()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.receipt_path is null then return new; end if;
  if tg_op = 'INSERT' or old.receipt_path is distinct from new.receipt_path then
    insert into public.financial_payments(application_id, expected_amount_syp, reconciliation_status)
    values (new.id, new.amount_syp, 'unverified')
    on conflict (application_id) do update
      set expected_amount_syp = excluded.expected_amount_syp,
          updated_at = now()
      where public.financial_payments.reconciliation_status <> 'matched';
  end if;
  return new;
end;
$$;
revoke all on function public.ensure_financial_payment_record() from public, anon, authenticated;
drop trigger if exists ensure_financial_payment_record on public.applications;
create trigger ensure_financial_payment_record after insert or update of receipt_path on public.applications
for each row execute function public.ensure_financial_payment_record();
insert into public.financial_payments(application_id, expected_amount_syp, reconciliation_status)
select id, amount_syp, 'unverified' from public.applications where receipt_path is not null
on conflict (application_id) do nothing;

-- لا يمكن الموافقة على طلب ما لم يطابق مسؤول مالي التحويل الفعلي في سجل شام كاش/كشف الحساب.
create or replace function public.require_reconciled_payment_for_approval()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_payment public.financial_payments%rowtype;
begin
  if new.status = 'approved' and old.status is distinct from 'approved' then
    select * into v_payment from public.financial_payments where application_id = new.id;
    if not found or v_payment.reconciliation_status <> 'matched'
       or v_payment.checked_against_statement is not true
       or v_payment.received_amount_syp is distinct from new.amount_syp
       or coalesce(btrim(v_payment.transaction_reference), '') = ''
       or v_payment.transfer_at is null then
      raise exception 'PAYMENT_NOT_RECONCILED: لا يمكن الموافقة قبل مطابقة مبلغ التحويل ورقمه مع سجل شام كاش الفعلي.';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.require_reconciled_payment_for_approval() from public, anon, authenticated;
drop trigger if exists require_reconciled_payment_for_approval on public.applications;
create trigger require_reconciled_payment_for_approval before update of status on public.applications
for each row execute function public.require_reconciled_payment_for_approval();

-- جدول إقفال الصندوق/حساب شام كاش يوميًا.
create table if not exists public.financial_daily_closings (
  id uuid primary key default gen_random_uuid(),
  closing_date date not null unique,
  matched_transaction_count integer not null default 0,
  matched_total_syp bigint not null default 0,
  statement_transaction_count integer not null check (statement_transaction_count >= 0),
  statement_total_syp bigint not null check (statement_total_syp >= 0),
  difference_count integer not null,
  difference_amount_syp bigint not null,
  is_override boolean not null default false,
  override_reason text,
  notes text,
  closed_by uuid references auth.users(id) on delete set null,
  closed_at timestamptz not null default now()
);
alter table public.financial_daily_closings enable row level security;
revoke all on public.financial_daily_closings from anon, authenticated;

-- مجموع موثوق للحركات المطابقة في فترة زمنية؛ لا يتيح هذا RPC إلا لخادم الخدمة.
create or replace function public.financial_day_totals(p_start timestamptz, p_end timestamptz)
returns table(matched_count bigint, matched_total_syp bigint)
language sql stable security definer set search_path = public as $$
  select count(*)::bigint, coalesce(sum(received_amount_syp), 0)::bigint
  from public.financial_payments
  where reconciliation_status = 'matched' and transfer_at >= p_start and transfer_at < p_end;
$$;
revoke all on function public.financial_day_totals(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.financial_day_totals(timestamptz, timestamptz) to service_role;

-- علامة حضور غير قابلة للاستخدام المتكرر. الاستدعاء محصور بخدمة الخادم بعد التحقق من دور الموظف.
alter table public.entry_tickets add column if not exists checked_in_at timestamptz;
alter table public.entry_tickets add column if not exists checked_in_by uuid references auth.users(id) on delete set null;
create index if not exists entry_tickets_checked_in_at_idx on public.entry_tickets(checked_in_at) where checked_in_at is not null;

create or replace function public.check_in_ticket_once(p_ticket_token text, p_actor_user_id uuid, p_actor_email text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_ticket public.entry_tickets%rowtype;
  v_application public.applications%rowtype;
  v_role text;
begin
  select role into v_role from public.staff_roles where user_id = p_actor_user_id;
  if v_role is null or v_role not in ('admin', 'reviewer', 'gate') then
    raise exception 'GATE_ACCESS_DENIED';
  end if;
  select * into v_ticket from public.entry_tickets where ticket_token = upper(btrim(p_ticket_token)) for update;
  if not found then return jsonb_build_object('status', 'invalid', 'message', 'رمز البطاقة غير موجود.'); end if;
  select * into v_application from public.applications where id = v_ticket.application_id;
  if not found or v_application.status <> 'approved' then
    return jsonb_build_object('status', 'invalid', 'message', 'الطلب غير مقبول؛ لا يسمح بالدخول.');
  end if;
  if v_ticket.checked_in_at is not null then
    return jsonb_build_object('status', 'already_used', 'checked_in_at', v_ticket.checked_in_at,
      'message', 'تم استخدام هذه البطاقة سابقًا. لا تسمح بدخول ثانٍ بهذه البطاقة.',
      'ticket_type', v_ticket.ticket_type, 'ticket_number', v_ticket.ticket_number, 'full_name', v_application.full_name,
      'department', v_application.department, 'specialization', v_application.specialization);
  end if;
  update public.entry_tickets set checked_in_at = now(), checked_in_by = p_actor_user_id where id = v_ticket.id;
  insert into public.admin_audit_logs(actor_user_id, actor_email, actor_role, action, entity_type, entity_id, tracking_code, details)
  values (p_actor_user_id, coalesce(p_actor_email, 'unknown'), v_role, 'ticket_checked_in', 'entry_ticket', v_ticket.id,
    v_application.tracking_code, jsonb_build_object('ticket_type', v_ticket.ticket_type, 'ticket_number', v_ticket.ticket_number,
      'full_name', v_application.full_name, 'department', v_application.department, 'checked_in_at', now()));
  return jsonb_build_object('status', 'checked_in', 'checked_in_at', now(), 'ticket_type', v_ticket.ticket_type,
    'ticket_number', v_ticket.ticket_number, 'full_name', v_application.full_name, 'university_number', v_application.university_number,
    'department', v_application.department, 'specialization', v_application.specialization,
    'message', 'تم تسجيل الدخول بنجاح. لا يمكن استخدام هذه البطاقة مرة أخرى.');
end;
$$;
revoke all on function public.check_in_ticket_once(text, uuid, text) from public, anon, authenticated;
grant execute on function public.check_in_ticket_once(text, uuid, text) to service_role;

-- توثيق تشغيل النسخ الاحتياطية وتصدير التقارير.
create table if not exists public.admin_backup_runs (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_email text not null,
  file_name text not null,
  file_size_bytes bigint,
  row_counts jsonb not null default '{}'::jsonb,
  confirmed_saved boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.admin_backup_runs enable row level security;
revoke all on public.admin_backup_runs from anon, authenticated;

comment on table public.admin_audit_logs is 'سجل تدقيق إداري يثبت مراجعة الطلبات والحذف والمطابقة المالية وتسجيل الدخول من قبل الموظفين.';
comment on table public.financial_payments is 'سجل مطابقة يدوية ضد حركات شام كاش الفعلية؛ رفع PDF وحده ليس إثبات دفع.';
comment on table public.financial_daily_closings is 'إقفال يومي يقارن عدد ومجموع الحركات المطابقة مع كشف شام كاش الرسمي.';
comment on column public.entry_tickets.checked_in_at is 'وقت أول مسح ناجح داخل بوابة الموظفين؛ لا يمكن استخدام البطاقة ثانية.';
