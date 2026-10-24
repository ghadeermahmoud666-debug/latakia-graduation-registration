import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Cache-Control': 'no-store' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });
const tableConfig: Record<string, { order: string }> = {
  applications: { order: 'created_at' }, entry_tickets: { order: 'created_at' }, financial_payments: { order: 'created_at' }, financial_transactions: { order: 'transferred_at' },
  financial_daily_closings: { order: 'closing_date' }, admin_audit_logs: { order: 'created_at' }, admin_backup_runs: { order: 'created_at' },
  academic_units: { order: 'name' }, academic_specializations: { order: 'name' }, staff_roles: { order: 'created_at' }, staff_unit_permissions: { order: 'created_at' }, event_settings: { order: 'id' },
};
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'طريقة الطلب غير مدعومة.' }, 405);
  const url = Deno.env.get('SUPABASE_URL'); const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'); const anon = Deno.env.get('SUPABASE_ANON_KEY') || Deno.env.get('SUPABASE_PUBLISHABLE_KEY');
  if (!url || !service || !anon) return json({ error: 'إعدادات الخادم غير مكتملة.' }, 500);
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim(); if (!token) return json({ error: 'يلزم تسجيل الدخول.' }, 401);
  const userClient = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${token}` } } });
  const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: auth, error: authError } = await userClient.auth.getUser(token); if (authError || !auth.user) return json({ error: 'انتهت الجلسة. سجّل الدخول مجددًا.' }, 401);
  const actor = auth.user; const { data: role, error: roleError } = await admin.from('staff_roles').select('role').eq('user_id', actor.id).maybeSingle();
  if (roleError || role?.role !== 'admin') return json({ error: 'النسخ الاحتياطي متاح للمدير فقط.' }, 403);
  let body: Record<string, unknown>; try { body = await req.json(); } catch { return json({ error: 'صيغة الطلب غير صالحة.' }, 400); }
  if (body.action === 'backup_history') {
    const { data, error } = await admin.from('admin_backup_runs').select('id,actor_email,file_name,file_size_bytes,row_counts,confirmed_saved,created_at').order('created_at', { ascending: false }).limit(30);
    if (error) return json({ error: error.message }, 500);
    return json({ runs: data || [] });
  }
  if (body.action === 'record_backup') {
    if (body.confirmed_saved !== true) return json({ error: 'أكد أنك تحققت من وجود ملف ZIP في التنزيلات قبل تسجيل النسخة.' }, 400);
    const fileName = String(body.file_name || '').trim(); if (!/^graduation-admin-backup-[\d-]+\.zip$/.test(fileName)) return json({ error: 'اسم ملف النسخة غير صالح.' }, 400);
    const { data: run, error } = await admin.from('admin_backup_runs').insert({ actor_user_id: actor.id, actor_email: actor.email || 'unknown', file_name: fileName, file_size_bytes: Number(body.file_size_bytes) || null, row_counts: body.row_counts && typeof body.row_counts === 'object' ? body.row_counts : {}, confirmed_saved: true }).select('*').single();
    if (error) return json({ error: 'تم تجهيز النسخة لكن تعذر تسجيل عملية النسخ: ' + error.message }, 500);
    await admin.from('admin_audit_logs').insert({ actor_user_id: actor.id, actor_email: actor.email || 'unknown', actor_role: 'admin', action: 'admin_backup_saved', entity_type: 'backup', entity_id: run.id, details: { file_name: fileName, file_size_bytes: run.file_size_bytes, row_counts: run.row_counts } });
    return json({ ok: true, run });
  }
  if (body.action !== 'page') return json({ error: 'العملية المطلوبة غير معروفة.' }, 400);
  const table = String(body.table || ''); const config = tableConfig[table]; if (!config) return json({ error: 'الجدول غير متاح للتصدير.' }, 400);
  const offset = Math.max(0, Math.floor(Number(body.offset || 0))); const limit = Math.min(1000, Math.max(1, Math.floor(Number(body.limit || 1000))));
  const { data, error, count } = await admin.from(table).select('*', { count: 'exact' }).order(config.order, { ascending: true }).range(offset, offset + limit - 1);
  if (error) return json({ error: `تعذر تصدير ${table}: ${error.message}` }, 500);
  return json({ table, offset, limit, total: count || 0, rows: data || [] });
});
