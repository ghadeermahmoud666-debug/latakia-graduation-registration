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
    const form = await request.formData();
    const fullName = String(form.get('full_name') || '').trim().replace(/\s+/g, ' ');
    const universityNumber = String(form.get('university_number') || '').trim();
    const department = String(form.get('department') || '').trim();
    const specialization = String(form.get('specialization') || '').trim();
    const companionsValue = Number(form.get('companions') ?? 0);
    const receipt = form.get('receipt');

    if (fullName.length < 5 || fullName.length > 120) return json({ error: 'يرجى إدخال الاسم الثلاثي بشكل صحيح.' }, 400);
    if (!universityNumber || universityNumber.length > 32) return json({ error: 'الرقم الجامعي غير صالح.' }, 400);
    if (!department || department.length > 100) return json({ error: 'يرجى إدخال القسم بشكل صحيح.' }, 400);
    if (!specialization || specialization.length > 100) return json({ error: 'يرجى إدخال الاختصاص بشكل صحيح.' }, 400);
    if (!Number.isInteger(companionsValue) || companionsValue < 0 || companionsValue > 20) return json({ error: 'عدد المرافقين غير صالح.' }, 400);
    if (!(receipt instanceof File)) return json({ error: 'يرجى إرفاق إيصال الدفع بصيغة PDF.' }, 400);
    if (receipt.size <= 0 || receipt.size > 5 * 1024 * 1024) return json({ error: 'حجم الإيصال يجب ألا يتجاوز 5 ميغابايت.' }, 400);
    if (receipt.type !== 'application/pdf' || !receipt.name.toLowerCase().endsWith('.pdf')) return json({ error: 'الملف المرفق يجب أن يكون PDF.' }, 400);
    const bytes = new Uint8Array(await receipt.arrayBuffer());
    if (new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-') return json({ error: 'الملف المرفق لا يبدو ملف PDF صالحاً.' }, 400);

    const { data: settings, error: settingsError } = await admin.from('event_settings').select('*').eq('id', 1).single();
    if (settingsError || !settings) return json({ error: 'تعذر قراءة إعدادات التسجيل.' }, 500);
    if (!settings.registration_open) return json({ error: 'التسجيل مغلق حالياً.' }, 403);
    if (companionsValue > Number(settings.max_companions)) return json({ error: `الحد الأقصى للمرافقين هو ${settings.max_companions}.` }, 400);

    const amount = Number(settings.student_fee) + companionsValue * Number(settings.companion_fee);
    const id = crypto.randomUUID();
    const codeBytes = crypto.getRandomValues(new Uint8Array(5));
    const code = 'LAT-' + Array.from(codeBytes, (byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
    const receiptPath = `${id}/receipt.pdf`;

    const { error: uploadError } = await admin.storage.from('receipts').upload(receiptPath, bytes, {
      contentType: 'application/pdf',
      cacheControl: '0',
      upsert: false,
    });
    if (uploadError) return json({ error: 'تعذر حفظ إيصال الدفع. حاول رفعه مجدداً.' }, 500);

    const { error: insertError } = await admin.from('applications').insert({
      id,
      tracking_code: code,
      full_name: fullName,
      university_number: universityNumber,
      department,
      specialization,
      companions: companionsValue,
      amount_syp: amount,
      receipt_path: receiptPath,
      status: 'pending',
    });
    if (insertError) {
      await admin.storage.from('receipts').remove([receiptPath]);
      console.error('insert application failed', insertError.message);
      return json({ error: 'تعذر حفظ طلب التسجيل. يرجى المحاولة مجدداً.' }, 500);
    }

    return json({ tracking_code: code, amount_syp: amount, status: 'pending' }, 201);
  } catch (error) {
    console.error('submit-application error', error);
    return json({ error: 'حدث خطأ غير متوقع. يرجى المحاولة مجدداً.' }, 500);
  }
});
