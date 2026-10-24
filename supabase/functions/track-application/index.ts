import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
});

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'طريقة الطلب غير مدعومة.' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) return json({ error: 'إعدادات الخادم غير مكتملة.' }, 500);
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  try {
    const body = await request.json();
    const code = String(body.tracking_code || '').trim().toUpperCase();
    // نقبل الأكواد القديمة للاختبارات السابقة، والأكواد الجديدة الأقوى ذات 128 بت.
    if (!/^LAT-(?:[A-F0-9]{10}|[A-F0-9]{32})$/.test(code)) {
      return json({ error: 'أدخل رمز التتبع كاملاً كما ظهر بعد التسجيل.' }, 400);
    }

    const { data, error } = await admin.from('applications')
      .select('id, tracking_code, full_name, amount_syp, status, rejection_reason, created_at, companions, carried_subjects, department, specialization')
      .eq('tracking_code', code)
      .maybeSingle();
    if (error) {
      console.error('track application failed', error.message);
      return json({ error: 'تعذر جلب حالة الطلب حالياً.' }, 500);
    }
    if (!data) return json({ error: 'لم يتم العثور على طلب مطابق. تأكد من كتابة رمز التتبع كاملاً.' }, 404);

    let tickets: Array<{ ticket_type: string; ticket_number: number; ticket_token: string }> = [];
    if (data.status === 'approved') {
      const { data: ticketRows, error: ticketError } = await admin.from('entry_tickets')
        .select('ticket_type, ticket_number, ticket_token')
        .eq('application_id', data.id)
        .order('ticket_number', { ascending: true });
      if (ticketError) {
        console.error('entry tickets lookup failed', ticketError.message);
        return json({ error: 'تم قبول الطلب، لكن تعذّر تحميل بطاقات الدخول الآن. حاول تحديث الصفحة.' }, 500);
      }
      tickets = ticketRows || [];
    }

    const { id: _id, ...application } = data;
    return json({ application: { ...application, tickets } });
  } catch (error) {
    console.error('track-application error', error);
    return json({ error: 'تعذر التحقق من الطلب. يرجى المحاولة مجدداً.' }, 400);
  }
});
