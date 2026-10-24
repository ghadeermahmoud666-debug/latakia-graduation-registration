import { PDFDocument } from 'pdf-lib';
import JSZip from 'jszip';
import JsBarcode from 'jsbarcode';
import { downloadBlob, safeArchiveFilename } from './localArchive';

const MAROON = '#4b101d';
const MAROON_LIGHT = '#64192a';
const IVORY = '#fff5e5';
const WHITE = '#fffaf2';
const MUTED = '#ddcfc1';

function drawWrapped(ctx, text, x, y, maxWidth, lineHeight, size, color, weight = 500, align = 'right') {
  ctx.save(); ctx.direction = 'rtl'; ctx.textAlign = align; ctx.textBaseline = 'alphabetic';
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

function drawPill(ctx, x, y, width, height, label, value, opts = {}) {
  const { labelSize = 15, valueSize = 21, fill = IVORY, color = MAROON, maxWidth = width - 24 } = opts;
  ctx.save();
  ctx.fillStyle = fill;
  const r = Math.min(20, height / 2);
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + width, y, x + width, y + height, r); ctx.arcTo(x + width, y + height, x, y + height, r); ctx.arcTo(x, y + height, x, y, r); ctx.arcTo(x, y, x + width, y, r); ctx.closePath(); ctx.fill();
  ctx.direction = 'rtl'; ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic';
  ctx.font = `700 ${labelSize}px Arial, Tahoma, sans-serif`; ctx.fillStyle = color;
  ctx.fillText(label, x + width - 15, y + 17, maxWidth);
  ctx.font = `700 ${valueSize}px Arial, Tahoma, sans-serif`; ctx.fillText(String(value || 'يحدد لاحقًا'), x + width - 15, y + height - 10, maxWidth);
  ctx.restore();
}

