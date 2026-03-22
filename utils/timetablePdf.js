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

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function ordinal(n) {
  const j = n % 10;
  const k = n % 100;
  if (j === 1 && k !== 11) return `${n}st`;
  if (j === 2 && k !== 12) return `${n}nd`;
  if (j === 3 && k !== 13) return `${n}rd`;
  return `${n}th`;
}

/** getUTCDay() index: 0 Sun .. 6 Sat */
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Parse "HH:mm" or "H:mm" -> { h, min } 24h */
function parseTimeParts(timeStr) {
  const s = String(timeStr || '').trim();
  const m = s.match(/(\d{1,2}):(\d{2})/);
  if (!m) return { h: 0, min: 0 };
  return { h: parseInt(m[1], 10), min: parseInt(m[2], 10) };
}

/** 24h parts -> "8AM", "8:30PM" */
function format12hLabel(parts) {
  let { h, min } = parts;
  if (h === 24 && min === 0) {
    h = 0;
  }
  const period = h >= 12 ? 'PM' : 'AM';
  let h12 = h % 12;
  if (h12 === 0) h12 = 12;
  if (min === 0) return `${h12}${period}`;
  return `${h12}:${String(min).padStart(2, '0')}${period}`;
}

function shiftRowLabel(startTime, endTime) {
  const a = parseTimeParts(startTime);
  const b = parseTimeParts(endTime);
  return `${format12hLabel(a)}-${format12hLabel(b)}`;
}

function slotKey(startTime, endTime) {
  const a = parseTimeParts(startTime);
  const b = parseTimeParts(endTime);
  return `${String(a.h).padStart(2, '0')}:${String(a.min).padStart(2, '0')}|${String(b.h).padStart(2, '0')}:${String(b.min).padStart(2, '0')}`;
}

function slotSortOrder(key) {
  const [left] = key.split('|');
  const [h, min] = left.split(':').map((x) => parseInt(x, 10));
  return (h || 0) * 60 + (min || 0);
}

/**
 * Given names in full, surname as initial + period.
 * "Anna Collins" -> "Anna C."; "Anna Marie Smith" -> "Anna Marie S."
 * Single token -> shown unchanged (e.g. "Ludwig").
 */
function formatStaffNameForCell(rawName) {
  if (rawName == null) return '';
  const s = String(rawName).trim();
  if (!s) return 'Unknown';
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0];
  const firstNames = parts.slice(0, -1).join(' ');
  const surname = parts[parts.length - 1];
  const letter = surname.replace(/^[^A-Za-z]+/, '').charAt(0);
  const surAbbrev = letter ? `${letter.toUpperCase()}.` : '';
  return surAbbrev ? `${firstNames} ${surAbbrev}` : firstNames;
}

function formatStaffForCell(assignedStaff) {
  if (!assignedStaff || !assignedStaff.length) return '';
  return assignedStaff
    .map((a) => formatStaffNameForCell(a.name))
    .filter(Boolean)
    .join(' / ');
}

/**
 * Seven columns matching the timetable snapshot week (same range as generation:
 * week_start_date .. week_start_date + 6 days), not a separate Mon–Sun calendar week.
 * Headers use the real weekday for each column, e.g. "Wed 12th Mar".
 */
function weekDayDatesForSnapshotWeek(week) {
  const ymd = formatYmd(week.week_start_date);
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return [];
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10) - 1;
  const d = parseInt(m[3], 10);
  const out = [];
  for (let i = 0; i < 7; i++) {
    const dt = new Date(Date.UTC(y, mo, d + i));
    const yy = dt.getUTCFullYear();
    const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(dt.getUTCDate()).padStart(2, '0');
    const str = `${yy}-${mm}-${dd}`;
    const dayNum = dt.getUTCDate();
    const moIdx = dt.getUTCMonth();
    const dow = dt.getUTCDay();
    const wlabel = WEEKDAY_SHORT[dow] || '';
    const header = `${wlabel} ${ordinal(dayNum)} ${MONTHS_SHORT[moIdx] || ''}`;
    out.push({ ymd: str, header });
  }
  return out;
}

function buildWeekGridForHome(week, homeIdString) {
  const shifts = (week.shifts || []).filter((s) => homeIdStr(s.home_id) === homeIdString);
  const slotKeys = new Set();
  for (const s of shifts) {
    slotKeys.add(slotKey(s.start_time, s.end_time));
  }
  const rows = Array.from(slotKeys).sort((a, b) => slotSortOrder(a) - slotSortOrder(b));
  const rowLabels = {};
  for (const s of shifts) {
    const k = slotKey(s.start_time, s.end_time);
    rowLabels[k] = shiftRowLabel(s.start_time, s.end_time);
  }

  const days = weekDayDatesForSnapshotWeek(week);
  const cellMap = new Map();
  for (const s of shifts) {
    const k = slotKey(s.start_time, s.end_time);
    const date = formatYmd(s.date);
    const cellText = formatStaffForCell(s.assigned_staff);
    const ck = `${k}@@${date}`;
    if (cellText) {
      const prev = cellMap.get(ck);
      cellMap.set(ck, prev ? `${prev}, ${cellText}` : cellText);
    }
  }

  return { rows, rowLabels, days, cellMap };
}

function drawTableGrid(doc, opts) {
  const {
    x,
    y,
    colWidths,
    rowHeights,
    headerBg = '#e8e0d0',
    bodyBg = '#f7f4ec',
    border = '#000000'
  } = opts;

  doc.lineWidth(0.5);
  doc.strokeColor(border);
  let rowY = y;
  for (let r = 0; r < rowHeights.length; r++) {
    let cx = x;
    const rh = rowHeights[r];
    for (let c = 0; c < colWidths.length; c++) {
      const cw = colWidths[c];
      const fill = r === 0 || c === 0 ? headerBg : bodyBg;
      doc.fillColor(fill).rect(cx, rowY, cw, rh).fill();
      doc.rect(cx, rowY, cw, rh).stroke();
      cx += cw;
    }
    rowY += rh;
  }
}

