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
    const fullName = String(body.full_name || '').trim().replace(/\s+/g, ' ');
    const universityNumber = String(body.university_number || '').trim();
    const phoneNumber = String(body.phone_number || '').trim();
    const unitId = String(body.academic_unit_id || '').trim();
    const specializationId = String(body.academic_specialization_id || '').trim();
    const carriedSubjects = Number(body.carried_subjects ?? 0);
    const companions = Number(body.companions ?? 0);

    if (fullName.length < 5 || fullName.length > 120 || fullName.split(' ').length < 3) return json({ error: 'يرجى إدخال الاسم الثلاثي كاملاً.' }, 400);
    if (!universityNumber || universityNumber.length > 32) return json({ error: 'الرقم الجامعي غير صالح.' }, 400);
    if (!/^[+\d\s()\-]{7,20}$/.test(phoneNumber)) return json({ error: 'يرجى إدخال رقم هاتف صحيح للتواصل.' }, 400);
    if (!unitId) return json({ error: 'اختر الكلية أو المعهد.' }, 400);
    if (!Number.isInteger(carriedSubjects) || carriedSubjects < 0 || carriedSubjects > 30) return json({ error: 'عدد المواد المحمولة غير صالح.' }, 400);
    if (!Number.isInteger(companions) || companions < 0 || companions > 20) return json({ error: 'عدد المرافقين غير صالح.' }, 400);

    const { data: settings, error: settingsError } = await admin.from('event_settings').select('*').eq('id', 1).single();
    if (settingsError || !settings) return json({ error: 'تعذر قراءة إعدادات التسجيل. تحقق من إعداد قاعدة البيانات.' }, 500);
    if (!settings.registration_open) return json({ error: 'التسجيل مغلق حالياً.' }, 403);
    if (carriedSubjects > Number(settings.max_carried_subjects ?? 5)) return json({ error: `الحد الأقصى للمواد المحمولة هو ${settings.max_carried_subjects}.` }, 400);
    if (companions > Number(settings.max_companions)) return json({ error: `الحد الأقصى للمرافقين هو ${settings.max_companions}.` }, 400);

    const { data: unit, error: unitError } = await admin.from('academic_units').select('id, name, unit_type, is_open, registration_capacity, registered_count, capacity_reached').eq('id', unitId).maybeSingle();
    if (unitError) return json({ error: 'تعذر التحقق من الكلية أو المعهد.' }, 500);
    if (!unit) return json({ error: 'الكلية أو المعهد غير موجود.' }, 404);
    if (unit.capacity_reached || (unit.registration_capacity != null && Number(unit.registered_count || 0) + 1 + companions > Number(unit.registration_capacity))) return json({ error: 'لا تكفي السعة المتبقية لاستقبال الخريج وعدد المرافقين الذي اخترته، أو اكتمل العدد المحدد. قلل عدد المرافقين أو اختر جهة أخرى.' }, 409);
    if (!unit.is_open) return json({ error: 'التسجيل مغلق لهذه الكلية أو المعهد.' }, 403);

    const { data: allSpecs, error: specsError } = await admin.from('academic_specializations').select('id, name, is_open').eq('unit_id', unit.id);
    if (specsError) return json({ error: 'تعذر التحقق من الاختصاصات.' }, 500);
    const specs = allSpecs || [];
    let chosenSpec: { id: string; name: string } | null = null;
    if (specs.length > 0) {
      const openSpecs = specs.filter((item) => item.is_open);
      if (openSpecs.length === 0) return json({ error: 'التسجيل مغلق لجميع الاختصاصات في هذه الكلية أو المعهد.' }, 403);
      if (!specializationId) return json({ error: 'اختر الاختصاص من القائمة.' }, 400);
      const matched = openSpecs.find((item) => item.id === specializationId);
      if (!matched) return json({ error: 'هذا الاختصاص مغلق للتسجيل أو لا يتبع الكلية المحددة.' }, 403);
      chosenSpec = { id: matched.id, name: matched.name };
    } else if (specializationId) {
      return json({ error: 'لا يوجد اختصاص مسجل لهذه الكلية أو المعهد. حدّث الصفحة وأعد المحاولة.' }, 400);
    }

    const amount = Number(settings.student_fee) + companions * Number(settings.companion_fee);
    const id = crypto.randomUUID();
    const codeBytes = crypto.getRandomValues(new Uint8Array(16));
    const code = 'LAT-' + Array.from(codeBytes, (byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase();

    const { error: insertError } = await admin.from('applications').insert({
      id,
      tracking_code: code,
      full_name: fullName,
      university_number: universityNumber,
      phone_number: phoneNumber,
      department: unit.name,
      specialization: chosenSpec?.name || 'لا يوجد اختصاص',
      academic_unit_id: unit.id,
      academic_specialization_id: chosenSpec?.id || null,
      carried_subjects: carriedSubjects,
      companions,
      amount_syp: amount,
      receipt_path: null,
      status: 'awaiting_payment',
    });
    if (insertError) {
      console.error('create application failed', insertError.message);
      if (insertError.message.includes('REGISTRATION_CAPACITY_REACHED')) return json({ error: 'اكتمل العدد المحدد لهذه الكلية أو المعهد. اختر جهة أخرى مفتوحًا التسجيل فيها.' }, 409);
      if (insertError.message.includes('REGISTRATION_CLOSED')) return json({ error: 'أُغلق التسجيل لهذه الكلية أو المعهد. اختر جهة أخرى مفتوحًا التسجيل فيها.' }, 403);
      return json({ error: 'تعذر حفظ بيانات التسجيل. يرجى المحاولة مجدداً.' }, 500);
    }

    return json({ tracking_code: code, amount_syp: amount, student_fee: Number(settings.student_fee), companion_fee: Number(settings.companion_fee), status: 'awaiting_payment' }, 201);
  } catch (error) {
    console.error('submit-application error', error);
    return json({ error: 'حدث خطأ غير متوقع أثناء إنشاء الطلب.' }, 400);
  }
});
