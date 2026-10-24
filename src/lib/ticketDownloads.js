import { PDFDocument } from 'pdf-lib';
import JSZip from 'jszip';
import QRCode from 'qrcode';
import { downloadBlob, safeArchiveFilename } from './localArchive';

function drawWrapped(ctx, text, x, y, maxWidth, lineHeight, size, color, weight = 500) {
  ctx.save(); ctx.direction = 'rtl'; ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic';
  ctx.font = `${weight} ${size}px Arial, Tahoma, sans-serif`; ctx.fillStyle = color;
  const words = String(text ?? '—').split(/\s+/); let line = ''; const lines = [];
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(test).width > maxWidth) { lines.push(line); line = word; } else line = test;
  }
  if (line) lines.push(line);
  lines.slice(0, 2).forEach((v, i) => ctx.fillText(v, x, y + i * lineHeight, maxWidth));
  ctx.restore(); return y + Math.min(lines.length, 2) * lineHeight;
}

async function imageFromUrl(url) {
  return new Promise((resolve) => {
    const image = new Image(); image.onload = () => resolve(image); image.onerror = () => resolve(null); image.src = url;
  });
}

async function makeTicketPdf(ticket, application, batchName) {
  const canvas = document.createElement('canvas'); canvas.width = 1500; canvas.height = 960;
  const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('تعذر إنشاء صورة بطاقة الدخول.');
  ctx.fillStyle = '#fffdf8'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#18594b'; ctx.fillRect(0, 0, canvas.width, 22);
  ctx.fillStyle = '#a93236'; ctx.fillRect(0, 22, 420, 10); ctx.fillStyle = '#c3a15c'; ctx.fillRect(420, 22, 320, 10);
  ctx.strokeStyle = '#d9cbb6'; ctx.lineWidth = 3; ctx.strokeRect(36, 48, canvas.width - 72, canvas.height - 84);
  const logo = await imageFromUrl(`${window.location.origin}/brand/ssu-emblem.png`);
  if (logo) { try { ctx.drawImage(logo, 82, 72, 135, 135); } catch {} }
  const isGraduate = ticket.ticket_type === 'graduate' || ticket.ticket_number === 0;
  const right = 1360;
  drawWrapped(ctx, 'اتحاد طلبة سوريا – فرع محافظة اللاذقية', right, 112, 1040, 44, 32, '#18594b', 700);
  drawWrapped(ctx, `${batchName || 'دفعة 2026'} · جامعة اللاذقية`, right, 160, 1040, 34, 24, '#68766b', 500);
  drawWrapped(ctx, isGraduate ? 'بطاقة دخول الخريج' : `بطاقة دخول المرافق ${ticket.ticket_number}`, right, 248, 1050, 55, 40, '#a93236', 700);
  drawWrapped(ctx, application.full_name || '—', right, 326, 1050, 50, 38, '#203b34', 700);
  drawWrapped(ctx, application.department || '—', right, 379, 1050, 37, 27, '#68766b', 500);
  let y = 460;
  const details = isGraduate
    ? [['الرقم الجامعي', application.university_number], ['الاختصاص', application.specialization || 'لا يوجد اختصاص'], ['عدد المرافقين', application.companions], ['المواد المحمولة', application.carried_subjects]]
    : [['يرافق الخريج', application.full_name], ['رقم المرافق', ticket.ticket_number], ['الجهة الدراسية', application.department], ['نوع الدخول', 'مرافق']];
  for (const [label, value] of details) {
    drawWrapped(ctx, `${label}: ${value ?? '—'}`, right, y, 950, 37, 25, '#203b34', 600); y += 58;
  }
  const verifyUrl = `${window.location.origin}/?ticket=${encodeURIComponent(ticket.ticket_token)}`;
  const qr = await QRCode.toDataURL(verifyUrl, { width: 380, margin: 1, errorCorrectionLevel: 'M', color: { dark: '#173f35', light: '#ffffff' } });
  const qrImage = await imageFromUrl(qr);
  if (qrImage) ctx.drawImage(qrImage, 90, 250, 350, 350);
  drawWrapped(ctx, 'رمز تحقق الدخول', 450, 640, 370, 34, 24, '#18594b', 700);
  drawWrapped(ctx, 'امسح الرمز عند بوابة الحفل', 450, 680, 370, 32, 21, '#68766b', 500);
  drawWrapped(ctx, `رمز البطاقة: ${ticket.ticket_token.slice(-8)}`, 450, 730, 370, 30, 17, '#777777', 500);
  drawWrapped(ctx, 'البطاقة صالحة بعد الموافقة النهائية فقط', 1360, 864, 1100, 30, 20, '#8b857a', 500);

  const pdf = await PDFDocument.create();
  const pngBytes = await new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? blob.arrayBuffer().then(resolve, reject) : reject(new Error('تعذر تجهيز صورة البطاقة.')), 'image/png'));
  const image = await pdf.embedPng(new Uint8Array(pngBytes));
  const page = pdf.addPage([842, 539]); page.drawImage(image, { x: 0, y: 0, width: 842, height: 539 });
  return new Uint8Array(await pdf.save());
}

function ticketFilename(ticket, application) {
  const type = ticket.ticket_type === 'graduate' || ticket.ticket_number === 0 ? 'بطاقة_الخريج' : `بطاقة_المرافق_${String(ticket.ticket_number).padStart(2, '0')}`;
  return `${type}_${safeArchiveFilename(application.tracking_code || 'تذكرة')}.pdf`;
}

export async function downloadTicketsAsOnePdf(tickets, application, batchName) {
  if (!tickets?.length) throw new Error('لا توجد بطاقات لتنزيلها.');
  const bundle = await PDFDocument.create();
  for (const ticket of tickets) {
    const bytes = await makeTicketPdf(ticket, application, batchName);
    const one = await PDFDocument.load(bytes);
    const pages = await bundle.copyPages(one, one.getPageIndices());
    pages.forEach((page) => bundle.addPage(page));
  }
  const bytes = await bundle.save({ useObjectStreams: true });
  downloadBlob(new Blob([bytes], { type: 'application/pdf' }), `بطاقات_التخرج_${safeArchiveFilename(application.tracking_code)}.pdf`);
}

export async function downloadTicketsSeparatelyZip(tickets, application, batchName) {
  if (!tickets?.length) throw new Error('لا توجد بطاقات لتنزيلها.');
  const zip = new JSZip();
  for (const ticket of tickets) {
    const bytes = await makeTicketPdf(ticket, application, batchName);
    zip.file(ticketFilename(ticket, application), bytes);
  }
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  downloadBlob(blob, `بطاقات_منفصلة_${safeArchiveFilename(application.tracking_code)}.zip`);
}
