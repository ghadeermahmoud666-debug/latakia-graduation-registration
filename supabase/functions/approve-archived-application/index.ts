import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
});
const sha256 = async (bytes: ArrayBuffer) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
const isSha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
const safeRelativePath = (value: unknown): value is string => typeof value === 'string' && value.length <= 600 && value.length > 0 && !value.startsWith('/') && !value.includes('..') && !/^[a-z]:/i.test(value);

type Payload = {
  application_id?: string;
  archive_file_name?: string;
  archive_relative_path?: string;
  archive_mode?: 'directory' | 'download';
  archive_sha256?: string;
  archive_size_bytes?: number;
  receipt_sha256?: string;
  receipt_size_bytes?: number;
  archive_confirmed?: boolean;
  backup_confirmed?: boolean;
};

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'طريقة الطلب غير مدعومة.' }, 405);

  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || Deno.env.get('SUPABASE_PUBLISHABLE_KEY');
  if (!url || !serviceKey || !anonKey) return json({ error: 'إعدادات الخادم غير مكتملة.' }, 500);
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return json({ error: 'يلزم تسجيل الدخول بحساب الفريق.' }, 401);

  const userClient = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${token}` } } });
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: authData, error: authError } = await userClient.auth.getUser(token);
  if (authError || !authData.user) return json({ error: 'جلسة الدخول غير صالحة أو انتهت.' }, 401);
  const actor = authData.user;
  const { data: role, error: roleError } = await admin.from('staff_roles').select('role').eq('user_id', actor.id).maybeSingle();
  if (roleError || !role || !['admin', 'reviewer'].includes(role.role)) return json({ error: 'هذا الحساب ليس مخولًا بمراجعة الطلبات.' }, 403);

  let body: Payload;
  try { body = await request.json(); } catch { return json({ error: 'صيغة الطلب غير صالحة.' }, 400); }
  const appId = String(body.application_id || '');
  if (!appId) return json({ error: 'معرّف الطلب مطلوب.' }, 400);
  if (body.archive_confirmed !== true || body.backup_confirmed !== true) return json({ error: 'يجب تأكيد حفظ ملف الأرشيف ووجود نسخة احتياطية ثانية.' }, 400);
  if (!['directory', 'download'].includes(String(body.archive_mode))) return json({ error: 'طريقة حفظ الأرشيف غير صالحة.' }, 400);
  if (!safeRelativePath(body.archive_relative_path) || !isSha(body.archive_sha256) || !isSha(body.receipt_sha256)) return json({ error: 'بيانات الأرشيف أو بصماته غير صالحة.' }, 400);
  if (!Number.isSafeInteger(body.archive_size_bytes) || Number(body.archive_size_bytes) <= 0 || !Number.isSafeInteger(body.receipt_size_bytes) || Number(body.receipt_size_bytes) <= 0) return json({ error: 'أحجام الملفات غير صالحة.' }, 400);
  const fileName = String(body.archive_file_name || '').trim();
  if (!fileName.toLowerCase().endsWith('.pdf') || fileName.length > 220 || /[\\/\x00-\x1f]/.test(fileName)) return json({ error: 'اسم ملف الأرشيف غير صالح.' }, 400);

  const { data: application, error: appError } = await admin.from('applications').select('id, status, receipt_path, academic_unit_id, academic_specialization_id, receipt_archive_path, receipt_sha256, receipt_size_bytes, receipt_archive_sha256, receipt_archive_size_bytes').eq('id', appId).maybeSingle();
  if (appError) return json({ error: 'تعذر تحميل بيانات الطلب.' }, 500);
  if (!application) return json({ error: 'الطلب غير موجود.' }, 404);
  if (role.role !== 'admin') {
    const { data: permissions, error: permissionError } = await admin.from('staff_unit_permissions').select('academic_unit_id,academic_specialization_id').eq('user_id', actor.id).eq('academic_unit_id', application.academic_unit_id);
    if (permissionError) return json({ error: 'تعذر التحقق من نطاق صلاحياتك.' }, 500);
    const allowed = (permissions || []).some((p) => p.academic_specialization_id == null || p.academic_specialization_id === application.academic_specialization_id);
    if (!allowed) return json({ error: 'هذا الطلب خارج نطاق الكليات أو الاختصاصات المسموح لك بمراجعتها.' }, 403);
  }
  if (application.status !== 'pending') return json({ error: 'لا يمكن الموافقة إلا على طلب قيد التدقيق بعد رفع الفاتورة.' }, 409);
  const { data: financialRecord, error: financialError } = await admin.from('financial_payments').select('reconciliation_status,checked_against_statement,received_amount_syp,transaction_reference,transfer_at').eq('application_id', appId).maybeSingle();
  if (financialError) return json({ error: 'تعذر قراءة المطابقة المالية. لم تتم الموافقة أو حذف الفاتورة.' }, 500);
  if (!financialRecord || financialRecord.reconciliation_status !== 'matched' || financialRecord.checked_against_statement !== true || Number(financialRecord.received_amount_syp) <= 0 && Number(financialRecord.received_amount_syp) !== 0 || Number(financialRecord.received_amount_syp) < 0 || !financialRecord.transaction_reference || !financialRecord.transfer_at) return json({ error: 'يجب أن يطابق المسؤول المالي الحركة الفعلية في شام كاش ورقمها ومبلغها قبل الموافقة. لم تُحذف الفاتورة.' }, 409);
  const { data: amountRow } = await admin.from('applications').select('amount_syp').eq('id', appId).maybeSingle();
  if (!amountRow || Number(financialRecord.received_amount_syp) !== Number(amountRow.amount_syp)) return json({ error: 'المبلغ المستلم لا يطابق المبلغ المطلوب؛ لا يمكن الموافقة.' }, 409);

  // Verify the original cloud receipt hash before deleting it. On a retry after object removal,
  // accept only matching archive metadata written by this endpoint during a previous attempt.
  if (application.receipt_path) {
    const { data: cloudBlob, error: downloadError } = await admin.storage.from('receipts').download(application.receipt_path);
    if (downloadError || !cloudBlob) {
      const alreadyArchived = application.receipt_archive_path === body.archive_relative_path
        && application.receipt_sha256 === body.receipt_sha256
        && application.receipt_size_bytes === Number(body.receipt_size_bytes)
        && application.receipt_archive_sha256 === body.archive_sha256
        && application.receipt_archive_size_bytes === Number(body.archive_size_bytes);
      if (!alreadyArchived) return json({ error: 'تعذر التحقق من الفاتورة الأصلية. لم تتم الموافقة أو الحذف. راجع حالة التخزين قبل إعادة المحاولة.' }, 409);
    } else {
      const bytes = await cloudBlob.arrayBuffer();
      const actualHash = await sha256(bytes);
      if (actualHash.toLowerCase() !== body.receipt_sha256.toLowerCase() || bytes.byteLength !== Number(body.receipt_size_bytes)) {
        return json({ error: 'اختلفت بصمة الفاتورة عن النسخة التي تمت مراجعتها. لم يتم حذف الملف أو الموافقة.' }, 409);
      }
      const { error: metadataError } = await admin.from('applications').update({
        receipt_archive_path: body.archive_relative_path,
        receipt_archive_mode: body.archive_mode,
        receipt_archive_sha256: body.archive_sha256.toLowerCase(),
        receipt_archive_size_bytes: Number(body.archive_size_bytes),
        receipt_sha256: actualHash,
        receipt_size_bytes: bytes.byteLength,
        receipt_archived_at: new Date().toISOString(),
        receipt_archive_saved_by: actor.id,
      }).eq('id', appId).eq('status', 'pending');
      if (metadataError) return json({ error: 'لم يتم حفظ بيانات الأرشيف في سجل الطلب. لم تحذف الفاتورة: ' + metadataError.message }, 500);
      const { error: removeError } = await admin.storage.from('receipts').remove([application.receipt_path]);
      if (removeError) return json({ error: 'حُفظت بيانات الأرشيف لكن تعذر حذف الملف السحابي؛ لم تتم الموافقة. يمكنك المحاولة مجددًا: ' + removeError.message }, 500);
    }
  } else {
    const alreadyArchived = application.receipt_archive_path === body.archive_relative_path
      && application.receipt_sha256 === body.receipt_sha256
      && application.receipt_size_bytes === Number(body.receipt_size_bytes)
      && application.receipt_archive_sha256 === body.archive_sha256
      && application.receipt_archive_size_bytes === Number(body.archive_size_bytes);
    if (!alreadyArchived) return json({ error: 'لا توجد فاتورة سحابية للتحقق، وبيانات الأرشيف لا تطابق سجلًا سابقًا. لم تتم الموافقة.' }, 409);
  }

  const { data: approved, error: approveError } = await admin.from('applications').update({
    status: 'approved', receipt_path: null, rejection_reason: null,
    reviewed_by: actor.id, reviewed_at: new Date().toISOString(),
    receipt_archive_path: body.archive_relative_path,
    receipt_archive_mode: body.archive_mode,
    receipt_archive_sha256: body.archive_sha256.toLowerCase(),
    receipt_archive_size_bytes: Number(body.archive_size_bytes),
    receipt_sha256: body.receipt_sha256.toLowerCase(),
    receipt_size_bytes: Number(body.receipt_size_bytes),
    receipt_archived_at: new Date().toISOString(),
    receipt_archive_saved_by: actor.id,
  }).eq('id', appId).eq('status', 'pending').select('id,tracking_code').maybeSingle();
  if (approveError || !approved) return json({ error: 'حُفظ الأرشيف والتحقق من الوصل، لكن لم يتسنَّ إنهاء الموافقة في قاعدة البيانات. أعد المحاولة؛ لن يُحذف الأرشيف المحلي.' }, 500);
  const { error: auditError } = await admin.from('admin_audit_logs').insert({ actor_user_id: actor.id, actor_email: actor.email || 'unknown', actor_role: role.role, action: 'application_approved_and_receipt_archived', entity_type: 'application', entity_id: approved.id, tracking_code: approved.tracking_code, details: { receipt_removed_from_cloud: true, archive_file_name: fileName, archive_relative_path: body.archive_relative_path, archive_sha256: body.archive_sha256, receipt_sha256: body.receipt_sha256, financial_transaction_reference: financialRecord.transaction_reference, amount_syp: amountRow?.amount_syp } });
  if (auditError) console.error('audit insert failed', auditError.message);
  return json({ ok: true, status: 'approved', tracking_code: approved.tracking_code, receipt_removed_from_cloud: true, message: 'تمت الموافقة بعد التحقق من بصمة الفاتورة ومطابقة التحويل وتسجيل بيانات الأرشيف.' });
});
