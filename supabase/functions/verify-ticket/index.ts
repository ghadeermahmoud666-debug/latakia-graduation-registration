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
    const token = String(body.ticket_token || '').trim().toUpperCase();
    if (!/^TKT-[A-F0-9]{32}$/.test(token)) return json({ valid: false, error: 'رمز البطاقة غير صالح.' }, 400);

    const { data: ticket, error: ticketError } = await admin.from('entry_tickets')
      .select('application_id, ticket_type, ticket_number, created_at')
      .eq('ticket_token', token)
      .maybeSingle();
    if (ticketError) {
      console.error('ticket lookup failed', ticketError.message);
      return json({ valid: false, error: 'تعذّر التحقق من البطاقة حالياً.' }, 500);
    }
    if (!ticket) return json({ valid: false, error: 'البطاقة غير موجودة أو رمز QR غير صحيح.' }, 404);

    const { data: application, error: appError } = await admin.from('applications')
      .select('full_name, university_number, department, specialization, created_at, status')
      .eq('id', ticket.application_id)
      .maybeSingle();
    if (appError) return json({ valid: false, error: 'تعذّر قراءة بيانات الطلب.' }, 500);
    if (!application || application.status !== 'approved') {
      return json({ valid: false, error: 'هذه البطاقة غير صالحة للدخول لأن الطلب ليس مقبولاً حالياً.' }, 409);
    }

    // تعرض صفحة QR أقل قدر من بيانات الخريج اللازمة للتحقق عند البوابة؛ لا نكشف الهاتف أو المبلغ للعامة.
    const graduate = {
      full_name: application.full_name,
      university_number: application.university_number,
      department: application.department,
      specialization: application.specialization,
      application_created_at: application.created_at,
    };
    return json({
      valid: true,
      ticket: { type: ticket.ticket_type, number: ticket.ticket_number, issued_at: ticket.created_at },
      graduate,
      message: 'البطاقة صالحة للدخول. تحقق من الاسم ونوع البطاقة قبل السماح بالدخول.',
    });
  } catch (error) {
    console.error('verify-ticket error', error);
    return json({ valid: false, error: 'تعذر التحقق من البطاقة. حاول مجدداً.' }, 400);
  }
});
