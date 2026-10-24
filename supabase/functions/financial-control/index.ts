import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Cache-Control': 'no-store' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
const BACKUP_TABLES = new Set(['event_settings','academic_units','academic_specializations','applications','entry_tickets','staff_roles','staff_unit_permissions','admin_audit_logs','financial_payments','financial_transactions','financial_daily_closings','admin_backup_runs']);
const normalizeSource = (v: unknown) => v === 'csv' ? 'csv' : 'manual';
Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'طريقة الطلب غير مدعومة.' }, 405);
  const url = Deno.env.get('SUPABASE_URL'); const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'); const anon = Deno.env.get('SUPABASE_ANON_KEY') || Deno.env.get('SUPABASE_PUBLISHABLE_KEY');
  if (!url || !service || !anon) return json({ error: 'إعدادات الخادم غير مكتملة.' }, 500);
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return json({ error: 'يلزم تسجيل الدخول بحساب فريق مخوّل.' }, 401);
  const userClient = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${token}` } } });
  const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: auth, error: authError } = await userClient.auth.getUser(token);
  if (authError || !auth.user) return json({ error: 'جلسة الفريق غير صالحة أو انتهت.' }, 401);
  const actor = auth.user;
  const { data: roleRow, error: roleError } = await admin.from('staff_roles').select('role').eq('user_id', actor.id).maybeSingle();
  if (roleError || !roleRow) return json({ error: 'الحساب غير مسجل ضمن فريق التنظيم.' }, 403);
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return json({ error: 'محتوى الطلب غير صالح.' }, 400); }
  const action = String(body.action || '');
  const isAdmin = roleRow.role === 'admin';
  const isFinance = roleRow.role === 'finance';
  if (['backup_table','record_backup'].includes(action)) {
    if (!isAdmin) return json({ error: 'النسخ الاحتياطي متاح للمدير فقط.' }, 403);
  } else if (!isAdmin && !isFinance) return json({ error: 'الأداة المالية متاحة للمدير والمسؤول المالي فقط.' }, 403);

  if (action === 'day_summary') {
    const date = String(body.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: 'تاريخ اليوم غير صالح.' }, 400);
    const { data, error } = await admin.rpc('financial_day_summary', { p_date: date });
    if (error) return json({ error: 'تعذر تحميل ملخص اليوم المالي: ' + error.message }, 500);
    return json({ summary: data });
  }

  if (action === 'closing_history') {
    const { data, error } = await admin.from('financial_daily_closings').select('*').order('closing_date', { ascending: false }).limit(60);
    if (error) return json({ error: 'تعذر تحميل سجل الإقفالات: ' + error.message }, 500);
    return json({ closings: data || [] });
  }

  if (action === 'record_transaction' || action === 'import_transactions') {
    const rawRows = action === 'record_transaction' ? [body.transaction] : body.transactions;
    if (!Array.isArray(rawRows) || rawRows.length < 1 || rawRows.length > 100) return json({ error: 'أرسل من 1 إلى 100 حركة في كل طلب.' }, 400);
    const results: unknown[] = [];
    for (const raw of rawRows as Record<string, unknown>[]) {
      const reference = String(raw.transaction_reference || raw.reference || '').trim();
      const amount = Number(raw.amount_syp ?? raw.amount);
      const note = String(raw.payer_note ?? raw.note ?? raw.notes ?? '').trim();
      const kind = raw.transaction_kind === 'other_income' ? 'other_income' : 'graduation_payment';
      const source = normalizeSource(raw.source || (action === 'import_transactions' ? 'csv' : 'manual'));
      const timestampRaw = String(raw.transferred_at || raw.transfer_at || '').trim();
      let transferredAt: string | null = null;
      if (timestampRaw) {
        const withZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(timestampRaw) ? timestampRaw : `${timestampRaw}+03:00`;
        const parsed = new Date(withZone);
        if (!Number.isNaN(parsed.getTime())) transferredAt = parsed.toISOString();
      }
      if (!reference || !Number.isSafeInteger(amount) || amount <= 0 || !transferredAt) {
        results.push({ status: 'invalid', transaction_reference: reference, message: 'رقم الحركة أو المبلغ أو التاريخ غير صالح.' });
        continue;
      }
      const { data, error } = await admin.rpc('record_financial_transaction', {
        p_actor_user_id: actor.id,
        p_actor_email: actor.email || 'unknown',
        p_transaction_reference: reference,
        p_amount_syp: amount,
        p_payer_note: note,
        p_transferred_at: transferredAt,
        p_transaction_kind: kind,
        p_source: source,
      });
      if (error) results.push({ status: 'error', transaction_reference: reference, message: error.message });
      else results.push(data || { status: 'error', transaction_reference: reference, message: 'لم ترجع قاعدة البيانات نتيجة.' });
    }
    const counts = results.reduce((acc: Record<string, number>, row: any) => { const key = String(row?.status || 'unknown'); acc[key] = (acc[key] || 0) + 1; return acc; }, {});
    return json({ results, counts });
  }

  if (action === 'close_day') {
    const date = String(body.closing_date || '');
    const count = Number(body.statement_count);
    const total = Number(body.statement_total_syp);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(total) || total < 0) return json({ error: 'تاريخ أو عدد حركات أو إجمالي كشف شام كاش غير صالح.' }, 400);
    const { data, error } = await admin.rpc('close_financial_day', {
      p_date: date, p_statement_count: count, p_statement_total_syp: total,
      p_notes: String(body.notes || ''), p_override_reason: isAdmin ? String(body.override_reason || '') : '',
      p_actor_user_id: actor.id, p_actor_email: actor.email || 'unknown',
    });
    if (error) return json({ error: 'تعذر إقفال اليوم المالي: ' + error.message }, 500);
    if (data?.error) return json(data, 409);
    return json(data);
  }

  if (action === 'backup_table') {
    const table = String(body.table || '');
    if (!BACKUP_TABLES.has(table)) return json({ error: 'اسم الجدول غير مسموح ضمن النسخة الاحتياطية.' }, 400);
    const offset = Math.max(0, Math.floor(Number(body.offset || 0)));
    const limit = Math.min(1000, Math.max(1, Math.floor(Number(body.limit || 1000))));
    const orderColumn = table === 'staff_roles' ? 'user_id' : 'id';
    const { data, error, count } = await admin.from(table as any).select('*', { count: 'exact' }).order(orderColumn, { ascending: true }).range(offset, offset + limit - 1);
    if (error) return json({ error: `تعذر تصدير الجدول ${table}: ${error.message}` }, 500);
    return json({ table, rows: data || [], count: count || 0, offset, next_offset: (data || []).length === limit ? offset + limit : null });
  }

  if (action === 'record_backup') {
    const fileName = String(body.file_name || '').trim();
    const fileSize = Number(body.file_size_bytes);
    const counts = body.row_counts && typeof body.row_counts === 'object' ? body.row_counts : {};
    if (!fileName || fileName.length > 220 || /[\\/\x00-\x1f]/.test(fileName) || !Number.isSafeInteger(fileSize) || fileSize <= 0 || body.confirmed_saved !== true) return json({ error: 'أكد حفظ ملف النسخة الاحتياطية على الجهاز وأدخل بيانات صالحة.' }, 400);
    const { data, error } = await admin.from('admin_backup_runs').insert({ actor_user_id: actor.id, actor_email: actor.email || 'unknown', file_name: fileName, file_size_bytes: fileSize, row_counts: counts, confirmed_saved: true }).select('id,created_at').single();
    if (error) return json({ error: 'تعذر تسجيل النسخة الاحتياطية: ' + error.message }, 500);
    await admin.from('admin_audit_logs').insert({ actor_user_id: actor.id, actor_email: actor.email || 'unknown', actor_role: roleRow.role, action: 'database_backup_saved', entity_type: 'admin_backup_run', entity_id: data.id, details: { file_name: fileName, file_size_bytes: fileSize, row_counts: counts } });
    return json({ ok: true, backup: data });
  }

  return json({ error: 'نوع العملية غير معروف.' }, 400);
});
