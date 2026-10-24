-- المرحلة التاسعة: دفتر واردات شام كاش، إقفال يومي صارم، صلاحية ماسح البوابة للموظفين فقط.
-- شغّل مرة واحدة بعد migrations 001-006.

create table if not exists public.financial_transactions (
  id uuid primary key default gen_random_uuid(),
  transaction_reference text not null,
  amount_syp bigint not null check (amount_syp > 0),
  payer_note text not null default '',
  transferred_at timestamptz not null,
  transaction_kind text not null default 'graduation_payment'
    check (transaction_kind in ('graduation_payment', 'other_income')),
  match_status text not null default 'missing_tracking_code'
    check (match_status in ('matched','other_income','missing_tracking_code','unknown_tracking_code','amount_mismatch','already_paid','application_rejected','duplicate_payment_reference')),
  tracking_code text,
  matched_application_id uuid references public.applications(id) on delete set null,
  recorded_by uuid references auth.users(id) on delete set null,
  source text not null default 'manual' check (source in ('manual','csv')),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create unique index if not exists financial_transactions_reference_uq
  on public.financial_transactions (upper(btrim(transaction_reference)));
create index if not exists financial_transactions_transfer_idx
  on public.financial_transactions (transferred_at desc);
create index if not exists financial_transactions_status_idx
  on public.financial_transactions (match_status, transferred_at desc);
create index if not exists financial_transactions_application_idx
  on public.financial_transactions (matched_application_id);

alter table public.financial_transactions enable row level security;
revoke all on public.financial_transactions from anon, authenticated;

alter table public.financial_daily_closings
  add column if not exists recorded_transaction_count integer not null default 0,
  add column if not exists recorded_total_syp bigint not null default 0,
  add column if not exists unresolved_transaction_count integer not null default 0,
  add column if not exists closed_by_role text;

-- يسجل الحركة الواردة كما ظهرت في حساب شام كاش، ويطابقها فقط عندما يكون رمز التتبع والمبلغ صحيحين.
-- كل الإدخالات تمر عبر function خادمية لا يستطيع العميل استدعاءها مباشرة.
create or replace function public.record_financial_transaction(
  p_actor_user_id uuid,
  p_actor_email text,
  p_transaction_reference text,
  p_amount_syp bigint,
  p_payer_note text,
  p_transferred_at timestamptz,
  p_transaction_kind text default 'graduation_payment',
  p_source text default 'manual'
) returns jsonb
language plpgsql security definer set search_path = public, auth as $$
declare
  v_role text;
  v_reference text := upper(btrim(coalesce(p_transaction_reference, '')));
  v_note text := btrim(coalesce(p_payer_note, ''));
  v_kind text := coalesce(p_transaction_kind, 'graduation_payment');
  v_source text := coalesce(p_source, 'manual');
  v_day date;
  v_code text;
  v_app public.applications%rowtype;
  v_existing public.financial_payments%rowtype;
  v_match_status text;
  v_app_id uuid;
  v_transaction_id uuid;
  v_role_text text;
  v_result jsonb;
begin
  select role into v_role from public.staff_roles where user_id = p_actor_user_id;
  if v_role not in ('admin','finance') or v_role is null then
    return jsonb_build_object('status','forbidden','message','هذه العملية متاحة للمدير والمسؤول المالي فقط.');
  end if;
  if length(v_reference) < 3 or length(v_reference) > 160 then
    return jsonb_build_object('status','invalid','message','رقم الحركة في كشف شام كاش مطلوب ويجب أن يكون فريدًا.');
  end if;
  if p_amount_syp is null or p_amount_syp <= 0 then
    return jsonb_build_object('status','invalid','message','المبلغ الوارد يجب أن يكون أكبر من صفر.');
  end if;
  if p_transferred_at is null then
    return jsonb_build_object('status','invalid','message','تاريخ ووقت التحويل مطلوبان.');
  end if;
  if v_kind not in ('graduation_payment','other_income') then
    return jsonb_build_object('status','invalid','message','نوع الحركة غير صالح.');
  end if;
  if v_source not in ('manual','csv') then v_source := 'manual'; end if;
  v_day := (p_transferred_at at time zone 'Asia/Damascus')::date;
  perform pg_advisory_xact_lock(hashtext(v_day::text));
  if exists (select 1 from public.financial_daily_closings c where c.closing_date = v_day) then
    return jsonb_build_object('status','day_closed','message','تم إقفال هذا اليوم المالي؛ لا يمكن إضافة حركات إليه بعد الإقفال.');
  end if;
  if exists (select 1 from public.financial_transactions t where upper(btrim(t.transaction_reference)) = upper(v_reference)) then
    insert into public.admin_audit_logs(actor_user_id,actor_email,actor_role,action,entity_type,tracking_code,details)
    values (p_actor_user_id,coalesce(p_actor_email,'unknown'),v_role,'financial_duplicate_reference_attempt','financial_transaction',null,
      jsonb_build_object('transaction_reference',v_reference,'amount_syp',p_amount_syp,'transferred_at',p_transferred_at));
    return jsonb_build_object('status','duplicate_reference','message','رقم الحركة موجود مسبقًا. لم تتم إضافتها مرتين.');
  end if;

  if v_kind = 'other_income' then
    if length(v_note) < 3 then return jsonb_build_object('status','invalid','message','اشرح طبيعة الحركة الأخرى في الملاحظات.'); end if;
    v_match_status := 'other_income';
  else
    v_code := (regexp_match(upper(v_note), '(LAT-[A-F0-9]{32}|LAT-[A-F0-9]{10})'))[1];
    if v_code is null then
      v_match_status := 'missing_tracking_code';
    else
      select * into v_app from public.applications where tracking_code = v_code for update;
      if not found then
        v_match_status := 'unknown_tracking_code';
      elsif v_app.status = 'rejected' then
        v_match_status := 'application_rejected';
        v_app_id := v_app.id;
      elsif v_app.amount_syp is distinct from p_amount_syp then
        v_match_status := 'amount_mismatch';
        v_app_id := v_app.id;
      else
        select * into v_existing from public.financial_payments where application_id = v_app.id for update;
        if found and v_existing.reconciliation_status = 'matched' then
          v_match_status := 'already_paid';
          v_app_id := v_app.id;
        elsif exists (select 1 from public.financial_payments fp where upper(btrim(fp.transaction_reference)) = upper(v_reference)) then
          v_match_status := 'duplicate_payment_reference';
          v_app_id := v_app.id;
        else
          v_match_status := 'matched';
          v_app_id := v_app.id;
        end if;
      end if;
    end if;
  end if;

  insert into public.financial_transactions(transaction_reference,amount_syp,payer_note,transferred_at,transaction_kind,match_status,tracking_code,matched_application_id,recorded_by,source,details)
  values (v_reference,p_amount_syp,v_note,p_transferred_at,v_kind,v_match_status,v_code,
    case when v_match_status = 'matched' then v_app_id else null end,p_actor_user_id,v_source,
    jsonb_build_object('candidate_application_id',v_app_id,'local_day',v_day))
  returning id into v_transaction_id;

  if v_match_status = 'matched' then
    insert into public.financial_payments(application_id,expected_amount_syp,received_amount_syp,transaction_reference,transfer_at,payer_note,reconciliation_status,checked_against_statement,verification_notes,created_by,updated_by,verified_by,verified_at,updated_at)
    values (v_app.id,v_app.amount_syp,p_amount_syp,v_reference,p_transferred_at,v_note,'matched',true,'تمت مطابقته مع حركة واردة أدخلها المسؤول المالي من كشف شام كاش.',p_actor_user_id,p_actor_user_id,p_actor_user_id,now(),now())
    on conflict (application_id) do update set
      expected_amount_syp = excluded.expected_amount_syp,
      received_amount_syp = excluded.received_amount_syp,
      transaction_reference = excluded.transaction_reference,
      transfer_at = excluded.transfer_at,
      payer_note = excluded.payer_note,
      reconciliation_status = 'matched',
      checked_against_statement = true,
      verification_notes = excluded.verification_notes,
      updated_by = excluded.updated_by,
      verified_by = excluded.verified_by,
      verified_at = excluded.verified_at,
      updated_at = now()
    where public.financial_payments.reconciliation_status <> 'matched';
  end if;

  insert into public.admin_audit_logs(actor_user_id,actor_email,actor_role,action,entity_type,entity_id,tracking_code,details)
  values (p_actor_user_id,coalesce(p_actor_email,'unknown'),v_role,
    case when v_match_status = 'matched' then 'financial_transfer_matched' when v_match_status = 'other_income' then 'financial_other_income_recorded' else 'financial_transfer_exception_recorded' end,
    'financial_transaction',v_transaction_id,v_code,
    jsonb_build_object('transaction_reference',v_reference,'amount_syp',p_amount_syp,'transfer_at',p_transferred_at,'match_status',v_match_status,'candidate_application_id',v_app_id,'source',v_source));

  v_role_text := case v_match_status
    when 'matched' then 'تمت المطابقة: المبلغ ورمز التتبع مطابقان لطلب واحد.'
    when 'other_income' then 'سجلت كحركة أخرى وليست رسوم تخرج.'
    when 'missing_tracking_code' then 'استثناء: لا يوجد رمز تتبع في ملاحظات التحويل.'
    when 'unknown_tracking_code' then 'استثناء: رمز التتبع لا يطابق طلبًا مسجلًا.'
    when 'amount_mismatch' then 'استثناء: المبلغ لا يساوي المبلغ المطلوب في الطلب.'
    when 'already_paid' then 'استثناء: الطلب مرتبط بتحويل مطابق سابقًا.'
    when 'application_rejected' then 'استثناء: الطلب مرفوض.'
    when 'duplicate_payment_reference' then 'استثناء: رقم الحركة مستخدم في مطابقة سابقة.'
    else 'تم تسجيل الحركة.' end;
  return jsonb_build_object('status',v_match_status,'message',v_role_text,'transaction_id',v_transaction_id,'transaction_reference',v_reference,'tracking_code',v_code,'amount_syp',p_amount_syp,'candidate_application_id',v_app_id);
exception when unique_violation then
  return jsonb_build_object('status','duplicate_reference','message','رقم الحركة موجود مسبقًا ولم تُسجّل مرتين.');
end;
$$;
revoke all on function public.record_financial_transaction(uuid,text,text,bigint,text,timestamptz,text,text) from public, anon, authenticated;
grant execute on function public.record_financial_transaction(uuid,text,text,bigint,text,timestamptz,text,text) to service_role;

create or replace function public.financial_day_summary(p_date date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_start timestamptz := (p_date::timestamp at time zone 'Asia/Damascus');
  v_end timestamptz := ((p_date + 1)::timestamp at time zone 'Asia/Damascus');
  v_summary jsonb;
  v_closing jsonb;
begin
  select jsonb_build_object(
    'closing_date',p_date,
    'recorded_count',count(*),
    'recorded_total_syp',coalesce(sum(amount_syp),0),
    'matched_count',count(*) filter (where match_status='matched'),
    'matched_total_syp',coalesce(sum(amount_syp) filter (where match_status='matched'),0),
    'other_income_count',count(*) filter (where match_status='other_income'),
    'unresolved_count',count(*) filter (where match_status not in ('matched','other_income')),
    'exception_count',count(*) filter (where match_status not in ('matched','other_income')),
    'recent_transactions',coalesce((select jsonb_agg(x) from (select t.id,t.transaction_reference,t.amount_syp,t.payer_note,t.transferred_at,t.transaction_kind,t.match_status,t.tracking_code,t.created_at,a.full_name,a.department,a.specialization from public.financial_transactions t left join public.applications a on a.id = t.matched_application_id where t.transferred_at >= v_start and t.transferred_at < v_end order by t.transferred_at desc limit 200) x),'[]'::jsonb)
  ) into v_summary
  from public.financial_transactions
  where transferred_at >= v_start and transferred_at < v_end;
  select to_jsonb(c) into v_closing from public.financial_daily_closings c where c.closing_date = p_date;
  return v_summary || jsonb_build_object('closing',v_closing);
end;
$$;
revoke all on function public.financial_day_summary(date) from public, anon, authenticated;
grant execute on function public.financial_day_summary(date) to service_role;

create or replace function public.close_financial_day(
  p_date date,
  p_statement_count integer,
  p_statement_total_syp bigint,
  p_notes text,
  p_override_reason text,
  p_actor_user_id uuid,
  p_actor_email text
) returns jsonb
language plpgsql security definer set search_path = public, auth as $$
declare
  v_role text;
  v_start timestamptz := (p_date::timestamp at time zone 'Asia/Damascus');
  v_end timestamptz := ((p_date + 1)::timestamp at time zone 'Asia/Damascus');
  v_recorded_count integer;
  v_recorded_total bigint;
  v_matched_count integer;
  v_matched_total bigint;
  v_unresolved integer;
  v_diff_count integer;
  v_diff_amount bigint;
  v_override boolean := length(btrim(coalesce(p_override_reason,''))) >= 10;
  v_id uuid;
begin
  select role into v_role from public.staff_roles where user_id = p_actor_user_id;
  if v_role not in ('admin','finance') or v_role is null then
    return jsonb_build_object('error','إقفال اليوم متاح للمدير والمسؤول المالي فقط.');
  end if;
  if p_date is null or p_statement_count is null or p_statement_count < 0 or p_statement_total_syp is null or p_statement_total_syp < 0 then
    return jsonb_build_object('error','أدخل تاريخًا وعدد حركات وإجماليًا صحيحًا من كشف شام كاش.');
  end if;
  perform pg_advisory_xact_lock(hashtext(p_date::text));
  if exists (select 1 from public.financial_daily_closings where closing_date = p_date) then
    return jsonb_build_object('error','تم إقفال هذا اليوم مسبقًا. لا يمكن إقفاله مرتين.');
  end if;
  select count(*)::integer,coalesce(sum(amount_syp),0)::bigint,
    count(*) filter (where match_status='matched')::integer,
    coalesce(sum(amount_syp) filter (where match_status='matched'),0)::bigint,
    count(*) filter (where match_status not in ('matched','other_income'))::integer
  into v_recorded_count,v_recorded_total,v_matched_count,v_matched_total,v_unresolved
  from public.financial_transactions where transferred_at >= v_start and transferred_at < v_end;
  v_diff_count := p_statement_count - v_recorded_count;
  v_diff_amount := p_statement_total_syp - v_recorded_total;
  if (v_diff_count <> 0 or v_diff_amount <> 0 or v_unresolved <> 0) and not v_override then
    return jsonb_build_object('error','لا يمكن إقفال اليوم: هناك فرق بين كشف شام كاش والحركات المدخلة أو حركات غير محلولة. طابق الأرقام وحل الاستثناءات، أو اطلب من المدير إقفالًا استثنائيًا مع سبب موثق.',
      'recorded_count',v_recorded_count,'recorded_total_syp',v_recorded_total,'matched_count',v_matched_count,'matched_total_syp',v_matched_total,'unresolved_count',v_unresolved,'difference_count',v_diff_count,'difference_amount_syp',v_diff_amount);
  end if;
  if (v_diff_count <> 0 or v_diff_amount <> 0 or v_unresolved <> 0) and v_role <> 'admin' then
    return jsonb_build_object('error','الإقفال الاستثنائي بسبب فروقات أو حركات غير محلولة متاح للمدير فقط.');
  end if;
  insert into public.financial_daily_closings(closing_date,matched_transaction_count,matched_total_syp,statement_transaction_count,statement_total_syp,difference_count,difference_amount_syp,is_override,override_reason,notes,closed_by,closed_at,recorded_transaction_count,recorded_total_syp,unresolved_transaction_count,closed_by_role)
  values (p_date,v_matched_count,v_matched_total,p_statement_count,p_statement_total_syp,v_diff_count,v_diff_amount,
    (v_diff_count <> 0 or v_diff_amount <> 0 or v_unresolved <> 0),case when v_override then btrim(p_override_reason) else null end,
    nullif(btrim(coalesce(p_notes,'')),''),p_actor_user_id,now(),v_recorded_count,v_recorded_total,v_unresolved,v_role)
  returning id into v_id;
  insert into public.admin_audit_logs(actor_user_id,actor_email,actor_role,action,entity_type,entity_id,details)
  values (p_actor_user_id,coalesce(p_actor_email,'unknown'),v_role,'financial_day_closed','financial_daily_closing',v_id,
    jsonb_build_object('closing_date',p_date,'recorded_count',v_recorded_count,'recorded_total_syp',v_recorded_total,
      'statement_count',p_statement_count,'statement_total_syp',p_statement_total_syp,'difference_count',v_diff_count,
      'difference_amount_syp',v_diff_amount,'matched_count',v_matched_count,'matched_total_syp',v_matched_total,
      'unresolved_count',v_unresolved,'override', (v_diff_count <> 0 or v_diff_amount <> 0 or v_unresolved <> 0), 'override_reason',p_override_reason));
  return jsonb_build_object('ok',true,'closing_id',v_id,'closing_date',p_date,'recorded_count',v_recorded_count,'recorded_total_syp',v_recorded_total,
    'matched_count',v_matched_count,'matched_total_syp',v_matched_total,'statement_count',p_statement_count,'statement_total_syp',p_statement_total_syp,
    'difference_count',v_diff_count,'difference_amount_syp',v_diff_amount,'unresolved_count',v_unresolved,'override',(v_diff_count <> 0 or v_diff_amount <> 0 or v_unresolved <> 0));
end;
$$;
revoke all on function public.close_financial_day(date,integer,bigint,text,text,uuid,text) from public, anon, authenticated;
grant execute on function public.close_financial_day(date,integer,bigint,text,text,uuid,text) to service_role;

-- لا يسمح باستعمال وظيفة الحضور إلا لحساب المدير أو دور البوابة، والعملية الذرية تستهلك البطاقة مرة واحدة.
create or replace function public.check_in_ticket_once(p_ticket_token text, p_actor_user_id uuid, p_actor_email text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_ticket public.entry_tickets%rowtype;
  v_application public.applications%rowtype;
  v_role text;
  v_now timestamptz := now();
begin
  select role into v_role from public.staff_roles where user_id = p_actor_user_id;
  if v_role is null or v_role not in ('admin','gate') then
    raise exception 'GATE_ACCESS_DENIED';
  end if;
  select * into v_ticket from public.entry_tickets where ticket_token = upper(btrim(p_ticket_token)) for update;
  if not found then return jsonb_build_object('status','invalid','message','رمز البطاقة غير موجود.'); end if;
  select * into v_application from public.applications where id = v_ticket.application_id;
  if not found or v_application.status <> 'approved' then
    return jsonb_build_object('status','invalid','message','الطلب غير مقبول؛ لا يسمح بالدخول.');
  end if;
  if v_ticket.checked_in_at is not null then
    return jsonb_build_object('status','already_used','checked_in_at',v_ticket.checked_in_at,
      'message','تم استخدام هذه البطاقة سابقًا. لا تسمح بدخول ثانٍ بهذه البطاقة.',
      'ticket_type',v_ticket.ticket_type,'ticket_number',v_ticket.ticket_number,'full_name',v_application.full_name,
      'department',v_application.department,'specialization',v_application.specialization);
  end if;
  update public.entry_tickets set checked_in_at = v_now, checked_in_by = p_actor_user_id where id = v_ticket.id and checked_in_at is null;
  if not found then
    select checked_in_at into v_ticket.checked_in_at from public.entry_tickets where id = v_ticket.id;
    return jsonb_build_object('status','already_used','checked_in_at',v_ticket.checked_in_at,'message','تم استخدام هذه البطاقة سابقًا.');
  end if;
  insert into public.admin_audit_logs(actor_user_id,actor_email,actor_role,action,entity_type,entity_id,tracking_code,details)
  values (p_actor_user_id,coalesce(p_actor_email,'unknown'),v_role,'ticket_checked_in','entry_ticket',v_ticket.id,v_application.tracking_code,
    jsonb_build_object('ticket_type',v_ticket.ticket_type,'ticket_number',v_ticket.ticket_number,'full_name',v_application.full_name,
      'department',v_application.department,'checked_in_at',v_now));
  return jsonb_build_object('status','checked_in','checked_in_at',v_now,'ticket_type',v_ticket.ticket_type,'ticket_number',v_ticket.ticket_number,
    'full_name',v_application.full_name,'university_number',v_application.university_number,'department',v_application.department,
    'specialization',v_application.specialization,'message','تم تسجيل الدخول بنجاح. لا يمكن استخدام هذه البطاقة مرة أخرى.');
end;
$$;
revoke all on function public.check_in_ticket_once(text,uuid,text) from public, anon, authenticated;
grant execute on function public.check_in_ticket_once(text,uuid,text) to service_role;

comment on table public.financial_transactions is 'دفتر حركات واردة كما ظهرت في كشف شام كاش؛ الإيصال وحده لا يثبت الدفع.';
comment on column public.financial_transactions.match_status is 'نتيجة مطابقة الحركة مع رمز التتبع والمبلغ والطلبات السابقة.';
comment on table public.financial_daily_closings is 'لقطة إقفال يومي تقارن كشف شام كاش مع سجل الحركات، وتحتفظ بالفروقات وأسباب أي إقفال استثنائي.';
