-- المرحلة العاشرة: بيانات المكان والتاريخ المطبوعة على التذكرة.
-- شغّل مرة واحدة بعد ترحيلات المراحل السابقة.
alter table public.event_settings
  add column if not exists event_location text not null default '',
  add column if not exists event_date date;

comment on column public.event_settings.event_location is 'مكان الحفل المعروض على تذاكر الدخول.';
comment on column public.event_settings.event_date is 'تاريخ الحفل المعروض على تذاكر الدخول.';
