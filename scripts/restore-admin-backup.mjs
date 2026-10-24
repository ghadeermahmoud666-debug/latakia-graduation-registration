import fs from 'node:fs';
import JSZip from 'jszip';
import { createClient } from '@supabase/supabase-js';

const file = process.argv[2];
const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!file) {
  console.error('الاستخدام: node scripts/restore-admin-backup.mjs "E:\\path\\graduation-admin-backup-YYYY-MM-DD.zip"');
  process.exit(2);
}
if (!url || !serviceKey) {
  console.error('اضبط SUPABASE_URL وSUPABASE_SERVICE_ROLE_KEY في نافذة CMD الحالية فقط. لا تضع مفتاح الخدمة في ملفات المشروع أو GitHub.');
  process.exit(2);
}
if (!fs.existsSync(file)) {
  console.error('ملف النسخة الاحتياطية غير موجود:', file);
  process.exit(2);
}
const supabase = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const bytes = fs.readFileSync(file);
const zip = await JSZip.loadAsync(bytes);
const metadataEntry = zip.file('backup-metadata.json');
if (!metadataEntry) throw new Error('ملف backup-metadata.json غير موجود. هذا ليس ملف النسخة الاحتياطية المتوقع.');
const metadata = JSON.parse(await metadataEntry.async('text'));
console.log(`نسخة ${metadata.schema || 'غير معروف'} أُنشئت في ${metadata.generated_at || 'وقت غير معروف'}`);
console.log('تنبيه: الاستعادة دمج آمن (upsert) وليست مسحًا كاملًا للجداول. لا تستعيد ملفات PDF ولا كلمات مرور/جلسات Authentication.');
const proceed = process.env.CONFIRM_RESTORE === 'YES';
if (!proceed) {
  console.error('للتنفيذ بعد مراجعة الملف والاتصال بالمشروع الصحيح، أغلق هذه النافذة وافتح CMD جديدًا ثم اضبط CONFIRM_RESTORE=YES.');
  console.error('مثال: set "CONFIRM_RESTORE=YES"');
  process.exit(2);
}
const order = [
  'event_settings', 'academic_units', 'academic_specializations', 'applications', 'entry_tickets',
  'financial_payments', 'financial_transactions', 'financial_daily_closings', 'staff_roles',
  'staff_unit_permissions', 'admin_backup_runs', 'admin_audit_logs',
];
const omitIdOnInsert = new Set(['admin_audit_logs']); // generated-always identity
let totalRows = 0;
for (const table of order) {
  const entry = zip.file(`${table}.json`);
  if (!entry) { console.log(`تخطي ${table}: غير موجود في النسخة.`); continue; }
  let rows = JSON.parse(await entry.async('text'));
  if (!Array.isArray(rows)) throw new Error(`بيانات ${table}.json ليست قائمة سجلات.`);
  if (!rows.length) { console.log(`${table}: لا توجد سجلات.`); continue; }
  if (table === 'admin_audit_logs') {
    rows = rows.map((row) => {
      const copy = { ...row, details: { ...(row.details || {}), restored_from_backup_id: row.id ?? null } };
      delete copy.id;
      return copy;
    });
    // The log table uses GENERATED ALWAYS identity; append events without original identity values.
    for (let i = 0; i < rows.length; i += 100) {
      const { error } = await supabase.from(table).insert(rows.slice(i, i + 100));
      if (error) throw new Error(`فشل استعادة ${table}: ${error.message}`);
    }
  } else {
    for (let i = 0; i < rows.length; i += 100) {
      const chunk = rows.slice(i, i + 100);
      const { error } = await supabase.from(table).upsert(chunk);
      if (error) throw new Error(`فشل استعادة ${table}: ${error.message}. تأكد أن migrations 001-008 مطبقة وأن حسابات الموظفين المشار إليها موجودة في مشروع Supabase المستهدف.`);
    }
  }
  totalRows += rows.length;
  console.log(`${table}: تمت معالجة ${rows.length} سجلًا.`);
}
console.log(`اكتملت الاستعادة/المزامنة. إجمالي السجلات المعالجة: ${totalRows}. راجع البيانات يدويًا قبل إعادة فتح التسجيل.`);
