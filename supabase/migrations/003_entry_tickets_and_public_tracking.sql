-- المرحلة الثالثة: تتبع الطلب برمز فريد فقط، وبطاقات دخول QR للخريج والمرافقين.
-- شغّل هذا الملف مرة واحدة بعد migration 002 في Supabase SQL Editor.

create table if not exists public.entry_tickets (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.applications(id) on delete cascade,
  ticket_number smallint not null check (ticket_number >= 0),
  ticket_type text not null check (ticket_type in ('graduate', 'companion')),
  ticket_token text not null unique default ('TKT-' || upper(encode(gen_random_bytes(16), 'hex'))),
  created_at timestamptz not null default now(),
  unique (application_id, ticket_number),
  check ((ticket_type = 'graduate' and ticket_number = 0) or (ticket_type = 'companion' and ticket_number >= 1))
);

create index if not exists entry_tickets_application_id_idx on public.entry_tickets(application_id);

-- بطاقة QR لا تُقرأ مباشرة من المتصفح. تقرأها وظيفة خادم باستخدام service role.
alter table public.entry_tickets enable row level security;
revoke all on table public.entry_tickets from anon, authenticated;
grant select on table public.entry_tickets to service_role;

create or replace function public.create_entry_tickets_for_approved_application()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  companion_index integer;
  should_generate boolean := false;
begin
  if new.status = 'approved' then
    if tg_op = 'INSERT' then
      should_generate := true;
    elsif old.status is distinct from 'approved' then
      should_generate := true;
    end if;
  end if;

  if should_generate then
    insert into public.entry_tickets (application_id, ticket_number, ticket_type)
    values (new.id, 0, 'graduate')
    on conflict (application_id, ticket_number) do nothing;

    if coalesce(new.companions, 0) > 0 then
      for companion_index in 1..new.companions loop
        insert into public.entry_tickets (application_id, ticket_number, ticket_type)
        values (new.id, companion_index, 'companion')
        on conflict (application_id, ticket_number) do nothing;
      end loop;
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.create_entry_tickets_for_approved_application() from public, anon, authenticated;
drop trigger if exists create_entry_tickets_after_approval on public.applications;
create trigger create_entry_tickets_after_approval
after insert or update of status on public.applications
for each row execute function public.create_entry_tickets_for_approved_application();

-- تجهيز بطاقات للطلبات المقبولة الموجودة مسبقاً، مع المحافظة على البطاقات التي تم إنشاؤها.
insert into public.entry_tickets (application_id, ticket_number, ticket_type)
select a.id, 0, 'graduate'
from public.applications a
where a.status = 'approved'
on conflict (application_id, ticket_number) do nothing;

insert into public.entry_tickets (application_id, ticket_number, ticket_type)
select a.id, gs.ticket_number, 'companion'
from public.applications a
cross join lateral generate_series(1, coalesce(a.companions, 0)) as gs(ticket_number)
where a.status = 'approved'
on conflict (application_id, ticket_number) do nothing;

comment on table public.entry_tickets is 'بطاقات الدخول الفردية؛ الوصول عبر وظائف تحقق الخادم فقط.';
