import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outputArg = outIndex >= 0 ? args[outIndex + 1] : '';
const deleteAfterVerify = args.includes('--delete-after-verify');
const limitIndex = args.indexOf('--limit');
const limitValue = limitIndex >= 0 ? Number.parseInt(args[limitIndex + 1], 10) : 0;
if (limitIndex >= 0 && (!Number.isInteger(limitValue) || limitValue < 1 || deleteAfterVerify)) {
  console.error('يُسمح بـ --limit برقم موجب في وضع الأرشفة فقط، ولا يُسمح بجمعه مع خيار الحذف.');
  process.exit(1);
}
const outputDir = resolve(outputArg || './receipt-archive');
const supabaseUrl = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceKey) {
  console.error('يجب ضبط SUPABASE_URL وSUPABASE_SERVICE_ROLE_KEY في نافذة CMD الحالية. لا تضع المفتاح السري في ملفات React أو GitHub.');
  process.exit(1);
}
if (deleteAfterVerify && !args.includes('--only-finalized')) {
  console.error('لمنع حذف إيصالات لم تُراجع، يجب جمع --delete-after-verify مع --only-finalized.');
  process.exit(1);
}
const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
mkdirSync(outputDir, { recursive: true });
const manifestName = `manifest-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
const manifestPath = join(outputDir, manifestName);
writeFileSync(manifestPath, '\uFEFFtracking_code,application_id,full_name,department,specialization,status,created_at,archive_path,sha256,size_bytes,archived_at\r\n', 'utf8');

const csvCell = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
const folderSafe = (value) => String(value || 'unknown').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/[. ]+$/g, '').slice(0, 80) || 'unknown';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const isPdf = (bytes) => bytes.length > 5 && bytes.subarray(0, 5).toString('ascii') === '%PDF-';

async function fetchAllReceiptRows() {
  const all = [];
  let from = 0;
  const size = 500;
  while (true) {
    const { data, error } = await supabase.from('applications')
      .select('id,tracking_code,full_name,department,specialization,status,created_at,receipt_path,receipt_archive_path,receipt_sha256,receipt_size_bytes,receipt_archived_at')
      .not('receipt_path', 'is', null)
      .order('created_at', { ascending: true })
      .range(from, from + size - 1);
    if (error) throw new Error(`تعذر جلب قائمة الإيصالات: ${error.message}`);
    all.push(...(data || []));
    if (!data || data.length < size) break;
    from += size;
  }
  return all;
}

async function main() {
  console.log(`مجلد الأرشيف: ${outputDir}`);
  console.log(deleteAfterVerify ? 'وضع الأرشفة والحذف: سيحذف فقط ملفات الطلبات المقبولة أو المرفوضة بعد التحقق.' : 'وضع الأرشفة فقط: لن يُحذف أي ملف من Supabase Storage.');
  const rows = await fetchAllReceiptRows();
  const eligible = rows.filter((row) => !deleteAfterVerify || ['approved', 'rejected'].includes(row.status));
  const candidates = limitValue > 0 ? eligible.slice(0, limitValue) : eligible;
  console.log(`عدد السجلات التي ستُفحص: ${candidates.length}`);
  let complete = 0, failed = 0, deleted = 0;

  for (const row of candidates) {
    try {
      const year = new Date(row.created_at || Date.now()).getFullYear();
      const folder = join(String(year), folderSafe(row.department));
      const filename = `${folderSafe(row.tracking_code || row.id)}.pdf`;
      const absolutePath = join(outputDir, folder, filename);
      const relativePath = relative(outputDir, absolutePath).replaceAll('\\', '/');
      mkdirSync(dirname(absolutePath), { recursive: true });

      let bytes;
      let cloudDigest = null;
      // When deletion is requested, always download the current cloud object as well.
      // This prevents deleting a valid cloud receipt based only on an unrelated local file.
      let cloudBytes = null;
      if (deleteAfterVerify) {
        const { data, error } = await supabase.storage.from('receipts').download(row.receipt_path);
        if (error || !data) throw new Error(`تعذر تنزيل النسخة السحابية للتحقق: ${error?.message || 'لا توجد بيانات'}`);
        cloudBytes = Buffer.from(await data.arrayBuffer());
        cloudDigest = sha256(cloudBytes);
        if (!isPdf(cloudBytes)) throw new Error('النسخة السحابية ليست PDF سليماً؛ لن يتم حذفها.');
      }

      if (existsSync(absolutePath)) {
        bytes = readFileSync(absolutePath);
      } else {
        if (!cloudBytes) {
          const { data, error } = await supabase.storage.from('receipts').download(row.receipt_path);
          if (error || !data) throw new Error(`تعذر تنزيل الملف من Supabase Storage: ${error?.message || 'لا توجد بيانات'}`);
          cloudBytes = Buffer.from(await data.arrayBuffer());
        }
        bytes = cloudBytes;
        const tempPath = `${absolutePath}.tmp`;
        writeFileSync(tempPath, bytes);
        renameSync(tempPath, absolutePath);
      }
      if (!isPdf(bytes)) throw new Error('الملف المحفوظ لا يبدأ بتوقيع PDF المتوقع؛ لن يتم حذف النسخة السحابية.');
      const digest = sha256(bytes);
      if (row.receipt_sha256 && row.receipt_archive_path === relativePath && row.receipt_sha256 !== digest) {
        throw new Error('بصمة الأرشيف تختلف عن البصمة المسجلة؛ لن يتم حذف النسخة السحابية.');
      }
      if (deleteAfterVerify && cloudDigest !== digest) {
        throw new Error('بصمة النسخة المحلية لا تطابق النسخة الحالية في Supabase Storage؛ لن يتم حذف النسخة السحابية.');
      }

      // Save archive metadata first. Keep receipt_path intact until object removal succeeds.
      const archivedAt = new Date().toISOString();
      const { error: metadataError } = await supabase.from('applications').update({
        receipt_archive_path: relativePath,
        receipt_sha256: digest,
        receipt_size_bytes: bytes.length,
        receipt_archived_at: row.receipt_archived_at || archivedAt,
      }).eq('id', row.id);
      if (metadataError) throw new Error(`تم حفظ الملف محلياً لكن تعذّر حفظ بيانات الأرشيف في القاعدة: ${metadataError.message}`);

      if (deleteAfterVerify && ['approved', 'rejected'].includes(row.status)) {
        const { error: removeError } = await supabase.storage.from('receipts').remove([row.receipt_path]);
        if (removeError) throw new Error(`تم الأرشفة والتحقق لكن تعذّر حذف النسخة السحابية: ${removeError.message}`);
        const { error: clearPathError } = await supabase.from('applications').update({ receipt_path: null }).eq('id', row.id).eq('receipt_path', row.receipt_path);
        if (clearPathError) throw new Error(`حُذفت النسخة السحابية لكن تعذّر تحديث مسارها في قاعدة البيانات. الأرشيف المحلي موجود: ${relativePath}`);
        deleted++;
      }

      appendFileSync(manifestPath, [row.tracking_code, row.id, row.full_name, row.department, row.specialization, row.status, row.created_at, relativePath, digest, bytes.length, row.receipt_archived_at || archivedAt].map(csvCell).join(',') + '\r\n', 'utf8');
      complete++;
      if (complete % 100 === 0) console.log(`تمت معالجة ${complete} فاتورة…`);
    } catch (error) {
      failed++;
      console.error(`[${row.tracking_code || row.id}] ${error instanceof Error ? error.message : error}`);
    }
  }
  console.log('\nانتهت المهمة.');
  console.log(`نجح حفظ: ${complete}`);
  console.log(`تعذّر/تحتاج مراجعة: ${failed}`);
  console.log(`حُذفت من التخزين السحابي بعد التحقق: ${deleted}`);
  console.log(`البيان التفصيلي: ${manifestPath}`);
  if (deleteAfterVerify) console.log('مهم: احفظ نسختين احتياطيتين مشفرتين للأرشيف قبل الاعتماد عليه كمصدر وحيد.');
}

main().catch((error) => { console.error(error); process.exit(1); });
