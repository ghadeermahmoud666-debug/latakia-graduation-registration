import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Cache-Control': 'no-store' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
function tokenFrom(value: string) {
  const raw = String(value || '').trim();
  try {
    const parsed = new URL(raw);
    const token = parsed.searchParams.get('ticket') || parsed.searchParams.get('ticket_token');
    if (token) return token.trim().toUpperCase();
  } catch { /* this is probably a bare ticket token */ }
  const match = raw.toUpperCase().match(/TKT-[A-F0-9]{32}/);
  return match?.[0] || raw.toUpperCase();
}
Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'طريقة الطلب غير مدعومة.' }, 405);
  const url = Deno.env.get('SUPABASE_URL');
  const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const anon = Deno.env.get('SUPABASE_ANON_KEY') || Deno.env.get('SUPABASE_PUBLISHABLE_KEY');
  if (!url || !service || !anon) return json({ error: 'إعدادات الخادم غير مكتملة.' }, 500);
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return json({ error: 'يجب تسجيل الدخول إلى حساب فريق البوابة.' }, 401);
  const userClient = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${token}` } } });
  const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: auth, error: authError } = await userClient.auth.getUser(token);
  if (authError || !auth.user) return json({ error: 'جلسة الفريق غير صالحة أو انتهت.' }, 401);
  const { data: role, error: roleError } = await admin.from('staff_roles').select('role').eq('user_id', auth.user.id).maybeSingle();
  if (roleError || !role || !['admin', 'gate'].includes(role.role)) return json({ error: 'ماسح البوابة متاح لحساب المدير أو حساب يحمل دور البوابة فقط.' }, 403);
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return json({ error: 'محتوى الطلب غير صالح.' }, 400); }
  const ticketToken = tokenFrom(String(body.ticket_token || body.value || ''));
  if (!/^TKT-[A-F0-9]{32}$/.test(ticketToken)) return json({ status: 'invalid', message: 'رمز QR غير واضح أو غير صالح. امسح بطاقة دخول أصلية أو أدخل رمزها يدويًا.' }, 400);
  const { data, error } = await admin.rpc('check_in_ticket_once', { p_ticket_token: ticketToken, p_actor_user_id: auth.user.id, p_actor_email: auth.user.email || 'unknown' });
  if (error) {
    const denied = error.message?.includes('GATE_ACCESS_DENIED');
    return json({ status: 'error', message: denied ? 'ليس لديك صلاحية استخدام ماسح البوابة.' : 'تعذر تسجيل الدخول. تحقق من اتصال قاعدة البيانات.' }, denied ? 403 : 500);
  }
  return json(data || { status: 'error', message: 'لم ترجع قاعدة البيانات نتيجة للتحقق.' });
});
