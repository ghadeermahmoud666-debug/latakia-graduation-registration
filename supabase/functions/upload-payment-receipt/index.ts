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
    const code = String(form.get('tracking_code') || '').trim().toUpperCase();
    const receipt = form.get('receipt');
    if (!/^LAT-(?:[A-F0-9]{10}|[A-F0-9]{32})$/.test(code)) return json({ error: 'رمز التتبع غير صحيح.' }, 400);
    if (!(receipt instanceof File)) return json({ error: 'اختر فاتورة التحويل بصيغة PDF.' }, 400);
    if (receipt.size <= 0 || receipt.size > 5 * 1024 * 1024) return json({ error: 'حجم الفاتورة يجب ألا يتجاوز 5 ميغابايت.' }, 400);
    if (receipt.type !== 'application/pdf' || !receipt.name.toLowerCase().endsWith('.pdf')) return json({ error: 'الملف المرفق يجب أن يكون PDF.' }, 400);
    const bytes = new Uint8Array(await receipt.arrayBuffer());
    if (new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-') return json({ error: 'الملف لا يبدو فاتورة PDF سليمة.' }, 400);

    const { data: application, error: findError } = await admin.from('applications')
      .select('id, status, receipt_path')
      .eq('tracking_code', code)
      .maybeSingle();
    if (findError) return json({ error: 'تعذر التحقق من الطلب.' }, 500);
    if (!application) return json({ error: 'لم يتم العثور على طلب بهذا الرمز. تحقق من كتابته كاملاً.' }, 404);
    if (application.status !== 'awaiting_payment') return json({ error: 'تم استلام فاتورة لهذا الطلب أو أن الطلب لم يعد بانتظار الدفع. استخدم صفحة تتبع الطلب لمعرفة حالته.' }, 409);

    const receiptPath = `${application.id}/receipt-${Date.now()}.pdf`;
    const { error: uploadError } = await admin.storage.from('receipts').upload(receiptPath, bytes, {
      contentType: 'application/pdf', cacheControl: '0', upsert: false,
    });
    if (uploadError) {
      console.error('receipt upload failed', uploadError.message);
      return json({ error: 'تعذر رفع الفاتورة. حاول مجدداً.' }, 500);
    }

    const { data: updated, error: updateError } = await admin.from('applications')
      .update({ receipt_path: receiptPath, status: 'pending' })
      .eq('id', application.id)
      .eq('status', 'awaiting_payment')
      .select('id')
      .maybeSingle();
    if (updateError || !updated) {
      await admin.storage.from('receipts').remove([receiptPath]);
      return json({ error: 'تغيرت حالة الطلب أثناء الرفع. حدّث حالة الطلب وحاول مجدداً إن كان ذلك مطلوباً.' }, 409);
    }

    return json({ tracking_code: code, status: 'pending', message: 'تم استلام الفاتورة بنجاح، وأصبح الطلب قيد تدقيق فريق التنظيم.' }, 200);
  } catch (error) {
    console.error('upload-payment-receipt error', error);
    return json({ error: 'حدث خطأ غير متوقع أثناء رفع الفاتورة.' }, 400);
  }
});
