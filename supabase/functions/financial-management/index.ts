import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Cache-Control': 'no-store' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });
async function audit(admin: ReturnType<typeof createClient>, actor: { id: string; email?: string }, role: string, action: string, entityType: string, entityId: string | null, trackingCode: string | null, details: Record<string, unknown>) {
  const { error } = await admin.from('admin_audit_logs').insert({ actor_user_id: actor.id, actor_email: actor.email || 'unknown', actor_role: role, action, entity_type: entityType, entity_id: entityId, tracking_code: trackingCode, details });
  if (error) console.error('audit insert failed', error.message);
}
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'طريقة الطلب غير مدعومة.' }, 405);
  const url = Deno.env.get('SUPABASE_URL'); const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'); const anon = Deno.env.get('SUPABASE_ANON_KEY') || Deno.env.get('SUPABASE_PUBLISHABLE_KEY');
  if (!url || !service || !anon) return json({ error: 'إعدادات الخادم غير مكتملة.' }, 500);
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim(); if (!token) return json({ error: 'يلزم تسجيل الدخول.' }, 401);
  const userClient = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${token}` } } });
  const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: auth, error: authError } = await userClient.auth.getUser(token); if (authError || !auth.user) return json({ error: 'انتهت الجلسة. سجّل الدخول مجددًا.' }, 401);
  const actor = auth.user;
  const { data: roleRow, error: roleError } = await admin.from('staff_roles').select('role').eq('user_id', actor.id).maybeSingle();
  const role = roleRow?.role as string | undefined;
  if (roleError || !role || !['admin', 'finance'].includes(role)) return json({ error: 'هذه الصفحة متاحة للمدير والمسؤول المالي فقط.' }, 403);
  let body: Record<string, unknown>; try { body = await req.json(); } catch { return json({ error: 'صيغة الطلب غير صالحة.' }, 400); }
  const action = String(body.action || 'list');
  try {
    if (action === 'list') {
      const offset = Math.max(0, Math.floor(Number(body.offset || 0)));
      const limit = Math.min(100, Math.max(1, Math.floor(Number(body.limit || 50))));
      let paymentQuery = admin.from('financial_payments').select('*', { count: 'exact' }).order('created_at', { ascending: false });
      const filterStatus = String(body.reconciliation_status || 'all');
      if (filterStatus !== 'all') paymentQuery = paymentQuery.eq('reconciliation_status', filterStatus);
      const { data: payments, error: paymentError, count } = await paymentQuery.range(offset, offset + limit - 1);
      if (paymentError) throw new Error(paymentError.message);
      const ids = (payments || []).map((p) => p.application_id);
      const { data: applications, error: appError } = ids.length ? await admin.from('applications').select('id,tracking_code,full_name,university_number,department,specialization,amount_syp,status,receipt_path,created_at').in('id', ids) : { data: [], error: null };
      if (appError) throw new Error(appError.message);
      const byId = new Map((applications || []).map((a) => [a.id, a]));
      const { data: closings, error: closeError } = await admin.from('financial_daily_closings').select('*').order('closing_date', { ascending: false }).limit(60);
      if (closeError) throw new Error(closeError.message);
      return json({ payments: (payments || []).map((p) => ({ ...p, application: byId.get(p.application_id) || null })), total: count || 0, closings: closings || [] });
    }
    if (action === 'receipt_url') {
      const appId = String(body.application_id || ''); if (!appId) return json({ error: 'معرّف الطلب مطلوب.' }, 400);
      const { data: app, error } = await admin.from('applications').select('id,receipt_path,tracking_code').eq('id', appId).maybeSingle();
      if (error || !app) return json({ error: 'الطلب غير موجود.' }, 404);
      if (!app.receipt_path) return json({ error: 'لا توجد فاتورة سحابية لهذا الطلب. قد تكون مؤرشفة بعد الموافقة.' }, 409);
      const { data: signed, error: signError } = await admin.storage.from('receipts').createSignedUrl(app.receipt_path, 300);
      if (signError || !signed?.signedUrl) return json({ error: 'تعذر إنشاء رابط مؤقت للفاتورة.' }, 500);
      return json({ url: signed.signedUrl, expires_in: 300 });
    }
    if (action === 'save_review') {
      const appId = String(body.application_id || ''); if (!appId) return json({ error: 'معرّف الطلب مطلوب.' }, 400);
      const { data: app, error: appError } = await admin.from('applications').select('id,tracking_code,amount_syp,receipt_path,receipt_archive_path,full_name').eq('id', appId).maybeSingle();
      if (appError || !app) return json({ error: 'الطلب غير موجود.' }, 404);
      if (!app.receipt_path && !app.receipt_archive_path) return json({ error: 'لا توجد فاتورة متاحة للمطابقة.' }, 409);
      const requested = String(body.reconciliation_status || 'suspected');
      if (!['matched', 'mismatch', 'suspected', 'not_found', 'unverified'].includes(requested)) return json({ error: 'حالة المطابقة غير صالحة.' }, 400);
      const ref = String(body.transaction_reference || '').trim().toUpperCase().slice(0, 120);
      const amount = body.received_amount_syp === '' || body.received_amount_syp == null ? null : Number(body.received_amount_syp);
      const transferAt = body.transfer_at ? new Date(String(body.transfer_at)).toISOString() : null;
      let finalStatus = requested;
      if (requested === 'matched') {
        if (body.checked_against_statement !== true) return json({ error: 'لا يمكن تأكيد المطابقة دون مراجعة الحركة الفعلية في حساب شام كاش أو كشف رسمي.' }, 400);
        if (!ref || !transferAt || !Number.isSafeInteger(amount) || amount < 0) return json({ error: 'لحفظ المطابقة أدخل مرجع التحويل والمبلغ وتاريخ التحويل.' }, 400);
        if (amount !== Number(app.amount_syp)) finalStatus = 'mismatch';
        if (finalStatus === 'matched') {
          const { data: ledgerRow, error: ledgerError } = await admin.from('financial_transactions').select('id,match_status,matched_application_id,amount_syp,transaction_reference').eq('transaction_reference', ref).maybeSingle();
          if (ledgerError) return json({ error: 'تعذر قراءة دفتر الواردات المالي: ' + ledgerError.message }, 500);
          if (!ledgerRow || ledgerRow.match_status !== 'matched' || ledgerRow.matched_application_id !== appId || Number(ledgerRow.amount_syp) !== amount) {
            return json({ error: 'سجّل الحركة أولًا في تبويب «دفتر الواردات» من كشف شام كاش الفعلي. لا يمكن اعتماد فاتورة اعتمادًا على الملف أو خانة التأكيد وحدها.' }, 409);
          }
        }
        const { data: duplicate, error: dupError } = await admin.from('financial_payments').select('application_id').eq('transaction_reference', ref).neq('application_id', appId).maybeSingle();
        if (dupError && !dupError.message.includes('0 rows')) throw new Error(dupError.message);
        if (duplicate) return json({ error: 'رقم حركة شام كاش هذا مسجل لطلب آخر؛ لا تستخدم الحركة نفسها مرتين.' }, 409);
      }
      const now = new Date().toISOString();
      const payload = {
        application_id: appId, expected_amount_syp: Number(app.amount_syp), received_amount_syp: Number.isSafeInteger(amount) && amount >= 0 ? amount : null,
        transaction_reference: ref || null, transfer_at: transferAt, payer_note: String(body.payer_note || '').trim().slice(0, 160),
        reconciliation_status: finalStatus, checked_against_statement: finalStatus === 'matched' && body.checked_against_statement === true,
        verification_notes: String(body.verification_notes || '').trim().slice(0, 2000), updated_by: actor.id,
        verified_by: finalStatus === 'matched' ? actor.id : null, verified_at: finalStatus === 'matched' ? now : null, updated_at: now,
      };
      const { data: saved, error: saveError } = await admin.from('financial_payments').upsert(payload, { onConflict: 'application_id' }).select('*').single();
      if (saveError) {
        if (saveError.code === '23505') return json({ error: 'رقم الحركة مكرر. راجع سجل المطابقة قبل المتابعة.' }, 409);
        throw new Error(saveError.message);
      }
      await audit(admin, actor, role, `financial_payment_${finalStatus}`, 'financial_payment', saved.id, app.tracking_code, { application_id: appId, expected_amount_syp: app.amount_syp, received_amount_syp: saved.received_amount_syp, transaction_reference: saved.transaction_reference, transfer_at: saved.transfer_at, status: finalStatus, notes: saved.verification_notes });
      if (requested === 'matched' && finalStatus === 'mismatch') return json({ payment: saved, warning: 'المبلغ الفعلي لا يطابق الرسوم المطلوبة؛ تم حفظ السجل بوصفه اختلافًا ولم يصبح مؤهلًا للموافقة.' }, 200);
      return json({ payment: saved, message: finalStatus === 'matched' ? 'تمت مطابقة الحركة مع كشف شام كاش الفعلي. يمكن متابعة التدقيق الإداري.' : 'تم حفظ نتيجة التدقيق المالي.' });
    }
    if (action === 'close_day') return json({ error: 'أُوقف الإقفال القديم. استخدم دفتر الواردات في financial-control حتى تتم مطابقة كل حركة وإقفال اليوم على سجل واحد.' }, 410);
    return json({ error: 'العملية المطلوبة غير معروفة.' }, 400);
  } catch (error) {
    console.error('financial-management', error);
    return json({ error: error instanceof Error ? error.message : 'حدث خطأ غير متوقع في الجرد المالي.' }, 500);
  }
});
