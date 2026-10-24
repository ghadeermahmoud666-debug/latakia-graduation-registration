import { PDFDocument } from 'pdf-lib';

const ARCHIVE_FOLDER_NAME = 'بيانات إيصالات الدفع لحفلات التخرج';

function safeName(value, max = 90) {
  return String(value || 'غير-معروف')
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, max) || 'غير-معروف';
}

function drawRtl(ctx, text, x, y, maxWidth, size = 32, color = '#203b34', weight = 500) {
  ctx.save();
  ctx.direction = 'rtl';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = color;
  ctx.font = `${weight} ${size}px Arial, Tahoma, sans-serif`;
  const words = String(text ?? '—').split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(test).width > maxWidth) {
      lines.push(line);
      line = word;
    } else line = test;
  }
  if (line) lines.push(line);
  lines.slice(0, 3).forEach((entry, index) => ctx.fillText(entry, x, y + index * (size + 10), maxWidth));
  ctx.restore();
  return y + Math.min(lines.length, 3) * (size + 10);
}

function drawArchiveCover(application, settings = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = 1240;
  canvas.height = 1754;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('تعذر تجهيز صفحة بيانات الأرشيف في المتصفح.');
  ctx.fillStyle = '#fffdf8';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#18594b'; ctx.fillRect(0, 0, canvas.width, 26);
  ctx.fillStyle = '#a93236'; ctx.fillRect(0, 26, 330, 12);
  ctx.fillStyle = '#c3a15c'; ctx.fillRect(330, 26, 280, 12);

  ctx.save();
  ctx.direction = 'rtl'; ctx.textAlign = 'right';
  ctx.fillStyle = '#18594b'; ctx.font = 'bold 48px Arial, Tahoma, sans-serif';
  ctx.fillText(settings.organizer || 'اتحاد طلبة سوريا – فرع محافظة اللاذقية', 1140, 125, 1060);
  ctx.fillStyle = '#7a8177'; ctx.font = '30px Arial, Tahoma, sans-serif';
  ctx.fillText(settings.university_label || 'جامعة اللاذقية', 1140, 178, 1060);
  ctx.fillStyle = '#a93236'; ctx.font = 'bold 47px Arial, Tahoma, sans-serif';
  ctx.fillText('ملف أرشفة إيصال دفع', 1140, 282, 1060);
  ctx.fillStyle = '#64736a'; ctx.font = '29px Arial, Tahoma, sans-serif';
  ctx.fillText(settings.batch_name || 'دفعة 2026', 1140, 333, 1060);
  ctx.restore();

  ctx.strokeStyle = '#ded7c9'; ctx.lineWidth = 2; ctx.strokeRect(72, 390, 1096, 1185);
  ctx.fillStyle = '#f3f0e8'; ctx.fillRect(72, 390, 1096, 88);
  drawRtl(ctx, 'بيانات الطالب والطلب', 1115, 448, 980, 36, '#18594b', 700);
  const fields = [
    ['اسم الطالب', application.full_name],
    ['الرقم الجامعي', application.university_number],
    ['رقم الهاتف', application.phone_number],
    ['الكلية أو المعهد', application.department],
    ['الاختصاص', application.specialization || 'لا يوجد اختصاص'],
    ['عدد المواد المحمولة', application.carried_subjects ?? 0],
    ['عدد المرافقين', application.companions ?? 0],
    ['المبلغ المستحق', `${new Intl.NumberFormat('ar-SY').format(Number(application.amount_syp || 0))} ل.س`],
    ['رمز التتبع', application.tracking_code],
    ['تاريخ التسجيل', application.created_at ? new Date(application.created_at).toLocaleString('ar-SY') : '—'],
    ['الحالة وقت الأرشفة', application.status === 'approved' ? 'مقبول' : application.status === 'rejected' ? 'مرفوض' : 'قيد التدقيق'],
  ];
  let y = 550;
  for (const [label, value] of fields) {
    drawRtl(ctx, label, 1115, y, 950, 29, '#7a8177', 500);
    y = drawRtl(ctx, value, 1115, y + 42, 950, 34, '#203b34', 700) + 28;
    ctx.strokeStyle = '#eee7dc'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(125, y - 6); ctx.lineTo(1115, y - 6); ctx.stroke();
  }
  ctx.fillStyle = '#f8f1e8'; ctx.fillRect(72, 1610, 1096, 74);
  drawRtl(ctx, 'تأتي صفحات إيصال التحويل الأصلي بعد هذه الصفحة. احتفظ بنسخة احتياطية مستقلة.', 1115, 1655, 1000, 24, '#8c3b34', 600);
  return canvas;
}

export async function sha256Blob(blob) {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function safeArchiveFilename(value) { return safeName(value); }

export async function createReceiptArchivePdf(application, receiptBlob, settings = {}) {
  if (!(receiptBlob instanceof Blob) || receiptBlob.size <= 0) throw new Error('ملف الفاتورة فارغ أو غير متاح.');
  const inputBytes = new Uint8Array(await receiptBlob.arrayBuffer());
  if (new TextDecoder().decode(inputBytes.slice(0, 5)) !== '%PDF-') throw new Error('الملف الموجود في التخزين ليس PDF صالحًا.');
  const sourcePdf = await PDFDocument.load(inputBytes);
  const resultPdf = await PDFDocument.create();
  const canvas = drawArchiveCover(application, settings);
  const pngData = await new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? blob.arrayBuffer().then(resolve, reject) : reject(new Error('تعذر إنشاء صورة صفحة الأرشيف.')), 'image/png'));
  const embeddedCover = await resultPdf.embedPng(new Uint8Array(pngData));
  const coverPage = resultPdf.addPage([595.28, 841.89]);
  coverPage.drawImage(embeddedCover, { x: 0, y: 0, width: 595.28, height: 841.89 });
  const sourcePages = await resultPdf.copyPages(sourcePdf, sourcePdf.getPageIndices());
  sourcePages.forEach((page) => resultPdf.addPage(page));
  const bytes = await resultPdf.save({ useObjectStreams: true });
  return new Blob([bytes], { type: 'application/pdf' });
}

export async function saveArchiveToDirectory(baseHandle, application, archiveBlob) {
  if (!baseHandle?.getDirectoryHandle) throw new Error('لم يتم اختيار مجلد أرشيف صالح.');
  const year = String(new Date(application.created_at || Date.now()).getFullYear());
  const unitName = safeName(application.department || 'غير-محدد', 70);
  const root = await baseHandle.getDirectoryHandle(ARCHIVE_FOLDER_NAME, { create: true });
  const yearFolder = await root.getDirectoryHandle(year, { create: true });
  const unitFolder = await yearFolder.getDirectoryHandle(unitName, { create: true });
  const filename = `${safeName(application.tracking_code, 50)}_${safeName(application.full_name, 75)}.pdf`;
  const fileHandle = await unitFolder.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(archiveBlob);
  await writable.close();
  return { filename, relativePath: `${ARCHIVE_FOLDER_NAME}/${year}/${unitName}/${filename}` };
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