function drawCellText(doc, text, x, y, w, h, { bold = false, size = 8 } = {}) {
  doc.fillColor('#000000');
  if (bold) {
    doc.font('Helvetica-Bold');
  } else {
    doc.font('Helvetica');
  }
  doc.fontSize(size);
  const t = String(text || '');
  const pad = 3;
  const maxTextH = Math.max(h - pad * 2, size);
  const textH = doc.heightOfString(t, { width: w, lineGap: 0 });
  if (textH > maxTextH) {
    doc.text(t, x, y + pad, {
      width: w,
      align: 'center',
      height: maxTextH,
      lineGap: 0,
      ellipsis: true
    });
  } else {
    const ty = y + pad + (maxTextH - textH) / 2;
    doc.text(t, x, ty, { width: w, align: 'center', lineGap: 0 });
  }
  doc.font('Helvetica');
}

/**
 * Build a PDF document for one home’s shifts across all snapshot weeks.
 * Landscape grid: rows = shift times, columns = days (see sample layout).
 */
function createTimetableHomePdf(timetable, homeMongoId, options = {}) {
  const homeName = options.homeName || 'Home';
  const homeIdString = homeIdStr(homeMongoId);
  const doc = new PDFDocument({
    margin: 36,
    size: 'A4',
    layout: 'landscape'
  });

  const pageW = doc.page.width;
  const pageH = doc.page.height;
  const margin = 36;
  let cursorY = margin;

  doc.fillColor('#000000');
  doc.font('Helvetica-Bold').fontSize(16).text(String(timetable.name || 'Timetable'), margin, cursorY, {
    width: pageW - 2 * margin
  });
  cursorY = doc.y + 8;

  doc.font('Helvetica').fontSize(9).fillColor('#333333');
  doc.text(`Home: ${homeName}`, margin, cursorY);
  cursorY = doc.y + 2;
  doc.text(`Period: ${formatYmd(timetable.start_date)} – ${formatYmd(timetable.end_date)}`, margin, cursorY);
  cursorY = doc.y + 2;
  if (timetable.published_at) {
    doc.text(`Published: ${formatYmd(timetable.published_at)}`, margin, cursorY);
    cursorY = doc.y + 2;
  }
  doc.text(`Names: given names in full, surname as initial (e.g. Anna C.).`, margin, cursorY);
  cursorY = doc.y + 14;
  doc.fillColor('#000000');

  const weeks = Array.isArray(timetable.weekly_rotas) ? timetable.weekly_rotas : [];
  let hadAnyShifts = false;

  const innerW = pageW - 2 * margin;
  const timeColW = 78;
  const dayColW = (innerW - timeColW) / 7;

  for (const week of weeks) {
    const shifts = (week.shifts || []).filter((s) => homeIdStr(s.home_id) === homeIdString);
    if (shifts.length === 0) continue;

    hadAnyShifts = true;
    const { rows, rowLabels, days, cellMap } = buildWeekGridForHome(week, homeIdString);

    const headerH = 22;
    const spaceForTable = () => pageH - margin - cursorY;
    let dataRowH =
      rows.length === 0
        ? 20
        : Math.min(30, Math.max(12, Math.floor((spaceForTable() - headerH - 8) / Math.max(rows.length, 1))));
    let tableH = headerH + rows.length * dataRowH;

    if (cursorY + tableH > pageH - margin) {
      doc.addPage();
      cursorY = margin;
      dataRowH =
        rows.length === 0
          ? 20
          : Math.min(30, Math.max(12, Math.floor((pageH - 2 * margin - headerH - 8) / Math.max(rows.length, 1))));
      tableH = headerH + rows.length * dataRowH;
    }

    const tableTop = cursorY;
    const colWidths = [timeColW, ...Array(7).fill(dayColW)];
    const rowHeights = [headerH, ...rows.map(() => dataRowH)];

    drawTableGrid(doc, {
      x: margin,
      y: tableTop,
      colWidths,
      rowHeights,
      headerBg: '#e8e0d0',
      bodyBg: '#f7f4ec',
      border: '#000000'
    });

    let rx = margin;
    let ry = tableTop;

    // Header row text
    drawCellText(doc, `WEEK ${week.week_number}`, rx, ry, timeColW, headerH, { bold: true, size: 8 });
    rx += timeColW;
    for (const day of days) {
      drawCellText(doc, day.header, rx, ry, dayColW, headerH, { bold: true, size: 8 });
      rx += dayColW;
    }

    // Data rows
    for (let ri = 0; ri < rows.length; ri++) {
      const slot = rows[ri];
      ry = tableTop + headerH + ri * dataRowH;
      rx = margin;
      drawCellText(doc, rowLabels[slot] || slot, rx, ry, timeColW, dataRowH, { bold: true, size: 7 });
      rx += timeColW;
      for (const day of days) {
        const ck = `${slot}@@${day.ymd}`;
        const content = cellMap.get(ck) || '';
        drawCellText(doc, content, rx, ry, dayColW, dataRowH, { bold: false, size: 7 });
        rx += dayColW;
      }
    }

    cursorY = tableTop + tableH + 16;
  }

  if (!hadAnyShifts) {
    doc.font('Helvetica').fontSize(11).text('No shifts recorded for this home in this timetable.', margin, cursorY);
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
