const PDFDocument = require('pdfkit');

function homeIdStr(h) {
  if (h == null) return '';
  if (typeof h === 'object' && h._id != null && h._id !== h) return String(h._id);
  return String(h);
}

function formatYmd(value) {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString().split('T')[0];
  const s = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().split('T')[0];
  return s;
}

/**
 * Build a PDF document for one home’s shifts across all snapshot weeks.
 * Caller pipes the document to the HTTP response and calls doc.end().
 */
function createTimetableHomePdf(timetable, homeMongoId, options = {}) {
  const homeName = options.homeName || 'Home';
  const homeIdString = homeIdStr(homeMongoId);
  const doc = new PDFDocument({ margin: 48, size: 'A4' });

  doc.fontSize(18).text(String(timetable.name || 'Timetable'), { underline: true });
  doc.moveDown(0.5);
  doc.fontSize(11).fillColor('#333333');
  doc.text(`Home: ${homeName}`);
  doc.text(`Period: ${formatYmd(timetable.start_date)} – ${formatYmd(timetable.end_date)}`);
  if (timetable.published_at) {
    doc.text(`Published: ${formatYmd(timetable.published_at)}`);
  }
  doc.text(`Status: ${timetable.status || ''}`);
  doc.fillColor('#000000');
  doc.moveDown();

  const weeks = Array.isArray(timetable.weekly_rotas) ? timetable.weekly_rotas : [];
  let hadAnyShifts = false;

  for (const week of weeks) {
    const shifts = (week.shifts || []).filter((s) => homeIdStr(s.home_id) === homeIdString);
    if (shifts.length === 0) continue;

    hadAnyShifts = true;

    if (doc.y > 680) {
      doc.addPage();
    }

    doc
      .fontSize(12)
      .text(
        `Week ${week.week_number}: ${formatYmd(week.week_start_date)} – ${formatYmd(week.week_end_date)}`,
        { underline: true }
      );
    doc.moveDown(0.25);
    doc.fontSize(9);

    const sorted = [...shifts].sort((a, b) => {
      const ka = `${a.date || ''} ${(a.start_time || '').slice(0, 5)}`;
      const kb = `${b.date || ''} ${(b.start_time || '').slice(0, 5)}`;
      return ka.localeCompare(kb);
    });

    for (const shift of sorted) {
      const staff = (shift.assigned_staff || []).map((s) => s.name).join(', ') || '—';
      const type = shift.shift_type || '';
      const line = `${shift.date}  ${String(shift.start_time || '').slice(0, 5)}–${String(shift.end_time || '').slice(0, 5)}  ${type}  Staff: ${staff}`;
      doc.text(line, { width: 500 });
    }
    doc.moveDown(0.75);
  }

  if (!hadAnyShifts) {
    doc.fontSize(11).text('No shifts recorded for this home in this timetable.');
  }

  return doc;
}

function safeFilePart(s) {
  const t = String(s || 'export')
    .replace(/[^\w.-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return t.slice(0, 80) || 'timetable';
}

module.exports = {
  createTimetableHomePdf,
  homeIdStr,
  safeFilePart
};
