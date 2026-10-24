-- المرحلة الرابعة: نطاق صلاحيات فريق التنظيم، اسم الدفعة، وبيانات أرشفة الفواتير.
-- شغّل هذا الملف مرة واحدة بعد migrations 001 و002 و003.

alter table public.event_settings
  add column if not exists batch_name text not null default 'دفعة 2026';
update public.event_settings
set batch_name = 'دفعة 2026'
where id = 1 and (batch_name is null or btrim(batch_name) = '');

alter table public.applications
  add column if not exists receipt_archive_path text,
  add column if not exists receipt_sha256 text,
  add column if not exists receipt_size_bytes bigint,
  add column if not exists receipt_archived_at timestamptz;

create index if not exists applications_receipt_path_created_at_idx
  on public.applications (created_at asc) where receipt_path is not null;

create table if not exists public.staff_unit_permissions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.staff_roles(user_id) on delete cascade,
  academic_unit_id uuid not null references public.academic_units(id) on delete cascade,
  academic_specialization_id uuid references public.academic_specializations(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists staff_unit_permissions_user_idx
  on public.staff_unit_permissions(user_id);
create index if not exists staff_unit_permissions_scope_idx
  on public.staff_unit_permissions(academic_unit_id, academic_specialization_id);
create unique index if not exists staff_unit_permissions_whole_unit_uq
  on public.staff_unit_permissions(user_id, academic_unit_id)
  where academic_specialization_id is null;
create unique index if not exists staff_unit_permissions_specific_spec_uq
  on public.staff_unit_permissions(user_id, academic_unit_id, academic_specialization_id)
  where academic_specialization_id is not null;

alter table public.staff_unit_permissions enable row level security;
revoke all on public.staff_unit_permissions from anon, authenticated;
grant select on public.staff_unit_permissions to authenticated;
drop policy if exists "Admins read staff unit permissions" on public.staff_unit_permissions;
create policy "Admins read staff unit permissions" on public.staff_unit_permissions
  for select to authenticated using (public.is_admin());
-- Writes are performed only by the role-checked manage-staff Edge Function using service_role.

create or replace function public.can_access_application(target_application_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from public.applications a
    join public.staff_roles sr on sr.user_id = auth.uid()
    where a.id = target_application_id
      and (
        sr.role = 'admin'
        or (
          sr.role = 'reviewer'
          and exists (
            select 1
            from public.staff_unit_permissions p
            where p.user_id = sr.user_id
              and p.academic_unit_id = a.academic_unit_id
              and (
                p.academic_specialization_id is null
                or p.academic_specialization_id = a.academic_specialization_id
              )
          )
        )
      )
  );
$$;
revoke all on function public.can_access_application(uuid) from public, anon;
grant execute on function public.can_access_application(uuid) to authenticated;

-- Reviewer must only be able to read/update assigned applications; admins can see all.
drop policy if exists "Staff can read applications" on public.applications;
drop policy if exists "Staff can update applications" on public.applications;
drop policy if exists "Staff can read assigned applications" on public.applications;
drop policy if exists "Staff can update assigned applications" on public.applications;
create policy "Staff can read assigned applications" on public.applications
  for select to authenticated using (public.can_access_application(id));
create policy "Staff can update assigned applications" on public.applications
  for update to authenticated
  using (public.can_access_application(id))
  with check (public.can_access_application(id) and reviewed_by = auth.uid());

-- The browser only needs to update review decision columns, not student/payment data.
revoke update on public.applications from authenticated;
grant update (status, rejection_reason, reviewed_by, reviewed_at) on public.applications to authenticated;

-- Staff can see their own role. Only an admin can enumerate other staff roles.
drop policy if exists "Staff can read staff roles" on public.staff_roles;
drop policy if exists "Users can read own staff role" on public.staff_roles;
create policy "Users can read own staff role" on public.staff_roles
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());
revoke insert, update, delete on public.staff_roles from authenticated;

-- Restrict private receipt access by application scope, not merely membership in any staff role.
drop policy if exists "Staff can read receipt objects" on storage.objects;
drop policy if exists "Assigned staff can read receipt objects" on storage.objects;
create policy "Assigned staff can read receipt objects" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'receipts'
    and exists (
      select 1 from public.applications a
      where a.id::text = split_part(name, '/', 1)
        and public.can_access_application(a.id)
    )
  );

comment on column public.event_settings.batch_name is 'اسم الدفعة المعروض في الموقع وبطاقات الدخول.';
comment on column public.applications.receipt_archive_path is 'المسار النسبي في أرشيف خارجي مؤمّن؛ لا يعني أن الملف متاح عبر الموقع.';
comment on table public.staff_unit_permissions is 'نطاقات الكليات والاختصاصات المسموح لكل مراجع بالوصول إليها.';
