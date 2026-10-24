-- المرحلة السادسة: أرشفة محلية للإيصالات، حذف إيصال المقبول فقط، وسعة التسجيل لكل كلية/معهد.
-- شغّل هذا الملف مرة واحدة بعد migrations 001 إلى 004.

alter table public.applications
  add column if not exists receipt_archive_sha256 text,
  add column if not exists receipt_archive_size_bytes bigint,
  add column if not exists receipt_archive_mode text,
  add column if not exists receipt_archive_saved_by uuid references auth.users(id) on delete set null;

alter table public.applications
  drop constraint if exists applications_receipt_archive_mode_check;
alter table public.applications
  add constraint applications_receipt_archive_mode_check
  check (receipt_archive_mode is null or receipt_archive_mode in ('directory', 'download')) not valid;
alter table public.applications
  validate constraint applications_receipt_archive_mode_check;

comment on column public.applications.receipt_archive_path is 'مسار نسبي داخل الأرشيف المحلي للموظف، وليس رابطًا عامًا أو مسارًا مطلقًا على جهازه.';
comment on column public.applications.receipt_sha256 is 'بصمة SHA-256 لملف إيصال الدفع الأصلي قبل الدمج مع صفحة بيانات الطالب.';
comment on column public.applications.receipt_archive_sha256 is 'بصمة SHA-256 لملف PDF المدمج (بيانات الطالب + الإيصال الأصلي) المحفوظ محليًا.';
comment on column public.applications.receipt_archive_mode is 'directory للكتابة إلى مجلد اختاره المستخدم أو download للتنزيلات.';

alter table public.academic_units
  add column if not exists registration_capacity integer,
  add column if not exists registered_count integer not null default 0,
  add column if not exists capacity_reached boolean not null default false;

alter table public.academic_units
  drop constraint if exists academic_units_registration_capacity_check;
alter table public.academic_units
  add constraint academic_units_registration_capacity_check
  check (registration_capacity is null or registration_capacity between 1 and 1000000) not valid;
alter table public.academic_units
  validate constraint academic_units_registration_capacity_check;

-- Backfill the counter from requests that still occupy a seat; rejected requests do not count.
update public.academic_units u
set registered_count = (
  select coalesce(sum(1 + coalesce(a.companions, 0)), 0)::integer
  from public.applications a
  where a.academic_unit_id = u.id and a.status <> 'rejected'
);
update public.academic_units
set is_open = false, capacity_reached = true
where registration_capacity is not null and registered_count >= registration_capacity;

create or replace function public.block_application_when_unit_closed_or_full()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  current_open boolean;
  current_capacity integer;
  current_count integer;
  current_capacity_reached boolean;
  seats_requested integer;
begin
  if new.academic_unit_id is null then
    return new;
  end if;
  seats_requested := 1 + greatest(coalesce(new.companions, 0), 0);
  select is_open, registration_capacity, registered_count, capacity_reached
    into current_open, current_capacity, current_count, current_capacity_reached
    from public.academic_units
    where id = new.academic_unit_id
    for update;
  if not found then
    raise exception 'ACADEMIC_UNIT_NOT_FOUND';
  end if;
  if current_capacity is not null and current_count + seats_requested > current_capacity then
    raise exception 'REGISTRATION_CAPACITY_REACHED';
  end if;
  if not current_open then
    if current_capacity_reached then raise exception 'REGISTRATION_CAPACITY_REACHED';
    else raise exception 'REGISTRATION_CLOSED'; end if;
  end if;
  return new;
end;
$$;

revoke all on function public.block_application_when_unit_closed_or_full() from public, anon, authenticated;
drop trigger if exists block_application_when_unit_closed_or_full on public.applications;
create trigger block_application_when_unit_closed_or_full
before insert on public.applications
for each row execute function public.block_application_when_unit_closed_or_full();

create or replace function public.sync_academic_unit_registration_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_unit uuid;
  delta integer := 0;
  current_count integer;
  current_capacity integer;
  was_capacity_closed boolean;
  next_count integer;