function drawCap(ctx, centerX, topY) {
  ctx.save(); ctx.fillStyle = '#09070a'; ctx.strokeStyle = '#09070a';
  ctx.beginPath(); ctx.moveTo(centerX - 78, topY + 22); ctx.lineTo(centerX, topY); ctx.lineTo(centerX + 78, topY + 22); ctx.lineTo(centerX, topY + 47); ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.moveTo(centerX - 48, topY + 40); ctx.lineTo(centerX - 44, topY + 68); ctx.quadraticCurveTo(centerX, topY + 92, centerX + 44, topY + 68); ctx.lineTo(centerX + 48, topY + 40); ctx.closePath(); ctx.fill();
  ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(centerX + 65, topY + 26); ctx.lineTo(centerX + 74, topY + 70); ctx.stroke(); ctx.beginPath(); ctx.arc(centerX + 75, topY + 76, 8, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

async function imageFromUrl(url) {
  return new Promise((resolve) => {
    const image = new Image(); image.onload = () => resolve(image); image.onerror = () => resolve(null); image.src = url;
  });
}

async function makeBarcodeImage(token) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  JsBarcode(svg, token, { format: 'CODE128', lineColor: MAROON, background: IVORY, width: 2.5, height: 150, margin: 8, displayValue: false });
  const blob = new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml;charset=utf-8' });
  const objectUrl = URL.createObjectURL(blob);
  try { return await imageFromUrl(objectUrl); } finally { URL.revokeObjectURL(objectUrl); }
}

function isGraduateTicket(ticket) {
  return ticket.ticket_type === 'graduate' || Number(ticket.ticket_number) === 0;
}

function ticketNumberLabel(ticket) {
  const tokenPart = String(ticket?.ticket_token || '').replace(/^TKT-/i, '').slice(0, 12).toUpperCase();
  return `${isGraduateTicket(ticket) ? 'GR' : `GU${String(ticket.ticket_number ?? 0).padStart(2, '0')}`}-${tokenPart || 'PENDING'}`;
}

function formatEventDate(value) {
  if (!value) return 'يحدد لاحقًا';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00`) : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString('ar-SY', { year: 'numeric', month: 'long', day: 'numeric' });
}

async function makeTicketPdf(ticket, application, batchName, eventLocation, eventDate) {
  const W = 1800, H = 580, STUB_X = 1360, STUB_W = W - STUB_X;
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('تعذر إنشاء صورة بطاقة الدخول.');
  const background = ctx.createLinearGradient(0, 0, W, H); background.addColorStop(0, MAROON); background.addColorStop(1, MAROON_LIGHT);
  ctx.fillStyle = background; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#39101a'; ctx.fillRect(STUB_X, 0, STUB_W, H);

  const ornament = await imageFromUrl(`${window.location.origin}/brand/ticket-ornament.svg`);
  if (ornament) { ctx.save(); ctx.globalAlpha = 0.58; ctx.drawImage(ornament, 0, 0, 490, H); ctx.restore(); }
  const logo = await imageFromUrl(`${window.location.origin}/brand/ssu-emblem.png`);
  const drawBrand = (x, y, size, rightEdge, maxTextWidth) => {
    ctx.save(); ctx.fillStyle = IVORY; ctx.beginPath(); ctx.arc(x + size / 2, y + size / 2, size / 2 + 5, 0, Math.PI * 2); ctx.fill();
    if (logo) { try { ctx.drawImage(logo, x + 5, y + 5, size - 10, size - 10); } catch {} }
    drawWrapped(ctx, 'اتحاد طلبة سوريا', rightEdge, y + 26, maxTextWidth, 26, size > 50 ? 23 : 17, WHITE, 700, 'right');
    drawWrapped(ctx, 'فرع محافظة اللاذقية', rightEdge, y + 50, maxTextWidth, 21, size > 50 ? 16 : 12, MUTED, 500, 'right');
    ctx.restore();
  };
  // Main ticket brand; emblem and lettering sit in separate zones to avoid overlap.
  drawBrand(1195, 34, 64, 1175, 270);

  const isGraduate = isGraduateTicket(ticket);
  const titleCenter = 875;
  drawWrapped(ctx, 'تذكرة دخول', titleCenter, 192, 760, 62, 59, WHITE, 800, 'center');
  drawWrapped(ctx, 'حفلات التخرج', titleCenter, 255, 760, 62, 59, WHITE, 800, 'center');
  drawWrapped(ctx, batchName || 'دفعة البناء والتأسيس 2026', titleCenter, 302, 760, 34, 27, '#f4e3cd', 500, 'center');
  drawWrapped(ctx, `${isGraduate ? 'الخريج / الخريجة' : `المرافق رقم ${ticket.ticket_number}`} : ${application.full_name || '—'}`, titleCenter, 354, 800, 34, 23, WHITE, 700, 'center');
  const academicInfo = `${application.department || 'جامعة اللاذقية'}${application.specialization && application.specialization !== 'لا يوجد اختصاص' ? ` · ${application.specialization}` : ''}`;
  drawWrapped(ctx, academicInfo, titleCenter, 390, 800, 30, 19, MUTED, 500, 'center');
  drawCap(ctx, titleCenter, 409);
  drawWrapped(ctx, 'نحو مستقبل يصنعه الشباب', titleCenter, 554, 600, 26, 19, '#f6e8d6', 500, 'center');

  // Perforated ticket stub.
  ctx.save(); ctx.strokeStyle = '#f4eadb'; ctx.lineWidth = 5; ctx.setLineDash([17, 13]); ctx.beginPath(); ctx.moveTo(STUB_X, 22); ctx.lineTo(STUB_X, H - 22); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = IVORY; ctx.beginPath(); ctx.arc(STUB_X, 0, 36, 0, Math.PI * 2); ctx.fill(); ctx.beginPath(); ctx.arc(STUB_X, H, 36, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  drawBrand(1698, 27, 48, 1682, 218);

  const barcode = await makeBarcodeImage(ticket.ticket_token);
  const barcodeX = 1380, barcodeY = 100, barcodeW = 92, barcodeH = 420;
  ctx.fillStyle = IVORY; ctx.fillRect(barcodeX, barcodeY, barcodeW, barcodeH);
  if (barcode) {
    // Rotate conventional CODE128 so its stripe direction resembles the sample ticket.
    ctx.save(); ctx.translate(barcodeX + barcodeW / 2, barcodeY + barcodeH / 2); ctx.rotate(Math.PI / 2);
    ctx.drawImage(barcode, -barcodeH / 2 + 3, -barcodeW / 2 + 4, barcodeH - 6, barcodeW - 8); ctx.restore();
  }
  const right = 1770, pillX = 1492, pillW = 278, pillH = 54;
  const loc = String(eventLocation || 'يحدد لاحقًا');
  drawPill(ctx, pillX, 112, pillW, pillH, 'المكان', loc.length > 28 ? `${loc.slice(0, 25)}…` : loc, { labelSize: 15, valueSize: 19, maxWidth: pillW - 24 });
  drawPill(ctx, pillX, 178, pillW, pillH, 'التاريخ', formatEventDate(eventDate), { labelSize: 15, valueSize: 18, maxWidth: pillW - 24 });
  drawPill(ctx, pillX, 244, pillW, pillH, 'نوع الدخول', isGraduate ? 'خريج' : `مرافق ${ticket.ticket_number}`, { labelSize: 15, valueSize: 20 });
  drawPill(ctx, pillX, 310, pillW, 72, 'رقم التذكرة', ticketNumberLabel(ticket), { labelSize: 15, valueSize: 17 });
  drawWrapped(ctx, 'تذكرة شخصية — لا تُسجّل الدخول إلا بواسطة فريق التنظيم', right, 446, 270, 25, 14, '#e4d2c2', 500, 'right');
  drawWrapped(ctx, 'الاحتفاظ بالتذكرة وعدم مشاركتها', right, 478, 270, 24, 13, '#e4d2c2', 500, 'right');

  const pdf = await PDFDocument.create();
  const pngBytes = await new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? blob.arrayBuffer().then(resolve, reject) : reject(new Error('تعذر تجهيز صورة البطاقة.')), 'image/png'));
  const image = await pdf.embedPng(new Uint8Array(pngBytes));
  const page = pdf.addPage([842, 271.8]); page.drawImage(image, { x: 0, y: 0, width: 842, height: 271.8 });
  return new Uint8Array(await pdf.save());
}

function ticketFilename(ticket, application) {
  const type = isGraduateTicket(ticket) ? 'بطاقة_الخريج' : `بطاقة_المرافق_${String(ticket.ticket_number).padStart(2, '0')}`;
  return `${type}_${safeArchiveFilename(application.tracking_code || 'تذكرة')}.pdf`;
}

export async function downloadTicketsAsOnePdf(tickets, application, batchName, eventLocation = '', eventDate = '') {
  if (!tickets?.length) throw new Error('لا توجد بطاقات لتنزيلها.');
  const bundle = await PDFDocument.create();
  for (const ticket of tickets) {
    const bytes = await makeTicketPdf(ticket, application, batchName, eventLocation, eventDate);
    const one = await PDFDocument.load(bytes);
    const pages = await bundle.copyPages(one, one.getPageIndices());
    pages.forEach((page) => bundle.addPage(page));
  }
  const bytes = await bundle.save({ useObjectStreams: true });
  downloadBlob(new Blob([bytes], { type: 'application/pdf' }), `بطاقات_التخرج_${safeArchiveFilename(application.tracking_code)}.pdf`);
}

export async function downloadTicketsSeparatelyZip(tickets, application, batchName, eventLocation = '', eventDate = '') {
  if (!tickets?.length) throw new Error('لا توجد بطاقات لتنزيلها.');
  const zip = new JSZip();
  for (const ticket of tickets) {
    const bytes = await makeTicketPdf(ticket, application, batchName, eventLocation, eventDate);
    zip.file(ticketFilename(ticket, application), bytes);
  }
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  downloadBlob(blob, `بطاقات_منفصلة_${safeArchiveFilename(application.tracking_code)}.zip`);
}
