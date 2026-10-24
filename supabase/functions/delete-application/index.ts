import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' } });
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
  if (roleError || role?.role !== 'admin') return json({ error: 'حذف كامل بيانات الطالب متاح للمدير فقط.' }, 403);
  let body: { application_id?: string; confirm?: boolean }; try { body = await request.json(); } catch { return json({ error: 'بيانات الطلب غير صالحة.' }, 400); }
  if (body.confirm !== true) return json({ error: 'يلزم تأكيد الحذف النهائي.' }, 400);
  const id = String(body.application_id || ''); if (!id) return json({ error: 'معرّف الطلب مطلوب.' }, 400);
  const { data: app, error } = await admin.from('applications').select('id,tracking_code,receipt_path').eq('id', id).maybeSingle();
  if (error) return json({ error: 'تعذر تحميل الطلب.' }, 500); if (!app) return json({ error: 'الطلب غير موجود.' }, 404);
  if (app.receipt_path) {
    const { error: removeError } = await admin.storage.from('receipts').remove([app.receipt_path]);
    if (removeError) return json({ error: 'تعذر حذف ملف الفاتورة؛ لم يُحذف سجل الطالب: ' + removeError.message }, 500);
  }
  const { error: deleteError } = await admin.from('applications').delete().eq('id', id);
  if (deleteError) return json({ error: 'تعذر حذف سجل الطالب: ' + deleteError.message }, 500);
  return json({ ok: true, tracking_code: app.tracking_code, message: 'حذف سجل الطالب والملفات السحابية المرتبطة به. أي نسخة أرشيفية على أجهزة الفريق تبقى خارج سيطرة الموقع، ويجب حذفها يدويًا حسب سياسة الاحتفاظ.' });
});
