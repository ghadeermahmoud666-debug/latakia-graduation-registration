import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' } });
const sha256 = async (bytes: ArrayBuffer) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
const isSha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
const safeRelativePath = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 600 && !value.startsWith('/') && !value.includes('..') && !/^[a-z]:/i.test(value);
Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'طريقة الطلب غير مدعومة.' }, 405);
  const url = Deno.env.get('SUPABASE_URL'); const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'); const anon = Deno.env.get('SUPABASE_ANON_KEY') || Deno.env.get('SUPABASE_PUBLISHABLE_KEY');
  if (!url || !service || !anon) return json({ error: 'إعدادات الخادم غير مكتملة.' }, 500);
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim(); if (!token) return json({ error: 'يلزم تسجيل الدخول.' }, 401);
  const userClient = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${token}` } } });
  const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: auth, error: authError } = await userClient.auth.getUser(token); if (authError || !auth.user) return json({ error: 'جلسة الدخول غير صالحة.' }, 401);
  const { data: role, error: roleError } = await admin.from('staff_roles').select('role').eq('user_id', auth.user.id).maybeSingle();
  if (roleError || role?.role !== 'admin') return json({ error: 'حذف الفاتورة المرفوضة متاح للمدير فقط.' }, 403);
  let body: Record<string, unknown>; try { body = await request.json(); } catch { return json({ error: 'بيانات الطلب غير صالحة.' }, 400); }
  const id = String(body.application_id || ''); if (!id) return json({ error: 'معرّف الطلب مطلوب.' }, 400);
  if (body.archive_confirmed !== true || body.backup_confirmed !== true) return json({ error: 'قبل حذف فاتورة مرفوضة، يجب تأكيد حفظ الأرشيف ووجود نسخة احتياطية ثانية.' }, 400);
  const archivePath = body.archive_relative_path;
  const archiveMode = String(body.archive_mode || '');
  const archiveHash = body.archive_sha256;
  const receiptHash = body.receipt_sha256;
  const archiveSize = Number(body.archive_size_bytes);
  const receiptSize = Number(body.receipt_size_bytes);
  const fileName = String(body.archive_file_name || '').trim();
  if (!safeRelativePath(archivePath) || !['directory', 'download'].includes(archiveMode) || !isSha(archiveHash) || !isSha(receiptHash) || !Number.isSafeInteger(archiveSize) || archiveSize <= 0 || !Number.isSafeInteger(receiptSize) || receiptSize <= 0 || !fileName.toLowerCase().endsWith('.pdf') || fileName.length > 220 || /[\\/\x00-\x1f]/.test(fileName)) return json({ error: 'معلومات الأرشيف غير صالحة.' }, 400);
  const { data: app, error } = await admin.from('applications').select('id,status,receipt_path,receipt_archive_path,receipt_sha256,receipt_size_bytes,receipt_archive_sha256,receipt_archive_size_bytes').eq('id', id).maybeSingle();
  if (error) return json({ error: 'تعذر تحميل الطلب.' }, 500); if (!app) return json({ error: 'الطلب غير موجود.' }, 404);
  if (app.status !== 'rejected') return json({ error: 'يمكن حذف الفاتورة فقط بعد رفض الطلب. تبقى الفاتورة للطلبات قيد التدقيق.' }, 409);
  if (!app.receipt_path) {
    const archivedAlready = app.receipt_archive_path === archivePath && app.receipt_sha256 === receiptHash && app.receipt_size_bytes === receiptSize && app.receipt_archive_sha256 === archiveHash && app.receipt_archive_size_bytes === archiveSize;
    if (!archivedAlready) return json({ error: 'لا توجد فاتورة سحابية أو بيانات أرشيف مطابقة.' }, 409);
    return json({ ok: true, message: 'الفاتورة محذوفة من السحابة وسجل الأرشيف محفوظ.' });
  }
  const { data: cloudBlob, error: downloadError } = await admin.storage.from('receipts').download(app.receipt_path);
  if (downloadError || !cloudBlob) {
    const archivedAlready = app.receipt_archive_path === archivePath && app.receipt_sha256 === receiptHash && app.receipt_size_bytes === receiptSize && app.receipt_archive_sha256 === archiveHash && app.receipt_archive_size_bytes === archiveSize;
    if (!archivedAlready) return json({ error: 'تعذر التحقق من الفاتورة السحابية. لم يتم الحذف.' }, 409);
  } else {
    const bytes = await cloudBlob.arrayBuffer(); const actualHash = await sha256(bytes);
    if (actualHash.toLowerCase() !== String(receiptHash).toLowerCase() || bytes.byteLength !== receiptSize) return json({ error: 'بصمة الفاتورة لا تطابق الملف المؤرشف. لم يتم الحذف.' }, 409);
    const { error: metadataError } = await admin.from('applications').update({
      receipt_archive_path: archivePath,
      receipt_archive_mode: archiveMode,
      receipt_archive_sha256: String(archiveHash).toLowerCase(),
      receipt_archive_size_bytes: archiveSize,
      receipt_sha256: actualHash,
      receipt_size_bytes: bytes.byteLength,
      receipt_archived_at: new Date().toISOString(),
      receipt_archive_saved_by: auth.user.id,
    }).eq('id', id).eq('status', 'rejected');
    if (metadataError) return json({ error: 'لم تُحفظ بيانات الأرشيف. لم تُحذف الفاتورة: ' + metadataError.message }, 500);
    const { error: removeError } = await admin.storage.from('receipts').remove([app.receipt_path]);
    if (removeError) return json({ error: 'تم تسجيل الأرشيف لكن تعذر حذف الفاتورة السحابية: ' + removeError.message }, 500);
  }
  const { error: updateError } = await admin.from('applications').update({ receipt_path: null }).eq('id', id).eq('status', 'rejected');
  if (updateError) return json({ error: 'حذفت الفاتورة السحابية لكن تعذر تحديث مسارها في سجل الطلب. احتفظ بالأرشيف وأعد المحاولة: ' + updateError.message }, 500);
  const { error: auditError } = await admin.from('admin_audit_logs').insert({ actor_user_id: auth.user.id, actor_email: auth.user.email || 'unknown', actor_role: 'admin', action: 'rejected_receipt_deleted', entity_type: 'application', entity_id: id, tracking_code: (await admin.from('applications').select('tracking_code').eq('id', id).maybeSingle()).data?.tracking_code || null, details: { archive_path: archivePath, archive_sha256: archiveHash, receipt_sha256: receiptHash, archive_file_name: fileName } });
  if (auditError) console.error('audit insert failed', auditError.message);
  return json({ ok: true, message: 'حُذفت الفاتورة من السحابة بعد التحقق من بصمتها وحفظ بيانات الأرشيف. بقي سجل الطالب.' });
});
