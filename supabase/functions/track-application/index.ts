import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
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
    const universityNumber = String(body.university_number || '').trim();
    if (!/^LAT-[A-F0-9]{10}$/.test(code) || !universityNumber || universityNumber.length > 32) {
      return json({ error: 'لم يتم العثور على طلب مطابق. تحقق من كود المتابعة والرقم الجامعي.' }, 404);
    }

    const { data, error } = await admin.from('applications')
      .select('tracking_code, full_name, university_number, amount_syp, status, rejection_reason, created_at, companions')
      .eq('tracking_code', code)
      .eq('university_number', universityNumber)
      .maybeSingle();
    if (error) {
      console.error('track application failed', error.message);
      return json({ error: 'تعذر جلب حالة الطلب حالياً.' }, 500);
    }
    if (!data) return json({ error: 'لم يتم العثور على طلب مطابق. تحقق من كود المتابعة والرقم الجامعي.' }, 404);
    return json({ application: data });
  } catch (error) {
    console.error('track-application error', error);
    return json({ error: 'تعذر التحقق من الطلب. يرجى المحاولة مجدداً.' }, 400);
  }
});
