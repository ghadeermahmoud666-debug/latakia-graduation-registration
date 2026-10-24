import { useCallback, useEffect, useMemo, useState } from 'react';
import { anonKeyValue, configurationProblem, functionUrl, isConfigured, supabase } from './lib/supabase';

const DEFAULT_SETTINGS = {
  id: 1,
  event_title: 'التسجيل لحفلات التخرج',
  university_label: 'جامعة اللاذقية',
  organizer: 'اتحاد طلبة سوريا – فرع محافظة اللاذقية',
  registration_open: false,
  student_fee: 0,
  companion_fee: 0,
  max_companions: 4,
  shamcash_account: '',
  payment_instructions: 'حوّل المبلغ الإجمالي إلى حساب شام كاش الموضح أدناه، ثم ارفع إيصال التحويل بصيغة PDF.',
  qr_image_url: '',
};

const STATUS = {
  pending: { label: 'قيد التدقيق', className: 'pending', icon: '◷' },
  approved: { label: 'تمت الموافقة', className: 'approved', icon: '✓' },
  rejected: { label: 'مرفوض', className: 'rejected', icon: '!' },
};

const fmt = (value) => new Intl.NumberFormat('ar-SY').format(Number(value || 0));
const humanDate = (value) => value ? new Date(value).toLocaleString('ar-SY', { dateStyle: 'medium', timeStyle: 'short' }) : '—';

