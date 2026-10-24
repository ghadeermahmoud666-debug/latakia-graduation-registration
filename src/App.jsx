import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import JSZip from 'jszip';
import { BrowserMultiFormatReader } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';
import JsBarcode from 'jsbarcode';
import { anonKeyValue, configurationProblem, functionUrl, isConfigured, supabase } from './lib/supabase';
import { createReceiptArchivePdf, downloadBlob as downloadArchiveBlob, safeArchiveFilename, saveArchiveToDirectory, sha256Blob } from './lib/localArchive';
import { downloadTicketsAsOnePdf, downloadTicketsSeparatelyZip } from './lib/ticketDownloads';
import FinancialLedgerPanel from './components/FinancialLedgerPanel.jsx';

const DEFAULT_SETTINGS = {
  id: 1,
  event_title: 'التسجيل لحفلات التخرج',
  batch_name: 'دفعة البناء والتأسيس 2026',
  university_label: 'جامعة اللاذقية',
  event_location: '',
  event_date: '',
  organizer: 'اتحاد طلبة سوريا – فرع محافظة اللاذقية',
  registration_open: false,
  student_fee: 0,
  companion_fee: 0,
  max_companions: 4,
  max_carried_subjects: 5,
  shamcash_account: '',
  payment_instructions: 'تأكد من اسم المستفيد والمبلغ قبل تأكيد التحويل، واحتفظ بفاتورة التحويل الأصلية بصيغة PDF.',
  qr_image_url: '',
  payment_images: [],
};

const STATUS = {
  awaiting_payment: { label: 'بانتظار الدفع والفاتورة', className: 'pending', icon: '◷' },
  pending: { label: 'الفاتورة قيد التدقيق', className: 'pending', icon: '◷' },
  approved: { label: 'تمت الموافقة', className: 'approved', icon: '✓' },
  rejected: { label: 'مرفوض', className: 'rejected', icon: '!' },
};

