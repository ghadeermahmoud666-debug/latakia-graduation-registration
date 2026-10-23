-- قاعدة بيانات منصة التسجيل لحفلات التخرج
create extension if not exists pgcrypto;

create table if not exists public.event_settings (
  id integer primary key default 1 check (id = 1),
  event_title text not null default 'التسجيل لحفلات التخرج',
  university_label text not null default 'جامعة اللاذقية',
  organizer text not null default 'اتحاد طلبة سوريا – فرع محافظة اللاذقية',
  registration_open boolean not null default false,
  student_fee bigint not null default 0 check (student_fee >= 0),
  companion_fee bigint not null default 0 check (companion_fee >= 0),
  max_companions smallint not null default 4 check (max_companions between 0 and 20),
  shamcash_account text not null default '',
  payment_instructions text not null default 'حوّل المبلغ الإجمالي إلى حساب شام كاش الموضح أدناه، ثم ارفع إيصال التحويل بصيغة PDF.',
  qr_image_url text,
  updated_at timestamptz not null default now()
);

insert into public.event_settings (id) values (1) on conflict (id) do nothing;

create table if not exists public.staff_roles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'reviewer' check (role in ('admin', 'reviewer')),
  created_at timestamptz not null default now()
);

create table if not exists public.applications (
  id uuid primary key default gen_random_uuid(),
  tracking_code text not null unique,
  full_name text not null check (char_length(full_name) between 5 and 120),
  university_number text not null check (char_length(university_number) between 1 and 32),
  department text not null check (char_length(department) between 1 and 100),
  specialization text not null check (char_length(specialization) between 1 and 100),
  companions smallint not null default 0 check (companions between 0 and 20),
  amount_syp bigint not null check (amount_syp >= 0),
  receipt_path text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  rejection_reason text,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  check (status <> 'rejected' or rejection_reason is not null or reviewed_by is null)
);

create index if not exists applications_created_at_idx on public.applications (created_at desc);
create index if not exists applications_status_idx on public.applications (status);
create index if not exists applications_university_number_idx on public.applications (university_number);

create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.staff_roles sr where sr.user_id = auth.uid());
$$;

revoke all on function public.is_staff() from public;
grant execute on function public.is_staff() to authenticated;

alter table public.event_settings enable row level security;
alter table public.staff_roles enable row level security;
alter table public.applications enable row level security;

grant select on public.event_settings to anon, authenticated;
grant update on public.event_settings to authenticated;
grant select on public.staff_roles to authenticated;
grant select, update on public.applications to authenticated;

create policy "Public can read event settings" on public.event_settings
  for select to anon, authenticated using (true);
create policy "Staff can update event settings" on public.event_settings
  for update to authenticated using (public.is_staff()) with check (public.is_staff());

create policy "Staff can read staff roles" on public.staff_roles
  for select to authenticated using (public.is_staff() or user_id = auth.uid());

create policy "Staff can read applications" on public.applications
  for select to authenticated using (public.is_staff());
create policy "Staff can update applications" on public.applications
  for update to authenticated using (public.is_staff()) with check (public.is_staff());

-- Bucket خاص لفواتير الطلاب، لا يسمح للطلاب بقراءة الملفات مباشرة.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('receipts', 'receipts', false, 5242880, array['application/pdf'])
on conflict (id) do update set public = false, file_size_limit = 5242880, allowed_mime_types = array['application/pdf'];

-- صور عامة مثل QR، لكن رفعها وتعديلها محصوران بفريق المراجعة.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('event-assets', 'event-assets', true, 3145728, array['image/png','image/jpeg','image/webp'])
on conflict (id) do update set public = true, file_size_limit = 3145728, allowed_mime_types = array['image/png','image/jpeg','image/webp'];

create policy "Staff can read receipt objects" on storage.objects
  for select to authenticated using (bucket_id = 'receipts' and public.is_staff());
create policy "Public can view event assets" on storage.objects
  for select to anon, authenticated using (bucket_id = 'event-assets');
create policy "Staff can upload event assets" on storage.objects
  for insert to authenticated with check (bucket_id = 'event-assets' and public.is_staff());
create policy "Staff can update event assets" on storage.objects
  for update to authenticated using (bucket_id = 'event-assets' and public.is_staff()) with check (bucket_id = 'event-assets' and public.is_staff());
create policy "Staff can delete event assets" on storage.objects
  for delete to authenticated using (bucket_id = 'event-assets' and public.is_staff());
