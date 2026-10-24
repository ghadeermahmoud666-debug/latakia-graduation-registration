import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';

const args = process.argv.slice(2);
const getArg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : ''; };
const trackingCode = String(getArg('--tracking-code') || '').trim().toUpperCase();
const archiveRoot = resolve(getArg('--archive-root') || '');
const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error('يجب ضبط SUPABASE_URL وSUPABASE_SERVICE_ROLE_KEY في نافذة CMD الحالية. لا تحفظ المفتاح في ملفات المشروع أو ترفعه إلى GitHub.');
  process.exit(1);
}
if (!trackingCode || !archiveRoot || archiveRoot === resolve('.')) {
  console.error('الاستخدام: node scripts/restore-archived-receipt.mjs --tracking-code LAT-... --archive-root "E:\\GraduationReceiptArchive"');
  process.exit(1);
}
const supabase = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function main() {
  const { data: row, error } = await supabase.from('applications')
    .select('id,tracking_code,receipt_path,receipt_archive_path,receipt_sha256,status')
    .eq('tracking_code', trackingCode).maybeSingle();
  if (error) throw new Error('تعذر البحث عن الطلب: ' + error.message);
  if (!row) throw new Error('لم يُعثر على طلب بهذا الرمز.');
  if (row.receipt_path) {
    console.log('للطلب بالفعل إيصال في Supabase Storage:', row.receipt_path);
    return;
  }
  if (!row.receipt_archive_path) throw new Error('لا يوجد مسار أرشيف مسجل لهذا الطلب.');
  const filePath = resolve(archiveRoot, ...row.receipt_archive_path.split('/'));
  if (!(filePath === archiveRoot || filePath.startsWith(archiveRoot + sep))) throw new Error('مسار الملف يتجاوز مجلد الأرشيف المحدد.');
  if (!existsSync(filePath)) throw new Error('لم يُعثر على ملف الإيصال في الأرشيف المحلي: ' + filePath);
  const bytes = readFileSync(filePath);
  if (bytes.length < 6 || bytes.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('الملف المحلي ليس PDF سليمًا.');
  const digest = sha256(bytes);
  if (!row.receipt_sha256 || digest !== row.receipt_sha256) throw new Error('بصمة الملف لا تطابق البصمة المسجلة في قاعدة البيانات؛ لن تتم استعادته.');
  const restoredPath = `${row.id}/receipt-restored-${Date.now()}.pdf`;
  const { error: uploadError } = await supabase.storage.from('receipts').upload(restoredPath, bytes, {
    contentType: 'application/pdf', cacheControl: '0', upsert: false,
  });
  if (uploadError) throw new Error('تعذر رفع نسخة الاستعادة: ' + uploadError.message);
  const { error: updateError } = await supabase.from('applications').update({ receipt_path: restoredPath }).eq('id', row.id).is('receipt_path', null);
  if (updateError) {
    await supabase.storage.from('receipts').remove([restoredPath]);
    throw new Error('تم رفع الملف لكن تعذر ربطه بالطلب، وتمت محاولة حذف النسخة المؤقتة: ' + updateError.message);
  }
  console.log('تمت استعادة الإيصال إلى Supabase Storage. أعد تحميل لوحة الإدارة ثم افتح الطلب.');
  console.log('مسار النسخة المستعادة:', restoredPath);
  console.log('المصدر الأصلي ما زال محفوظًا في الأرشيف المحلي.');
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
