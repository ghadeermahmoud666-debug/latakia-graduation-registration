-- ترقية قاعدة البيانات لتدفق التسجيل المرحلي وإدارة الكليات والمعاهد والاختصاصات.
-- شغّل هذا الملف مرة واحدة على مشروع Supabase الحالي بعد إنشاء الجداول في 001_init.sql.

create table if not exists public.academic_units (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (char_length(name) between 2 and 140),
  unit_type text not null check (unit_type in ('faculty', 'institute')),
  is_open boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.academic_specializations (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references public.academic_units(id) on delete cascade,
  name text not null check (char_length(name) between 2 and 140),
  is_open boolean not null default true,
  created_at timestamptz not null default now(),
  unique (unit_id, name)
);

alter table public.event_settings
  add column if not exists max_carried_subjects smallint not null default 5 check (max_carried_subjects between 0 and 30);
alter table public.event_settings
  add column if not exists payment_images jsonb not null default '[]'::jsonb;

alter table public.applications alter column receipt_path drop not null;
alter table public.applications add column if not exists phone_number text;
alter table public.applications add column if not exists carried_subjects smallint not null default 0 check (carried_subjects between 0 and 30);
alter table public.applications add column if not exists academic_unit_id uuid references public.academic_units(id) on delete set null;
alter table public.applications add column if not exists academic_specialization_id uuid references public.academic_specializations(id) on delete set null;

alter table public.applications drop constraint if exists applications_status_check;
alter table public.applications add constraint applications_status_check
  check (status in ('awaiting_payment', 'pending', 'approved', 'rejected'));

create index if not exists applications_phone_number_idx on public.applications (phone_number);
create index if not exists applications_academic_unit_id_idx on public.applications (academic_unit_id);
create index if not exists academic_specializations_unit_id_idx on public.academic_specializations (unit_id);

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.staff_roles sr
    where sr.user_id = auth.uid() and sr.role = 'admin'
  );
$$;
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

alter table public.academic_units enable row level security;
alter table public.academic_specializations enable row level security;

grant select on public.academic_units to anon, authenticated;
grant select on public.academic_specializations to anon, authenticated;
grant insert, update, delete on public.academic_units to authenticated;
grant insert, update, delete on public.academic_specializations to authenticated;

drop policy if exists "Public can read academic units" on public.academic_units;
create policy "Public can read academic units" on public.academic_units
  for select to anon, authenticated using (true);
drop policy if exists "Admins manage academic units" on public.academic_units;
create policy "Admins manage academic units" on public.academic_units
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Public can read academic specializations" on public.academic_specializations;
create policy "Public can read academic specializations" on public.academic_specializations
  for select to anon, authenticated using (true);
drop policy if exists "Admins manage academic specializations" on public.academic_specializations;
create policy "Admins manage academic specializations" on public.academic_specializations
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- لا يستطيع المراجع تعديل إعدادات المنصة أو بيانات الكليات، وإنما يستطيع المدير ذلك فقط.
drop policy if exists "Staff can update event settings" on public.event_settings;
drop policy if exists "Admins can update event settings" on public.event_settings;
create policy "Admins can update event settings" on public.event_settings
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Staff can upload event assets" on storage.objects;
drop policy if exists "Staff can update event assets" on storage.objects;
drop policy if exists "Staff can delete event assets" on storage.objects;
drop policy if exists "Admins can upload event assets" on storage.objects;
create policy "Admins can upload event assets" on storage.objects
  for insert to authenticated with check (bucket_id = 'event-assets' and public.is_admin());
drop policy if exists "Admins can update event assets" on storage.objects;
create policy "Admins can update event assets" on storage.objects
  for update to authenticated using (bucket_id = 'event-assets' and public.is_admin()) with check (bucket_id = 'event-assets' and public.is_admin());
drop policy if exists "Admins can delete event assets" on storage.objects;
create policy "Admins can delete event assets" on storage.objects
  for delete to authenticated using (bucket_id = 'event-assets' and public.is_admin());

-- قيمة افتراضية أكثر وضوحاً للتعليمات، مع الإبقاء على ما أدخله المدير سابقاً.
update public.event_settings
set payment_instructions = 'تأكد من اسم المستفيد والمبلغ قبل تأكيد التحويل، واحتفظ بفاتورة التحويل الأصلية بصيغة PDF.'
where id = 1 and (payment_instructions is null or payment_instructions = '' or payment_instructions = 'حوّل المبلغ الإجمالي إلى حساب شام كاش الموضح أدناه، ثم ارفع إيصال التحويل بصيغة PDF.');