begin
  if tg_op = 'INSERT' then
    target_unit := new.academic_unit_id;
    if new.status <> 'rejected' then delta := 1 + greatest(coalesce(new.companions, 0), 0); end if;
  elsif tg_op = 'DELETE' then
    target_unit := old.academic_unit_id;
    if old.status <> 'rejected' then delta := -(1 + greatest(coalesce(old.companions, 0), 0)); end if;
  else
    if old.academic_unit_id is distinct from new.academic_unit_id then
      if old.academic_unit_id is not null and old.status <> 'rejected' then
        update public.academic_units u
        set registered_count = greatest(u.registered_count - (1 + greatest(coalesce(old.companions, 0), 0)), 0),
            is_open = case
              when u.capacity_reached and (u.registration_capacity is null or greatest(u.registered_count - (1 + greatest(coalesce(old.companions, 0), 0)), 0) < u.registration_capacity) then true
              else u.is_open end,
            capacity_reached = case
              when u.capacity_reached and (u.registration_capacity is null or greatest(u.registered_count - (1 + greatest(coalesce(old.companions, 0), 0)), 0) < u.registration_capacity) then false
              else u.capacity_reached end
        where u.id = old.academic_unit_id;
      end if;
      if new.academic_unit_id is not null and new.status <> 'rejected' then
        update public.academic_units u
        set registered_count = u.registered_count + (1 + greatest(coalesce(new.companions, 0), 0)),
            is_open = case when u.registration_capacity is not null and u.registered_count + (1 + greatest(coalesce(new.companions, 0), 0)) >= u.registration_capacity then false else u.is_open end,
            capacity_reached = case when u.registration_capacity is not null and u.registered_count + (1 + greatest(coalesce(new.companions, 0), 0)) >= u.registration_capacity then true else u.capacity_reached end
        where u.id = new.academic_unit_id;
      end if;
      return new;
    end if;
    target_unit := new.academic_unit_id;
    delta := (case when new.status <> 'rejected' then 1 + greatest(coalesce(new.companions, 0), 0) else 0 end)
           - (case when old.status <> 'rejected' then 1 + greatest(coalesce(old.companions, 0), 0) else 0 end);
  end if;

  if target_unit is null then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;
  if delta = 0 and tg_op = 'UPDATE' then return new; end if;

  select registered_count, registration_capacity, capacity_reached
    into current_count, current_capacity, was_capacity_closed
    from public.academic_units where id = target_unit for update;
  if not found then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;
  next_count := greatest(coalesce(current_count, 0) + delta, 0);
  update public.academic_units
  set registered_count = next_count,
      is_open = case
        when current_capacity is not null and next_count >= current_capacity then false
        when was_capacity_closed and (current_capacity is null or next_count < current_capacity) then true
        else is_open end,
      capacity_reached = case
        when current_capacity is not null and next_count >= current_capacity then true
        when was_capacity_closed and (current_capacity is null or next_count < current_capacity) then false
        else capacity_reached end
  where id = target_unit;

  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;
revoke all on function public.sync_academic_unit_registration_count() from public, anon, authenticated;
drop trigger if exists sync_academic_unit_registration_count on public.applications;
create trigger sync_academic_unit_registration_count
after insert or update or delete on public.applications
for each row execute function public.sync_academic_unit_registration_count();

create or replace function public.sync_academic_unit_capacity_setting()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.registration_capacity is not null and new.registered_count >= new.registration_capacity then
    new.is_open := false;
    new.capacity_reached := true;
  elsif old.capacity_reached and (new.registration_capacity is null or new.registered_count < new.registration_capacity) then
    new.is_open := true;
    new.capacity_reached := false;
  end if;
  return new;
end;
$$;
revoke all on function public.sync_academic_unit_capacity_setting() from public, anon, authenticated;
drop trigger if exists sync_academic_unit_capacity_setting on public.academic_units;
create trigger sync_academic_unit_capacity_setting
before update of registration_capacity on public.academic_units
for each row execute function public.sync_academic_unit_capacity_setting();

comment on column public.academic_units.registration_capacity is 'الحد الأقصى للمقاعد المحجوزة (الخريج + المرافقون)؛ NULL تعني بلا حد.';
comment on column public.academic_units.registered_count is 'عداد محمي للمقاعد المحجوزة: الخريج + المرافقون لكل طلب غير مرفوض.';
comment on column public.academic_units.capacity_reached is 'علامة أن إغلاق التسجيل تم تلقائيًا بسبب بلوغ السعة، لتمييزه عن الإغلاق اليدوي.';
