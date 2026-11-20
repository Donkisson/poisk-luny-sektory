((root) => {
  'use strict';

  const statuses = {
    unknown: { label: 'Статус неизвестен', color: '#789487', priority: 0 },
    free: { label: 'Свободен', color: '#789487', priority: 0 },
    done: { label: 'Проверен', color: '#2d8355', priority: 1 },

    booked: { label: 'Назначен', color: '#d9912d', priority: 3 },
    searching: { label: 'Ищут', color: '#3a70b0', priority: 4 }
  };
  const requiredFields = ['sector', 'start', 'end', 'status'];
  const publicFields = [...requiredFields, 'username', 'actual_start', 'actual_end'];

  function normalizeSector(raw) {
    const input = String(raw ?? '').trim().toUpperCase().replace(/^[MМ][- ]?/, '').replace(/^0+(?=\d)/, '');
    return /^\d{1,4}$/.test(input) && Number(input) > 0 ? input.padStart(3, '0') : '';
  }

  function minutes(value) {
    const match = String(value).trim().match(/^(\d{1,2}):(\d{2})(?::00)?$/);
    return match && +match[1] < 24 && +match[2] < 60 ? +match[1] * 60 + +match[2] : NaN;
  }

  function formatTime(value) {
    return String(Math.floor(value / 60)).padStart(2, '0') + ':' + String(value % 60).padStart(2, '0');
  }

  function parseCSV(input) {
    const rows = [];
    let row = [], cell = '', quoted = false;
    const source = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    for (let index = 0; index < source.length; index++) {
      const char = source[index];
      if (char === '"') {
        if (quoted && source[index + 1] === '"') {
          cell += '"';
          index++;
        } else if (quoted || !cell) {
          quoted = !quoted;
        } else {
          cell += char;
        }
      } else if (char === ',' && !quoted) {
        row.push(cell);
        cell = '';
      } else if (char === '\n' && !quoted) {
        rows.push(row.concat(cell));
        row = [];
        cell = '';
      } else {
        cell += char;
      }
    }
    if (quoted) throw new Error('В CSV не закрыты кавычки.');
    if (row.length || cell) rows.push(row.concat(cell));
    return rows.filter(fields => fields.some(value => value.trim()));
  }

  function telegramUsername(value) {
    const name = String(value ?? '').trim().replace(/^@/, '');
    return /^[A-Za-z0-9_]{4,32}$/.test(name) && /[A-Za-z]/.test(name) ? name : '';
  }

  const minskClock = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Minsk', year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', hourCycle:'h23'
  });

  function minskTime(now) {
    const fields = Object.fromEntries(minskClock.formatToParts(now).map(part => [part.type, part.value]));
    return fields.year + '-' + fields.month + '-' + fields.day + 'T' + fields.hour + ':' + fields.minute;
  }

  function crossesMidnight(start, end) {
    return minutes(end) < minutes(start);
  }

  function validRange(start, end) {
    return Number.isFinite(start) && Number.isFinite(end) && start !== end;
  }

  function awaitingReport(entry, date, clock) {
    if (entry.status !== 'booked' && entry.status !== 'searching') return false;
    if (!crossesMidnight(entry.start, entry.end)) return clock >= date + 'T' + entry.end;
    const tomorrow = new Date(date + 'T00:00:00Z');
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    return clock >= tomorrow.toISOString().slice(0, 10) + 'T' + entry.end;
  }

  function shiftWindow(entry) {
    const actual = entry.status === 'done' && entry.actual_start && entry.actual_end;
    const start = actual ? entry.actual_start : entry.start;
    const end = actual ? entry.actual_end : entry.end;
    return start + '–' + end + (crossesMidnight(start, end) ? ' (+1 день)' : '');
  }

  function clean(row, includePrivate = false) {
    if (!row || typeof row !== 'object') return null;
    const sector = normalizeSector(row.sector);
    const start = minutes(row.start), end = minutes(row.end);
    const status = String(row.status ?? '').trim();
    if (!sector || !validRange(start, end) || !Object.hasOwn(statuses, status) || ['free', 'unknown'].includes(status)) return null;
    const shift = { sector, start: formatTime(start), end: formatTime(end), status };
    const username = telegramUsername(row.username);
    if (username) shift.username = username;
    const actualStart = minutes(row.actual_start), actualEnd = minutes(row.actual_end);
    if (status === 'done' && validRange(actualStart, actualEnd)) {
      shift.actual_start = formatTime(actualStart);
      shift.actual_end = formatTime(actualEnd);
    }
    if (includePrivate) {
      shift.id = String(row.id ?? '');
      shift.contact = String(row.contact ?? '').slice(0, 100);
      shift.note = String(row.note ?? '').slice(0, 600);
    }
    return shift;
  }

  function readSchedule(text) {
    const [header, ...rows] = parseCSV(text);
    if (header?.length === 1 && !rows.length && header[0].trim().startsWith('[')) {
      const envelope = JSON.parse(header[0]);
      if (!Array.isArray(envelope) || envelope[0] !== 'luna-schedule-v1' || !Array.isArray(envelope[1])) {
        throw new Error('Некорректный формат расписания.');
      }
      const entries = envelope[1].filter(row => row?.status !== 'partial').map(row => clean(row));
      return { entries: entries.filter(Boolean), invalid: entries.filter(row => !row).length };
    }
    const columns = (header ?? []).map(value => value.trim().toLowerCase());
    if (requiredFields.some(field => !columns.includes(field))) throw new Error('В CSV отсутствуют нужные заголовки.');
    const entries = rows.map(row => Object.fromEntries(publicFields.map(field => [field, row[columns.indexOf(field)]])))
      .filter(row => row.status?.trim() !== 'partial').map(row => clean(row));
    return { entries: entries.filter(Boolean), invalid: entries.filter(row => !row).length };
  }

  function serialize(entries, separator = ',') {
    const escape = value => {
      const text = String(value ?? '');
      return separator === ',' && /[,"\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
    };
    return [publicFields.join(separator), ...entries.map(entry => clean(entry)).filter(Boolean).sort(compare)
      .map(row => publicFields.map(field => escape(row[field])).join(separator))].join(separator === ',' ? '\r\n' : '\n') + '\n';
  }

  function sheetCell(entries) {
    return JSON.stringify(['luna-schedule-v1', entries.map(entry => clean(entry)).filter(Boolean).sort(compare)]);
  }

  function compare(a, b) {
    return Number(a.sector) - Number(b.sector) || a.start.localeCompare(b.start);
  }

  function sectorStatus(entries) {
    return entries.reduce((top, shift) => statuses[shift.status].priority > statuses[top].priority ? shift.status : top, 'free');
  }

  function hasOverlap(entries, slot) {
    const endMinute = entry => minutes(entry.end) + (crossesMidnight(entry.start, entry.end) ? 24 * 60 : 0);
    const slotStart = minutes(slot.start), slotEnd = endMinute(slot);
    return entries.some(entry => entry.sector === slot.sector && (!slot.id || entry.id !== slot.id) &&
      minutes(entry.start) < slotEnd && slotStart < endMinute(entry));
  }

  const model = { statuses, minutes, formatTime, normalizeSector, telegramUsername, minskTime, crossesMidnight, awaitingReport, shiftWindow, readSchedule, serialize, sheetCell, compare, clean, sectorStatus, hasOverlap };
  if (typeof module !== 'undefined' && module.exports) module.exports = model;
  else root.SearchModel = model;
})(globalThis);