function App() {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [page, setPage] = useState('register');
  const [toast, setToast] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(null);
  const [trackingCode, setTrackingCode] = useState('');
  const [trackingUni, setTrackingUni] = useState('');
  const [trackingBusy, setTrackingBusy] = useState(false);
  const [trackingResult, setTrackingResult] = useState(null);
  const [form, setForm] = useState({ full_name: '', university_number: '', department: '', specialization: '', companions: '0', receipt: null });
  const [staffUser, setStaffUser] = useState(null);
  const [authChecking, setAuthChecking] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const notify = useCallback((message, kind = 'info') => {
    setToast({ message, kind });
    window.setTimeout(() => setToast(null), 4200);
  }, []);

  const loadSettings = useCallback(async () => {
    if (!isConfigured) { setSettingsLoaded(true); return; }
    const { data, error } = await supabase.from('event_settings').select('*').eq('id', 1).maybeSingle();
    if (data) setSettings({ ...DEFAULT_SETTINGS, ...data });
    if (error) console.error('settings:', error.message);
    setSettingsLoaded(true);
  }, []);

  useEffect(() => { loadSettings(); }, [loadSettings]);

  useEffect(() => {
    if (!isConfigured) return;
    let alive = true;
    supabase.auth.getSession().then(({ data }) => {
      if (alive && data.session) setStaffUser(data.session.user);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setStaffUser(session?.user ?? null);
      if (!session) setPage((current) => current === 'admin' ? 'staff' : current);
    });
    return () => { alive = false; listener.subscription.unsubscribe(); };
  }, []);

  const companions = Math.max(0, Number.parseInt(form.companions || '0', 10) || 0);
  const total = Number(settings.student_fee || 0) + companions * Number(settings.companion_fee || 0);
  const registrationUnavailable = !settings.registration_open;

  const setField = (key, value) => setForm((old) => ({ ...old, [key]: value }));

  async function handleSubmit(event) {
    event.preventDefault();
    if (!isConfigured) return notify('اربط المشروع بـ Supabase أولاً لتفعيل التسجيل الحقيقي. راجع ملف README.', 'error');
    if (!settings.registration_open) return notify('التسجيل مغلق حالياً.', 'error');
    if (!form.receipt) return notify('يرجى إرفاق إيصال الدفع بصيغة PDF.', 'error');
    if (form.receipt.type !== 'application/pdf' || !form.receipt.name.toLowerCase().endsWith('.pdf')) return notify('الملف المرفق يجب أن يكون PDF.', 'error');
    if (form.receipt.size > 5 * 1024 * 1024) return notify('حجم الإيصال يجب ألا يتجاوز 5 ميغابايت.', 'error');
    if (companions > Number(settings.max_companions)) return notify(`الحد الأقصى للمرافقين هو ${settings.max_companions}.`, 'error');
    setSubmitting(true);
    try {
      const payload = new FormData();
      ['full_name', 'university_number', 'department', 'specialization'].forEach((key) => payload.append(key, form[key].trim()));
      payload.append('companions', String(companions));
      payload.append('receipt', form.receipt);
      const response = await fetch(functionUrl('submit-application'), {
        method: 'POST',
        headers: { apikey: anonKeyValue, Authorization: `Bearer ${anonKeyValue}` },
        body: payload,
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'تعذر إرسال الطلب. حاول مجدداً.');
      setSuccess({ ...result, university_number: form.university_number });
      setForm({ full_name: '', university_number: '', department: '', specialization: '', companions: '0', receipt: null });
      event.target.reset();
      notify('تم إرسال طلبك بنجاح.', 'success');
    } catch (error) {
      notify(error.message || 'حدث خطأ أثناء الإرسال.', 'error');
    } finally { setSubmitting(false); }
  }

  async function handleTrack(event) {
    event.preventDefault();
    if (!isConfigured) return notify('تتبع الطلب متاح بعد إعداد Supabase ونشر الوظائف الخلفية.', 'error');
    setTrackingBusy(true); setTrackingResult(null);
    try {
      const response = await fetch(functionUrl('track-application'), {
        method: 'POST',
        headers: { apikey: anonKeyValue, Authorization: `Bearer ${anonKeyValue}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ tracking_code: trackingCode.trim().toUpperCase(), university_number: trackingUni.trim() }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'لم يتم العثور على طلب مطابق. تحقق من البيانات.');
      setTrackingResult(result.application);
    } catch (error) { notify(error.message || 'تعذر تتبع الطلب.', 'error'); }
    finally { setTrackingBusy(false); }
  }

  async function handleLogin(event) {
    event.preventDefault();
    if (!isConfigured) return notify('أكمل إعداد Supabase أولاً.', 'error');
    setAuthChecking(true);
    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (error) throw error;
      const { data: role, error: roleError } = await supabase.from('staff_roles').select('user_id, role').eq('user_id', data.user.id).maybeSingle();
      if (roleError || !role) {
        await supabase.auth.signOut();
        throw new Error('هذا الحساب غير مخوّل للوصول إلى لوحة الفريق. اطلب من مدير النظام إضافته إلى فريق المراجعة.');
      }
      setStaffUser(data.user); setPage('admin'); notify('مرحباً بك في لوحة المراجعة.', 'success');
    } catch (error) { notify(error.message || 'تعذر تسجيل الدخول.', 'error'); }
    finally { setAuthChecking(false); }
  }

  async function signOut() {
    await supabase.auth.signOut();
    setStaffUser(null); setPage('staff');
  }

  const amountSummary = useMemo(() => ({ student: Number(settings.student_fee || 0), companion: Number(settings.companion_fee || 0), total }), [settings, total]);

  return <div className="app-shell">
    <div className="topline"><div className="container topline-inner"><span><i className="dot" /> منصة التسجيل الرسمية</span><span>جامعة اللاذقية <b className="top-sep">•</b> موسم حفلات التخرج</span></div></div>
    <header className="site-header">
      <div className="container header-inner">
        <button className="brand" onClick={() => setPage('register')} aria-label="العودة إلى الرئيسية">
          <div className="brand-mark"><span>ل</span><small>تخرج</small></div>
          <div className="brand-copy"><strong>{settings.university_label || DEFAULT_SETTINGS.university_label}</strong><span>{settings.organizer || DEFAULT_SETTINGS.organizer}</span></div>
        </button>
        <nav className="main-nav" aria-label="التنقل الرئيسي">
          <button className={page === 'register' ? 'active' : ''} onClick={() => setPage('register')}>التسجيل</button>
          <button className={page === 'track' ? 'active' : ''} onClick={() => { setPage('track'); setTrackingResult(null); }}>تتبع الطلب</button>
          <button className={page === 'staff' || page === 'admin' ? 'active' : ''} onClick={() => setPage(staffUser ? 'admin' : 'staff')}><span className="nav-lock">⌑</span> دخول الفريق</button>
        </nav>
      </div>
    </header>

    <main>
      {page === 'register' && <>
        <section className="hero">
          <div className="hero-pattern" />
          <div className="container hero-content">
            <div className="hero-copy">
              <div className="eyebrow"><span className="eyebrow-star">✳</span> لحظة تستحق أن تُخلّد</div>
              <h1>{settings.event_title || 'التسجيل لحفلات التخرج'}<br /><em>تبدأ من هنا.</em></h1>
              <p>أكمل بياناتك الجامعية، ثبّت رسومك، وارفع إيصال الدفع لمتابعة طلب التسجيل لحفل التخرج بكل سهولة.</p>
              <div className="hero-points"><span><b>01</b> تعبئة البيانات</span><span><b>02</b> دفع الرسوم</span><span><b>03</b> تدقيق الطلب</span></div>
            </div>
            <div className="hero-art" aria-hidden="true">
              <div className="orbit orbit-one" /><div className="orbit orbit-two" />
              <div className="cap-icon"><div className="cap-top" /><div className="cap-base" /><div className="cap-tassel" /></div>
              <div className="art-star star-a">✦</div><div className="art-star star-b">✧</div><div className="art-star star-c">✦</div>
              <div className="art-caption"><span>CLASS OF</span><strong>2026</strong><small>خطوة نحو المستقبل</small></div>
            </div>
          </div>
          <div className="hero-bottom-line"><div className="container"><span>رحلتك الجامعية تستحق احتفالاً يليق بها</span><span className="line-decoration" /></div></div>
        </section>

        <section className="container content-grid" id="registration">
          <div className="form-column">
            <div className="section-heading"><div><span className="section-index">01 / التسجيل</span><h2>بيانات الطالب</h2><p>يرجى إدخال المعلومات تماماً كما تظهر في سجلك الجامعي.</p></div><div className="heading-icon">▤</div></div>
            {!isConfigured && <div className="notice notice-warning"><span className="notice-icon">ⓘ</span><div><strong>الموقع في وضع الإعداد</strong><p>{configurationProblem === 'invalid-url' ? 'عنوان Supabase في إعدادات النشر غير صحيح. راجع VITE_SUPABASE_URL في Cloudflare.' : 'الواجهة جاهزة للمعاينة، لكن حفظ الطلبات ورفع الملفات يحتاج إعداد متغيرات Supabase في Cloudflare.'}</p></div></div>}
            {registrationUnavailable && <div className="notice notice-info"><span className="notice-icon">◷</span><div><strong>التسجيل غير مفتوح حالياً</strong><p>سيظهر نموذج التسجيل بشكل فعّال بعد أن يفتح فريق التنظيم التسجيل من لوحة التحكم.</p></div></div>}
            <form className="panel registration-form" onSubmit={handleSubmit}>
              <div className="form-panel-title"><span className="step-circle">1</span><div><strong>المعلومات الشخصية والجامعية</strong><small>جميع الحقول التالية مطلوبة</small></div></div>
              <div className="field-grid">
                <label className="field field-full"><span>الاسم الثلاثي <b>*</b></span><div className="input-wrap"><span className="input-icon">♙</span><input required minLength="5" maxLength="120" value={form.full_name} onChange={(e) => setField('full_name', e.target.value)} placeholder="مثال: أحمد محمد علي" autoComplete="name" disabled={registrationUnavailable} /></div></label>
                <label className="field"><span>الرقم الجامعي <b>*</b></span><div className="input-wrap"><span className="input-icon">№</span><input required maxLength="32" value={form.university_number} onChange={(e) => setField('university_number', e.target.value)} placeholder="أدخل رقمك الجامعي" disabled={registrationUnavailable} /></div></label>
                <label className="field"><span>القسم <b>*</b></span><div className="input-wrap"><span className="input-icon">▤</span><input required maxLength="100" value={form.department} onChange={(e) => setField('department', e.target.value)} placeholder="اسم القسم" disabled={registrationUnavailable} /></div></label>
                <label className="field field-full"><span>الاختصاص <b>*</b></span><div className="input-wrap"><span className="input-icon">⌘</span><input required maxLength="100" value={form.specialization} onChange={(e) => setField('specialization', e.target.value)} placeholder="مثال: هندسة البرمجيات" disabled={registrationUnavailable} /></div></label>
              </div>
              <div className="form-divider" />
              <div className="form-panel-title"><span className="step-circle">2</span><div><strong>عدد المرافقين والرسوم</strong><small>سيُحسب المبلغ الإجمالي تلقائياً</small></div></div>
              <div className="companion-row">
                <div><strong>عدد المرافقين</strong><small>الحد الأقصى: {settings.max_companions} مرافقين</small></div>
                <div className="counter"><button type="button" onClick={() => setField('companions', String(Math.max(0, companions - 1)))} disabled={registrationUnavailable || companions <= 0} aria-label="إنقاص عدد المرافقين">−</button><output>{companions}</output><button type="button" onClick={() => setField('companions', String(Math.min(Number(settings.max_companions), companions + 1)))} disabled={registrationUnavailable || companions >= Number(settings.max_companions)} aria-label="زيادة عدد المرافقين">+</button></div>
              </div>
              <div className="price-summary">
                <div><span>رسوم تسجيل الطالب</span><strong>{fmt(amountSummary.student)} <small>ل.س</small></strong></div>
                <div><span>رسوم المرافق الواحد</span><strong>{fmt(amountSummary.companion)} <small>ل.س</small></strong></div>
                <div className="price-total"><span>المبلغ الإجمالي المطلوب</span><strong>{fmt(amountSummary.total)} <small>ل.س</small></strong></div>
              </div>
              <div className="form-divider" />
              <div className="form-panel-title"><span className="step-circle">3</span><div><strong>إرفاق إيصال الدفع</strong><small>ارفع فاتورة التحويل بعد الدفع عبر شام كاش</small></div></div>
              <div className={`upload-box ${form.receipt ? 'has-file' : ''}`}>
                <input id="receipt-file" type="file" accept="application/pdf,.pdf" onChange={(e) => setField('receipt', e.target.files?.[0] || null)} disabled={registrationUnavailable} />
                <label htmlFor="receipt-file" className="upload-label"><span className="upload-icon">⇧</span><span className="upload-main">{form.receipt ? form.receipt.name : 'اضغط لاختيار ملف الإيصال'}</span><span className="upload-sub">PDF فقط · الحجم الأقصى 5 ميغابايت</span><span className="upload-choose">استعراض الملفات</span></label>
                {form.receipt && <button type="button" className="remove-file" onClick={() => { setField('receipt', null); const input = document.getElementById('receipt-file'); if (input) input.value = ''; }}>إزالة الملف ×</button>}
              </div>
              <label className="consent-check"><input type="checkbox" required disabled={registrationUnavailable} /><span>أقرّ بأن البيانات المدخلة صحيحة، وأعلم أن التسجيل يخضع لتدقيق فريق التنظيم.</span></label>
              <button className="primary-button submit-button" type="submit" disabled={submitting || registrationUnavailable}><span>{submitting ? 'جارٍ إرسال الطلب…' : 'إرسال طلب التسجيل'}</span><span className="button-arrow">←</span></button>
              <p className="form-footnote"><span>♢</span> ستحصل على كود خاص لمتابعة حالة طلبك بعد الإرسال.</p>
            </form>
          </div>

          <aside className="side-column">
            <div className="section-heading side-heading"><div><span className="section-index">02 / الدفع</span><h2>خطوات الدفع</h2><p>اتبع الخطوات التالية لإتمام طلبك.</p></div></div>
            <div className="panel payment-panel">
              <div className="payment-step"><span className="payment-step-number">01</span><div><strong>احسب الرسوم</strong><p>يظهر المبلغ النهائي حسب رسوم الطالب وعدد المرافقين.</p></div></div>
              <div className="payment-step"><span className="payment-step-number">02</span><div><strong>حوّل عبر شام كاش</strong><p>{settings.payment_instructions || DEFAULT_SETTINGS.payment_instructions}</p></div></div>
              {settings.qr_image_url ? <div className="qr-container"><img src={settings.qr_image_url} alt="رمز QR للدفع عبر شام كاش" /><span>امسح الرمز من تطبيق شام كاش</span></div> : <div className="qr-placeholder"><div className="qr-mini">▦</div><span>سيظهر رمز الدفع هنا بعد إضافته من لوحة الفريق</span></div>}
              <div className="account-box"><span>حساب شام كاش للتحويل</span><strong>{settings.shamcash_account || 'سيتم الإعلان عنه قريباً'}</strong>{settings.shamcash_account && <button type="button" onClick={() => { navigator.clipboard?.writeText(settings.shamcash_account); notify('تم نسخ حساب شام كاش.', 'success'); }}>نسخ الحساب ⧉</button>}</div>
              <div className="secure-note"><span>▣</span><p>لن يُعتمد الطلب تلقائياً بعد الدفع؛ يجب أن يراجع الفريق الإيصال ويؤكد صحة التحويل.</p></div>
            </div>
            <div className="help-card"><div className="help-symbol">?</div><div><strong>هل تحتاج إلى مساعدة؟</strong><p>احتفظ بكود المتابعة بعد التسجيل. استخدمه مع رقمك الجامعي لمعرفة حالة طلبك.</p><button onClick={() => setPage('track')}>تتبع طلبي <span>←</span></button></div></div>
            <div className="privacy-note"><span>⌑</span><p>يُستخدم رقمك الجامعي وبيانات الطلب لغرض تنظيم حفلات التخرج ومراجعة التسجيل فقط.</p></div>
          </aside>
        </section>
        <section className="container process-section"><div className="section-index">كيف يعمل الموقع؟</div><h2>ثلاث خطوات، وطلبك قيد المتابعة</h2><div className="process-grid"><div className="process-item"><span>01</span><div className="process-icon">♙</div><h3>سجّل بياناتك</h3><p>أدخل بياناتك الجامعية وعدد المرافقين بعناية.</p></div><div className="process-item"><span>02</span><div className="process-icon">▦</div><h3>ادفع وارفع الإيصال</h3><p>حوّل الرسوم عبر شام كاش وأرفق الإيصال بصيغة PDF.</p></div><div className="process-item"><span>03</span><div className="process-icon">✓</div><h3>تابع الموافقة</h3><p>يُدقق الفريق طلبك ويمكنك معرفة القرار من كود المتابعة.</p></div></div></section>
      </>}

      {page === 'track' && <section className="container inner-page"><div className="inner-hero"><span className="section-index">متابعة التسجيل</span><h1>أين وصل طلبك؟</h1><p>أدخل كود المتابعة الذي حصلت عليه بعد التسجيل ورقمك الجامعي لعرض آخر حالة للطلب.</p></div><div className="track-layout"><form className="panel track-panel" onSubmit={handleTrack}><label className="field"><span>كود المتابعة <b>*</b></span><div className="input-wrap"><span className="input-icon">⌘</span><input required value={trackingCode} onChange={(e) => setTrackingCode(e.target.value.toUpperCase())} placeholder="مثال: LAT-AB12CD34EF" /></div></label><label className="field"><span>الرقم الجامعي <b>*</b></span><div className="input-wrap"><span className="input-icon">№</span><input required value={trackingUni} onChange={(e) => setTrackingUni(e.target.value)} placeholder="أدخل الرقم الجامعي" /></div></label><button className="primary-button" disabled={trackingBusy}><span>{trackingBusy ? 'جارٍ البحث…' : 'عرض حالة الطلب'}</span><span className="button-arrow">←</span></button><p className="form-footnote">للحفاظ على خصوصية بياناتك، يجب مطابقة الكود مع الرقم الجامعي.</p></form>
          {trackingResult ? <div className="panel track-result"><div className="result-header"><span className="section-index">نتيجة الاستعلام</span><span className={`status-badge ${STATUS[trackingResult.status]?.className || 'pending'}`}>{STATUS[trackingResult.status]?.label || 'قيد التدقيق'}</span></div><h2>{trackingResult.full_name}</h2><div className="result-code"><span>كود المتابعة</span><strong>{trackingResult.tracking_code}</strong></div><div className="result-meta"><div><span>تاريخ التقديم</span><strong>{humanDate(trackingResult.created_at)}</strong></div><div><span>المبلغ المسجل</span><strong>{fmt(trackingResult.amount_syp)} ل.س</strong></div></div>{trackingResult.status === 'pending' && <p className="result-message">طلبك قيد المراجعة من قبل فريق التنظيم. يرجى متابعة الحالة لاحقاً.</p>}{trackingResult.status === 'approved' && <p className="result-message success-message">تمت الموافقة على طلبك. احتفظ بكود المتابعة لأي مراجعة لاحقة.</p>}{trackingResult.status === 'rejected' && <div className="rejection-message"><strong>سبب الرفض</strong><p>{trackingResult.rejection_reason || 'يرجى التواصل مع فريق التنظيم لمعرفة التفاصيل.'}</p></div>}</div> : <div className="track-help"><div className="big-lock">⌑</div><h3>بياناتك محمية</h3><p>لا يمكن عرض تفاصيل الطلب دون مطابقة كود المتابعة والرقم الجامعي.</p></div>}
        </div></section>}

      {page === 'staff' && <section className="container inner-page staff-page"><div className="inner-hero"><span className="section-index">للاستخدام الداخلي</span><h1>بوابة فريق التنظيم</h1><p>تسجيل الدخول مخصص للأشخاص الذين أضافهم مدير النظام إلى فريق مراجعة الطلبات.</p></div><div className="staff-login-layout"><div className="panel staff-login-card"><div className="staff-login-mark">⌑</div><h2>تسجيل دخول الفريق</h2><p>استخدم بيانات الحساب المصرّح به من مدير النظام.</p><form onSubmit={handleLogin}><label className="field"><span>البريد الإلكتروني</span><div className="input-wrap"><span className="input-icon">✉</span><input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" placeholder="name@example.com" /></div></label><label className="field"><span>كلمة المرور</span><div className="input-wrap"><span className="input-icon">⌑</span><input required type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" placeholder="أدخل كلمة المرور" /></div></label><button className="primary-button" disabled={authChecking || !isConfigured}><span>{authChecking ? 'جارٍ التحقق…' : 'تسجيل الدخول'}</span><span className="button-arrow">←</span></button>{!isConfigured && <small className="muted-line">إعداد قاعدة البيانات مطلوب قبل تسجيل الدخول.</small>}</form></div><div className="staff-login-info"><span className="section-index">صلاحيات المراجعة</span><h2>كل الطلبات في مكان واحد.</h2><p>بعد تسجيل الدخول، يمكن للفريق الاطلاع على الطلبات وإيصالات الدفع، ثم الموافقة أو الرفض مع تدوين السبب، وتعديل رسوم التسجيل ومعلومات الدفع.</p><div className="staff-feature"><span>✓</span><div><strong>مراجعة الإيصالات</strong><small>فتح ملف PDF من مساحة تخزين خاصة</small></div></div><div className="staff-feature"><span>✓</span><div><strong>توثيق القرار</strong><small>تسجيل الموافقة أو سبب الرفض وتاريخ المراجعة</small></div></div><div className="staff-feature"><span>✓</span><div><strong>إعدادات التسجيل</strong><small>الرسوم، عدد المرافقين، وحساب الدفع</small></div></div></div></div></section>}

      {page === 'admin' && staffUser && <AdminDashboard staffUser={staffUser} settings={settings} setSettings={setSettings} refreshSettings={loadSettings} notify={notify} onSignOut={signOut} />}
    </main>

    <footer className="site-footer"><div className="container footer-inner"><div className="footer-brand"><div className="brand-mark small-mark"><span>ل</span><small>تخرج</small></div><div><strong>{settings.university_label || DEFAULT_SETTINGS.university_label}</strong><span>{settings.organizer || DEFAULT_SETTINGS.organizer}</span></div></div><p>منصة تنظيم التسجيل لحفلات التخرج · {new Date().getFullYear()}</p><span className="footer-status"><i className="dot" /> نظام التسجيل والمتابعة</span></div></footer>

    {toast && <div className={`toast toast-${toast.kind}`} role="status"><span>{toast.kind === 'error' ? '!' : toast.kind === 'success' ? '✓' : 'i'}</span>{toast.message}<button onClick={() => setToast(null)} aria-label="إغلاق">×</button></div>}
    {success && <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="تم إرسال طلب التسجيل"><div className="success-modal panel"><button className="modal-close" onClick={() => setSuccess(null)} aria-label="إغلاق">×</button><div className="success-check">✓</div><span className="section-index">تم استلام طلبك</span><h2>تم إرسال التسجيل بنجاح</h2><p>احتفظ بكود المتابعة التالي. ستحتاج إليه مع رقمك الجامعي لمعرفة قرار فريق التنظيم.</p><div className="tracking-code-card"><span>كود المتابعة الخاص بك</span><strong>{success.tracking_code}</strong><button onClick={() => { navigator.clipboard?.writeText(success.tracking_code); notify('تم نسخ كود المتابعة.', 'success'); }}>نسخ الكود ⧉</button></div><div className="success-total"><span>المبلغ المسجل في الطلب</span><strong>{fmt(success.amount_syp)} ل.س</strong></div><button className="primary-button" onClick={() => { setTrackingCode(success.tracking_code); setTrackingUni(success.university_number || ''); setSuccess(null); setPage('track'); }}><span>الانتقال إلى تتبع الطلب</span><span className="button-arrow">←</span></button><small>لا تغلق هذه النافذة قبل حفظ الكود أو نسخه.</small></div></div>}
  </div>;
}

function AdminDashboard({ staffUser, settings, setSettings, refreshSettings, notify, onSignOut }) {
  const [applications, setApplications] = useState([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(null);
  const [rejectReason, setRejectReason] = useState('');
  const [savingDecision, setSavingDecision] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [localSettings, setLocalSettings] = useState(settings);
  const [tab, setTab] = useState('applications');
  const [receiptLink, setReceiptLink] = useState('');

  useEffect(() => setLocalSettings(settings), [settings]);
  const loadApplications = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.from('applications').select('*').order('created_at', { ascending: false }).limit(500);
    if (error) notify('تعذر تحميل الطلبات: ' + error.message, 'error');
    setApplications(data || []); setLoading(false);
  }, [statusFilter, notify]);
  useEffect(() => { loadApplications(); }, [loadApplications]);
  useEffect(() => { if (selected) setSelected(applications.find((item) => item.id === selected.id) || selected); }, [applications]);

  const filtered = applications.filter((item) => {
    const term = search.trim().toLowerCase();
    const matchesStatus = statusFilter === 'all' || item.status === statusFilter;
    const matchesSearch = !term || [item.full_name, item.university_number, item.tracking_code, item.department, item.specialization].some((v) => String(v || '').toLowerCase().includes(term));
    return matchesStatus && matchesSearch;
  });
  const counts = { all: applications.length, pending: applications.filter((a) => a.status === 'pending').length, approved: applications.filter((a) => a.status === 'approved').length, rejected: applications.filter((a) => a.status === 'rejected').length };

  async function decide(status) {
    if (!selected) return;
    if (status === 'rejected' && rejectReason.trim().length < 3) return notify('اكتب سبب الرفض ليظهر للطالب عند تتبع الطلب.', 'error');
    setSavingDecision(true);
    const { error } = await supabase.from('applications').update({ status, rejection_reason: status === 'rejected' ? rejectReason.trim() : null, reviewed_by: staffUser.id, reviewed_at: new Date().toISOString() }).eq('id', selected.id);
    if (error) notify('تعذر حفظ القرار: ' + error.message, 'error');
    else { notify(status === 'approved' ? 'تمت الموافقة على الطلب.' : 'تم رفض الطلب وحفظ السبب.', 'success'); setRejectReason(''); await loadApplications(); }
    setSavingDecision(false);
  }

  async function openReceipt() {
    if (!selected?.receipt_path) return;
    const { data, error } = await supabase.storage.from('receipts').createSignedUrl(selected.receipt_path, 300);
    if (error) return notify('تعذر فتح الإيصال: ' + error.message, 'error');
    setReceiptLink(data.signedUrl);
    window.open(data.signedUrl, '_blank', 'noopener,noreferrer');
  }

  async function saveSettings(event) {
    event.preventDefault(); setSavingSettings(true);
    const dataToSave = {
      event_title: localSettings.event_title.trim(), university_label: localSettings.university_label.trim(), organizer: localSettings.organizer.trim(),
      registration_open: Boolean(localSettings.registration_open), student_fee: Number(localSettings.student_fee), companion_fee: Number(localSettings.companion_fee),
      max_companions: Number(localSettings.max_companions), shamcash_account: localSettings.shamcash_account.trim(), payment_instructions: localSettings.payment_instructions.trim(), qr_image_url: localSettings.qr_image_url || null,
      updated_at: new Date().toISOString(),
    };
    const { error } = await supabase.from('event_settings').update(dataToSave).eq('id', 1);
    if (error) notify('تعذر حفظ الإعدادات: ' + error.message, 'error');
    else { notify('تم حفظ إعدادات التسجيل.', 'success'); await refreshSettings(); }
    setSavingSettings(false);
  }

  async function uploadQr(file) {
    if (!file) return;
    if (!file.type.startsWith('image/')) return notify('اختر ملف صورة لرمز QR.', 'error');
    if (file.size > 3 * 1024 * 1024) return notify('حجم صورة QR يجب ألا يتجاوز 3 ميغابايت.', 'error');
    const ext = file.name.split('.').pop()?.toLowerCase() || 'png';
    const path = `qr-code-${Date.now()}.${ext}`;
    const { error } = await supabase.storage.from('event-assets').upload(path, file, { upsert: true, contentType: file.type });
    if (error) return notify('تعذر رفع صورة QR: ' + error.message, 'error');
    const { data } = supabase.storage.from('event-assets').getPublicUrl(path);
    setLocalSettings((old) => ({ ...old, qr_image_url: data.publicUrl }));
    notify('تم رفع الصورة. اضغط حفظ الإعدادات لنشرها.', 'success');
  }

  function exportCsv() {
    const cols = ['tracking_code', 'full_name', 'university_number', 'department', 'specialization', 'companions', 'amount_syp', 'status', 'rejection_reason', 'created_at'];
    const escape = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`;
    const csv = '\uFEFF' + [cols.join(','), ...filtered.map((row) => cols.map((col) => escape(row[col])).join(','))].join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'graduation-applications.csv'; anchor.click(); URL.revokeObjectURL(url);
  }

  return <section className="container admin-page">
    <div className="admin-welcome"><div><span className="section-index">لوحة إدارة التسجيل</span><h1>مرحباً بفريق التنظيم</h1><p>راجع الطلبات، تحقق من إيصالات الدفع، ووثّق قرارات الموافقة أو الرفض.</p></div><button className="secondary-button" onClick={onSignOut}>تسجيل الخروج ↗</button></div>
    <div className="admin-tabs"><button className={tab === 'applications' ? 'active' : ''} onClick={() => setTab('applications')}>الطلبات <span>{counts.pending}</span></button><button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>إعدادات التسجيل</button></div>
    {tab === 'applications' ? <>
      <div className="stats-grid"><div className="stat-card"><span>إجمالي الطلبات المعروضة</span><strong>{fmt(counts.all)}</strong><small>حتى آخر 500 طلب</small></div><div className="stat-card stat-pending"><span>قيد التدقيق</span><strong>{fmt(counts.pending)}</strong><small>تحتاج إلى مراجعة</small></div><div className="stat-card stat-approved"><span>تمت الموافقة</span><strong>{fmt(counts.approved)}</strong><small>طلبات معتمدة</small></div><div className="stat-card stat-rejected"><span>مرفوضة</span><strong>{fmt(counts.rejected)}</strong><small>مع تسجيل السبب</small></div></div>
      <div className="admin-workspace"><div className="panel applications-panel"><div className="applications-toolbar"><div><h2>طلبات التسجيل</h2><span>{filtered.length} نتيجة</span></div><button className="secondary-button export-button" onClick={exportCsv}>تصدير CSV ⇩</button></div><div className="filter-row"><div className="input-wrap search-wrap"><span className="input-icon">⌕</span><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="ابحث بالاسم أو الرقم الجامعي أو الكود" /></div><select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="تصفية حسب الحالة"><option value="all">كل الحالات</option><option value="pending">قيد التدقيق</option><option value="approved">تمت الموافقة</option><option value="rejected">مرفوض</option></select><button className="refresh-button" onClick={loadApplications} title="تحديث">↻</button></div>
        {loading ? <div className="empty-state">جارٍ تحميل الطلبات…</div> : filtered.length === 0 ? <div className="empty-state"><span>⌕</span><strong>لا توجد طلبات مطابقة</strong><p>ستظهر الطلبات هنا بعد إرسالها من نموذج التسجيل.</p></div> : <div className="table-scroll"><table className="applications-table"><thead><tr><th>الطالب / الكود</th><th>القسم والاختصاص</th><th>المبلغ</th><th>الحالة</th><th>التاريخ</th></tr></thead><tbody>{filtered.map((item) => <tr key={item.id} className={selected?.id === item.id ? 'selected-row' : ''} onClick={() => { setSelected(item); setRejectReason(item.rejection_reason || ''); setReceiptLink(''); }}><td><strong>{item.full_name}</strong><small>{item.tracking_code} · {item.university_number}</small></td><td><span>{item.department}</span><small>{item.specialization}</small></td><td><strong>{fmt(item.amount_syp)} ل.س</strong><small>{fmt(item.companions)} مرافق</small></td><td><span className={`status-badge ${STATUS[item.status]?.className || 'pending'}`}>{STATUS[item.status]?.label || item.status}</span></td><td>{humanDate(item.created_at)}</td></tr>)}</tbody></table></div>}
      </div>
      <div className="panel review-panel">{selected ? <><div className="review-top"><span className="section-index">تفاصيل الطلب</span><span className={`status-badge ${STATUS[selected.status]?.className || 'pending'}`}>{STATUS[selected.status]?.label || selected.status}</span></div><h2>{selected.full_name}</h2><div className="review-code">{selected.tracking_code}</div><div className="review-details"><div><span>الرقم الجامعي</span><strong>{selected.university_number}</strong></div><div><span>القسم</span><strong>{selected.department}</strong></div><div><span>الاختصاص</span><strong>{selected.specialization}</strong></div><div><span>عدد المرافقين</span><strong>{fmt(selected.companions)}</strong></div><div><span>المبلغ الإجمالي</span><strong>{fmt(selected.amount_syp)} ل.س</strong></div><div><span>تاريخ الطلب</span><strong>{humanDate(selected.created_at)}</strong></div></div><button className="receipt-open-button" onClick={openReceipt}>عرض إيصال الدفع PDF ↗</button>{selected.status === 'rejected' && selected.rejection_reason && <div className="prior-reason"><strong>سبب الرفض المسجل</strong><p>{selected.rejection_reason}</p></div>}<div className="decision-divider" /><label className="field"><span>سبب الرفض (مطلوب عند الرفض)</span><textarea rows="3" maxLength="1000" value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} placeholder="مثال: الإيصال لا يطابق المبلغ المطلوب، يرجى إعادة الدفع ورفع إيصال واضح…" /></label><div className="decision-actions"><button className="reject-button" disabled={savingDecision} onClick={() => decide('rejected')}>رفض الطلب</button><button className="approve-button" disabled={savingDecision} onClick={() => decide('approved')}>✓ موافقة على الطلب</button></div><small className="muted-line">سيتم تسجيل حساب الموظف وتاريخ اتخاذ القرار.</small></> : <div className="review-empty"><div>☷</div><strong>اختر طلباً لمراجعته</strong><p>اضغط على أي صف في قائمة الطلبات لعرض التفاصيل وإيصال الدفع.</p></div>}</div></div>
    </> : <div className="panel settings-panel"><div className="settings-header"><div><span className="section-index">تخصيص المنصة</span><h2>إعدادات التسجيل والدفع</h2><p>تطبق الرسوم ومعلومات الدفع الجديدة على الطلبات التالية، ولا تغيّر المبالغ المسجلة مسبقاً.</p></div><span className={`open-indicator ${localSettings.registration_open ? 'is-open' : ''}`}>{localSettings.registration_open ? 'التسجيل مفتوح' : 'التسجيل مغلق'}</span></div><form onSubmit={saveSettings}><div className="settings-grid"><label className="field"><span>عنوان الصفحة</span><input value={localSettings.event_title || ''} onChange={(e) => setLocalSettings((s) => ({ ...s, event_title: e.target.value }))} required /></label><label className="field"><span>اسم الجامعة</span><input value={localSettings.university_label || ''} onChange={(e) => setLocalSettings((s) => ({ ...s, university_label: e.target.value }))} required /></label><label className="field field-full"><span>الجهة المنظمة</span><input value={localSettings.organizer || ''} onChange={(e) => setLocalSettings((s) => ({ ...s, organizer: e.target.value }))} required /></label><label className="field"><span>رسوم الطالب (ل.س)</span><input type="number" min="0" step="1" value={localSettings.student_fee ?? 0} onChange={(e) => setLocalSettings((s) => ({ ...s, student_fee: e.target.value }))} required /></label><label className="field"><span>رسوم المرافق الواحد (ل.س)</span><input type="number" min="0" step="1" value={localSettings.companion_fee ?? 0} onChange={(e) => setLocalSettings((s) => ({ ...s, companion_fee: e.target.value }))} required /></label><label className="field"><span>الحد الأقصى للمرافقين</span><input type="number" min="0" max="20" step="1" value={localSettings.max_companions ?? 4} onChange={(e) => setLocalSettings((s) => ({ ...s, max_companions: e.target.value }))} required /></label><label className="field"><span>حساب شام كاش</span><input value={localSettings.shamcash_account || ''} onChange={(e) => setLocalSettings((s) => ({ ...s, shamcash_account: e.target.value }))} placeholder="أدخل الحساب أو المعرّف" /></label><label className="field field-full"><span>تعليمات الدفع للطلاب</span><textarea rows="3" value={localSettings.payment_instructions || ''} onChange={(e) => setLocalSettings((s) => ({ ...s, payment_instructions: e.target.value }))} /></label><div className="field field-full"><span>رمز QR للدفع</span><div className="qr-admin-upload">{localSettings.qr_image_url && <img src={localSettings.qr_image_url} alt="رمز الدفع الحالي" />}<label className="secondary-button upload-qr-button">رفع صورة QR<input type="file" accept="image/*" onChange={(e) => uploadQr(e.target.files?.[0])} /></label><small>صورة PNG أو JPG، حتى 3 ميغابايت. سيتم نشرها ضمن بيانات الدفع العامة.</small></div></div><label className="toggle-row field-full"><input type="checkbox" checked={Boolean(localSettings.registration_open)} onChange={(e) => setLocalSettings((s) => ({ ...s, registration_open: e.target.checked }))} /><span className="toggle-look" /><span><strong>فتح التسجيل للطلاب</strong><small>عند إلغاء التحديد، يتوقف استقبال الطلبات الجديدة.</small></span></label></div><div className="settings-save-row"><button className="primary-button" disabled={savingSettings}><span>{savingSettings ? 'جارٍ الحفظ…' : 'حفظ الإعدادات'}</span><span className="button-arrow">←</span></button><button type="button" className="secondary-button" onClick={() => setLocalSettings(settings)}>إلغاء التعديلات</button></div></form></div>}
    <div className="admin-footnote">مسجل الدخول: <strong>{staffUser.email}</strong> <span>•</span> لا تشارك بيانات دخول الفريق مع الطلاب.</div>
  </section>;
}

export default App;
