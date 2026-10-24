import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
});
const makeTemporaryPassword = () => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('') + 'a7!';
};
type Assignment = { academic_unit_id: string; academic_specialization_id: string | null };

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'طريقة الطلب غير مدعومة.' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || Deno.env.get('SUPABASE_PUBLISHABLE_KEY');
  if (!supabaseUrl || !serviceKey || !anonKey) return json({ error: 'إعدادات الخادم غير مكتملة.' }, 500);
  const authorization = request.headers.get('Authorization') || '';
  const token = authorization.replace(/^Bearer\s+/i, '').trim();
  if (!token) return json({ error: 'يلزم تسجيل دخول المدير.' }, 401);

  const userClient = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: userResult, error: userError } = await userClient.auth.getUser(token);
  if (userError || !userResult.user) return json({ error: 'انتهت جلسة الدخول. سجّل الدخول مرة أخرى.' }, 401);
  const actor = userResult.user;
  const { data: actorRole } = await admin.from('staff_roles').select('role').eq('user_id', actor.id).maybeSingle();
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return json({ error: 'محتوى الطلب غير صالح.' }, 400); }
  const action = String(body.action || '');
  const auditStaffAction = async (actionName: string, targetId: string, targetEmail: string, details: Record<string, unknown> = {}) => {
    const { error } = await admin.from('admin_audit_logs').insert({ actor_user_id: actor.id, actor_email: actor.email || 'unknown', actor_role: actorRole?.role || 'admin', action: actionName, entity_type: 'staff_account', entity_id: targetId, details: { target_email: targetEmail, ...details } });
    if (error) console.error('staff audit insert failed', error.message);
  };
  const normalizeRole = (value: unknown): 'admin' | 'reviewer' | 'finance' | 'gate' => {
    const allowed = ['admin', 'reviewer', 'finance', 'gate'];
    return allowed.includes(String(value)) ? String(value) as 'admin' | 'reviewer' | 'finance' | 'gate' : 'reviewer';
  };

  // Any authenticated staff member may clear the protected one-time-password flag only for themselves.
  if (action === 'complete_password_change') {
    if (!actorRole) return json({ error: 'هذا الحساب ليس ضمن فريق التنظيم.' }, 403);
    const { error } = await admin.auth.admin.updateUserById(actor.id, {
      app_metadata: { ...(actor.app_metadata || {}), must_change_password: false },
    });
    if (error) return json({ error: 'تم تغيير كلمة المرور لكن تعذر تأكيد اكتمال خطوة الأمان: ' + error.message }, 500);
    return json({ ok: true });
  }

  if (actorRole?.role !== 'admin') return json({ error: 'هذه العملية متاحة لمدير النظام فقط.' }, 403);

  const validateAssignments = async (raw: unknown): Promise<Assignment[]> => {
    if (!Array.isArray(raw)) throw new Error('قائمة الصلاحيات غير صالحة.');
    const normalized: Assignment[] = [];
    for (const value of raw as Record<string, unknown>[]) {
      const unitId = String(value.academic_unit_id || '');
      const specId = value.academic_specialization_id ? String(value.academic_specialization_id) : null;
      if (!unitId) throw new Error('يوجد نطاق وصول بلا كلية أو معهد.');
      const { data: unit } = await admin.from('academic_units').select('id').eq('id', unitId).maybeSingle();
      if (!unit) throw new Error('إحدى الكليات أو المعاهد المحددة غير موجودة.');
      if (specId) {
        const { data: spec } = await admin.from('academic_specializations').select('id,unit_id').eq('id', specId).maybeSingle();
        if (!spec || spec.unit_id !== unitId) throw new Error('أحد الاختصاصات لا يتبع الكلية أو المعهد المحدد.');
      }
      normalized.push({ academic_unit_id: unitId, academic_specialization_id: specId });
    }
    const wholeUnits = new Set(normalized.filter((item) => !item.academic_specialization_id).map((item) => item.academic_unit_id));
    const compact = normalized.filter((item) => !item.academic_specialization_id || !wholeUnits.has(item.academic_unit_id));
    const unique = new Map(compact.map((item) => [`${item.academic_unit_id}:${item.academic_specialization_id || '*'}`, item]));
    return [...unique.values()];
  };

  const replaceAssignments = async (staffId: string, assignments: Assignment[]) => {
    const { error: deleteError } = await admin.from('staff_unit_permissions').delete().eq('user_id', staffId);
    if (deleteError) throw new Error('تعذر حذف الصلاحيات السابقة: ' + deleteError.message);
    if (!assignments.length) return;
    const { error } = await admin.from('staff_unit_permissions').insert(assignments.map((item) => ({ user_id: staffId, ...item })));
    if (error) throw new Error('تعذر حفظ صلاحيات الكليات والاختصاصات: ' + error.message);
  };

  try {
    if (action === 'list') {
      const { data: roles, error: rolesError } = await admin.from('staff_roles').select('user_id,role,created_at').order('created_at', { ascending: true });
      if (rolesError) throw new Error(rolesError.message);
      const { data: scopeRows, error: scopeError } = await admin.from('staff_unit_permissions').select('user_id,academic_unit_id,academic_specialization_id');
      if (scopeError) throw new Error(scopeError.message);
      const users: Record<string, { email?: string }> = {};
      for (let page = 1; page <= 20; page++) {
        const { data: userPage, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
        if (error) throw new Error(error.message);
        for (const item of userPage.users) users[item.id] = { email: item.email };
        if (userPage.users.length < 1000) break;
      }
      return json({ members: (roles || []).map((role) => ({
        user_id: role.user_id, email: users[role.user_id]?.email || '', role: role.role, created_at: role.created_at,
        assignments: (scopeRows || []).filter((scope) => scope.user_id === role.user_id).map((scope) => ({ academic_unit_id: scope.academic_unit_id, academic_specialization_id: scope.academic_specialization_id })),
      })) });
    }

    if (action === 'create') {
      const email = String(body.email || '').trim().toLowerCase();
      const role = normalizeRole(body.role);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return json({ error: 'أدخل بريدًا إلكترونيًا صحيحًا.' }, 400);
      const assignments = role === 'reviewer' ? await validateAssignments(body.assignments || []) : [];
      if (role === 'reviewer' && assignments.length === 0) return json({ error: 'يجب تحديد كلية أو اختصاص واحد على الأقل للمراجع.' }, 400);
      const temporaryPassword = makeTemporaryPassword();
      const { data: newUser, error: createError } = await admin.auth.admin.createUser({ email, password: temporaryPassword, email_confirm: true, app_metadata: { must_change_password: true } });
      if (createError || !newUser.user) return json({ error: createError?.message || 'تعذر إنشاء الحساب.' }, 400);
      const { error: roleError } = await admin.from('staff_roles').insert({ user_id: newUser.user.id, role });
      if (roleError) { await admin.auth.admin.deleteUser(newUser.user.id); return json({ error: 'تعذر إسناد الدور إلى الحساب: ' + roleError.message }, 500); }
      try { await replaceAssignments(newUser.user.id, assignments); }
      catch (error) { await admin.auth.admin.deleteUser(newUser.user.id); throw error; }
      await auditStaffAction('staff_created', newUser.user.id, email, { role, assignment_count: assignments.length });
      return json({ ok: true, user_id: newUser.user.id, email, role, temporary_password: temporaryPassword }, 201);
    }

    if (action === 'update') {
      const staffId = String(body.staff_id || '');
      const role = normalizeRole(body.role);
      if (!staffId) return json({ error: 'معرّف حساب الفريق مطلوب.' }, 400);
      if (staffId === actor.id && role !== 'admin') return json({ error: 'لا يمكنك خفض صلاحية حساب المدير الذي تستخدمه الآن.' }, 400);
      const { data: current, error: currentError } = await admin.from('staff_roles').select('user_id,role').eq('user_id', staffId).maybeSingle();
      if (currentError || !current) return json({ error: 'حساب الفريق غير موجود.' }, 404);
      if (current.role === 'admin' && role !== 'admin') {
        const { count } = await admin.from('staff_roles').select('user_id', { count: 'exact', head: true }).eq('role', 'admin');
        if ((count || 0) <= 1) return json({ error: 'لا يمكن خفض صلاحية آخر مدير في المنصة.' }, 400);
      }
      const assignments = role === 'reviewer' ? await validateAssignments(body.assignments || []) : [];
      if (role === 'reviewer' && assignments.length === 0) return json({ error: 'المراجع يحتاج إلى كلية أو اختصاص واحد على الأقل.' }, 400);
      const { error: roleError } = await admin.from('staff_roles').update({ role }).eq('user_id', staffId);
      if (roleError) throw new Error(roleError.message);
      await replaceAssignments(staffId, assignments);
      const { data: updatedUser } = await admin.auth.admin.getUserById(staffId);
      await auditStaffAction('staff_role_or_scope_updated', staffId, updatedUser.user?.email || staffId, { role, assignment_count: assignments.length });
      return json({ ok: true });
    }

    if (action === 'delete') {
      const staffId = String(body.staff_id || '');
      if (!staffId || staffId === actor.id) return json({ error: 'لا يمكنك حذف حسابك الحالي.' }, 400);
      const { data: target } = await admin.from('staff_roles').select('role').eq('user_id', staffId).maybeSingle();
      if (!target) return json({ error: 'حساب الفريق غير موجود.' }, 404);
      if (target.role === 'admin') {
        const { count } = await admin.from('staff_roles').select('user_id', { count: 'exact', head: true }).eq('role', 'admin');
        if ((count || 0) <= 1) return json({ error: 'لا يمكن حذف آخر مدير في المنصة.' }, 400);
      }
      const { data: targetUser } = await admin.auth.admin.getUserById(staffId);
      await auditStaffAction('staff_account_deleted', staffId, targetUser.user?.email || staffId, { previous_role: target.role });
      const { error } = await admin.auth.admin.deleteUser(staffId);
      if (error) throw new Error(error.message);
      return json({ ok: true });
    }

    if (action === 'reset_password') {
      const staffId = String(body.staff_id || '');
      const { data: target } = await admin.from('staff_roles').select('user_id').eq('user_id', staffId).maybeSingle();
      if (!target) return json({ error: 'حساب الفريق غير موجود.' }, 404);
      const { data: existingUser, error: existingUserError } = await admin.auth.admin.getUserById(staffId);
      if (existingUserError || !existingUser.user) throw new Error('تعذر قراءة بيانات حساب الموظف.');
      const temporaryPassword = makeTemporaryPassword();
      const { error } = await admin.auth.admin.updateUserById(staffId, { password: temporaryPassword, app_metadata: { ...(existingUser.user.app_metadata || {}), must_change_password: true } });
      if (error) throw new Error(error.message);
      const { data: targetUser } = await admin.auth.admin.getUserById(staffId);
      await auditStaffAction('staff_password_reset', staffId, targetUser.user?.email || staffId, {});
      return json({ ok: true, temporary_password: temporaryPassword });
    }

    return json({ error: 'نوع العملية غير معروف.' }, 400);
  } catch (error) {
    console.error('manage-staff:', error);
    return json({ error: error instanceof Error ? error.message : 'حدث خطأ غير متوقع.' }, 500);
  }
});