const fmt = (value) => new Intl.NumberFormat('ar-SY').format(Number(value || 0));
const humanDate = (value) => value ? new Date(value).toLocaleString('ar-SY', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
const safeSessionGet = () => {
  try {
    const value = sessionStorage.getItem('latakia_payment_application');
    return value ? JSON.parse(value) : null;
  } catch { return null; }
};

function App() {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [catalog, setCatalog] = useState({ units: [], specializations: [] });
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const [catalogError, setCatalogError] = useState('');
  const ticketTokenFromUrl = new URLSearchParams(window.location.search).get('ticket') || '';
  const teamRouteRequested = new URLSearchParams(window.location.search).get('team') === '1';
  const gateRouteRequested = new URLSearchParams(window.location.search).get('gate') === '1';
  const [page, setPage] = useState(() => ticketTokenFromUrl ? 'verify' : (teamRouteRequested || gateRouteRequested) ? 'staff' : 'register');
  const [registrationStage, setRegistrationStage] = useState(() => safeSessionGet() ? 'code' : 'details');
  const [toast, setToast] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [receiptSubmitting, setReceiptSubmitting] = useState(false);
  const [paymentApplication, setPaymentApplication] = useState(() => safeSessionGet());
  const [codeCopied, setCodeCopied] = useState(false);
  const [form, setForm] = useState({ full_name: '', university_number: '', phone_number: '', carried_subjects: '0', academic_unit_id: '', academic_specialization_id: '', companions: '0' });
  const [paymentReceipt, setPaymentReceipt] = useState(null);
  const [trackingCode, setTrackingCode] = useState('');
  const [trackingBusy, setTrackingBusy] = useState(false);
  const [trackingResult, setTrackingResult] = useState(null);
  const [trackReceipt, setTrackReceipt] = useState(null);
  const [trackReceiptBusy, setTrackReceiptBusy] = useState(false);
  const [ticketVerification, setTicketVerification] = useState(null);
  const [ticketVerifyBusy, setTicketVerifyBusy] = useState(false);
  const [ticketVerifyError, setTicketVerifyError] = useState('');
  const [staffUser, setStaffUser] = useState(null);
  const [staffRole, setStaffRole] = useState(null);
  const [authChecking, setAuthChecking] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [newStaffPassword, setNewStaffPassword] = useState('');
  const [confirmStaffPassword, setConfirmStaffPassword] = useState('');

  const notify = useCallback((message, kind = 'info') => {
    setToast({ message, kind });
    window.setTimeout(() => setToast(null), 4500);
  }, []);

  const loadSettings = useCallback(async () => {
    if (!isConfigured) { setSettingsLoaded(true); return; }
    const { data, error } = await supabase.from('event_settings').select('*').eq('id', 1).maybeSingle();
    if (data) setSettings({ ...DEFAULT_SETTINGS, ...data, payment_images: Array.isArray(data.payment_images) ? data.payment_images : [] });
    if (error) console.error('settings:', error.message);
    setSettingsLoaded(true);
  }, []);

  const loadCatalog = useCallback(async () => {
    if (!isConfigured) { setCatalogLoaded(true); return; }
    const [unitsResult, specsResult] = await Promise.all([
      supabase.from('academic_units').select('id,name,unit_type,is_open,registration_capacity,registered_count,capacity_reached,created_at').order('name'),
      supabase.from('academic_specializations').select('id,unit_id,name,is_open,created_at').order('name'),
    ]);
    if (unitsResult.error || specsResult.error) {
      const error = unitsResult.error || specsResult.error;
      setCatalogError(error.message || 'تعذر تحميل قوائم الكليات والاختصاصات.');
      console.error('catalog:', error.message);
    } else {
      setCatalog({ units: unitsResult.data || [], specializations: specsResult.data || [] });
      setCatalogError('');
    }
    setCatalogLoaded(true);
  }, []);

  useEffect(() => { loadSettings(); loadCatalog(); }, [loadSettings, loadCatalog]);

  useEffect(() => {
    if (page !== 'verify') return undefined;
    if (!ticketTokenFromUrl) { setTicketVerifyError('لم يتم العثور على رمز البطاقة في الرابط.'); return undefined; }
    if (!isConfigured) { setTicketVerifyError('خدمة التحقق غير متصلة حالياً.'); return undefined; }
    let alive = true;
    setTicketVerifyBusy(true);
    setTicketVerifyError('');
    fetch(functionUrl('verify-ticket'), {
      method: 'POST',
      headers: { apikey: anonKeyValue, Authorization: `Bearer ${anonKeyValue}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket_token: ticketTokenFromUrl }),
    }).then(async (response) => {
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.valid) throw new Error(result.error || 'هذه البطاقة غير صالحة.');
      if (alive) setTicketVerification(result);
    }).catch((error) => {
      if (alive) setTicketVerifyError(error.message || 'تعذّر التحقق من البطاقة.');
    }).finally(() => { if (alive) setTicketVerifyBusy(false); });
    return () => { alive = false; };
  }, [page, ticketTokenFromUrl]);

  const loadStaffRole = useCallback(async (userId) => {
    if (!isConfigured || !userId) { setStaffRole(null); return; }
    const { data } = await supabase.from('staff_roles').select('role').eq('user_id', userId).maybeSingle();
    setStaffRole(data?.role || null);
  }, []);

  useEffect(() => {
    if (!isConfigured) return undefined;
    let alive = true;
    supabase.auth.getSession().then(async ({ data }) => {
      if (!alive || !data.session?.user) return;
      setStaffUser(data.session.user);
      const { data: role } = await supabase.from('staff_roles').select('role').eq('user_id', data.session.user.id).maybeSingle();
      if (alive) setStaffRole(role?.role || null);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setStaffUser(session?.user ?? null);
      if (!session?.user) {
        setStaffRole(null);
        setPage((current) => (['admin', 'staff-password', 'finance', 'gate'].includes(current)) ? 'staff' : current);
      } else {
        window.setTimeout(() => loadStaffRole(session.user.id), 0);
      }
    });
    return () => { alive = false; listener.subscription.unsubscribe(); };
  }, [loadStaffRole]);

  const setField = (key, value) => setForm((old) => ({ ...old, [key]: value }));
  const companions = Math.max(0, Number.parseInt(form.companions || '0', 10) || 0);
  const carriedSubjects = Math.max(0, Number.parseInt(form.carried_subjects || '0', 10) || 0);
  const total = Number(settings.student_fee || 0) + companions * Number(settings.companion_fee || 0);
  const registrationUnavailable = !settings.registration_open;
  const allSpecsForUnit = catalog.specializations.filter((item) => item.unit_id === form.academic_unit_id);
  const openSpecsForUnit = allSpecsForUnit.filter((item) => item.is_open);
  const selectedUnit = catalog.units.find((unit) => unit.id === form.academic_unit_id) || null;
  const openUnits = catalog.units.filter((unit) => unit.is_open && (() => {
    const specs = catalog.specializations.filter((item) => item.unit_id === unit.id);
    return specs.length === 0 || specs.some((item) => item.is_open);
  })());
  const selectedUnitRequiresSpecialization = allSpecsForUnit.length > 0;
  const amountSummary = useMemo(() => ({ student: Number(settings.student_fee || 0), companion: Number(settings.companion_fee || 0), total }), [settings, total]);

  async function copyTrackingCode() {
    if (!paymentApplication?.tracking_code) return;
    try {
      await navigator.clipboard.writeText(paymentApplication.tracking_code);
      setCodeCopied(true);
      notify('تم نسخ رمز التتبع. احتفظ به واكتبه في ملاحظات التحويل.', 'success');
    } catch {
      notify('تعذر النسخ التلقائي. اضغط مطولاً على الرمز لنسخه، ثم فعّل مربع التأكيد.', 'info');
    }
  }

  async function handleCreateRegistration(event) {
    event.preventDefault();
    if (!isConfigured) return notify('الاتصال بقاعدة البيانات غير مكتمل. راجع متغيرات Supabase في إعدادات النشر.', 'error');
    if (!settings.registration_open) return notify('التسجيل العام مغلق حالياً.', 'error');
    if (!form.full_name.trim().split(/\s+/).length || form.full_name.trim().split(/\s+/).length < 3) return notify('يرجى إدخال الاسم الثلاثي كاملاً.', 'error');
    if (!form.academic_unit_id) return notify('اختر الكلية أو المعهد من القائمة.', 'error');
    if (selectedUnitRequiresSpecialization && !form.academic_specialization_id) return notify('اختر الاختصاص من القائمة.', 'error');
    if (carriedSubjects > Number(settings.max_carried_subjects)) return notify(`الحد الأقصى للمواد المحمولة هو ${settings.max_carried_subjects}.`, 'error');
    if (companions > Number(settings.max_companions)) return notify(`الحد الأقصى للمرافقين هو ${settings.max_companions}.`, 'error');
    setSubmitting(true);
    try {
      const payload = {
        full_name: form.full_name.trim().replace(/\s+/g, ' '),
        university_number: form.university_number.trim(),
        phone_number: form.phone_number.trim(),
        carried_subjects: carriedSubjects,
        academic_unit_id: form.academic_unit_id,
        academic_specialization_id: form.academic_specialization_id || null,
        companions,
      };
      const response = await fetch(functionUrl('submit-application'), {
        method: 'POST',
        headers: { apikey: anonKeyValue, Authorization: `Bearer ${anonKeyValue}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'تعذر إنشاء الطلب. حاول مجدداً.');
      const created = { tracking_code: result.tracking_code, amount_syp: result.amount_syp, university_number: payload.university_number, status: result.status };
      setPaymentApplication(created);
      try { sessionStorage.setItem('latakia_payment_application', JSON.stringify(created)); } catch { /* browser storage can be disabled */ }
      setCodeCopied(false);
      setPaymentReceipt(null);
      setRegistrationStage('code');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      notify('تم حفظ بياناتك وحساب الرسوم. انسخ رمز التتبع قبل الدفع.', 'success');
    } catch (error) {
      notify(error.message || 'حدث خطأ أثناء إنشاء الطلب.', 'error');
    } finally { setSubmitting(false); }
  }

  async function uploadReceiptForApplication(application, file) {
    if (!application?.tracking_code) throw new Error('رمز التتبع غير موجود. أعد إدخاله وحاول مجدداً.');
    if (!file) throw new Error('اختر فاتورة التحويل بصيغة PDF.');
    if (file.type !== 'application/pdf' || !file.name.toLowerCase().endsWith('.pdf')) throw new Error('الفاتورة يجب أن تكون بصيغة PDF فقط.');
    if (file.size <= 0 || file.size > 5 * 1024 * 1024) throw new Error('حجم الفاتورة يجب ألا يتجاوز 5 ميغابايت.');
    const payload = new FormData();
    payload.append('tracking_code', application.tracking_code.trim().toUpperCase());
    payload.append('receipt', file);
    const response = await fetch(functionUrl('upload-payment-receipt'), {
      method: 'POST',
      headers: { apikey: anonKeyValue, Authorization: `Bearer ${anonKeyValue}` },
      body: payload,
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'تعذر رفع الفاتورة. حاول مجدداً.');
    return result;
  }

  async function handleReceiptUpload(event) {
    event.preventDefault();
    if (!paymentApplication) return notify('لم يتم العثور على طلب بانتظار الدفع.', 'error');
    if (!codeCopied) return notify('انسخ رمز التتبع أولاً ثم تابع رفع الفاتورة.', 'error');
    setReceiptSubmitting(true);
    try {
      await uploadReceiptForApplication(paymentApplication, paymentReceipt);
      const finished = { ...paymentApplication, status: 'pending' };
      setPaymentApplication(finished);
      setRegistrationStage('done');
      try { sessionStorage.removeItem('latakia_payment_application'); } catch { /* ignore */ }
      setPaymentReceipt(null);
      notify('تم استلام الفاتورة بنجاح، والطلب الآن قيد التدقيق.', 'success');
    } catch (error) { notify(error.message || 'تعذر رفع الفاتورة.', 'error'); }
    finally { setReceiptSubmitting(false); }
  }

  async function handleTrack(event) {
    event.preventDefault();
    if (!isConfigured) return notify('تتبع الطلب متاح بعد إعداد Supabase ونشر الوظائف الخلفية.', 'error');
    setTrackingBusy(true); setTrackingResult(null); setTrackReceipt(null);
    try {
      const response = await fetch(functionUrl('track-application'), {
        method: 'POST',
        headers: { apikey: anonKeyValue, Authorization: `Bearer ${anonKeyValue}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ tracking_code: trackingCode.trim().toUpperCase() }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'لم يتم العثور على طلب مطابق. تحقق من البيانات.');
      setTrackingResult(result.application);
    } catch (error) { notify(error.message || 'تعذر تتبع الطلب.', 'error'); }
    finally { setTrackingBusy(false); }
  }

  async function handleTrackReceiptUpload(event) {
    event.preventDefault();
    if (!trackingResult) return;
    setTrackReceiptBusy(true);
    try {
      await uploadReceiptForApplication({ tracking_code: trackingResult.tracking_code }, trackReceipt);
      setTrackingResult((old) => ({ ...old, status: 'pending', has_receipt: true }));
      setTrackReceipt(null);
      notify('تم رفع الفاتورة. أصبح الطلب قيد التدقيق.', 'success');
    } catch (error) { notify(error.message || 'تعذر رفع الفاتورة.', 'error'); }
    finally { setTrackReceiptBusy(false); }
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
      setStaffUser(data.user); setStaffRole(role.role);
      const requestedGate = new URLSearchParams(window.location.search).get('gate') === '1';
      const landingPage = role.role === 'finance' ? 'finance' : role.role === 'gate' ? 'gate' : requestedGate && role.role === 'admin' ? 'gate' : 'admin';
      window.history.replaceState({}, '', `${window.location.pathname}?${landingPage === 'gate' ? 'gate=1' : 'team=1'}`);
      if (data.user.app_metadata?.must_change_password) {
        setPage('staff-password');
        notify('لأمان الحساب، غيّر كلمة المرور المؤقتة قبل متابعة العمل.', 'info');
      } else {
        setPage(landingPage);
        notify(landingPage === 'gate' ? 'تم الدخول إلى بوابة التحقق.' : landingPage === 'finance' ? 'مرحباً بك في لوحة الجرد المالي.' : 'مرحباً بك في لوحة الفريق.', 'success');
      }
    } catch (error) { notify(error.message || 'تعذر تسجيل الدخول.', 'error'); }
    finally { setAuthChecking(false); }
  }

  async function handleForcedPasswordChange(event) {
    event.preventDefault();
    if (newStaffPassword.length < 12) return notify('اختر كلمة مرور من 12 محرفاً على الأقل.', 'error');
    if (newStaffPassword !== confirmStaffPassword) return notify('تأكيد كلمة المرور غير مطابق.', 'error');
    setAuthChecking(true);
    try {
      const { data, error } = await supabase.auth.updateUser({ password: newStaffPassword });
      if (error) throw error;
      const { data: completion, error: completionError } = await supabase.functions.invoke('manage-staff', { body: { action: 'complete_password_change' } });
      if (completionError || completion?.error) throw new Error(completion?.error || completionError?.message || 'تم تغيير كلمة المرور، لكن تعذر تسجيل اكتمال خطوة الأمان. اضغط حفظ مجددًا للمحاولة.');
      if (data.user) setStaffUser(data.user);
      setNewStaffPassword(''); setConfirmStaffPassword(''); setPage(staffRole === 'finance' ? 'finance' : staffRole === 'gate' ? 'gate' : new URLSearchParams(window.location.search).get('gate') === '1' ? 'gate' : 'admin');
      notify('تم تغيير كلمة المرور. أهلاً بك في لوحة الفريق.', 'success');
    } catch (error) { notify(error.message || 'تعذر تغيير كلمة المرور.', 'error'); }
    finally { setAuthChecking(false); }
  }

  async function signOut() {
    await supabase.auth.signOut();
    setStaffUser(null); setStaffRole(null); setPage('staff'); window.history.replaceState({}, '', `${window.location.pathname}?team=1`);
  }

  const paymentImages = Array.isArray(settings.payment_images) ? settings.payment_images : [];

  // Team access is intentionally absent from public navigation. Authentication and RLS remain the actual security boundary.
  useEffect(() => {
    if (!staffUser) return undefined;
    let timeoutId;
    const logoutAfterInactivity = () => {
      window.clearTimeout(timeoutId);
      timeoutId = window.setTimeout(async () => {
        await supabase.auth.signOut();
        setStaffUser(null); setStaffRole(null); setPage('staff');
        window.history.replaceState({}, '', `${window.location.pathname}?team=1`);
        notify('تم تسجيل الخروج تلقائياً بسبب عدم النشاط.', 'info');
      }, 20 * 60 * 1000);
    };
    const events = ['pointerdown', 'keydown', 'touchstart', 'click'];
    events.forEach((eventName) => window.addEventListener(eventName, logoutAfterInactivity, { passive: true }));
    logoutAfterInactivity();
    return () => { window.clearTimeout(timeoutId); events.forEach((eventName) => window.removeEventListener(eventName, logoutAfterInactivity)); };
  }, [staffUser, notify]);

  return <div className="app-shell">
    <div className="topline"><div className="container topline-inner"><span><i className="dot" /> اتحاد طلبة سوريا</span><span>{settings.batch_name || DEFAULT_SETTINGS.batch_name}</span></div></div>
    <header className="site-header">
      <div className="container header-inner">
        <button className="brand" onClick={() => { setPage('register'); setRegistrationStage(paymentApplication ? registrationStage : 'details'); }} aria-label="العودة إلى الرئيسية">
          <img className="brand-logo" src="/brand/ssu-emblem.png" alt="شعار اتحاد طلبة سوريا" />
          <div className="brand-copy"><strong>{settings.organizer || DEFAULT_SETTINGS.organizer}</strong><span>{settings.university_label || DEFAULT_SETTINGS.university_label}</span></div>
        </button>
        <nav className="main-nav" aria-label="التنقل الرئيسي">
          <button className={page === 'register' ? 'active' : ''} onClick={() => setPage('register')}>التسجيل</button>
          <button className={page === 'track' ? 'active' : ''} onClick={() => { setPage('track'); setTrackingResult(null); }}>تتبع الطلب</button>
        </nav>
      </div>
    </header>

    <main>
      {page === 'register' && <>
        <section className="hero">
          <div className="hero-pattern" />
          <div className="container hero-content">
            <div className="hero-copy">
              <div className="eyebrow"><span className="eyebrow-star">✦</span> لحظة تستحق أن تُخلّد</div>
              <h1>{settings.event_title || 'التسجيل لحفلات التخرج'}<br /><em>{settings.batch_name || DEFAULT_SETTINGS.batch_name}</em></h1>
              <p>اتبع الخطوات بالترتيب، وانسخ رمز التتبع قبل الدفع. لن تُقبل أي فاتورة لا تتضمن رمز التتبع في ملاحظات تحويل شام كاش.</p>
              <div className="hero-points"><span><b>01</b> بيانات الطالب</span><span><b>02</b> رمز التتبع</span><span><b>03</b> الدفع والفاتورة</span></div>
            </div>
            <div className="hero-art graduation-hero-art" aria-label="قبعة التخرج ودفعة 2026">
              <div className="orbit" /><div className="orbit orbit-two" />
              <span className="art-star star-a">✦</span><span className="art-star star-b">✦</span><span className="art-star star-c">✧</span>
              <div className="cap-icon"><div className="cap-top" /><div className="cap-base" /><div className="cap-tassel" /></div>
              <div className="art-caption"><span>GRADUATION CLASS</span><strong>2026</strong><small>دفعة التخرج</small></div>
            </div>
          </div>
          <div className="hero-bottom-line"><div className="container"><span>اتحاد طلبة سوريا · فرع محافظة اللاذقية</span><span className="line-decoration" /></div></div>
        </section>

        {registrationStage === 'details' && <section className="container content-grid" id="registration">
          <div className="form-column">
            <div className="section-heading"><div><span className="section-index">01 / التسجيل</span><h2>بيانات الطالب</h2><p>أدخل معلوماتك بالتسلسل كما تظهر في سجلك الجامعي.</p></div><div className="heading-icon">▤</div></div>
            {!isConfigured && <div className="notice notice-warning"><span className="notice-icon">ⓘ</span><div><strong>الموقع في وضع الإعداد</strong><p>{configurationProblem === 'invalid-url' ? 'عنوان Supabase في إعدادات النشر غير صحيح.' : 'الاتصال بقاعدة البيانات مطلوب لحفظ الطلبات. راجع متغيرات Supabase في إعدادات Cloudflare.'}</p></div></div>}
            {!catalogLoaded && <div className="notice notice-info">جارٍ تحميل قوائم الكليات والمعاهد…</div>}
            {catalogError && <div className="notice notice-warning"><strong>تعذر تحميل قائمة الكليات والمعاهد</strong><p>يجب تطبيق ترقية قاعدة البيانات 002 من SQL Editor في Supabase. تفاصيل النظام: {catalogError}</p></div>}
            {registrationUnavailable && <div className="notice notice-info"><span className="notice-icon">◷</span><div><strong>التسجيل غير مفتوح حالياً</strong><p>يفتح المدير التسجيل العام ثم يفتح الكليات والمعاهد والاختصاصات المطلوبة.</p></div></div>}
            {settings.registration_open && openUnits.length === 0 && !catalogError && <div className="notice notice-warning"><strong>لا توجد كلية أو معهد مفتوح للتسجيل</strong><p>يرجى مراجعة قوائم الكليات والمعاهد أو انتظار فتح التسجيل من الإدارة.</p></div>}
            <form className="panel registration-form" onSubmit={handleCreateRegistration}>
              <div className="form-panel-title"><span className="step-circle">1</span><div><strong>المعلومات الشخصية</strong><small>ابدأ ببيانات التواصل الأساسية</small></div></div>
              <div className="field-grid">
                <label className="field field-full"><span>الاسم الثلاثي <b>*</b></span><div className="input-wrap"><input required minLength="5" maxLength="120" value={form.full_name} onChange={(e) => setField('full_name', e.target.value)} placeholder="مثال: أحمد محمد علي" autoComplete="name" disabled={registrationUnavailable} /></div></label>
                <label className="field"><span>الرقم الجامعي <b>*</b></span><div className="input-wrap"><input required maxLength="32" value={form.university_number} onChange={(e) => setField('university_number', e.target.value)} placeholder="أدخل رقمك الجامعي" disabled={registrationUnavailable} /></div></label>
                <label className="field"><span>رقم الهاتف للتواصل <b>*</b></span><div className="input-wrap"><input required type="tel" maxLength="20" value={form.phone_number} onChange={(e) => setField('phone_number', e.target.value)} placeholder="09xxxxxxxx" autoComplete="tel" disabled={registrationUnavailable} /></div></label>
              </div>
              <div className="form-divider" />
              <div className="form-panel-title"><span className="step-circle">2</span><div><strong>المواد المحمولة والجهة الدراسية</strong><small>القوائم يحددها فريق التنظيم</small></div></div>
              <div className="field-grid">
                <label className="field field-full"><span>عدد المواد المحمولة <b>*</b></span><div className="input-wrap"><input required type="number" inputMode="numeric" min="0" max={settings.max_carried_subjects} step="1" value={form.carried_subjects} onChange={(e) => setField('carried_subjects', e.target.value)} disabled={registrationUnavailable} /></div><small className="field-help">الحد الأقصى المسموح: {fmt(settings.max_carried_subjects)} مادة.</small></label>
                <label className="field field-full"><span>الكلية أو المعهد <b>*</b></span><select required value={form.academic_unit_id} onChange={(e) => setForm((old) => ({ ...old, academic_unit_id: e.target.value, academic_specialization_id: '' }))} disabled={registrationUnavailable || openUnits.length === 0}><option value="">اختر الكلية أو المعهد</option>{openUnits.map((unit) => <option value={unit.id} key={unit.id}>{unit.unit_type === 'institute' ? 'معهد' : 'كلية'} — {unit.name}</option>)}</select></label>
                {selectedUnit && selectedUnitRequiresSpecialization && <label className="field field-full"><span>الاختصاص <b>*</b></span><select required value={form.academic_specialization_id} onChange={(e) => setField('academic_specialization_id', e.target.value)} disabled={registrationUnavailable || openSpecsForUnit.length === 0}><option value="">اختر الاختصاص</option>{openSpecsForUnit.map((spec) => <option key={spec.id} value={spec.id}>{spec.name}</option>)}</select><small className="field-help">تظهر الاختصاصات المفتوحة للتسجيل فقط.</small></label>}
                {selectedUnit && !selectedUnitRequiresSpecialization && <div className="field field-full no-specialization-note">لا توجد اختصاصات مضافة لهذه الجهة الدراسية؛ يمكنك المتابعة دون اختيار اختصاص.</div>}
              </div>
              <div className="form-divider" />
              <div className="form-panel-title"><span className="step-circle">3</span><div><strong>عدد المرافقين وحساب الرسوم</strong><small>يظهر المبلغ النهائي قبل إنشاء رمز التتبع</small></div></div>
              <div className="companion-row"><div><strong>عدد المرافقين</strong><small>الحد الأقصى: {fmt(settings.max_companions)} مرافق</small></div><div className="counter"><button type="button" onClick={() => setField('companions', String(Math.max(0, companions - 1)))} disabled={registrationUnavailable || companions <= 0} aria-label="إنقاص عدد المرافقين">−</button><output>{fmt(companions)}</output><button type="button" onClick={() => setField('companions', String(Math.min(Number(settings.max_companions), companions + 1)))} disabled={registrationUnavailable || companions >= Number(settings.max_companions)} aria-label="زيادة عدد المرافقين">+</button></div></div>
              <div className="price-summary"><div><span>رسوم الطالب</span><strong>{fmt(amountSummary.student)} <small>ل.س</small></strong></div><div><span>رسوم المرافق الواحد</span><strong>{fmt(amountSummary.companion)} <small>ل.س</small></strong></div><div className="price-total"><span>المبلغ الإجمالي المطلوب</span><strong>{fmt(amountSummary.total)} <small>ل.س</small></strong></div></div>
              <div className="important-warning"><strong>تنبيه قبل المتابعة</strong><p>بعد تأكيد البيانات سيُنشأ رمز تتبع خاص بك. يجب نسخه وكتابته في خانة الملاحظات في شام كاش؛ الفواتير التي لا تحتوي على الرمز لن تُقبل.</p></div>
              <label className="consent-check"><input type="checkbox" required disabled={registrationUnavailable} /><span>أؤكد صحة بياناتي وأوافق على استخدامها لتنظيم حفل التخرج ومراجعة الطلب.</span></label>
              <button className="primary-button submit-button" type="submit" disabled={submitting || registrationUnavailable || !isConfigured || !selectedUnit}><span>{submitting ? 'جارٍ حفظ بياناتك وإنشاء رمز التتبع…' : 'تأكيد البيانات وحساب التكلفة وإنشاء رمز التتبع'}</span><span className="button-arrow">←</span></button>
              <p className="form-footnote"><span>♢</span> لن تنتقل إلى الدفع قبل ظهور رمز التتبع وإتاحة نسخه.</p>
            </form>
          </div>
          <aside className="side-column">
            <div className="section-heading side-heading"><div><span className="section-index">خطوات التسجيل</span><h2>رتّب خطواتك</h2><p>اتبع التسلسل حتى لا يضيع رمز التتبع أو تنقص معلومات الفاتورة.</p></div></div>
            <div className="panel payment-panel guide-steps"><div className="payment-step"><span className="payment-step-number">01</span><div><strong>أدخل البيانات واحسب الرسوم</strong><p>تحقق من الرقم الجامعي والهاتف والكلية وعدد المرافقين.</p></div></div><div className="payment-step"><span className="payment-step-number">02</span><div><strong>انسخ رمز التتبع أولاً</strong><p>سيظهر مباشرة بعد حفظ بياناتك. لا تبدأ التحويل قبل نسخه.</p></div></div><div className="payment-step"><span className="payment-step-number">03</span><div><strong>ادفع وارفع PDF</strong><p>اكتب رمز التتبع في ملاحظات شام كاش ثم ارفع الفاتورة.</p></div></div><div className="secure-note"><span>!</span><p><strong>أي فاتورة دون رمز التتبع في خانة الملاحظات لن تُقبل.</strong></p></div></div>
          </aside>
        </section>}

        {registrationStage !== 'details' && paymentApplication && <section className="container registration-flow">
          <div className="flow-progress"><div className={registrationStage === 'code' ? 'current' : 'complete'}><span>1</span><small>نسخ رمز التتبع</small></div><i /><div className={registrationStage === 'payment' ? 'current' : registrationStage === 'done' ? 'complete' : ''}><span>2</span><small>الدفع ورفع الفاتورة</small></div><i /><div className={registrationStage === 'done' ? 'complete current' : ''}><span>3</span><small>تأكيد الإرسال</small></div></div>
          {registrationStage === 'code' && <div className="panel code-stage-card"><span className="section-index">خطوة ضرورية قبل الدفع</span><h2>تم حساب الرسوم وإنشاء رمز التتبع</h2><p>انسخ الرمز الآن واحفظه. ستحتاج إلى كتابته في خانة الملاحظات داخل شام كاش، ولا تُقبل أي فاتورة لا تتضمن هذا الرمز بوضوح.</p><div className="tracking-code-card"><span>رمز التتبع الخاص بك</span><strong dir="ltr">{paymentApplication.tracking_code}</strong><button type="button" onClick={copyTrackingCode}>نسخ رمز التتبع ⧉</button></div><div className="success-total"><span>المبلغ المطلوب تحويله</span><strong>{fmt(paymentApplication.amount_syp)} ل.س</strong></div><label className="consent-check copy-confirm"><input type="checkbox" checked={codeCopied} onChange={(e) => setCodeCopied(e.target.checked)} /><span>نسخت رمز التتبع أو حفظته في مكان آمن، وسأكتبه كما هو في ملاحظات التحويل.</span></label><div className="important-warning"><strong>مهم جداً</strong><p>لا تدفع قبل حفظ الرمز. الطلب أو الفاتورة التي لا تحتوي على رمز التتبع في الملاحظات لن تُقبل.</p></div><button className="primary-button" type="button" disabled={!codeCopied} onClick={() => { setRegistrationStage('payment'); window.scrollTo({ top: 0, behavior: 'smooth' }); }}><span>انتقلت للخطوة التالية: الدفع</span><span className="button-arrow">←</span></button></div>}

          {registrationStage === 'payment' && <div className="payment-stage-grid"><div className="panel payment-instructions-card"><span className="section-index">الخطوة الثانية / الدفع</span><h2>حوّل المبلغ باستخدام شام كاش</h2><div className="tracking-code-card compact-code"><span>رمز التتبع — انسخه إلى ملاحظات التحويل</span><strong dir="ltr">{paymentApplication.tracking_code}</strong><button type="button" onClick={copyTrackingCode}>نسخ الرمز مرة أخرى ⧉</button></div><div className="amount-due-card"><span>المبلغ المطلوب كما حُسب في الخطوة السابقة</span><strong>{fmt(paymentApplication.amount_syp)} <small>ل.س</small></strong></div><ol className="payment-instruction-list"><li><strong>افتح حساب شام كاش</strong><p>افتح التطبيق واختر التحويل أو الدفع.</p></li><li><strong>امسح رمز QR أو أدخل رقم الحساب</strong><p>تأكد من أن معلومات المستفيد مطابقة للمعلومات المعروضة هنا.</p></li><li><strong>أدخل المبلغ المستحق</strong><p>حوّل المبلغ نفسه الظاهر في البطاقة السابقة دون زيادة أو نقصان.</p></li><li><strong>اكتب رمز التتبع في خانة الملاحظات</strong><p>اكتب الرمز كاملاً كما يظهر في الموقع. <b>الفواتير التي لا تحتوي على رمز التتبع لن تُقبل.</b></p></li><li><strong>نفّذ التحويل ثم صدّر الفاتورة PDF</strong><p>نزّل فاتورة التحويل من شام كاش بصيغة PDF قبل رفعها في النموذج التالي.</p></li></ol>
            {settings.payment_instructions && <div className="additional-payment-note"><strong>ملاحظات إضافية من الإدارة</strong><p>{settings.payment_instructions}</p></div>}
            <div className="payment-account-area">{settings.qr_image_url ? <div className="qr-container"><img src={settings.qr_image_url} alt="رمز QR للدفع عبر شام كاش" /><span>امسح هذا الرمز من داخل شام كاش</span></div> : <div className="qr-placeholder"><div className="qr-mini">▦</div><span>لم يضف المدير رمز QR بعد</span></div>}<div className="account-box"><span>رقم حساب شام كاش</span><strong>{settings.shamcash_account || 'لم يضف المدير رقم الحساب بعد'}</strong>{settings.shamcash_account && <button type="button" onClick={async () => { try { await navigator.clipboard.writeText(settings.shamcash_account); notify('تم نسخ رقم حساب شام كاش.', 'success'); } catch { notify('تعذر النسخ التلقائي؛ حدّد رقم الحساب وانسخه يدوياً.', 'info'); } }}>نسخ رقم الحساب ⧉</button>}</div></div>
            {paymentImages.length > 0 && <div className="payment-guide-images"><h3>صور توضيحية لطريقة الدفع</h3><div>{paymentImages.map((url, index) => <figure key={url}><a href={url} target="_blank" rel="noreferrer"><img src={url} alt={`صورة توضيحية للدفع ${index + 1}`} /></a><figcaption>الخطوة التوضيحية {fmt(index + 1)}</figcaption></figure>)}</div></div>}
            <div className="important-warning strong-warning"><strong>شرط قبول الفاتورة</strong><p>تأكد من ظهور رمز التتبع في خانة الملاحظات في شام كاش. لن تتم مراجعة أي طلب أو فاتورة لا تحتوي على رمز التتبع الخاص بالطالب.</p></div>
          </div><div className="panel receipt-upload-card"><span className="section-index">الخطوة الأخيرة / رفع الفاتورة</span><h2>ارفع فاتورة التحويل</h2><p>بعد إتمام التحويل وتصدير الفاتورة PDF، ارفع الملف هنا. لا ترفع صورة شاشة؛ المطلوب ملف PDF الذي تم تصديره من شام كاش.</p><form onSubmit={handleReceiptUpload}><label className={`upload-box ${paymentReceipt ? 'has-file' : ''}`}><input type="file" accept="application/pdf,.pdf" onChange={(e) => setPaymentReceipt(e.target.files?.[0] || null)} /><span className="upload-label"><span className="upload-icon">⇧</span><span className="upload-main">{paymentReceipt ? paymentReceipt.name : 'اضغط لاختيار فاتورة PDF'}</span><span className="upload-sub">PDF فقط · الحد الأقصى 5 ميغابايت</span><span className="upload-choose">اختيار الملف</span></span></label><div className="invoice-code-reminder"><strong>رمز التتبع الذي سيرتبط بالفاتورة</strong><span dir="ltr">{paymentApplication.tracking_code}</span><small>قبل الرفع، تأكد أنك كتبت هذا الرمز في ملاحظات التحويل داخل شام كاش.</small></div><button className="primary-button" type="submit" disabled={receiptSubmitting || !paymentReceipt || !codeCopied}><span>{receiptSubmitting ? 'جارٍ رفع الفاتورة…' : 'رفع الفاتورة وتأكيد الطلب'}</span><span className="button-arrow">←</span></button><button type="button" className="secondary-button full-width-button" onClick={() => setRegistrationStage('code')}>العودة إلى رمز التتبع</button></form><p className="form-footnote">عند نجاح الرفع، تصبح الحالة «الفاتورة قيد التدقيق» ويستطيع فريق التنظيم مراجعتها.</p></div></div>}

          {registrationStage === 'done' && <div className="panel code-stage-card completion-card"><div className="success-check">✓</div><span className="section-index">اكتمل إرسال الطلب</span><h2>تم تسجيل طلبك بنجاح</h2><p>تم استلام فاتورة التحويل، وأصبح الطلب قيد تدقيق فريق التنظيم. احتفظ برمز التتبع لمتابعة حالة طلبك.</p><div className="tracking-code-card"><span>رمز التتبع الخاص بك</span><strong dir="ltr">{paymentApplication.tracking_code}</strong><button type="button" onClick={copyTrackingCode}>نسخ الرمز ⧉</button></div><div className="success-total"><span>المبلغ المسجل</span><strong>{fmt(paymentApplication.amount_syp)} ل.س</strong></div><button className="primary-button" onClick={() => { setTrackingCode(paymentApplication.tracking_code); setTrackingResult(null); setPage('track'); }}><span>متابعة حالة الطلب</span><span className="button-arrow">←</span></button><button className="secondary-button full-width-button" onClick={() => { setPaymentApplication(null); setRegistrationStage('details'); setCodeCopied(false); setForm({ full_name: '', university_number: '', phone_number: '', carried_subjects: '0', academic_unit_id: '', academic_specialization_id: '', companions: '0' }); }}>بدء طلب جديد</button></div>}
        </section>}
      </>}

      {page === 'track' && <section className="container inner-page"><div className="inner-hero"><span className="section-index">متابعة التسجيل</span><h1>أين وصل طلبك؟</h1><p>أدخل رمز التتبع الخاص بك فقط. هذا الرمز فريد ويكفي لمعرفة حالة الطلب؛ لا تحتاج إلى الرقم الجامعي.</p></div><div className="track-layout"><form className="panel track-panel" onSubmit={handleTrack}><label className="field"><span>رمز التتبع <b>*</b></span><div className="input-wrap"><input required value={trackingCode} onChange={(e) => setTrackingCode(e.target.value.toUpperCase())} placeholder="LAT- ثم الرمز الطويل" autoCapitalize="characters" /></div></label><button className="primary-button" disabled={trackingBusy}><span>{trackingBusy ? 'جارٍ البحث…' : 'عرض حالة الطلب'}</span><span className="button-arrow">←</span></button><p className="form-footnote">احتفظ برمز التتبع ولا تشاركه إلا مع فريق التنظيم. لا يمكن تتبع الطلب برقم جامعي وحده.</p></form>
          {trackingResult ? <div className="panel track-result"><div className="result-header"><span className="section-index">نتيجة الاستعلام</span><span className={`status-badge ${STATUS[trackingResult.status]?.className || 'pending'}`}>{STATUS[trackingResult.status]?.label || trackingResult.status}</span></div><h2>{trackingResult.full_name}</h2><div className="result-code"><span>رمز التتبع</span><strong dir="ltr">{trackingResult.tracking_code}</strong></div><div className="result-meta"><div><span>تاريخ التقديم</span><strong>{humanDate(trackingResult.created_at)}</strong></div><div><span>المبلغ المسجل</span><strong>{fmt(trackingResult.amount_syp)} ل.س</strong></div><div><span>الكلية أو المعهد</span><strong>{trackingResult.department}</strong></div><div><span>الاختصاص</span><strong>{trackingResult.specialization}</strong></div></div>{trackingResult.status === 'awaiting_payment' && <><div className="important-warning"><strong>الطلب بانتظار الفاتورة</strong><p>أتمم التحويل مع كتابة رمز التتبع في الملاحظات، ثم ارفع فاتورة PDF هنا.</p></div><form className="track-receipt-form" onSubmit={handleTrackReceiptUpload}><label className="field"><span>فاتورة التحويل PDF <b>*</b></span><input type="file" accept="application/pdf,.pdf" onChange={(e) => setTrackReceipt(e.target.files?.[0] || null)} required /></label><button className="primary-button" disabled={trackReceiptBusy || !trackReceipt}><span>{trackReceiptBusy ? 'جارٍ الرفع…' : 'رفع الفاتورة'}</span></button></form></>}{trackingResult.status === 'pending' && <p className="result-message">تم استلام الفاتورة؛ طلبك قيد المراجعة من قبل فريق التنظيم.</p>}{trackingResult.status === 'approved' && <><ApprovalCelebration name={trackingResult.full_name} /><TicketGallery tickets={trackingResult.tickets || []} application={trackingResult} batchName={settings.batch_name || DEFAULT_SETTINGS.batch_name} eventLocation={settings.event_location || ''} eventDate={settings.event_date || ''} /></>}{trackingResult.status === 'rejected' && <div className="rejection-message"><strong>سبب الرفض</strong><p>{trackingResult.rejection_reason || 'يرجى التواصل مع فريق التنظيم لمعرفة التفاصيل.'}</p></div>}</div> : <div className="track-help"><div className="big-lock">⌑</div><h3>بياناتك محمية</h3><p>لا يظهر طلبك إلا لمن يمتلك رمز التتبع الفريد.</p></div>}
        </div></section>}

      {page === 'verify' && <section className="container inner-page ticket-verification-page"><div className="inner-hero"><span className="section-index">التحقق من بطاقة الدخول</span><h1>بوابة التحقق لحفل التخرج</h1><p>هذه الصفحة للقراءة والتحقق فقط ولا تسجّل دخولًا. تذكرة الإصدار الجديد تحتوي على باركود خطي. التذاكر القديمة التي تحتوي QR ما زالت مدعومة، ولا يُسجّل الحضور إلا من ماسح التذاكر داخل بوابة الفريق.</p></div>{ticketVerifyBusy && <div className="panel verification-state"><div className="verification-spinner" /><h2>جارٍ التحقق من رمز QR…</h2></div>}{!ticketVerifyBusy && ticketVerifyError && <div className="panel verification-state invalid-ticket"><div className="verification-symbol">×</div><h2>تعذّر التحقق من البطاقة</h2><p>{ticketVerifyError}</p></div>}{!ticketVerifyBusy && ticketVerification?.valid && <VerifiedTicket verification={ticketVerification} />}</section>}

      {page === 'staff' && <section className="container inner-page staff-page"><div className="inner-hero"><span className="section-index">للاستخدام الداخلي</span><h1>بوابة فريق التنظيم</h1><p>صفحة داخلية غير ظاهرة في قائمة الموقع العامة. الدخول مخصص للحسابات التي أنشأها مدير النظام فقط.</p></div><div className="staff-login-layout"><div className="panel staff-login-card"><div className="staff-login-mark">⌑</div><h2>تسجيل دخول الفريق</h2><p>استخدم بيانات الحساب المصرّح به من مدير النظام.</p><form onSubmit={handleLogin}><label className="field"><span>البريد الإلكتروني</span><div className="input-wrap"><input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" placeholder="name@example.com" /></div></label><label className="field"><span>كلمة المرور</span><div className="input-wrap"><input required type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" placeholder="أدخل كلمة المرور" /></div></label><button className="primary-button" disabled={authChecking || !isConfigured}><span>{authChecking ? 'جارٍ التحقق…' : 'تسجيل الدخول'}</span><span className="button-arrow">←</span></button>{!isConfigured && <small className="muted-line">إعداد قاعدة البيانات مطلوب قبل تسجيل الدخول.</small>}</form></div><div className="staff-login-info"><span className="section-index">صلاحيات المراجعة</span><h2>الطلبات المصرح بها فقط.</h2><p>تُحدد صلاحية كل حساب حسب الكليات والاختصاصات المسموح له بمراجعتها. لا يكفي إخفاء رابط الدخول وحده لحماية البيانات؛ يتم تطبيق الصلاحيات من قاعدة البيانات. يستطيع المدير وحده تعديل الرسوم وقوائم الكليات والاختصاصات.</p><div className="staff-feature"><span>✓</span><div><strong>مراجعة الإيصالات</strong><small>فتح ملف PDF من مساحة تخزين خاصة</small></div></div><div className="staff-feature"><span>✓</span><div><strong>توثيق القرار</strong><small>تسجيل الموافقة أو سبب الرفض وتاريخ المراجعة</small></div></div><div className="staff-feature"><span>✓</span><div><strong>إدارة قوائم التسجيل</strong><small>الكليات والمعاهد والاختصاصات وحدود المواد المحمولة</small></div></div></div></div></section>}

      {page === 'staff-password' && staffUser && <section className="container inner-page staff-page"><div className="inner-hero"><span className="section-index">خطوة أمان مطلوبة</span><h1>غيّر كلمة المرور المؤقتة</h1><p>يجب تعيين كلمة مرور شخصية قبل استخدام لوحة فريق التنظيم. استخدم كلمة مرور طويلة وفريدة ولا تشاركها مع أحد.</p></div><div className="staff-login-layout"><form className="panel staff-login-card" onSubmit={handleForcedPasswordChange}><h2>كلمة مرور جديدة</h2><label className="field"><span>كلمة المرور الجديدة</span><input type="password" required minLength={12} autoComplete="new-password" value={newStaffPassword} onChange={(e) => setNewStaffPassword(e.target.value)} placeholder="12 محرفاً على الأقل" /></label><label className="field"><span>تأكيد كلمة المرور</span><input type="password" required minLength={12} autoComplete="new-password" value={confirmStaffPassword} onChange={(e) => setConfirmStaffPassword(e.target.value)} placeholder="أعد كتابة كلمة المرور" /></label><button className="primary-button" disabled={authChecking}><span>{authChecking ? 'جارٍ الحفظ…' : 'حفظ كلمة المرور والمتابعة'}</span></button><button type="button" className="secondary-button" onClick={signOut}>تسجيل الخروج</button></form></div></section>}
      {page === 'admin' && staffUser && ['admin', 'reviewer'].includes(staffRole) && <AdminDashboard staffUser={staffUser} staffRole={staffRole} settings={settings} setSettings={setSettings} refreshSettings={loadSettings} catalog={catalog} catalogError={catalogError} refreshCatalog={loadCatalog} notify={notify} onSignOut={signOut} />}
      {page === 'gate' && staffUser && ['admin', 'gate'].includes(staffRole) && <GateDashboard staffUser={staffUser} staffRole={staffRole} notify={notify} onSignOut={signOut} />}
      {page === 'finance' && staffUser && ['admin', 'finance'].includes(staffRole) && <FinancialDashboard staffRole={staffRole} notify={notify} onSignOut={signOut} standalone />}
    </main>

    <footer className="site-footer"><div className="container footer-inner"><div className="footer-brand"><img className="brand-logo small-brand-logo" src="/brand/ssu-emblem.png" alt="" /><div><strong>{settings.organizer || DEFAULT_SETTINGS.organizer}</strong><span>{settings.university_label || DEFAULT_SETTINGS.university_label}</span></div></div><p>منصة التسجيل لحفلات التخرج · {settings.batch_name || DEFAULT_SETTINGS.batch_name} · {new Date().getFullYear()}</p><span className="footer-status"><i className="dot" /> نظام التسجيل والمتابعة</span></div></footer>

    {toast && <div className={`toast toast-${toast.kind}`} role="status"><span>{toast.kind === 'error' ? '!' : toast.kind === 'success' ? '✓' : 'i'}</span>{toast.message}<button onClick={() => setToast(null)} aria-label="إغلاق">×</button></div>}
  </div>;
}

function ApprovalCelebration({ name }) {
  const pieces = Array.from({ length: 24 }, (_, index) => index);
  return <section className="approval-celebration" aria-live="polite">
    <div className="celebration-confetti" aria-hidden="true">{pieces.map((piece) => <span key={piece} style={{ left: `${(piece * 37) % 100}%`, animationDelay: `${(piece % 8) * 0.16}s`, animationDuration: `${2.6 + (piece % 5) * 0.35}s`, '--piece-rotate': `${piece * 43}deg` }} />)}</div>
    <div className="celebration-badge" aria-hidden="true"><span className="celebration-cap-shape" /></div>
    <span className="section-index">خبر سعيد</span>
    <h3>مبارك يا {name || 'خريجنا العزيز'}!</h3>
    <p>تمت الموافقة على طلبك. نتمنى لك حفل تخرج مليئاً بالفرح والذكريات الجميلة.</p>
    <div className="celebration-sparkles" aria-hidden="true">✦ · ✧ · ✦</div>
  </section>;
}

function TicketGallery({ tickets, application, batchName, eventLocation, eventDate }) {
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState('');
  if (!tickets.length) return <div className="ticket-loading-note"><strong>تم قبول الطلب</strong><p>يجري تجهيز بطاقات الدخول. حدّث حالة الطلب بعد لحظات إن لم تظهر البطاقات.</p></div>;
  async function downloadAllOnePdf() {
    setDownloading(true); setDownloadError('');
    try { await downloadTicketsAsOnePdf(tickets, application, batchName, eventLocation, eventDate); }
    catch (error) { setDownloadError(error.message || 'تعذّر تجهيز ملف البطاقات.'); }
    finally { setDownloading(false); }
  }
  async function downloadSeparateTickets() {
    setDownloading(true); setDownloadError('');
    try { await downloadTicketsSeparatelyZip(tickets, application, batchName, eventLocation, eventDate); }
    catch (error) { setDownloadError(error.message || 'تعذّر تجهيز ملفات البطاقات.'); }
    finally { setDownloading(false); }
  }
  return <section className="ticket-gallery" id="entry-tickets">
    <div className="ticket-gallery-heading"><div><span className="section-index">بطاقات الدخول</span><h3>تذاكر حفلات التخرج — {batchName || 'دفعة 2026'}</h3><p>تصميم تذكرة أفقي مستوحى من النموذج المعتمد. حرّك أفقيًا لمعاينة التذكرة كاملة على الهاتف، أو نزّلها للطباعة.</p></div></div>
    <div className="ticket-download-actions"><button type="button" className="primary-button" disabled={downloading} onClick={downloadAllOnePdf}>{downloading ? 'جارٍ تجهيز البطاقات…' : 'تنزيل جميع التذاكر في PDF واحد'}</button><button type="button" className="secondary-button" disabled={downloading} onClick={downloadSeparateTickets}>تنزيل كل تذكرة بملف مستقل (ZIP)</button><button type="button" className="secondary-button ticket-print-button" onClick={() => window.print()}>طباعة التذاكر</button></div>
    {downloadError && <div className="notice notice-warning" role="alert">{downloadError}</div>}
    <div className="ticket-preview-scroll" dir="ltr"><div className="ticket-cards-grid">{tickets.map((ticket) => <EntryTicketCard key={ticket.ticket_token} ticket={ticket} application={application} batchName={batchName} eventLocation={eventLocation} eventDate={eventDate} />)}</div></div>
    <p className="ticket-privacy-note">رمز الباركود مشفّر بصريًا لرمز البطاقة فقط، ولا يسجّل الدخول إلا عند مسحه من بوابة فريق التنظيم. احتفظ بالتذكرة لنفسك.</p>
  </section>;
}

function makeTicketDisplayNumber(ticket) {
  const tokenPart = String(ticket?.ticket_token || '').replace(/^TKT-/i, '').slice(0, 12).toUpperCase();
  const isGraduate = ticket?.ticket_type === 'graduate' || Number(ticket?.ticket_number) === 0;
  const prefix = isGraduate ? 'GR' : `GU${String(ticket?.ticket_number ?? 0).padStart(2, '0')}`;
  return `${prefix}-${tokenPart || 'PENDING'}`;
}

function formatTicketEventDate(value) {
  if (!value) return 'يحدد لاحقًا';
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00`) : new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleDateString('ar-SY', { year: 'numeric', month: 'long', day: 'numeric' });
}

function TicketBarcode({ value }) {
  const barcodeRef = useRef(null);
  useEffect(() => {
    if (!barcodeRef.current || !value) return;
    try {
      JsBarcode(barcodeRef.current, value, {
        format: 'CODE128',
        lineColor: '#4b101d',
        background: '#fff7e9',
        width: 2,
        height: 120,
        margin: 5,
        displayValue: false,
      });
    } catch (error) {
      console.error('Barcode generation failed', error);
    }
  }, [value]);
  return <svg ref={barcodeRef} className="ticket-barcode-svg" role="img" aria-label="باركود دخول خاص بفريق التنظيم" />;
}

function TicketLogo({ compact = false }) {
  return <div className={`ticket-brand-lockup ${compact ? 'is-compact' : ''}`}>
    <span className="ticket-brand-emblem"><img src="/brand/ssu-emblem.png" alt="" /></span>
    <span className="ticket-brand-words"><strong>اتحاد طلبة سوريا</strong><small>فرع محافظة اللاذقية</small></span>
  </div>;
}

function EntryTicketCard({ ticket, application, batchName, eventLocation, eventDate }) {
  const isGraduate = ticket.ticket_type === 'graduate' || Number(ticket.ticket_number) === 0;
  const ticketNumber = makeTicketDisplayNumber(ticket);
  return <article className="entry-ticket-card official-event-ticket">
    <section className="ticket-main-panel" dir="rtl">
      <div className="ticket-main-ornament" aria-hidden="true" />
      <div className="ticket-main-brand"><TicketLogo /></div>
      <div className="ticket-main-copy">
        <h3>تذكرة دخول<br />حفلات التخرج</h3>
        <p className="ticket-batch-name">{batchName || 'دفعة البناء والتأسيس 2026'}</p>
        <div className="ticket-grad-details"><small>{isGraduate ? 'الخريج / الخريجة' : `المرافق رقم ${fmt(ticket.ticket_number)}`}</small><strong>{application.full_name || '—'}</strong><span>{application.department || '—'}{application.specialization && application.specialization !== 'لا يوجد اختصاص' ? ` · ${application.specialization}` : ''}</span></div>
        <span className="ticket-graduation-cap" aria-hidden="true"><i /></span>
      </div>
      <div className="ticket-main-slogan">نحو مستقبل يصنعه الشباب</div>
    </section>
    <div className="ticket-perforation" aria-hidden="true"><span /><span /></div>
    <aside className="ticket-stub-panel" dir="rtl">
      <div className="ticket-stub-brand"><TicketLogo compact /></div>
      <div className="ticket-stub-content" dir="ltr">
        <div className="ticket-barcode-column"><div className="ticket-barcode-rotated"><TicketBarcode value={ticket.ticket_token} /></div><small dir="ltr">NO. {ticketNumber}</small></div>
        <div className="ticket-stub-fields" dir="rtl">
          <div><span>المكان</span><strong>{eventLocation || 'يحدد لاحقًا'}</strong></div>
          <div><span>التاريخ</span><strong>{formatTicketEventDate(eventDate)}</strong></div>
          <div><span>نوع الدخول</span><strong>{isGraduate ? 'خريج' : `مرافق ${fmt(ticket.ticket_number)}`}</strong></div>
          <div><span>رقم التذكرة</span><strong dir="ltr">{ticketNumber}</strong></div>
        </div>
      </div>
      <div className="ticket-stub-footer">تذكرة شخصية — صالحة بعد الموافقة النهائية فقط</div>
    </aside>
  </article>;
}
function VerifiedTicket({ verification }) {
  const { ticket, graduate } = verification;
  const isGraduate = ticket.type === 'graduate' || ticket.number === 0;
  return <div className="panel verified-ticket-panel">
    <div className="verified-ticket-status"><span className="verified-status-icon">✓</span><div><strong>البطاقة صالحة للدخول</strong><small>تم التحقق من رمز البطاقة وموافقة الطلب</small></div><span className="status-badge approved">مقبول</span></div>
    <div className="verified-ticket-kind"><span className="verified-ticket-type-mark">{isGraduate ? 'خريج' : 'مرافق'}</span><div><small>نوع البطاقة</small><h2>{isGraduate ? 'بطاقة الخريج' : `بطاقة المرافق رقم ${ticket.number}`}</h2></div></div>
    <div className="verified-person-name"><span>اسم الخريج</span><strong>{graduate.full_name}</strong></div>
    <div className="verified-data-grid">
      <div><span>الرقم الجامعي</span><strong>{graduate.university_number || '—'}</strong></div>
      <div><span>الكلية أو المعهد</span><strong>{graduate.department || '—'}</strong></div>
      <div><span>الاختصاص</span><strong>{graduate.specialization || 'لا يوجد اختصاص'}</strong></div>
      {!isGraduate && <div><span>رقم بطاقة المرافق</span><strong>{fmt(ticket.number)}</strong></div>}
    </div>
    <div className="important-warning verified-ticket-warning"><strong>تعليمات البوابة</strong><p>{isGraduate ? 'طابق اسم الخريج ورقمه الجامعي مع وثيقة الطالب عند الحاجة.' : `هذه البطاقة خاصة بمرافق واحد للخريج ${graduate.full_name}. لا تستخدمها لدخول مرافق آخر.`}</p></div>
    <p className="verification-note">{verification.message}</p>
  </div>;
}

function extractTicketToken(raw) {
  return String(raw || '').match(/TKT-[A-F0-9]{32}/i)?.[0]?.toUpperCase() || '';
}

function GateOperationsPanel({ staffUser, staffRole, notify, embedded = false, onSignOut }) {
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [manualInput, setManualInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const videoRef = useRef(null);
  const readerRef = useRef(null);
  const controlsRef = useRef(null);
  const processingRef = useRef(false);

  const checkIn = useCallback(async (raw) => {
    const token = extractTicketToken(raw);
    if (!token) return notify('لم يتم العثور على باركود أو QR صالح. امسح تذكرة أصلية أو أدخل رمز TKT يدويًا.', 'error');
    setBusy(true); setResult(null); setCameraError('');
    try {
      const { data, error } = await supabase.functions.invoke('check-in-ticket', { body: { ticket_token: token } });
      if (error) {
        let body = null;
        try { if (error.context && typeof error.context.json === 'function') body = await error.context.json(); } catch { /* optional response body */ }
        throw new Error(body?.error || error.message || 'تعذر التحقق من بطاقة الدخول.');
      }
      if (!data || data.status === 'invalid' || data.status === 'error') throw new Error(data?.message || data?.error || 'البطاقة غير صالحة.');
      setResult(data);
      if (data.status === 'checked_in') notify('تم تسجيل دخول البطاقة بنجاح.', 'success');
      else if (data.status === 'already_used') notify('تنبيه: استُخدمت هذه البطاقة سابقًا.', 'error');
      else notify(data.message || 'تم التحقق من البطاقة.', 'info');
    } catch (error) {
      setResult({ status: 'error', message: error.message || 'تعذر تسجيل الدخول.' });
      notify(error.message || 'تعذر تسجيل الدخول.', 'error');
    } finally { setBusy(false); }
  }, [notify]);

  useEffect(() => {
    if (!cameraActive || !videoRef.current) return undefined;
    let cancelled = false;
    const hints = new Map([
      [DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.CODE_128, BarcodeFormat.QR_CODE]],
      [DecodeHintType.TRY_HARDER, true],
    ]);
    const reader = new BrowserMultiFormatReader(hints);
    readerRef.current = reader;
    setCameraError('');
    reader.decodeFromVideoDevice(undefined, videoRef.current, (decoded, _err, controls) => {
      if (controls) controlsRef.current = controls;
      if (cancelled || !decoded || processingRef.current) return;
      const raw = decoded.getText();
      if (!extractTicketToken(raw)) return;
      processingRef.current = true;
      setManualInput(extractTicketToken(raw));
      setCameraActive(false);
      checkIn(raw).finally(() => { processingRef.current = false; });
    }).catch((error) => {
      if (!cancelled) {
        setCameraError(error?.message || 'تعذر تشغيل الكاميرا. تحقق من إذن الكاميرا أو استخدم إدخال الرمز يدويًا.');
        setCameraActive(false);
      }
    });
    return () => {
      cancelled = true;
      try { controlsRef.current?.stop(); } catch { /* ignore */ }
      controlsRef.current = null;
      try { reader.reset(); } catch { /* ignore */ }
    };
  }, [cameraActive, checkIn]);

  function handleManualSubmit(event) {
    event.preventDefault();
    if (busy) return;
    checkIn(manualInput);
  }

  return <div className={`panel settings-panel gate-operations-panel ${embedded ? 'embedded-ops-panel' : ''}`}>
    <div className="settings-header"><div><span className="section-index">مخصص لفريق التنظيم</span><h2>بوابة التحقق وتسجيل الدخول</h2><p>المسح من هذه الصفحة بعد تسجيل دخول موظف مخوّل هو وحده الذي يسجل دخول البطاقة. الباركود الجديد يحتوي رمز البطاقة فقط، ومسح QR القديم بكاميرا عادية لا يسجل الدخول ولا يلغي البطاقة.</p></div><span className="status-badge approved">دخول الموظف: {staffUser?.email || 'موظف مخوّل'}</span></div>
    <div className="gate-scan-layout">
      <div className="gate-camera-box">
        <video ref={videoRef} className={`gate-camera-video ${cameraActive ? 'is-active' : ''}`} muted playsInline />
        {!cameraActive && <div className="gate-camera-placeholder"><span className="gate-scan-frame" aria-hidden="true" /><strong>وجّه كاميرا الهاتف إلى الباركود أو QR القديم</strong><small>تسجيل الدخول يتم مرة واحدة وبصلاحية حساب الموظف فقط.</small></div>}
        <div className="gate-camera-actions">{cameraActive ? <button type="button" className="reject-button" onClick={() => setCameraActive(false)}>إيقاف الكاميرا</button> : <button type="button" className="primary-button" disabled={busy} onClick={() => { setResult(null); setCameraError(''); setCameraActive(true); }}>تشغيل ماسح التذاكر</button>}</div>
        {cameraError && <div className="notice notice-warning" role="alert">{cameraError}</div>}
        {typeof window !== 'undefined' && !('mediaDevices' in navigator) && <p className="muted-line">لا يدعم هذا المتصفح تشغيل الكاميرا. استخدم خانة إدخال الرمز أدناه.</p>}
      </div>
      <div className="gate-manual-box">
        <h3>إدخال الرمز يدويًا</h3><p>استخدم هذا الخيار إذا لم تعمل الكاميرا أو كانت البطاقة مطبوعة بصورة غير واضحة.</p>
        <form onSubmit={handleManualSubmit}><label className="field"><span>رمز البطاقة أو نص QR القديم</span><input value={manualInput} onChange={(e) => setManualInput(e.target.value.toUpperCase())} placeholder="TKT-… أو الصق الرابط الكامل" dir="ltr" required /></label><button className="primary-button" type="submit" disabled={busy || !manualInput.trim()}>{busy ? 'جارٍ التحقق…' : 'التحقق وتسجيل الدخول'}</button></form>
        <div className="important-warning"><strong>قاعدة البوابة</strong><p>كل تذكرة تُسجل مرة واحدة فقط. إذا ظهرت «مستخدمة سابقًا» فلا تسمح بالدخول بالبطاقة نفسها، واطلب مراجعة المشرف إذا كان هناك اعتراض.</p></div>
      </div>
    </div>
    {result && <div className={`gate-result-card ${result.status === 'checked_in' ? 'gate-result-success' : result.status === 'already_used' ? 'gate-result-used' : 'gate-result-error'}`} role="status">
      <span className="section-index">نتيجة المسح</span><h3>{result.status === 'checked_in' ? 'تم تسجيل الدخول ✓' : result.status === 'already_used' ? 'البطاقة مستخدمة سابقًا' : 'لم يتم تسجيل الدخول'}</h3><p>{result.message || result.error}</p>
      {result.full_name && <div className="gate-result-details"><div><span>اسم الخريج</span><strong>{result.full_name}</strong></div><div><span>نوع البطاقة</span><strong>{result.ticket_type === 'graduate' ? 'الخريج' : `مرافق رقم ${fmt(result.ticket_number)}`}</strong></div>{result.department && <div><span>الكلية/المعهد</span><strong>{result.department}</strong></div>}{result.specialization && <div><span>الاختصاص</span><strong>{result.specialization}</strong></div>}{result.checked_in_at && <div><span>وقت الاستخدام الأول</span><strong>{humanDate(result.checked_in_at)}</strong></div>}</div>}
      <button className="secondary-button" type="button" onClick={() => { setResult(null); setManualInput(''); }}>مسح نتيجة والانتقال للبطاقة التالية</button>
    </div>}
  </div>;
}

function GateDashboard({ staffUser, staffRole, notify, onSignOut }) {
  return <section className="container inner-page gate-dashboard"><div className="inner-hero"><span className="section-index">صلاحية بوابة الدخول</span><h1>التحقق من بطاقات حفل التخرج</h1><p>لا يُسجّل دخول البطاقة إلا من ماسح التذاكر بعد التحقق من حساب الفريق.</p></div><GateOperationsPanel staffUser={staffUser} staffRole={staffRole} notify={notify} /><button className="secondary-button full-width-button" onClick={onSignOut}>تسجيل الخروج</button></section>;
}

function FinancialDashboard({ staffRole, notify, onSignOut, standalone = false, embedded = false }) {
  const [payments, setPayments] = useState([]);
  const [closings, setClosings] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [statusFilter, setStatusFilter] = useState('unverified');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const [transactionRef, setTransactionRef] = useState('');
  const [receivedAmount, setReceivedAmount] = useState('');
  const [transferAt, setTransferAt] = useState('');
  const [payerNote, setPayerNote] = useState('');
  const [verificationNotes, setVerificationNotes] = useState('');
  const [outcome, setOutcome] = useState('matched');
  const [checkedAgainstStatement, setCheckedAgainstStatement] = useState(false);
  const [closingDate, setClosingDate] = useState(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; });
  const [statementCount, setStatementCount] = useState('');
  const [statementTotal, setStatementTotal] = useState('');
  const [closingNotes, setClosingNotes] = useState('');
  const [overrideReason, setOverrideReason] = useState('');
  const isAdmin = staffRole === 'admin';
  const selected = payments.find((p) => p.application_id === selectedId) || null;

  const callFinancial = useCallback(async (payload) => {
    const { data, error } = await supabase.functions.invoke('financial-management', { body: payload });
    if (error) {
      let body = null;
      try { if (error.context && typeof error.context.json === 'function') body = await error.context.json(); } catch { /* optional response body */ }
      throw new Error(body?.error || error.message || 'تعذر الاتصال بوحدة الجرد المالي.');
    }
    if (data?.error) {
      if (data.reconciliation) notify(`الفرق: ${fmt(data.reconciliation.difference_count)} حركة، ${fmt(data.reconciliation.difference_amount_syp)} ل.س. لا يُقفل اليوم قبل معالجة الفرق أو تسجيل استثناء إداري موثق.`, 'error');
      throw new Error(data.error);
    }
    return data;
  }, [notify]);

  const refresh = useCallback(async (nextOffset = offset, nextStatus = statusFilter) => {
    setLoading(true);
    try {
      const data = await callFinancial({ action: 'list', offset: nextOffset, limit: 50, reconciliation_status: nextStatus });
      setPayments(data.payments || []); setTotal(data.total || 0); setClosings(data.closings || []);
    } catch (error) { notify(error.message, 'error'); }
    finally { setLoading(false); }
  }, [callFinancial, notify, offset, statusFilter]);
  useEffect(() => { refresh(offset, statusFilter); }, [refresh, offset, statusFilter]);

  function choosePayment(payment) {
    setSelectedId(payment.application_id);
    setTransactionRef(payment.transaction_reference || '');
    setReceivedAmount(payment.received_amount_syp == null ? String(payment.expected_amount_syp ?? payment.application?.amount_syp ?? '') : String(payment.received_amount_syp));
    setTransferAt(payment.transfer_at ? new Date(payment.transfer_at).toISOString().slice(0,16) : '');
    setPayerNote(payment.payer_note || ''); setVerificationNotes(payment.verification_notes || '');
    setOutcome(payment.reconciliation_status === 'matched' ? 'matched' : payment.reconciliation_status === 'mismatch' ? 'mismatch' : payment.reconciliation_status === 'not_found' ? 'not_found' : payment.reconciliation_status === 'suspected' ? 'suspected' : 'matched');
    setCheckedAgainstStatement(Boolean(payment.checked_against_statement));
  }

  async function openReceipt(payment) {
    const tab = window.open('about:blank', '_blank');
    try { const result = await callFinancial({ action: 'receipt_url', application_id: payment.application_id }); if (tab) tab.location.href = result.url; else window.location.href = result.url; }
    catch (error) { if (tab) tab.close(); notify(error.message, 'error'); }
  }

  async function saveReview(event) {
    event.preventDefault(); if (!selected) return;
    if (outcome === 'matched' && !checkedAgainstStatement) return notify('افتح حساب شام كاش أو الكشف الرسمي وتأكد من ظهور الحركة الفعلية قبل اختيار «مطابق».', 'error');
    setBusy(true);
    try {
      const result = await callFinancial({ action: 'save_review', application_id: selected.application_id, transaction_reference: transactionRef, received_amount_syp: receivedAmount, transfer_at: transferAt ? new Date(transferAt).toISOString() : '', payer_note: payerNote, verification_notes: verificationNotes, reconciliation_status: outcome, checked_against_statement: checkedAgainstStatement });
      notify(result.warning || result.message || 'تم حفظ المراجعة المالية.', result.warning ? 'warning' : 'success');
      await refresh(offset, statusFilter);
    } catch (error) { notify(error.message || 'تعذر حفظ المطابقة.', 'error'); }
    finally { setBusy(false); }
  }

  async function closeDay(event) {
    event.preventDefault(); setBusy(true);
    try {
      const result = await callFinancial({ action: 'close_day', closing_date: closingDate, statement_transaction_count: statementCount, statement_total_syp: statementTotal, notes: closingNotes, override_reason: overrideReason });
      notify(result.message || 'تم حفظ الإقفال اليومي.', 'success'); setOverrideReason(''); await refresh(0, statusFilter);
    } catch (error) { notify(error.message || 'تعذر إقفال اليوم.', 'error'); }
    finally { setBusy(false); }
  }

  const shell = <div className={`panel settings-panel finance-dashboard ${embedded ? 'embedded-ops-panel' : ''}`}>
    <div className="settings-header"><div><span className="section-index">الرقابة المالية</span><h2>مطابقة التحويلات والجرد اليومي</h2><p>لا يكفي ملف PDF وحده لإثبات الدفع. يجب مطابقة المبلغ ورقم الحركة مع سجل شام كاش الفعلي أو كشف رسمي، ويمنع النظام استخدام رقم الحركة نفسه لطلبين.</p></div><button type="button" className="secondary-button" onClick={() => refresh(0, statusFilter)} disabled={loading}>تحديث ↻</button></div>
    <div className="finance-warning"><strong>إجراء مسؤول مالي</strong><p>لا تضع حالة «مطابق» إلا بعد رؤية التحويل الفعلي في حساب شام كاش أو كشف الحساب. لا يوجد تحقق آلي من شام كاش في هذه النسخة.</p></div>
    <div className="finance-list-toolbar"><label className="field"><span>حالة المطابقة</span><select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setOffset(0); }}><option value="unverified">بانتظار المطابقة</option><option value="all">كل السجلات</option><option value="matched">مطابقة ناجحة</option><option value="mismatch">اختلاف مبلغ</option><option value="suspected">مشتبه به</option><option value="not_found">لم توجد الحركة</option></select></label><span>إجمالي السجلات: {fmt(total)}</span></div>
    {loading ? <div className="empty-state">جارٍ تحميل سجلات المطابقة…</div> : payments.length === 0 ? <div className="empty-state"><strong>لا توجد سجلات في هذه الصفحة</strong><p>عند رفع أي إيصال جديد يُنشأ سجل مطابقة تلقائيًا.</p></div> : <div className="table-scroll"><table className="applications-table finance-table"><thead><tr><th>الطالب</th><th>المبلغ المطلوب</th><th>المبلغ المدخل</th><th>حالة المطابقة</th><th>تاريخ رفع الإيصال</th><th>إجراء</th></tr></thead><tbody>{payments.map((payment) => <tr key={payment.application_id} className={selectedId === payment.application_id ? 'selected-row' : ''} onClick={() => choosePayment(payment)}><td><strong>{payment.application?.full_name || 'طلب غير موجود'}</strong><small>{payment.application?.tracking_code || payment.application_id}</small><small>{payment.application?.department || ''} · {payment.application?.specialization || ''}</small></td><td>{fmt(payment.expected_amount_syp)} ل.س</td><td>{payment.received_amount_syp == null ? '—' : `${fmt(payment.received_amount_syp)} ل.س`}</td><td><span className={`status-badge ${payment.reconciliation_status === 'matched' ? 'approved' : ['mismatch','suspected'].includes(payment.reconciliation_status) ? 'rejected' : 'pending'}`}>{({ unverified: 'بانتظار المطابقة', matched: 'مطابق', mismatch: 'اختلاف مبلغ', suspected: 'مشتبه به', not_found: 'لم توجد الحركة' })[payment.reconciliation_status] || payment.reconciliation_status}</span></td><td>{humanDate(payment.created_at)}</td><td><button type="button" className="secondary-button" onClick={(e) => { e.stopPropagation(); choosePayment(payment); if (payment.application?.receipt_path) openReceipt(payment); }}>عرض الفاتورة</button></td></tr>)}</tbody></table></div>}
    <div className="pagination-row"><span>عرض {fmt(total ? offset + 1 : 0)}–{fmt(Math.min(offset + 50, total))} من {fmt(total)}</span><div><button className="secondary-button" disabled={offset <= 0 || loading} onClick={() => setOffset((v) => Math.max(0, v - 50))}>السابق</button><button className="secondary-button" disabled={offset + 50 >= total || loading} onClick={() => setOffset((v) => v + 50)}>التالي</button></div></div>
    {selected && <form className="finance-review-form" onSubmit={saveReview}><div className="settings-header"><div><span className="section-index">مراجعة حركة مالية</span><h3>{selected.application?.full_name || selected.application_id}</h3><p>المبلغ المطلوب: <strong>{fmt(selected.expected_amount_syp)} ل.س</strong> · رمز التتبع: <code dir="ltr">{selected.application?.tracking_code}</code></p></div>{selected.application?.receipt_path && <button className="secondary-button" type="button" onClick={() => openReceipt(selected)}>فتح PDF في تبويب جديد</button>}</div>
      <div className="settings-grid"><label className="field"><span>رقم/معرّف حركة شام كاش</span><input value={transactionRef} onChange={(e) => setTransactionRef(e.target.value.toUpperCase())} placeholder="المرجع الظاهر في تفاصيل التحويل" /></label><label className="field"><span>المبلغ الوارد فعليًا (ل.س)</span><input type="number" min="0" step="1" value={receivedAmount} onChange={(e) => setReceivedAmount(e.target.value)} /></label><label className="field"><span>تاريخ ووقت التحويل</span><input type="datetime-local" value={transferAt} onChange={(e) => setTransferAt(e.target.value)} /></label><label className="field"><span>ملاحظة المرسل/صاحب الحساب (اختياري)</span><input value={payerNote} onChange={(e) => setPayerNote(e.target.value)} maxLength={160} /></label><label className="field"><span>نتيجة الفحص</span><select value={outcome} onChange={(e) => setOutcome(e.target.value)}><option value="matched">مطابق مع الحركة الفعلية</option><option value="mismatch">المبلغ مختلف</option><option value="suspected">مشتبه به / فاتورة غير موثوقة</option><option value="not_found">لم أجد التحويل في الحساب</option><option value="unverified">إبقاءه دون حسم</option></select></label><label className="field field-full"><span>سبب/ملاحظات المراجعة المالية</span><textarea rows="3" value={verificationNotes} onChange={(e) => setVerificationNotes(e.target.value)} placeholder="مثلاً: وصل مزور، رقم مرجع مكرر، المبلغ ناقص…" /></label></div>
      <label className="consent-check finance-confirm-check"><input type="checkbox" checked={checkedAgainstStatement} onChange={(e) => setCheckedAgainstStatement(e.target.checked)} /><span>أؤكد أنني راجعت الحركة في حساب شام كاش الفعلي أو كشف رسمي، وليس ملف PDF وحده.</span></label>
      <div className="decision-actions"><button className="primary-button" disabled={busy}>{busy ? 'جارٍ الحفظ…' : 'حفظ نتيجة المطابقة'}</button><button className="secondary-button" type="button" onClick={() => setSelectedId('')}>إلغاء التحديد</button></div>
    </form>}
    <div className="form-divider" /><div className="notice notice-info"><strong>الإقفال اليومي</strong><p>تم نقل تسجيل الواردات والمقارنة مع كشف شام كاش والإقفال إلى «دفتر الواردات» أدناه حتى يتم احتساب الاستثناءات والمرجع المكرر على مستوى الحركات.</p></div>
  </div>;
  if (!standalone) return <><div className="finance-view-switch"><strong>١. مراجعة فواتير الطلبات</strong><span>—</span><strong>٢. دفتر الواردات والإقفال اليومي</strong></div>{shell}<FinancialLedgerPanel staffRole={staffRole} notify={notify} /></>;
  return <section className="container inner-page finance-page"><div className="inner-hero"><span className="section-index">صلاحية المسؤول المالي</span><h1>الجرد المالي لحفلات التخرج</h1><p>طابق التحويلات الفعلية، سجّل كل حركة من كشف شام كاش، ثم أغلق اليوم بعد مطابقة العدد والإجمالي.</p></div>{shell}<FinancialLedgerPanel staffRole={staffRole} notify={notify} />{onSignOut && <button className="secondary-button full-width-button" onClick={onSignOut}>تسجيل الخروج</button>}</section>;
}

function AuditLogPanel({ notify }) {
  const [rows, setRows] = useState([]); const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [filter, setFilter] = useState('all');
  const refresh = useCallback(async () => { setLoading(true); setError(''); const { data, error: queryError } = await supabase.from('admin_audit_logs').select('*').order('created_at', { ascending: false }).limit(300); if (queryError) { setError(queryError.message); notify('تعذر تحميل سجل التدقيق.', 'error'); } else setRows(data || []); setLoading(false); }, [notify]);
  useEffect(() => { refresh(); }, [refresh]);
  const shown = filter === 'all' ? rows : rows.filter((r) => r.action.includes(filter));
  return <div className="panel settings-panel audit-log-panel"><div className="settings-header"><div><span className="section-index">المساءلة الإدارية</span><h2>سجل التدقيق الإداري</h2><p>يعرض الإجراءات التي تم تسجيلها في النظام. لا يستطيع الموظفون تعديل السجل مباشرة.</p></div><button className="secondary-button" onClick={refresh} disabled={loading}>تحديث ↻</button></div><div className="field"><span>تصفية السجل</span><select value={filter} onChange={(e) => setFilter(e.target.value)}><option value="all">جميع الإجراءات</option><option value="application_approved">الموافقة على طلب</option><option value="application_rejected">رفض طلب</option><option value="deleted">عمليات الحذف</option><option value="financial">عمليات مالية</option><option value="ticket_checked_in">تسجيل دخول عند البوابة</option><option value="backup">نسخ احتياطي</option><option value="staff_">إدارة حسابات الفريق</option></select></div>{loading ? <div className="empty-state">جارٍ تحميل السجل…</div> : error ? <div className="notice notice-warning">{error}</div> : shown.length === 0 ? <div className="empty-state">لا توجد أحداث مطابقة في آخر 300 سجل.</div> : <div className="table-scroll"><table className="applications-table audit-table"><thead><tr><th>التاريخ والوقت</th><th>المستخدم</th><th>الإجراء</th><th>الطلب/الكيان</th><th>التفاصيل</th></tr></thead><tbody>{shown.map((row) => <tr key={row.id}><td>{humanDate(row.created_at)}</td><td><strong>{row.actor_email}</strong><small>{row.actor_role || '—'}</small></td><td><code dir="ltr">{row.action}</code></td><td><strong>{row.tracking_code || row.entity_type}</strong><small>{row.entity_id || ''}</small></td><td><details><summary>عرض</summary><pre className="audit-detail-json">{JSON.stringify(row.details || {}, null, 2)}</pre></details></td></tr>)}</tbody></table></div>}<p className="form-footnote">يحفظ النظام حتى 300 حدثًا في هذه الشاشة للعرض؛ قاعدة البيانات تحتفظ بالسجل الكامل ما لم تحدد سياسة حذف لاحقًا.</p></div>;
}

function AdminBackupPanel({ notify }) {
  const [busy, setBusy] = useState(false); const [progress, setProgress] = useState(''); const [pendingBackup, setPendingBackup] = useState(null); const [confirmedSaved, setConfirmedSaved] = useState(false); const [history, setHistory] = useState([]); const [historyError, setHistoryError] = useState('');
  const tables = ['event_settings','academic_units','academic_specializations','applications','entry_tickets','financial_payments','financial_transactions','financial_daily_closings','admin_audit_logs','admin_backup_runs','staff_roles','staff_unit_permissions'];
  const refreshHistory = useCallback(async () => { const { data, error } = await supabase.functions.invoke('admin-data-export', { body: { action: 'backup_history' } }); if (error || data?.error) setHistoryError(data?.error || error?.message || 'تعذر تحميل سجل النسخ.'); else { setHistory(data.runs || []); setHistoryError(''); } }, []);
  useEffect(() => { refreshHistory(); }, [refreshHistory]);
  async function downloadBackup() {
    if (busy) return; setBusy(true); setProgress('بدء تصدير البيانات…'); setPendingBackup(null); setConfirmedSaved(false);
    try {
      const zip = new JSZip(); const counts = {}; const metadata = { app: 'latakia-graduation-registration', schema: '008', generated_at: new Date().toISOString(), note: 'نسخة بيانات من قاعدة البيانات؛ ملفات PDF المؤرشفة محليًا لا تُضمّن في هذا ZIP.' };
      for (const table of tables) {
        const rows = []; let offset = 0; let expected = null;
        while (true) {
          setProgress(`تصدير ${table} — تم تحميل ${rows.length}${expected == null ? '' : ` من ${expected}`}…`);
          const { data, error } = await supabase.functions.invoke('admin-data-export', { body: { action: 'page', table, offset, limit: 1000 } });
          if (error) { let body = null; try { if (error.context && typeof error.context.json === 'function') body = await error.context.json(); } catch {} throw new Error(body?.error || error.message); }
          if (data?.error) throw new Error(data.error);
          expected = Number(data.total || 0); rows.push(...(data.rows || [])); offset += (data.rows || []).length;
          if (!data.rows || data.rows.length < 1000 || offset >= expected) break;
        }
        counts[table] = rows.length; zip.file(`${table}.json`, JSON.stringify(rows));
      }
      zip.file('backup-metadata.json', JSON.stringify({ ...metadata, row_counts: counts }, null, 2));
      setProgress('ضغط الملفات وتجهيز ZIP…');
      const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
      const date = new Date(); const dateStr = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`; const fileName = `graduation-admin-backup-${dateStr}.zip`;
      const objectUrl = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = objectUrl; link.download = fileName; document.body.appendChild(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
      setPendingBackup({ fileName, size: blob.size, counts }); setProgress('تم تجهيز تنزيل النسخة. تحقق من وجود الملف في مجلد التنزيلات قبل توثيق العملية.'); notify('بدأ تنزيل النسخة الاحتياطية. تحقق من حفظها خارج المتصفح قبل التأكيد.', 'success');
    } catch (error) { setProgress(''); notify(error.message || 'فشل إنشاء النسخة الاحتياطية.', 'error'); }
    finally { setBusy(false); }
  }
  async function confirmBackup() {
    if (!pendingBackup || !confirmedSaved) return notify('ضع علامة التأكيد بعد التأكد من وجود ملف ZIP في التنزيلات.', 'error');
    setBusy(true);
    try { const { data, error } = await supabase.functions.invoke('admin-data-export', { body: { action: 'record_backup', confirmed_saved: true, file_name: pendingBackup.fileName, file_size_bytes: pendingBackup.size, row_counts: pendingBackup.counts } }); if (error || data?.error) throw new Error(data?.error || error?.message || 'تعذر تسجيل النسخ.'); notify('تم تسجيل عملية النسخ الاحتياطي في سجل الإدارة.', 'success'); setPendingBackup(null); setConfirmedSaved(false); await refreshHistory(); }
    catch (error) { notify(error.message || 'تعذر تسجيل النسخ الاحتياطي.', 'error'); }
    finally { setBusy(false); }
  }
  const lastBackup = history[0]?.created_at ? new Date(history[0].created_at) : null; const stale = !lastBackup || (Date.now() - lastBackup.getTime() > 24 * 60 * 60 * 1000);
  return <div className="panel settings-panel admin-backup-panel"><div className="settings-header"><div><span className="section-index">حماية البيانات</span><h2>النسخ الاحتياطي الدوري</h2><p>صدّر نسخة من جداول الإدارة والطلبات والبطاقات والجرد والتدقيق إلى ملف ZIP لتنزيله وحفظه خارج الموقع.</p></div><span className={`status-badge ${stale ? 'rejected' : 'approved'}`}>{stale ? 'النسخة اليومية مطلوبة' : 'سُجلت نسخة خلال آخر 24 ساعة'}</span></div><div className="important-warning"><strong>تنبيه حول ما تتضمنه النسخة</strong><p>تتضمن النسخة بيانات قاعدة البيانات وجداول البطاقات والجرد وسجل التدقيق، لكنها لا تتضمن ملفات PDF المحفوظة محليًا على أجهزة الفريق. احتفظ بأرشيف الإيصالات المشفر في وسيطين مستقلين. لا يستطيع المتصفح تنزيل نسخة دوريًا عندما يكون مغلقًا؛ يجب أن يضغط المدير على إنشاء النسخة كل يوم.</p></div><button className="primary-button" onClick={downloadBackup} disabled={busy}>{busy ? 'جارٍ إعداد النسخة…' : 'إنشاء وتنزيل نسخة احتياطية كاملة (ZIP)'}</button>{progress && <div className="notice notice-info" role="status">{progress}</div>}{pendingBackup && <div className="backup-confirm-box"><strong>تم إعداد الملف: {pendingBackup.fileName}</strong><p>الحجم: {fmt(pendingBackup.size)} بايت. الأعداد: {Object.entries(pendingBackup.counts).map(([k,v]) => `${k}: ${fmt(v)}`).join(' · ')}</p><label className="consent-check"><input type="checkbox" checked={confirmedSaved} onChange={(e) => setConfirmedSaved(e.target.checked)} /><span>تحققت أن ملف ZIP موجود في التنزيلات، واحتفظت بنسخة مستقلة أخرى.</span></label><button className="secondary-button" disabled={busy || !confirmedSaved} onClick={confirmBackup}>تأكيد الحفظ وتسجيله في سجل الإدارة</button></div>}<div className="daily-closing-history"><h3>سجل النسخ السابقة</h3>{historyError && <div className="notice notice-warning">{historyError}</div>}{history.length === 0 ? <p className="muted-line">لا توجد نسخ احتياطية موثقة بعد.</p> : <div className="table-scroll"><table className="applications-table"><thead><tr><th>التاريخ</th><th>المستخدم</th><th>الملف</th><th>الحجم</th><th>عدد السجلات</th></tr></thead><tbody>{history.map((item) => <tr key={item.id}><td>{humanDate(item.created_at)}</td><td>{item.actor_email}</td><td>{item.file_name}</td><td>{fmt(item.file_size_bytes || 0)} بايت</td><td>{Object.entries(item.row_counts || {}).map(([key,value]) => `${key}: ${fmt(value)}`).join(' · ')}</td></tr>)}</tbody></table></div>}</div></div>;
}

function StaffManagementPanel({ staffUser, catalog, notify }) {
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState('');
  const [newRole, setNewRole] = useState('reviewer');
  const [newScopes, setNewScopes] = useState([]);
  const [editor, setEditor] = useState(null);
  const [credentials, setCredentials] = useState(null);
  const units = catalog.units || [];
  const specs = catalog.specializations || [];

  const callStaff = useCallback(async (payload) => {
    const { data, error } = await supabase.functions.invoke('manage-staff', { body: payload });
    if (error) {
      let detail = null;
      try {
        if (error.context && typeof error.context.json === 'function') detail = await error.context.json();
      } catch { /* the response body may already have been consumed */ }
      throw new Error(detail?.error || error.message || 'تعذر تنفيذ عملية إدارة الفريق.');
    }
    if (data?.error) throw new Error(data.error);
    return data;
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await callStaff({ action: 'list' });
      setMembers(data.members || []);
    } catch (error) {
      notify(error.message || 'تعذر تحميل حسابات الفريق.', 'error');
    } finally { setLoading(false); }
  }, [callStaff, notify]);

  useEffect(() => { refresh(); }, [refresh]);

  function toAssignments(tokens) {
    const result = [];
    for (const token of tokens) {
      if (token.startsWith('unit:')) result.push({ academic_unit_id: token.slice(5), academic_specialization_id: null });
      if (token.startsWith('spec:')) {
        const spec = specs.find((item) => item.id === token.slice(5));
        if (spec) result.push({ academic_unit_id: spec.unit_id, academic_specialization_id: spec.id });
      }
    }
    const unitIds = new Set(result.filter((item) => !item.academic_specialization_id).map((item) => item.academic_unit_id));
    return result.filter((item) => !item.academic_specialization_id || !unitIds.has(item.academic_unit_id));
  }

  function tokensFromAssignments(assignments) {
    return (assignments || []).map((item) => item.academic_specialization_id ? `spec:${item.academic_specialization_id}` : `unit:${item.academic_unit_id}`);
  }

  function toggleToken(tokens, setTokens, token, checked, unitId = null) {
    setTokens((current) => {
      let next = current.filter((item) => item !== token);
      if (checked) next.push(token);
      if (token.startsWith('unit:')) {
        const targetUnit = token.slice(5);
        const children = specs.filter((spec) => spec.unit_id === targetUnit).map((spec) => `spec:${spec.id}`);
        next = next.filter((item) => !children.includes(item));
      } else if (token.startsWith('spec:') && checked && unitId) {
        next = next.filter((item) => item !== `unit:${unitId}`);
      }
      return [...new Set(next)];
    });
  }

  function renderScopePicker(tokens, setTokens, prefix) {
    return <div className="staff-scope-picker">{units.length === 0 ? <p className="muted-line">أضف الكليات والاختصاصات أولًا من تبويب «الكليات والاختصاصات».</p> : units.map((unit) => {
      const unitToken = `unit:${unit.id}`;
      const chosenWholeUnit = tokens.includes(unitToken);
      const unitSpecs = specs.filter((spec) => spec.unit_id === unit.id);
      return <div className="staff-scope-unit" key={`${prefix}-${unit.id}`}>
        <label className="staff-scope-check"><input type="checkbox" checked={chosenWholeUnit} onChange={(e) => toggleToken(tokens, setTokens, unitToken, e.target.checked)} /><span><strong>{unit.unit_type === 'institute' ? 'معهد' : 'كلية'}: {unit.name}</strong><small>تحديد الجهة كاملة يمنح الوصول لكل اختصاصاتها.</small></span></label>
        {unitSpecs.length > 0 && <div className="staff-scope-specs">{unitSpecs.map((spec) => <label key={spec.id} className="staff-scope-check staff-scope-child"><input type="checkbox" disabled={chosenWholeUnit} checked={tokens.includes(`spec:${spec.id}`)} onChange={(e) => toggleToken(tokens, setTokens, `spec:${spec.id}`, e.target.checked, unit.id)} /><span>{spec.name}</span></label>)}</div>}
      </div>;
    })}</div>;
  }

  function scopeLabels(assignments) {
    if (!assignments?.length) return 'لا توجد جهات محددة';
    return assignments.map((assignment) => {
      const unit = units.find((item) => item.id === assignment.academic_unit_id);
      const spec = specs.find((item) => item.id === assignment.academic_specialization_id);
      return unit ? `${unit.name}${spec ? ` — ${spec.name}` : ' (كل الاختصاصات)'}` : 'جهة غير موجودة';
    }).join('، ');
  }

  async function createStaff(event) {
    event.preventDefault();
    if (!email.trim()) return notify('أدخل البريد الإلكتروني للموظف.', 'error');
    const assignments = newRole === 'reviewer' ? toAssignments(newScopes) : [];
    if (newRole === 'reviewer' && assignments.length === 0) return notify('حدد كلية أو اختصاصًا واحدًا على الأقل للمراجع.', 'error');
    setBusy(true); setCredentials(null);
    try {
      const result = await callStaff({ action: 'create', email: email.trim().toLowerCase(), role: newRole, assignments });
      setCredentials({ email: result.email, password: result.temporary_password });
      setEmail(''); setNewScopes([]); setNewRole('reviewer');
      notify('تم إنشاء حساب الفريق. انسخ كلمة المرور المؤقتة الآن واحفظها بأمان.', 'success');
      await refresh();
    } catch (error) { notify(error.message || 'تعذر إنشاء الحساب.', 'error'); }
    finally { setBusy(false); }
  }

  function startEdit(member) {
    setEditor({ user_id: member.user_id, email: member.email, role: member.role, scopes: tokensFromAssignments(member.assignments) });
    setCredentials(null);
  }

  async function saveEdit() {
    if (!editor) return;
    const assignments = editor.role === 'reviewer' ? toAssignments(editor.scopes) : [];
    if (editor.role === 'reviewer' && assignments.length === 0) return notify('المراجع يحتاج إلى كلية أو اختصاص واحد على الأقل.', 'error');
    setBusy(true);
    try {
      await callStaff({ action: 'update', staff_id: editor.user_id, role: editor.role, assignments });
      notify('تم تحديث الدور وصلاحيات الوصول.', 'success'); setEditor(null); await refresh();
    } catch (error) { notify(error.message || 'تعذر تحديث الصلاحيات.', 'error'); }
    finally { setBusy(false); }
  }

  async function removeStaff(member) {
    if (member.user_id === staffUser.id) return notify('لا يمكنك حذف حسابك الحالي من هذه الشاشة.', 'error');
    if (!window.confirm(`هل تريد حذف حساب ${member.email} من فريق التنظيم؟ سيُمنع من تسجيل الدخول.`)) return;
    setBusy(true);
    try { await callStaff({ action: 'delete', staff_id: member.user_id }); notify('تم حذف حساب الفريق.', 'success'); await refresh(); }
    catch (error) { notify(error.message || 'تعذر حذف الحساب.', 'error'); }
    finally { setBusy(false); }
  }

  async function resetPassword(member) {
    if (!window.confirm(`إنشاء كلمة مرور مؤقتة جديدة للحساب ${member.email}؟ ستتوقف كلمة المرور القديمة عن العمل.`)) return;
    setBusy(true); setCredentials(null);
    try {
      const result = await callStaff({ action: 'reset_password', staff_id: member.user_id });
      setCredentials({ email: member.email, password: result.temporary_password });
      notify('تم إنشاء كلمة مرور جديدة. انسخها الآن وسلّمها للموظف عبر قناة آمنة.', 'success');
    } catch (error) { notify(error.message || 'تعذر إعادة تعيين كلمة المرور.', 'error'); }
    finally { setBusy(false); }
  }

  async function copyPassword() {
    if (!credentials?.password) return;
    try { await navigator.clipboard.writeText(credentials.password); notify('تم نسخ كلمة المرور المؤقتة.', 'success'); }
    catch { notify('تعذر النسخ الآلي؛ حدّد كلمة المرور وانسخها يدويًا.', 'info'); }
  }

  return <div className="panel settings-panel staff-management-panel">
    <div className="settings-header"><div><span className="section-index">أمان وصلاحيات</span><h2>حسابات فريق التنظيم</h2><p>أنشئ حسابًا لكل عضو، ثم حدّد له كلية كاملة أو اختصاصات محددة. صلاحيات الوصول تُفرض في قاعدة البيانات، وليست مجرد إخفاء للعناصر في الواجهة.</p></div><button type="button" className="secondary-button" onClick={refresh} disabled={loading || busy}>تحديث الحسابات ↻</button></div>
    {credentials && <div className="temporary-credential-box"><strong>كلمة المرور المؤقتة للحساب: {credentials.email}</strong><p>تُعرض هنا بعد الإنشاء أو إعادة التعيين فقط. انسخها واحفظها في مكان آمن؛ لن نخزنها أو نعرضها ثانية.</p><code dir="ltr">{credentials.password}</code><button type="button" className="secondary-button" onClick={copyPassword}>نسخ كلمة المرور</button><button type="button" className="text-delete" onClick={() => setCredentials(null)}>إخفاء</button></div>}
    <form className="staff-create-form" onSubmit={createStaff}>
      <h3>إنشاء حساب جديد</h3>
      <div className="staff-form-grid"><label className="field"><span>البريد الإلكتروني</span><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="off" placeholder="reviewer@example.com" /></label><label className="field"><span>الدور</span><select value={newRole} onChange={(e) => setNewRole(e.target.value)}><option value="reviewer">مراجع طلبات (حسب الكلية/الاختصاص)</option><option value="finance">مسؤول مالي (مطابقة وإقفال)</option><option value="gate">موظف بوابة (مسح QR وتسجيل الدخول)</option><option value="admin">مدير آخر</option></select></label></div>
      {newRole === 'reviewer' && <><div className="field"><span>الكليات والاختصاصات التي يمكنه الوصول إليها</span>{renderScopePicker(newScopes, setNewScopes, 'create')}</div><small className="muted-line">إن اخترت الكلية كاملة، فلا حاجة إلى اختيار اختصاصاتها منفردة. يمكن تحديد عدة جهات واختصاصات.</small></>}
      <button className="primary-button" disabled={busy || loading}><span>{busy ? 'جارٍ التنفيذ…' : 'إنشاء حساب وإصدار كلمة مرور مؤقتة'}</span></button>
    </form>
    <div className="staff-list-heading"><h3>أعضاء الفريق الحاليون</h3><span>{members.length} حساب</span></div>
    {loading ? <div className="empty-state">جارٍ تحميل حسابات الفريق…</div> : members.length === 0 ? <div className="empty-state">لا توجد حسابات فريق في نتيجة الاستعلام.</div> : <div className="staff-member-list">{members.map((member) => <article className="staff-member-card" key={member.user_id}>
      <div className="staff-member-head"><div><strong>{member.email || member.user_id}</strong><span className={`status-badge ${member.role === 'admin' ? 'approved' : 'pending'}`}>{{ admin: 'مدير', reviewer: 'مراجع', finance: 'مسؤول مالي', gate: 'موظف بوابة' }[member.role] || member.role}</span></div><small>{member.user_id === staffUser.id ? 'حسابك الحالي' : `أُنشئ في ${humanDate(member.created_at)}`}</small></div>
      <p className="staff-scope-summary">{member.role === 'admin' ? 'صلاحية كاملة على المنصة.' : member.role === 'finance' ? 'مطابقة التحويلات الفعلية وإقفال اليوم المالي؛ لا يمكنه تعديل الطلبات.' : member.role === 'gate' ? 'مسح QR وتسجيل دخول البطاقة مرة واحدة؛ لا يمكنه مراجعة الفواتير.' : scopeLabels(member.assignments)}</p>
      <div className="staff-member-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => startEdit(member)}>تعديل الدور والصلاحيات</button><button type="button" className="secondary-button" disabled={busy} onClick={() => resetPassword(member)}>إعادة تعيين كلمة المرور</button>{member.user_id !== staffUser.id && <button type="button" className="reject-button" disabled={busy} onClick={() => removeStaff(member)}>حذف الحساب</button>}</div>
      {editor?.user_id === member.user_id && <div className="staff-editor"><h4>تعديل صلاحيات {member.email}</h4><label className="field"><span>الدور</span><select value={editor.role} onChange={(e) => setEditor((old) => ({ ...old, role: e.target.value }))}><option value="reviewer">مراجع طلبات</option><option value="finance">مسؤول مالي</option><option value="gate">موظف بوابة</option><option value="admin">مدير</option></select></label>{editor.role === 'reviewer' && <div className="field"><span>نطاق الوصول</span>{renderScopePicker(editor.scopes, (updater) => setEditor((old) => ({ ...old, scopes: typeof updater === 'function' ? updater(old.scopes) : updater })), `edit-${member.user_id}`)}</div>}<div className="staff-member-actions"><button type="button" className="primary-button" disabled={busy} onClick={saveEdit}>حفظ الصلاحيات</button><button type="button" className="secondary-button" disabled={busy} onClick={() => setEditor(null)}>إلغاء</button></div></div>}
    </article>)}</div>}
  </div>;
}

function AdminDashboard({ staffUser, staffRole, settings, setSettings, refreshSettings, catalog, catalogError, refreshCatalog, notify, onSignOut }) {
  const [applications, setApplications] = useState([]);
  const [loading, setLoading] = useState(true);
  const [applicationsError, setApplicationsError] = useState('');
  const loadRequestRef = useRef(0);
  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [unitFilter, setUnitFilter] = useState('all');
  const [specializationFilter, setSpecializationFilter] = useState('all');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [pageNumber, setPageNumber] = useState(0);
  const [totalFiltered, setTotalFiltered] = useState(0);
  const pageSize = 50;
  const [selected, setSelected] = useState(null);
  const [rejectReason, setRejectReason] = useState('');
  const [savingDecision, setSavingDecision] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [localSettings, setLocalSettings] = useState(settings);
  const [tab, setTab] = useState('applications');
  const [receiptLink, setReceiptLink] = useState('');
  const [archiveDirectory, setArchiveDirectory] = useState(null);
  const [archiveProof, setArchiveProof] = useState(null);
  const [archiveConfirmed, setArchiveConfirmed] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [deletingApplication, setDeletingApplication] = useState(false);
  const [unitCapacityDrafts, setUnitCapacityDrafts] = useState({});
  const [newUnitName, setNewUnitName] = useState('');
  const [newUnitType, setNewUnitType] = useState('faculty');
  const [newSpecializationName, setNewSpecializationName] = useState('');
  const [specializationTargetUnit, setSpecializationTargetUnit] = useState('');
  const isAdmin = staffRole === 'admin';

  useEffect(() => setLocalSettings({ ...DEFAULT_SETTINGS, ...settings, payment_images: Array.isArray(settings.payment_images) ? settings.payment_images : [] }), [settings]);
  useEffect(() => { if (!isAdmin && ['settings', 'academic', 'team', 'audit', 'finance', 'backup', 'gate'].includes(tab)) setTab('applications'); }, [isAdmin, tab]);
  useEffect(() => {
    setUnitCapacityDrafts(Object.fromEntries((catalog.units || []).map((unit) => [unit.id, unit.registration_capacity == null ? '' : String(unit.registration_capacity)])));
  }, [catalog.units]);
  useEffect(() => {
    setArchiveProof(null);
    setArchiveConfirmed(false);
  }, [selected?.id]);

  const applyApplicationFilters = useCallback((query) => {
    let next = query;
    if (statusFilter !== 'all') next = next.eq('status', statusFilter);
    if (unitFilter !== 'all') next = next.eq('academic_unit_id', unitFilter);
    if (specializationFilter !== 'all') next = next.eq('academic_specialization_id', specializationFilter);
    if (fromDate) {
      const startDate = new Date(`${fromDate}T00:00:00`);
      if (!Number.isNaN(startDate.getTime())) next = next.gte('created_at', startDate.toISOString());
    }
    if (toDate) {
      const endDate = new Date(`${toDate}T00:00:00`);
      if (!Number.isNaN(endDate.getTime())) { endDate.setDate(endDate.getDate() + 1); next = next.lt('created_at', endDate.toISOString()); }
    }
    const term = search.trim().replace(/[%,()\\."'`;:*]/g, ' ').replace(/\s+/g, ' ').trim();
    if (term) {
      const pattern = `%${term}%`;
      next = next.or(`full_name.ilike.${pattern},university_number.ilike.${pattern},phone_number.ilike.${pattern},tracking_code.ilike.${pattern},department.ilike.${pattern},specialization.ilike.${pattern}`);
    }
    return next;
  }, [statusFilter, unitFilter, specializationFilter, fromDate, toDate, search]);

  const loadApplications = useCallback(async () => {
    const requestId = ++loadRequestRef.current;
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 25000);
    setLoading(true);
    setApplicationsError('');
    try {
      const query = applyApplicationFilters(supabase.from('applications'));
      const { data, error, count } = await query
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(pageNumber * pageSize, pageNumber * pageSize + pageSize - 1)
        .abortSignal(controller.signal);
      if (requestId !== loadRequestRef.current) return;
      if (error) throw error;
      setApplications(data || []);
      setTotalFiltered(count || 0);
    } catch (error) {
      if (requestId !== loadRequestRef.current) return;
      const message = error?.name === 'AbortError'
        ? 'استغرق البحث أكثر من 25 ثانية. تحقق من الاتصال ثم أعد المحاولة.'
        : `تعذر تحميل الطلبات المطابقة: ${error?.message || 'خطأ غير معروف'}`;
      setApplications([]);
      setTotalFiltered(0);
      setApplicationsError(message);
      notify(message, 'error');
    } finally {
      window.clearTimeout(timeoutId);
      if (requestId === loadRequestRef.current) setLoading(false);
    }
  }, [applyApplicationFilters, notify, pageNumber]);
  useEffect(() => { loadApplications(); }, [loadApplications]);
  useEffect(() => { if (selected) setSelected(applications.find((item) => item.id === selected.id) || selected); }, [applications]);

  async function fetchAllFilteredApplications() {
    const all = [];
    let offset = 0;
    const chunkSize = 1000;
    while (true) {
      const query = applyApplicationFilters(supabase.from('applications'));
      const { data, error } = await query.select('*').order('created_at', { ascending: false }).range(offset, offset + chunkSize - 1);
      if (error) throw new Error('تعذر تحميل كامل النتائج للتصدير: ' + error.message);
      all.push(...(data || []));
      if (!data || data.length < chunkSize) break;
      offset += chunkSize;
    }
    return all;
  }

  const filtered = applications;
  const counts = {
    all: totalFiltered,
    awaiting_payment: applications.filter((a) => a.status === 'awaiting_payment').length,
    pending: applications.filter((a) => a.status === 'pending').length,
    approved: applications.filter((a) => a.status === 'approved').length,
    rejected: applications.filter((a) => a.status === 'rejected').length,
  };

  async function decide(status) {
    if (!selected) return;
    if (!selected.receipt_path) return notify('لا توجد فاتورة سحابية متاحة لهذا الطلب. إذا كانت مؤرشفة محليًا، افتح ملف الأرشيف من الجهاز الذي حُفظ عليه.', 'error');
    if (status === 'rejected' && rejectReason.trim().length < 3) return notify('اكتب سبب الرفض ليظهر للطالب عند تتبع الطلب.', 'error');
    if (status === 'approved') {
      if (!archiveProof || archiveProof.applicationId !== selected.id) return notify('قبل الموافقة، افتح الفاتورة ليُنشأ ملف PDF يحتوي بيانات الطالب والوصل ويحفظ في الأرشيف المحلي.', 'error');
      if (!archiveConfirmed) return notify('أكد أن ملف الأرشيف محفوظ في الجهاز وأنك احتفظت بنسخة احتياطية أخرى قبل حذف الوصل السحابي.', 'error');
    }
    setSavingDecision(true);
    try {
      if (status === 'approved') {
        const { data, error } = await supabase.functions.invoke('approve-archived-application', { body: {
          application_id: selected.id,
          archive_file_name: archiveProof.fileName,
          archive_relative_path: archiveProof.relativePath,
          archive_mode: archiveProof.mode,
          archive_sha256: archiveProof.archiveSha256,
          archive_size_bytes: archiveProof.archiveSizeBytes,
          receipt_sha256: archiveProof.receiptSha256,
          receipt_size_bytes: archiveProof.receiptSizeBytes,
          archive_confirmed: true,
          backup_confirmed: true,
        } });
        if (error || data?.error) throw new Error(data?.error || error?.message || 'تعذر الموافقة أو حذف الوصل السحابي.');
        notify('تمت الموافقة على الطلب وحُذف الوصل من التخزين السحابي بعد حفظ الأرشيف. بقيت بيانات الطالب وبطاقات الدخول.', 'success');
        setArchiveProof(null); setArchiveConfirmed(false);
      } else {
        const { error } = await supabase.from('applications').update({ status: 'rejected', rejection_reason: rejectReason.trim(), reviewed_by: staffUser.id, reviewed_at: new Date().toISOString() }).eq('id', selected.id);
        if (error) throw error;
        notify('تم رفض الطلب وحفظ السبب. بقيت الفاتورة في التخزين حتى يحذفها المدير.', 'success');
        setRejectReason('');
      }
      await loadApplications();
    } catch (error) { notify(error.message || 'تعذر حفظ القرار.', 'error'); }
    finally { setSavingDecision(false); }
  }

  async function chooseArchiveDirectory() {
    if (typeof window.showDirectoryPicker !== 'function') {
      return notify('هذا المتصفح لا يدعم الكتابة المباشرة إلى مجلد. سيُنزل ملف الأرشيف إلى مجلد التنزيلات بدلًا من ذلك.', 'warning');
    }
    try {
      const handle = await window.showDirectoryPicker({ id: 'latakia-receipt-archive', mode: 'readwrite', startIn: 'desktop' });
      if (handle.requestPermission) {
        const permission = await handle.requestPermission({ mode: 'readwrite' });
        if (permission !== 'granted') throw new Error('لم يتم منح إذن الكتابة إلى المجلد.');
      }
      setArchiveDirectory(handle);
      notify(`تم تحديد مجلد أساس للأرشيف: ${handle.name}. سيُنشئ الموقع داخله مجلد الإيصالات تلقائيًا.`, 'success');
    } catch (error) {
      if (error?.name !== 'AbortError') notify(error.message || 'تعذر اختيار مجلد الأرشيف.', 'error');
    }
  }

  async function openReceipt() {
    if (!selected?.receipt_path) return notify('لم يرفع الطالب الفاتورة بعد أو أنها حُذفت بعد الأرشفة.', 'info');
    const reviewTab = window.open('about:blank', '_blank');
    setArchiveBusy(true); setArchiveProof(null); setArchiveConfirmed(false);
    try {
      const { data: receiptBlob, error } = await supabase.storage.from('receipts').download(selected.receipt_path);
      if (error || !receiptBlob) throw new Error('تعذر تنزيل الفاتورة من التخزين الآمن: ' + (error?.message || 'الملف غير موجود.'));
      const receiptObjectUrl = URL.createObjectURL(receiptBlob);
      if (reviewTab) reviewTab.location.href = receiptObjectUrl;
      else notify('تم تنزيل الفاتورة. اسمح بالنوافذ المنبثقة إن أردت فتح الأصل في تبويب مستقل.', 'info');
      window.setTimeout(() => URL.revokeObjectURL(receiptObjectUrl), 10 * 60 * 1000);

      const archiveBlob = await createReceiptArchivePdf(selected, receiptBlob, settings);
      const archiveHash = await sha256Blob(archiveBlob);
      const receiptHash = await sha256Blob(receiptBlob);
      const filename = `${safeArchiveFilename(selected.tracking_code)}_${safeArchiveFilename(selected.full_name)}.pdf`;
      let relativePath = `تنزيلات المتصفح/${filename}`;
      let mode = 'download';
      if (archiveDirectory) {
        try {
          const saved = await saveArchiveToDirectory(archiveDirectory, selected, archiveBlob);
          relativePath = saved.relativePath; mode = 'directory';
        } catch (saveError) {
          downloadArchiveBlob(archiveBlob, filename);
          mode = 'download';
          relativePath = `تنزيلات المتصفح/${filename}`;
          notify('تعذرت الكتابة إلى المجلد المحدد؛ بدأ تنزيل ملف الأرشيف كبديل. تحقق من حفظه قبل الموافقة.', 'warning');
        }
      } else {
        downloadArchiveBlob(archiveBlob, filename);
        notify('تم تجهيز ملف PDF للأرشفة وتنزيله. اختر مجلدًا في المرة القادمة لكتابته مباشرة، وتحقق من حفظه قبل الموافقة.', 'info');
      }
      setArchiveProof({ applicationId: selected.id, fileName: filename, relativePath, mode, archiveSha256: archiveHash, archiveSizeBytes: archiveBlob.size, receiptSha256: receiptHash, receiptSizeBytes: receiptBlob.size });
    } catch (error) {
      if (reviewTab) reviewTab.close();
      notify(error.message || 'تعذر فتح الفاتورة أو إنشاء ملف الأرشفة.', 'error');
    } finally { setArchiveBusy(false); }
  }

  async function deleteSelectedReceipt() {
    if (!isAdmin || !selected || selected.status !== 'rejected' || !selected.receipt_path) return;
    if (!archiveProof || archiveProof.applicationId !== selected.id || !archiveConfirmed) return notify('افتح الفاتورة أولًا وأنشئ ملف الأرشيف، ثم أكد حفظ نسختين قبل الحذف.', 'error');
    if (!window.confirm(`حذف فاتورة الطلب ${selected.tracking_code} من التخزين السحابي؟ ستبقى بيانات الطالب محفوظة.`)) return;
    setDeletingApplication(true);
    try {
      const { data, error } = await supabase.functions.invoke('delete-rejected-receipt', { body: { application_id: selected.id, archive_file_name: archiveProof?.fileName, archive_relative_path: archiveProof?.relativePath, archive_mode: archiveProof?.mode, archive_sha256: archiveProof?.archiveSha256, archive_size_bytes: archiveProof?.archiveSizeBytes, receipt_sha256: archiveProof?.receiptSha256, receipt_size_bytes: archiveProof?.receiptSizeBytes, archive_confirmed: archiveConfirmed, backup_confirmed: archiveConfirmed } });
      if (error || data?.error) throw new Error(data?.error || error?.message || 'تعذر حذف الفاتورة.');
      notify('حُذفت فاتورة الطلب المرفوض من السحابة بعد حفظ بيانات الأرشيف، وبقي سجل الطالب محفوظًا. احتفظوا بالنسخ المحلية حسب سياسة الأرشفة.', 'success');
      setArchiveProof(null); setArchiveConfirmed(false);
      await loadApplications();
    } catch (error) { notify(error.message || 'تعذر حذف الفاتورة.', 'error'); }
    finally { setDeletingApplication(false); }
  }

  async function deleteSelectedApplication() {
    if (!isAdmin || !selected) return;
    const confirmed = window.confirm(`تحذير نهائي: حذف كامل سجل الطالب ${selected.full_name} ورمز التتبع ${selected.tracking_code}؟ سيتم حذف الفاتورة السحابية وبطاقات الدخول المرتبطة. أي ملف أرشيف محفوظ يدويًا على أجهزة الفريق لن يُحذف تلقائيًا، ويجب حذفه يدويًا حسب سياسة الاحتفاظ. لا يمكن التراجع.`);
    if (!confirmed) return;
    setDeletingApplication(true);
    try {
      const { data, error } = await supabase.functions.invoke('delete-application', { body: { application_id: selected.id, confirm: true } });
      if (error || data?.error) throw new Error(data?.error || error?.message || 'تعذر حذف سجل الطالب.');
      notify('تم حذف سجل الطالب والملفات السحابية المرتبطة به. تذكّر أن نسخ الأرشيف المحلية على أجهزة الفريق لا تُحذف تلقائيًا.', 'success');
      setSelected(null); setArchiveProof(null); setArchiveConfirmed(false);
      await loadApplications();
    } catch (error) { notify(error.message || 'تعذر حذف سجل الطالب.', 'error'); }
    finally { setDeletingApplication(false); }
  }

  async function saveSettings(event) {
    event.preventDefault();
    if (!isAdmin) return notify('تعديل الإعدادات متاح للمدير فقط.', 'error');
    setSavingSettings(true);
    const dataToSave = {
      event_title: localSettings.event_title.trim(),
      batch_name: String(localSettings.batch_name || '').trim() || 'دفعة البناء والتأسيس 2026',
      event_location: String(localSettings.event_location || '').trim(),
      event_date: localSettings.event_date || null,
      university_label: localSettings.university_label.trim(),
      organizer: localSettings.organizer.trim(),
      registration_open: Boolean(localSettings.registration_open),
      student_fee: Number(localSettings.student_fee),
      companion_fee: Number(localSettings.companion_fee),
      max_companions: Number(localSettings.max_companions),
      max_carried_subjects: Number(localSettings.max_carried_subjects),
      shamcash_account: localSettings.shamcash_account.trim(),
      payment_instructions: localSettings.payment_instructions.trim(),
      qr_image_url: localSettings.qr_image_url || null,
      payment_images: Array.isArray(localSettings.payment_images) ? localSettings.payment_images : [],
      updated_at: new Date().toISOString(),
    };
    const { error } = await supabase.from('event_settings').update(dataToSave).eq('id', 1);
    if (error) notify('تعذر حفظ الإعدادات: ' + error.message, 'error');
    else { notify('تم حفظ إعدادات التسجيل والدفع.', 'success'); await refreshSettings(); }
    setSavingSettings(false);
  }

  async function uploadQr(file) {
    if (!file) return;
    if (!isAdmin) return notify('رفع صور الدفع متاح للمدير فقط.', 'error');
    if (!file.type.startsWith('image/')) return notify('اختر ملف صورة لرمز QR.', 'error');
    if (file.size > 3 * 1024 * 1024) return notify('حجم صورة QR يجب ألا يتجاوز 3 ميغابايت.', 'error');
    const ext = file.name.split('.').pop()?.toLowerCase() || 'png';
    const path = `qr-code-${crypto.randomUUID()}.${ext}`;
    const { error } = await supabase.storage.from('event-assets').upload(path, file, { upsert: false, contentType: file.type });
    if (error) return notify('تعذر رفع صورة QR: ' + error.message, 'error');
    const { data } = supabase.storage.from('event-assets').getPublicUrl(path);
    setLocalSettings((old) => ({ ...old, qr_image_url: data.publicUrl }));
    notify('تم رفع صورة QR. اضغط حفظ الإعدادات لنشرها.', 'success');
  }

  async function uploadPaymentImages(files) {
    if (!files?.length) return;
    if (!isAdmin) return notify('رفع الصور التوضيحية متاح للمدير فقط.', 'error');
    const existing = Array.isArray(localSettings.payment_images) ? localSettings.payment_images : [];
    if (existing.length + files.length > 8) return notify('الحد الأقصى للصور التوضيحية هو 8 صور.', 'error');
    const urls = [];
    for (const file of files) {
      if (!file.type.startsWith('image/')) return notify(`الملف ${file.name} ليس صورة.`, 'error');
      if (file.size > 3 * 1024 * 1024) return notify(`حجم الصورة ${file.name} يتجاوز 3 ميغابايت.`, 'error');
      const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg';
      const path = `payment-guides/${crypto.randomUUID()}.${ext}`;
      const { error } = await supabase.storage.from('event-assets').upload(path, file, { upsert: false, contentType: file.type });
      if (error) return notify(`تعذر رفع الصورة ${file.name}: ${error.message}`, 'error');
      const { data } = supabase.storage.from('event-assets').getPublicUrl(path);
      urls.push(data.publicUrl);
    }
    setLocalSettings((old) => ({ ...old, payment_images: [...(Array.isArray(old.payment_images) ? old.payment_images : []), ...urls] }));
    notify('تم رفع الصور التوضيحية. اضغط حفظ الإعدادات لإظهارها للطلاب.', 'success');
  }

  async function saveUnitCapacity(unit) {
    if (!isAdmin) return notify('تحديد السعة متاح للمدير فقط.', 'error');
    const raw = String(unitCapacityDrafts[unit.id] ?? '').trim();
    const capacity = raw === '' ? null : Number(raw);
    if (capacity !== null && (!Number.isInteger(capacity) || capacity < 1 || capacity > 1000000)) return notify('أدخل حدًا صحيحًا بين 1 و1,000,000 أو اترك الحقل فارغًا بلا حد.', 'error');
    const { error } = await supabase.from('academic_units').update({ registration_capacity: capacity }).eq('id', unit.id);
    if (error) return notify('تعذر حفظ سعة الجهة: ' + error.message, 'error');
    notify(capacity === null ? 'تم إلغاء الحد الأقصى لهذه الجهة.' : `تم حفظ الحد الأقصى ${fmt(capacity)} طلب لهذه الجهة. سيغلق التسجيل تلقائيًا عند بلوغه.`, 'success');
    await refreshCatalog();
  }

  async function addUnit(event) {
    event.preventDefault();
    if (!newUnitName.trim()) return;
    const { error } = await supabase.from('academic_units').insert({ name: newUnitName.trim(), unit_type: newUnitType, is_open: true });
    if (error) return notify(error.code === '23505' ? 'هذه الكلية أو المعهد مضاف مسبقاً.' : 'تعذر إضافة الجهة الدراسية: ' + error.message, 'error');
    setNewUnitName(''); notify('تمت إضافة الجهة الدراسية.', 'success'); await refreshCatalog();
  }

  async function toggleUnit(unit, isOpen) {
    const { error } = await supabase.from('academic_units').update({ is_open: isOpen }).eq('id', unit.id);
    if (error) return notify('تعذر تغيير حالة التسجيل: ' + error.message, 'error');
    notify(isOpen ? 'تم فتح التسجيل لهذه الجهة.' : 'تم إيقاف التسجيل لهذه الجهة.', 'success'); await refreshCatalog();
  }

  async function deleteUnit(unit) {
    if (!window.confirm(`هل أنت متأكد من حذف ${unit.name}؟ سيتم حذف الاختصاصات المرتبطة بها من قائمة الاختيار، ولن تُحذف الطلبات السابقة.`)) return;
    const { error } = await supabase.from('academic_units').delete().eq('id', unit.id);
    if (error) return notify('تعذر حذف الجهة: ' + error.message, 'error');
    notify('تم حذف الجهة من قائمة التسجيل.', 'success'); await refreshCatalog();
  }

  async function addSpecialization(event) {
    event.preventDefault();
    if (!specializationTargetUnit || !newSpecializationName.trim()) return notify('اختر كلية أو معهداً واكتب اسم الاختصاص.', 'error');
    const { error } = await supabase.from('academic_specializations').insert({ unit_id: specializationTargetUnit, name: newSpecializationName.trim(), is_open: true });
    if (error) return notify(error.code === '23505' ? 'هذا الاختصاص مضاف لهذه الجهة مسبقاً.' : 'تعذر إضافة الاختصاص: ' + error.message, 'error');
    setNewSpecializationName(''); notify('تمت إضافة الاختصاص.', 'success'); await refreshCatalog();
  }

  async function toggleSpecialization(spec, isOpen) {
    const { error } = await supabase.from('academic_specializations').update({ is_open: isOpen }).eq('id', spec.id);
    if (error) return notify('تعذر تغيير حالة الاختصاص: ' + error.message, 'error');
    notify(isOpen ? 'تم فتح التسجيل للاختصاص.' : 'تم إيقاف التسجيل للاختصاص.', 'success'); await refreshCatalog();
  }

  async function deleteSpecialization(spec) {
    if (!window.confirm(`هل تريد حذف الاختصاص «${spec.name}» من قائمة التسجيل؟ لن تتأثر الطلبات السابقة.`)) return;
    const { error } = await supabase.from('academic_specializations').delete().eq('id', spec.id);
    if (error) return notify('تعذر حذف الاختصاص: ' + error.message, 'error');
    notify('تم حذف الاختصاص من القائمة.', 'success'); await refreshCatalog();
  }

  const exportColumns = [
    ['full_name', 'اسم الخريج'], ['university_number', 'الرقم الجامعي'], ['phone_number', 'رقم الهاتف'],
    ['department', 'الكلية أو المعهد'], ['specialization', 'الاختصاص'], ['carried_subjects', 'المواد المحمولة'],
    ['companions', 'عدد المرافقين'], ['amount_syp', 'المبلغ ل.س'], ['status', 'حالة الطلب'],
    ['tracking_code', 'رمز التتبع'], ['created_at', 'تاريخ التسجيل'],
  ];
  const statusArabic = (status) => STATUS[status]?.label || status || '';
  const csvEscape = (value) => {
    let raw = String(value ?? '');
    if (/^[=+@\-\t\r]/.test(raw)) raw = `'${raw}`; // protect spreadsheet users from formula injection
    return `"${raw.replaceAll('"', '""')}"`;
  };
  const downloadBlob = (blob, filename) => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);
  };

  async function exportCsv() {
    notify('جارٍ تجهيز جميع النتائج المطابقة للتصدير، وقد يستغرق ذلك بعض الوقت للبيانات الكبيرة.', 'info');
    try {
      const rows = await fetchAllFilteredApplications();
      const csv = '\uFEFF' + [exportColumns.map(([, label]) => csvEscape(label)).join(','), ...rows.map((row) => exportColumns.map(([key]) => csvEscape(key === 'status' ? statusArabic(row[key]) : key === 'created_at' ? humanDate(row[key]) : row[key])).join(','))].join('\r\n');
      downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8;' }), `graduation-applications-${new Date().toISOString().slice(0, 10)}.csv`);
      notify(`تم تصدير ${fmt(rows.length)} سجلًا. الملف CSV متوافق مع Excel ويفتح مباشرة فيه.`, 'success');
    } catch (error) { notify(error.message || 'تعذر تصدير النتائج.', 'error'); }
  }

  async function exportPdf() {
    const printWindow = window.open('', '_blank');
    if (!printWindow) return notify('يرجى السماح بالنوافذ المنبثقة لهذا الموقع حتى تتمكن من إنشاء تقرير PDF.', 'error');
    printWindow.document.write('<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>تقرير بوابة التخرج</title><body style="font-family:Arial,sans-serif;padding:24px">جارٍ تجهيز التقرير…</body></html>');
    try {
      const rows = await fetchAllFilteredApplications();
      if (rows.length > 5000 && !window.confirm(`التقرير يحتوي على ${fmt(rows.length)} سجلًا وقد ينتج PDF طويلًا. هل تريد المتابعة؟`)) { printWindow.close(); return; }
      const esc = (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
      const body = rows.map((row, index) => `<tr><td>${index + 1}</td><td>${esc(row.full_name)}</td><td>${esc(row.university_number)}</td><td>${esc(row.department)}</td><td>${esc(row.specialization || 'لا يوجد اختصاص')}</td><td>${esc(row.companions ?? 0)}</td><td>${esc(statusArabic(row.status))}</td><td class="check"></td></tr>`).join('');
      const selectedUnitName = (catalog.units || []).find((unit) => unit.id === unitFilter)?.name;
      const selectedSpecName = (catalog.specializations || []).find((spec) => spec.id === specializationFilter)?.name;
      const title = `قائمة تدقيق بوابة التخرج — ${settings.batch_name || DEFAULT_SETTINGS.batch_name}`;
      printWindow.document.open();
      printWindow.document.write(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>${esc(title)}</title><style>@page{size:A4 landscape;margin:12mm}body{font-family:Arial,Tahoma,sans-serif;color:#222}h1{font-size:20px;margin:0 0 8px}p{font-size:12px;margin:4px 0 12px}.meta{display:flex;gap:18px;flex-wrap:wrap;margin-bottom:14px;font-size:11px}table{width:100%;border-collapse:collapse;font-size:10px}th,td{border:1px solid #999;padding:6px;text-align:right;vertical-align:top}th{background:#eee}.check{width:80px;height:22px}@media print{tr{break-inside:avoid}}</style></head><body><h1>${esc(title)}</h1><div class="meta"><span>عدد السجلات: ${esc(rows.length)}</span><span>الحالة: ${esc(statusFilter === 'all' ? 'كل الحالات' : statusArabic(statusFilter))}</span><span>الكلية/المعهد: ${esc(selectedUnitName || 'الكل')}</span><span>الاختصاص: ${esc(selectedSpecName || 'الكل')}</span><span>تاريخ التصدير: ${esc(new Date().toLocaleDateString('ar-SY'))}</span></div><table><thead><tr><th>#</th><th>اسم الخريج</th><th>الرقم الجامعي</th><th>الكلية/المعهد</th><th>الاختصاص</th><th>المرافقون</th><th>الحالة</th><th>تدقيق البوابة</th></tr></thead><tbody>${body}</tbody></table><script>window.onload=()=>setTimeout(()=>window.print(),300)</script></body></html>`);
      printWindow.document.close();
    } catch (error) { printWindow.close(); notify(error.message || 'تعذر إنشاء تقرير PDF.', 'error'); }
  }

  const units = catalog.units || [];
  const specs = catalog.specializations || [];
  return <section className="container admin-page">
    <div className="admin-welcome"><div><span className="section-index">لوحة إدارة التسجيل</span><h1>مرحباً بفريق التنظيم</h1><p>راجع الطلبات، تحقق من الفواتير، واضبط خيارات التسجيل بحسب الكليات والمعاهد.</p></div><button className="secondary-button" onClick={onSignOut}>تسجيل الخروج ↗</button></div>
    <div className="admin-tabs"><button className={tab === 'applications' ? 'active' : ''} onClick={() => setTab('applications')}>الطلبات <span>{counts.pending}</span></button>{isAdmin && <><button className={tab === 'gate' ? 'active' : ''} onClick={() => setTab('gate')}>بوابة الدخول</button><button className={tab === 'finance' ? 'active' : ''} onClick={() => setTab('finance')}>الجرد المالي</button><button className={tab === 'audit' ? 'active' : ''} onClick={() => setTab('audit')}>سجل التدقيق</button><button className={tab === 'backup' ? 'active' : ''} onClick={() => setTab('backup')}>النسخ الاحتياطي</button><button className={tab === 'team' ? 'active' : ''} onClick={() => setTab('team')}>فريق التنظيم</button><button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>الرسوم والدفع</button><button className={tab === 'academic' ? 'active' : ''} onClick={() => setTab('academic')}>الكليات والاختصاصات</button></>}</div>
    {tab === 'applications' && <>
      <div className="stats-grid admin-stats-five"><div className="stat-card"><span>إجمالي النتائج المطابقة</span><strong>{fmt(counts.all)}</strong><small>بحسب الفلاتر الحالية</small></div><div className="stat-card stat-pending"><span>بانتظار الفاتورة</span><strong>{fmt(counts.awaiting_payment)}</strong><small>في الصفحة المعروضة</small></div><div className="stat-card stat-pending"><span>قيد التدقيق</span><strong>{fmt(counts.pending)}</strong><small>في الصفحة المعروضة</small></div><div className="stat-card stat-approved"><span>تمت الموافقة</span><strong>{fmt(counts.approved)}</strong><small>في الصفحة المعروضة</small></div><div className="stat-card stat-rejected"><span>مرفوضة</span><strong>{fmt(counts.rejected)}</strong><small>في الصفحة المعروضة</small></div></div>
      <div className="panel applications-panel">
        <div className="applications-toolbar"><div><h2>طلبات التسجيل</h2><span>{fmt(totalFiltered)} نتيجة مطابقة</span></div><div className="export-actions"><button className="secondary-button export-button" onClick={exportCsv}>تصدير Excel (CSV) ⇩</button><button className="secondary-button export-button" onClick={exportPdf}>تقرير PDF / طباعة</button></div></div>
        <div className="advanced-filter-grid">
          <label className="field search-field"><span>بحث شامل</span><input value={searchInput} onChange={(e) => setSearchInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); setPageNumber(0); setSearch(searchInput); } }} placeholder="الاسم أو الرقم أو الهاتف أو رمز التتبع" /></label>
          <label className="field"><span>حالة الطلب</span><select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPageNumber(0); }}><option value="all">كل الحالات</option><option value="awaiting_payment">بانتظار الفاتورة</option><option value="pending">قيد التدقيق</option><option value="approved">تمت الموافقة</option><option value="rejected">مرفوض</option></select></label>
          <label className="field"><span>الكلية أو المعهد</span><select value={unitFilter} onChange={(e) => { setUnitFilter(e.target.value); setSpecializationFilter('all'); setPageNumber(0); }}><option value="all">كل الكليات والمعاهد</option>{(catalog.units || []).map((unit) => <option key={unit.id} value={unit.id}>{unit.name}</option>)}</select></label>
          <label className="field"><span>الاختصاص</span><select value={specializationFilter} onChange={(e) => { setSpecializationFilter(e.target.value); setPageNumber(0); }}><option value="all">كل الاختصاصات</option>{(catalog.specializations || []).filter((spec) => unitFilter === 'all' || spec.unit_id === unitFilter).map((spec) => <option key={spec.id} value={spec.id}>{spec.name}</option>)}</select></label>
          <label className="field"><span>من تاريخ</span><input type="date" value={fromDate} onChange={(e) => { setFromDate(e.target.value); setPageNumber(0); }} /></label>
          <label className="field"><span>إلى تاريخ</span><input type="date" value={toDate} min={fromDate || undefined} onChange={(e) => { setToDate(e.target.value); setPageNumber(0); }} /></label>
          <div className="advanced-filter-actions"><button className="primary-button" type="button" onClick={() => { setPageNumber(0); setSearch(searchInput); }}>تطبيق البحث</button><button className="secondary-button" type="button" onClick={() => { setSearch(''); setSearchInput(''); setStatusFilter('all'); setUnitFilter('all'); setSpecializationFilter('all'); setFromDate(''); setToDate(''); setPageNumber(0); }}>إلغاء الفلاتر</button><button className="refresh-button" type="button" onClick={loadApplications} title="تحديث النتائج">↻</button></div>
        </div>
        {loading ? <div className="empty-state filter-loading-state" role="status"><span className="filter-spinner" aria-hidden="true" /><strong>{search || statusFilter !== 'all' || unitFilter !== 'all' || specializationFilter !== 'all' || fromDate || toDate ? 'جارٍ البحث عن الطلبات المطابقة…' : 'جارٍ تحميل الطلبات…'}</strong><p>تستغرق الاستجابة عادةً بضع ثوانٍ.</p></div> : applicationsError ? <div className="notice notice-warning filter-error-state" role="alert"><strong>تعذر إكمال البحث</strong><p>{applicationsError}</p><button className="secondary-button" type="button" onClick={loadApplications}>إعادة المحاولة</button></div> : filtered.length === 0 ? <div className="empty-state"><span>⌕</span><strong>لا توجد طلبات مطابقة</strong><p>عدّل البحث أو الفلاتر لعرض نتائج أخرى.</p></div> : <div className="table-scroll"><table className="applications-table"><thead><tr><th>الطالب / الرمز</th><th>الكلية / الاختصاص</th><th>المبلغ</th><th>الحالة</th><th>التاريخ</th></tr></thead><tbody>{filtered.map((item) => <tr key={item.id} className={selected?.id === item.id ? 'selected-row' : ''} onClick={() => { setSelected(item); setRejectReason(item.rejection_reason || ''); setReceiptLink(''); }}><td><strong>{item.full_name}</strong><small>{item.tracking_code} · {item.university_number}</small><small>{item.phone_number || '—'}</small></td><td><span>{item.department}</span><small>{item.specialization}</small></td><td><strong>{fmt(item.amount_syp)} ل.س</strong><small>{fmt(item.companions)} مرافق · {fmt(item.carried_subjects)} مادة محمولة</small></td><td><span className={`status-badge ${STATUS[item.status]?.className || 'pending'}`}>{STATUS[item.status]?.label || item.status}</span></td><td>{humanDate(item.created_at)}</td></tr>)}</tbody></table></div>}
        <div className="pagination-row"><span>عرض {fmt(filtered.length ? pageNumber * pageSize + 1 : 0)}–{fmt(Math.min((pageNumber + 1) * pageSize, totalFiltered))} من {fmt(totalFiltered)}</span><div><button className="secondary-button" type="button" disabled={pageNumber <= 0 || loading} onClick={() => setPageNumber((old) => Math.max(0, old - 1))}>السابق</button><strong>صفحة {fmt(pageNumber + 1)} من {fmt(Math.max(1, Math.ceil(totalFiltered / pageSize)))}</strong><button className="secondary-button" type="button" disabled={(pageNumber + 1) * pageSize >= totalFiltered || loading} onClick={() => setPageNumber((old) => old + 1)}>التالي</button></div></div>
      </div>
      <div className="panel review-panel">
        {selected ? (
          <>
            <div className="review-top">
              <span className="section-index">تفاصيل الطلب</span>
              <span className={`status-badge ${STATUS[selected.status]?.className || 'pending'}`}>{STATUS[selected.status]?.label || selected.status}</span>
            </div>
            <h2>{selected.full_name}</h2>
            <div className="review-code" dir="ltr">{selected.tracking_code}</div>
            <div className="review-details">
              <div><span>الرقم الجامعي</span><strong>{selected.university_number}</strong></div>
              <div><span>هاتف التواصل</span><strong>{selected.phone_number || '—'}</strong></div>
              <div><span>الكلية أو المعهد</span><strong>{selected.department}</strong></div>
              <div><span>الاختصاص</span><strong>{selected.specialization || 'لا يوجد اختصاص'}</strong></div>
              <div><span>المواد المحمولة</span><strong>{fmt(selected.carried_subjects)}</strong></div>
              <div><span>عدد المرافقين</span><strong>{fmt(selected.companions)}</strong></div>
              <div><span>المبلغ الإجمالي</span><strong>{fmt(selected.amount_syp)} ل.س</strong></div>
              <div><span>تاريخ الطلب</span><strong>{humanDate(selected.created_at)}</strong></div>
            </div>
            {selected.receipt_path ? (
              <div className="receipt-archive-tools">
                <div className="receipt-archive-header">
                  <strong>أرشفة الفاتورة على هذا الجهاز</strong>
                  <small>سيُنشأ PDF يبدأ ببيانات الطالب ويضم صفحات فاتورة شام كاش الأصلية. يبقى الوصل سحابيًا حتى الموافقة فقط.</small>
                </div>
                <button type="button" className="secondary-button" onClick={chooseArchiveDirectory}>
                  {archiveDirectory ? `مجلد الأرشيف: ${archiveDirectory.name}` : 'اختيار مجلد أرشيف على هذا الجهاز'}
                </button>
                <small className="muted-line">على الحاسوب يمكن اختيار مجلد ثابت. على الهواتف أو المتصفحات غير المدعومة سيُنزل ملف الأرشيف إلى التنزيلات ويجب حفظه والتحقق منه يدويًا.</small>
                <button type="button" className="receipt-open-button" disabled={archiveBusy} onClick={openReceipt}>
                  {archiveBusy ? 'جارٍ فتح الفاتورة وإنشاء الأرشيف…' : 'فتح الفاتورة وإنشاء ملف الأرشيف PDF ↗'}
                </button>
                {archiveProof?.applicationId === selected.id && (
                  <div className="archive-proof-card">
                    <strong>تم تجهيز ملف الأرشيف</strong>
                    <code dir="ltr">{archiveProof.fileName}</code>
                    <small>المسار المنطقي: {archiveProof.relativePath}</small>
                    <small>الحجم: {fmt(archiveProof.archiveSizeBytes)} بايت · SHA-256: <code dir="ltr">{archiveProof.archiveSha256}</code></small>
                    <label className="archive-confirm-check">
                      <input type="checkbox" checked={archiveConfirmed} onChange={(e) => setArchiveConfirmed(e.target.checked)} />
                      <span>أؤكد أن ملف PDF حُفظ فعلًا ويمكن فتحه، وأنني أخذت نسخة احتياطية ثانية قبل حذف الوصل من التخزين السحابي.</span>
                    </label>
                  </div>
                )}
              </div>
            ) : selected.receipt_archive_path ? (
              <div className="notice notice-warning"><strong>الفاتورة غير موجودة في التخزين السحابي</strong><p>مسار الأرشيف المسجل: <code dir="ltr">{selected.receipt_archive_path}</code>. يلزم الرجوع إلى الجهاز أو المجلد الذي حُفظ عليه الأرشيف.</p></div>
            ) : (
              <div className="important-warning"><strong>لم تُرفع الفاتورة بعد</strong></div>
            )}
            {selected.status === 'awaiting_payment' && <div className="important-warning"><strong>لا يمكن مراجعة هذا الطلب بعد</strong><p>الطلب بانتظار أن يدفع الطالب ويرفع فاتورة PDF.</p></div>}
            {selected.status === 'rejected' && selected.rejection_reason && <div className="prior-reason"><strong>سبب الرفض المسجل</strong><p>{selected.rejection_reason}</p></div>}
            {selected.status === 'rejected' && isAdmin && selected.receipt_path && <button type="button" className="reject-button full-width-button" disabled={deletingApplication || archiveProof?.applicationId !== selected.id || !archiveConfirmed} onClick={deleteSelectedReceipt}>{deletingApplication ? 'جارٍ حذف الفاتورة…' : 'أرشفة موثقة ثم حذف فاتورة الطلب المرفوض (يبقى سجل الطالب)'}</button>}
            {isAdmin && <button type="button" className="reject-button full-width-button" disabled={deletingApplication} onClick={deleteSelectedApplication}>{deletingApplication ? 'جارٍ حذف سجل الطالب…' : 'حذف كامل بيانات الطالب نهائيًا'}</button>}
            {selected.receipt_path && selected.status === 'pending' && (
              <>
                <div className="decision-divider" />
                <label className="field"><span>سبب الرفض (مطلوب عند الرفض)</span><textarea rows="3" maxLength={1000} value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} placeholder="اكتب سبب الرفض بوضوح ليظهر للطالب عند تتبع الطلب…" /></label>
                <div className="decision-actions">
                  <button type="button" className="reject-button" disabled={savingDecision} onClick={() => decide('rejected')}>رفض الطلب</button>
                  <button type="button" className="approve-button" disabled={savingDecision || !archiveProof || archiveProof.applicationId !== selected.id || !archiveConfirmed} onClick={() => decide('approved')}>✓ أرشفة ثم الموافقة وحذف الوصل السحابي</button>
                </div>
                <small className="muted-line">لن يُحذف الوصل من التخزين السحابي إلا بعد حفظ بيانات الأرشيف والتحقق من بصمة الفاتورة وتأكيد النسخة الاحتياطية.</small>
              </>
            )}
          </>
        ) : (
          <div className="review-empty"><div>☷</div><strong>اختر طلباً لمراجعته</strong><p>اضغط على أي صف في قائمة الطلبات لعرض التفاصيل والفاتورة عند توفرها.</p></div>
        )}
      </div>
    </>}

    {tab === 'team' && isAdmin && <StaffManagementPanel staffUser={staffUser} catalog={catalog} notify={notify} />}

    {tab === 'settings' && isAdmin && <div className="panel settings-panel"><div className="settings-header"><div><span className="section-index">تخصيص المنصة</span><h2>الرسوم والدفع</h2><p>تطبق الإعدادات على الطلبات الجديدة. تبقى مبالغ الطلبات المنشأة سابقاً محفوظة كما هي.</p></div><span className={`open-indicator ${localSettings.registration_open ? 'is-open' : ''}`}>{localSettings.registration_open ? 'التسجيل العام مفتوح' : 'التسجيل العام مغلق'}</span></div><form onSubmit={saveSettings}><div className="settings-grid"><label className="field"><span>عنوان الصفحة</span><input value={localSettings.event_title || ''} onChange={(e) => setLocalSettings((s) => ({ ...s, event_title: e.target.value }))} required /></label><label className="field"><span>اسم الدفعة</span><input value={localSettings.batch_name || 'دفعة 2026'} onChange={(e) => setLocalSettings((s) => ({ ...s, batch_name: e.target.value }))} placeholder="مثال: دفعة الأمل 2026" required /></label><label className="field"><span>اسم الجامعة</span><input value={localSettings.university_label || ''} onChange={(e) => setLocalSettings((s) => ({ ...s, university_label: e.target.value }))} required /></label><label className="field"><span>مكان الحفل (يظهر على التذكرة)</span><input value={localSettings.event_location || ''} onChange={(e) => setLocalSettings((s) => ({ ...s, event_location: e.target.value }))} placeholder="مثال: الصالة الرياضية في الجامعة" /></label><label className="field"><span>تاريخ الحفل (يظهر على التذكرة)</span><input type="date" value={localSettings.event_date || ''} onChange={(e) => setLocalSettings((s) => ({ ...s, event_date: e.target.value }))} /></label><label className="field field-full"><span>الجهة المنظمة</span><input value={localSettings.organizer || ''} onChange={(e) => setLocalSettings((s) => ({ ...s, organizer: e.target.value }))} required /></label><label className="field"><span>رسوم الطالب (ل.س)</span><input type="number" min="0" step="1" value={localSettings.student_fee ?? 0} onChange={(e) => setLocalSettings((s) => ({ ...s, student_fee: e.target.value }))} required /></label><label className="field"><span>رسوم المرافق الواحد (ل.س)</span><input type="number" min="0" step="1" value={localSettings.companion_fee ?? 0} onChange={(e) => setLocalSettings((s) => ({ ...s, companion_fee: e.target.value }))} required /></label><label className="field"><span>الحد الأقصى للمرافقين</span><input type="number" min="0" max="20" step="1" value={localSettings.max_companions ?? 4} onChange={(e) => setLocalSettings((s) => ({ ...s, max_companions: e.target.value }))} required /></label><label className="field"><span>الحد الأقصى للمواد المحمولة</span><input type="number" min="0" max="30" step="1" value={localSettings.max_carried_subjects ?? 5} onChange={(e) => setLocalSettings((s) => ({ ...s, max_carried_subjects: e.target.value }))} required /><small className="field-help">يُرفض التسجيل تلقائياً إذا تجاوز الطالب الحد المحدد.</small></label><label className="field field-full"><span>رقم حساب شام كاش</span><input value={localSettings.shamcash_account || ''} onChange={(e) => setLocalSettings((s) => ({ ...s, shamcash_account: e.target.value }))} placeholder="أدخل رقم الحساب أو معرّف الدفع" /></label><label className="field field-full"><span>ملاحظات إضافية تظهر للطلاب في صفحة الدفع</span><textarea rows="3" value={localSettings.payment_instructions || ''} onChange={(e) => setLocalSettings((s) => ({ ...s, payment_instructions: e.target.value }))} /></label><div className="field field-full"><span>رمز QR للدفع</span><div className="qr-admin-upload">{localSettings.qr_image_url && <img src={localSettings.qr_image_url} alt="رمز الدفع الحالي" />}<label className="secondary-button upload-qr-button">رفع صورة QR<input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => uploadQr(e.target.files?.[0])} /></label><small>صورة PNG أو JPG أو WebP، حتى 3 ميغابايت.</small></div></div><div className="field field-full"><span>صور توضيحية لخطوات الدفع (حتى 8 صور)</span><div className="payment-images-admin"><label className="secondary-button upload-qr-button">إضافة صور توضيحية<input type="file" multiple accept="image/png,image/jpeg,image/webp" onChange={(e) => { uploadPaymentImages(Array.from(e.target.files || [])); e.target.value = ''; }} /></label><div className="payment-images-admin-grid">{(Array.isArray(localSettings.payment_images) ? localSettings.payment_images : []).map((url, index) => <figure key={url}><img src={url} alt={`صورة الدفع ${index + 1}`} /><button type="button" className="reject-button" onClick={() => setLocalSettings((old) => ({ ...old, payment_images: old.payment_images.filter((item) => item !== url) }))}>إزالة الصورة</button></figure>)}</div><small>بعد الإضافة أو الإزالة اضغط «حفظ الإعدادات» حتى تظهر التغييرات للطلاب.</small></div></div><label className="toggle-row field-full"><input type="checkbox" checked={Boolean(localSettings.registration_open)} onChange={(e) => setLocalSettings((s) => ({ ...s, registration_open: e.target.checked }))} /><span className="toggle-look" /><span><strong>فتح التسجيل العام</strong><small>يجب فتح التسجيل العام والجهة الدراسية والاختصاص حتى يستطيع الطالب التسجيل.</small></span></label></div><div className="settings-save-row"><button className="primary-button" disabled={savingSettings}><span>{savingSettings ? 'جارٍ الحفظ…' : 'حفظ الإعدادات'}</span><span className="button-arrow">←</span></button><button type="button" className="secondary-button" onClick={() => setLocalSettings({ ...DEFAULT_SETTINGS, ...settings, payment_images: Array.isArray(settings.payment_images) ? settings.payment_images : [] })}>إلغاء التعديلات</button></div></form></div>}

    {tab === 'academic' && isAdmin && <div className="panel settings-panel catalog-admin-panel"><div className="settings-header"><div><span className="section-index">قوائم التسجيل</span><h2>إدارة الكليات والمعاهد والاختصاصات</h2><p>يمكنك فتح التسجيل أو إيقافه لكل كلية أو معهد ولكل اختصاص بشكل مستقل. التغييرات تنعكس على القوائم التي يراها الطلاب.</p></div><button className="secondary-button" type="button" onClick={refreshCatalog}>تحديث القوائم ↻</button></div>
      {catalogError && <div className="notice notice-warning"><strong>قاعدة البيانات تحتاج إلى الترقية</strong><p>شغّل ملف supabase/migrations/002_staged_registration_and_academic_catalog.sql في SQL Editor أولاً. التفاصيل: {catalogError}</p></div>}
      <form className="catalog-add-form" onSubmit={addUnit}><label className="field"><span>نوع الجهة</span><select value={newUnitType} onChange={(e) => setNewUnitType(e.target.value)}><option value="faculty">كلية</option><option value="institute">معهد</option></select></label><label className="field"><span>اسم الكلية أو المعهد</span><input value={newUnitName} onChange={(e) => setNewUnitName(e.target.value)} placeholder="مثال: كلية الهندسة المعلوماتية" required /></label><button className="primary-button" type="submit"><span>إضافة الجهة</span></button></form>
      {units.length === 0 ? <div className="empty-state"><strong>لم تتم إضافة كليات أو معاهد بعد</strong><p>أضف الجهات التي تريد إتاحة التسجيل فيها، ثم أضف الاختصاصات إن وجدت.</p></div> : <div className="academic-units-list">{units.map((unit) => { const unitSpecs = specs.filter((spec) => spec.unit_id === unit.id); return <article className="academic-unit-card" key={unit.id}><div className="academic-unit-top"><div><span className="academic-unit-type">{unit.unit_type === 'institute' ? 'معهد' : 'كلية'}</span><h3>{unit.name}</h3><small>{unitSpecs.length} اختصاص مسجل · {fmt(unit.registered_count || 0)} مقعد محجوز (الخريج والمرافقون) {unit.registration_capacity ? `من ${fmt(unit.registration_capacity)}` : 'دون حد أعلى'}</small>{unit.capacity_reached && <span className="capacity-reached-badge">اكتملت السعة وأُغلق التسجيل تلقائيًا</span>}</div><label className="catalog-toggle"><input type="checkbox" checked={Boolean(unit.is_open)} disabled={Boolean(unit.capacity_reached)} onChange={(e) => toggleUnit(unit, e.target.checked)} /><span>{unit.capacity_reached ? 'مغلق لاكتمال السعة' : unit.is_open ? 'التسجيل مفتوح' : 'التسجيل متوقف'}</span></label><button type="button" className="reject-button catalog-delete" onClick={() => deleteUnit(unit)}>حذف</button></div><div className="unit-capacity-editor"><label className="field"><span>الحد الأقصى للحضور لهذه الجهة (الخريجون + المرافقون)</span><input type="number" min="1" max="1000000" step="1" value={unitCapacityDrafts[unit.id] ?? ''} onChange={(e) => setUnitCapacityDrafts((old) => ({ ...old, [unit.id]: e.target.value }))} placeholder="اتركه فارغًا دون حد" /></label><button type="button" className="secondary-button" onClick={() => saveUnitCapacity(unit)}>حفظ الحد</button><small>يحتسب كل خريج مع عدد مرافقيه في الطلبات غير المرفوضة، بما فيها بانتظار الدفع وقيد التدقيق والمقبولة. لا يحتسب الطلبات المرفوضة أو المحذوفة. يغلق التسجيل تلقائيًا عند بلوغ الحد.</small></div><div className="academic-specializations">{unitSpecs.length === 0 ? <p className="no-specs-admin">لم تتم إضافة اختصاصات لهذه الجهة؛ سيظهر للطالب «لا يوجد اختصاص».</p> : unitSpecs.map((spec) => <div className="specialization-row" key={spec.id}><span>{spec.name}</span><label className="catalog-toggle"><input type="checkbox" checked={Boolean(spec.is_open)} disabled={!unit.is_open} onChange={(e) => toggleSpecialization(spec, e.target.checked)} /><span>{spec.is_open ? 'مفتوح' : 'مغلق'}</span></label><button type="button" className="text-delete" onClick={() => deleteSpecialization(spec)}>حذف</button></div>)}</div></article>; })}</div>}
      <div className="specialization-add-box"><h3>إضافة اختصاص إلى كلية أو معهد</h3><form className="catalog-add-form" onSubmit={addSpecialization}><label className="field"><span>الكلية أو المعهد</span><select value={specializationTargetUnit} onChange={(e) => setSpecializationTargetUnit(e.target.value)} required><option value="">اختر الجهة</option>{units.map((unit) => <option key={unit.id} value={unit.id}>{unit.name}</option>)}</select></label><label className="field"><span>اسم الاختصاص</span><input value={newSpecializationName} onChange={(e) => setNewSpecializationName(e.target.value)} placeholder="مثال: هندسة البرمجيات" required /></label><button className="primary-button" type="submit" disabled={units.length === 0}><span>إضافة الاختصاص</span></button></form></div>
    </div>}
    {tab === 'gate' && isAdmin && <GateOperationsPanel staffUser={staffUser} staffRole={staffRole} notify={notify} embedded />}
    {tab === 'finance' && isAdmin && <FinancialDashboard staffRole={staffRole} notify={notify} embedded />}
    {tab === 'audit' && isAdmin && <AuditLogPanel notify={notify} />}
    {tab === 'backup' && isAdmin && <AdminBackupPanel notify={notify} />}
    <div className="admin-footnote">مسجل الدخول: <strong>{staffUser.email}</strong> <span>•</span> صلاحية الحساب: <strong>{{ admin: 'مدير', reviewer: 'مراجع', finance: 'مسؤول مالي', gate: 'موظف بوابة' }[staffRole] || staffRole}</strong> <span>•</span> لا تشارك بيانات دخول الفريق مع الطلاب.</div>
  </section>;
}

export default App;
