(() => {
  'use strict';

  const config = window.SEARCH_CONFIG;
  const { statuses, normalizeSector, telegramUsername, minskTime, awaitingReport, shiftWindow, readSchedule, serialize, sheetCell, compare, clean, sectorStatus, hasOverlap } = window.SearchModel;
  const { sectors, boundary } = window.MINSK_SECTORS;
  const zones = new Map(sectors.map(([id, center, vertices]) => [normalizeSector(id), { center, vertices }]));
  const root = document.documentElement;
  const coordinator = root.dataset.mode === 'coordinator';
  const detail = document.getElementById('detail');
  const search = document.getElementById('sector-query');
  const list = document.getElementById('sector-list');
  const syncStatus = document.getElementById('sync-status');
  const editorMessage = document.getElementById('editor-message');
  const mapNote = document.getElementById('map-note');
  const name = 'luna-sectors:' + config.date;
  const privateStore = name + ':coordinator';
  let storeReady = true;
  let shifts = [];
  let retiredShifts = [];
  let bySector = new Map();
  let filter = 'all';
  let selected = '';
  let editing = '';
  let moving = '';
  let loading = false;
  let lastSignature = '';
  let gotSchedule = false;
  let hasPublicSchedule = false;
  let map, polygonLayer, labelsLayer;
  let sectorTip, tipCloseTimer;
  const polygons = new Map();
  let publicCsv = '';

  const dateTitle = new Intl.DateTimeFormat('ru-RU', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC'
  }).format(new Date(config.date + 'T12:00:00Z'));
  document.getElementById('event-label').textContent = 'Минск · ' + dateTitle;

  function node(tag, className, text) {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (text !== undefined) result.textContent = text;
    return result;
  }

  function button(text, callback, className = '') {
    const result = node('button', className, text);
    result.type = 'button';
    result.addEventListener('click', callback);
    return result;
  }

  function external(text, url) {
    const result = node('a', '', text);
    result.href = url;
    result.target = '_blank';
    result.rel = 'noopener noreferrer';
    return result;
  }

  function telegramLink(value) {
    const username = telegramUsername(value);
    if (!username) return null;
    const link = external('@' + username, 'https://t.me/' + username);
    link.className = 'telegram-contact';
    return link;
  }

  function badge(status) {
    const result = node('span', 'badge');
    const dot = node('span', 'dot');
    dot.style.setProperty('--status', statuses[status].color);
    result.append(dot, statuses[status].label);
    return result;
  }

  function bucket(id) {
    return bySector.get(id) ?? [];
  }

  function statusOf(id) {
    return coordinator || hasPublicSchedule ? sectorStatus(bucket(id)) : 'unknown';
  }

  function updateIndexes() {
    bySector = new Map();
    for (const row of shifts) {
      if (!bySector.has(row.sector)) bySector.set(row.sector, []);
      bySector.get(row.sector).push(row);
    }
  }

  function stored(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); }
    catch { return null; }
  }

  function put(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch { return false; }
  }

  function publicFeed() {
    if (!config.scheduleCsvUrl?.trim()) return '';
    const url = new URL(config.scheduleCsvUrl);
    if (url.origin !== 'https://docs.google.com' || !/^\/spreadsheets\/d\/e\/[\w-]+\/pub$/.test(url.pathname) ||
        url.searchParams.get('output') !== 'csv' || url.username || url.password) {
      throw new Error('В config.js нужна ссылка на опубликованный CSV из Google Таблиц.');
    }
    return url.href;
  }

  async function readFeed(url) {
    const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(7000) });
    if (!response.ok) throw new Error('Расписание недоступно.');
    const result = readSchedule(await response.text());
    const known = result.entries.filter(row => zones.has(row.sector));
    return { entries: known.sort(compare), invalid: result.invalid + result.entries.length - known.length };
  }

  function showSchedule(entries) {
    hasPublicSchedule = true;
    const clock = minskTime(new Date());
    const signature = JSON.stringify(entries) + '|' + entries.filter(row => awaitingReport(row, config.date, clock)).length;
    shifts = entries;
    if (signature !== lastSignature) {
      lastSignature = signature;
      updateIndexes();
      closeSectorTip();
      paintPolygons();
      renderList();
      renderDetail();
    }
  }

  async function refresh() {
    if (coordinator || loading) return;
    loading = true;
    const control = document.getElementById('refresh');
    control.disabled = true;
    let configError = '';
    let liveError = false;
    let result;
    try { publicCsv = publicFeed(); } catch (error) { configError = error.message; }
    try {
      if (publicCsv) {
        try {
          result = await readFeed(publicCsv);
          gotSchedule = true;
          put(name + ':' + publicCsv, result.entries);
          syncStatus.textContent = 'Расписание обновлено в ' + new Intl.DateTimeFormat('ru-RU', {
            hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Minsk'
          }).format(new Date()) + ' по Минску.';
        } catch {
          liveError = true;
          if (gotSchedule) {
            syncStatus.textContent = 'Связь с таблицей прервалась. Показана последняя загруженная версия.';
            return;
          }
          const cached = stored(name + ':' + publicCsv);
          if (Array.isArray(cached)) {
            gotSchedule = true;
            showSchedule(cached.map(row => clean(row)).filter(row => row && zones.has(row.sector)).sort(compare));
            syncStatus.textContent = 'Таблица недоступна. Показана сохранённая версия.';
            return;
          }
        }
      }
      if (!result) {
        result = await readFeed('./schedule.csv');
        syncStatus.textContent = configError || (liveError ? 'Таблица недоступна. Показано расписание из файла.' : 'Расписание из файла.');
      }
      if (result.invalid) syncStatus.textContent += ' Пропущено строк с ошибками: ' + result.invalid + '.';
      if (!result.entries.length) syncStatus.textContent += ' Назначений пока нет.';
      showSchedule(result.entries);
    } catch {
      syncStatus.textContent = configError || (location.protocol === 'file:' ?
        'Локальный просмотр. Для общего расписания открой сайт по ссылке.' :
        'Расписание недоступно. Уточни у координатора, свободен ли участок.');
    } finally {
      control.disabled = false;
      loading = false;
    }
  }

  function makeFilters() {
    const holder = document.getElementById('filters');
    for (const [id, label] of [['all', 'Все'], ...Object.entries(statuses).filter(([id]) => id !== 'unknown').map(([id, value]) => [id, value.label])]) {
      const control = button(label, () => {
        filter = id;
        closeSectorTip();
        for (const item of holder.children) item.setAttribute('aria-pressed', item === control ? 'true' : 'false');
        paintPolygons();
        renderList();
      });
      if (id !== 'all') {
        const dot = node('span', 'dot');
        dot.style.setProperty('--status', statuses[id].color);
        control.prepend(dot);
      }
      control.setAttribute('aria-pressed', id === 'all' ? 'true' : 'false');
      holder.append(control);
    }
  }

  function matches(id) {
    return filter === 'all' || filter === statusOf(id);
  }

  function styleFor(id) {
    const state = statusOf(id);
    const visible = matches(id) || selected === id;
    const picked = selected === id;
    return {
      color: picked ? '#142721' : ['free','unknown'].includes(state) ? '#4f7566' : statuses[state].color,
      fillColor: statuses[state].color, weight: picked ? 3 : 1.35,
      fillOpacity: visible ? picked ? .60 : ['free','unknown'].includes(state) ? .19 : .52 : .015,
      opacity: visible ? .93 : .10
    };
  }

  function paintPolygons() {
    for (const [id, layer] of polygons) layer.setStyle(styleFor(id));
    polygons.get(selected)?.bringToFront();
    paintLabels();
  }

  function paintLabels() {
    if (!labelsLayer) return;
    labelsLayer.clearLayers();
    if (map.getZoom() < 13) return;
    const bounds = map.getBounds();
    for (const [id, zone] of zones) {
      if (!(matches(id) || id === selected)) continue;
      const [lon, lat] = zone.center;
      if (!bounds.contains([lat, lon])) continue;
      const label = node('div', 'sector-map-label', id);
      const completed = map.getZoom() >= 15 && bucket(id).filter(row => row.status === 'done').at(-1);
      if (completed) {
        label.classList.add('sector-map-completed');
        label.append(node('span', '', 'Проверено ' + shiftWindow(completed)));
        const who = completed.username ? '@' + completed.username : '';
        if (who) label.append(node('span', 'sector-map-person', who));
      }
      L.marker([lat, lon], {
        keyboard: false, interactive: false,
        icon: L.divIcon({
          className: 'map-label', html: label,
          iconSize: completed ? [126, 48] : [48, 18],
          iconAnchor: completed ? [63, 24] : [24, 9]
        })
      }).addTo(labelsLayer);
    }
  }

  function renderList() {
    list.replaceChildren();
    const query = search.value.trim().toUpperCase().replace(/^[MМ][ -]?/, '');
    if (!query && filter === 'all') {
      list.append(node('p', 'secondary', 'Всего участков: ' + zones.size + '. Можно выбрать любой на карте.'));
      return;
    }
    const exact = normalizeSector(query);
    const results = [...zones.keys()].filter(id => matches(id) && (!query || id === exact || id.includes(query)));
    results.sort((a, b) => Number(b === exact) - Number(a === exact));
    if (!results.length) list.append(node('p', 'secondary', query ? 'Участок не найден. Проверь номер или включи фильтр «Все».' : 'Участков с таким статусом пока нет.'));
    for (const id of results.slice(0, 24)) {
      const row = button('', () => select(id, { zoom: true, focus: true }), 'zone-row');
      row.append(node('span', 'zone-id', id), node('span', '', statuses[statusOf(id)].label));
      list.append(row);
    }
    if (results.length > 24) list.append(node('p', 'secondary', 'Показано 24 из ' + results.length + '. Уточни номер, чтобы сузить список.'));
  }

  function updateRoute() {
    const url = new URL(location.href);
    url.hash = selected ? selected : '';
    try { history.replaceState(null, '', url); } catch {}
  }

  function select(id, options = {}) {
    if (!zones.has(id)) return;
    closeSectorTip();
    if (coordinator && moving && id !== selected) {
      const shift = shifts.find(row => row.id === moving);
      if (shift) {
        const candidate = { ...shift, sector: id };
        if (hasOverlap(shifts, candidate)) {
          editorMessage.textContent = 'В ' + id + ' уже есть назначение на это время. Выбери другой участок.';
          return;
        }
        shifts = shifts.map(row => row.id === moving ? candidate : row);
        moving = '';
        storeShifts('Назначение перенесено в ' + id + '.');
      }
    }
    selected = id;
    editing = '';
    updateRoute();
    paintPolygons();
    renderDetail();
    if (options.zoom && map) {
      const [lon, lat] = zones.get(id).center;
      map.setView([lat, lon], Math.max(map.getZoom(), 14), { animate: false });
    }
    if (options.focus) {
      detail.focus({ preventScroll: true });
      if (matchMedia('(max-width:800px)').matches) detail.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  }

  function timeInput(form, display, name, value = '', required = true) {
    const label = node('label', '', display);
    const input = node('input');
    input.type = 'time';
    input.name = name;
    input.value = value;
    input.required = required;
    label.append(input);
    form.append(label);
  }

  function telegramTopic() {
    if (!config.telegramTopicUrl?.trim()) return '';
    try {
      const url = new URL(config.telegramTopicUrl.trim());
      if (url.origin === 'https://t.me' &&
          /^\/(?:c\/\d+|[A-Za-z][A-Za-z0-9_]{4,31})\/\d+(?:\/\d+)?\/?$/.test(url.pathname) &&
          !url.username && !url.password) return url.href;
    } catch {}
    return '';
  }

  function renderVolunteer(formParent, schedule, id, previous) {
    const form = node('form');
    const action = node('div', 'form-buttons');
    const topic = telegramTopic();
    const times = node('div', 'time-form');
    const response = node('p', 'hint');
    response.setAttribute('role', 'status');
    form.id = 'volunteer-form';
    timeInput(times, 'С', 'start', previous?.get('start') || '');
    timeInput(times, 'До', 'end', previous?.get('end') || '');
    const submit = node('button', 'primary', topic ? 'Скопировать и открыть тему' : 'Заявка в Telegram');
    submit.type = 'submit';
    action.append(submit, button('Скопировать заявку', () => send(true)));
    form.append(times, action, response);
    if (topic) {
      const link = external('Открыть тему поиска', topic);
      link.className = 'secondary';
      form.append(link);
    }
    form.addEventListener('submit', event => { event.preventDefault(); send(false); });
    async function send(copy) {
      if (!form.reportValidity()) return;
      const fields = new FormData(form);
      const start = fields.get('start'), end = fields.get('end');
      if (!(start < end)) {
        response.textContent = 'Время окончания должно быть позже начала.';
        return;
      }
      if (schedule.some(row => start < row.end && row.start < end && ['booked','searching'].includes(row.status))) {
        response.textContent = 'На это время участок уже занят. Выбери другое время или соседний участок.';
        return;
      }
      const message = 'Поиск Луны · ' + dateTitle + '\nУчасток ' + id + '\nМогу искать с ' + start + ' до ' + end + ' (время Минска).\nПожалуйста, подтверди назначение.';
      if (copy) {
        const ok = await copyText(message);
        response.textContent = ok ? 'Заявка скопирована. Отправь её координатору.' : 'Скопируй текст заявки ниже.';
        if (!ok) addCopyField(response, message);
        return;
      }
      if (topic) {
        const copying = copyText(message);
        window.open(topic, '_blank', 'noopener,noreferrer');
        const copied = await copying;
        response.textContent = copied ? 'Заявка в буфере. Вставь её в тему и нажми «Отправить».' :
          'В Telegram вставь текст из поля ниже.';
        if (!copied) addCopyField(response, message);
        return;
      }
      const username = String(config.coordinator ?? '').trim().replace(/^@/, '');
      const destination = /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(username);
      const url = destination
        ? new URL('https://t.me/' + username)
        : new URL('https://t.me/share/url');
      url.searchParams.set('text', message);
      if (!destination) url.searchParams.set('url', location.protocol === 'file:' ?
        'https://donkisson.github.io/poisk-luny/' : location.href);
      window.open(url.href, '_blank', 'noopener,noreferrer');
      response.textContent = destination ? 'В Telegram проверь текст и нажми «Отправить».' :
        'В Telegram выбери личный чат с координатором и отправь заявку.';
    }
    formParent.append(node('h3', '', 'Предложить время'), form);
  }

  function renderDetail() {
    const oldForm = document.getElementById('volunteer-form');
    const previous = oldForm?.dataset.sector === selected ? new FormData(oldForm) : null;
    detail.replaceChildren();
    if (!selected) {
      detail.append(node('h2', '', 'Выбери участок'),
        node('p', 'secondary', coordinator ? 'Нажми на соту или найди её по номеру. Здесь можно назначить группу и записать результат.' :
        'Нажми на соту или найди её по номеру. Координатор подтвердит заявку в Telegram.'));
      return;
    }
    const title = node('div', 'zone-title');
    const close = button('×', () => {
      selected = ''; editing = ''; moving = '';
      updateRoute(); paintPolygons(); renderDetail();
    });
    close.setAttribute('aria-label', 'Закрыть сведения об участке');
    title.append(node('h2', 'zone-id', 'Участок ' + selected), close);
    const [lon, lat] = zones.get(selected).center;
    const yandex = new URL('https://yandex.by/maps/');
    yandex.searchParams.set('ll', lon + ',' + lat);
    yandex.searchParams.set('pt', lon + ',' + lat + ',pm2gnm');
    yandex.searchParams.set('z', '16');
    const links = node('div', 'zone-links');
    links.append(external('Открыть центр в Яндекс Картах', yandex.href));
    detail.append(title, badge(statusOf(selected)), links);
    const schedule = bucket(selected);
    if (schedule.length) {
      const items = node('ul', 'shift-list');
      for (const entry of schedule) items.append(renderShift(entry));
      detail.append(node('h3', '', 'Расписание по Минску'), items);
    } else {
      detail.append(node('p', 'secondary', coordinator || hasPublicSchedule ? 'Подтверждённых назначений на этот участок пока нет.' : 'Расписание ещё не загружено. Уточни время у координатора.'));
    }
    if (coordinator) renderEditor();
    else {
      renderVolunteer(detail, schedule, selected, previous);
      document.getElementById('volunteer-form').dataset.sector = selected;
    }
  }

  function renderShift(entry) {
    const li = node('li', 'shift');
    const row = node('div', 'shift-line');
    const done = entry.status === 'done';
    const waiting = awaitingReport(entry, config.date, minskTime(new Date()));
    row.append(node('strong', '', (done ? 'Проверено ' : '') + shiftWindow(entry)));
    if (!done) row.append(waiting ? node('span', 'badge waiting', 'Ждём отчёт') : badge(entry.status));
    const publicContact = telegramLink(entry.username);
    if (publicContact) row.append(publicContact);
    li.append(row);
    if (!coordinator) return li;
    if (entry.contact && (!entry.username || telegramUsername(entry.contact).toLowerCase() !== entry.username.toLowerCase())) {
      const privateContact = telegramLink(entry.contact);
      li.append(privateContact ?? node('span', '', entry.contact));
    }
    if (entry.note) li.append(node('p', 'secondary private-note', entry.note));
    const actions = node('div', 'form-buttons');
    actions.append(button('Править', () => { editing = entry.id; renderDetail(); document.getElementById('edit-form')?.scrollIntoView({ block: 'nearest' }); }));
    actions.append(button(moving === entry.id ? 'Отмена' : 'Перенести', () => {
      moving = moving === entry.id ? '' : entry.id;
      editorMessage.textContent = moving ? 'Нажми на новый участок на карте, чтобы перенести назначение.' : 'Перенос отменён.';
      renderDetail();
    }));
    actions.append(button('Снять', () => {
      if (!confirm('Снять назначение с ' + entry.sector + ' на ' + entry.start + '–' + entry.end + '?')) return;
      shifts = shifts.filter(row => row.id !== entry.id);
      moving = ''; editing = '';
      storeShifts('Назначение снято.');
    }));
    li.append(actions);
    return li;
  }

  function field(parent, title, name, type, value = '') {
    const label = node('label', 'field', title);
    const control = node(type === 'textarea' || type === 'select' ? type : 'input');
    control.name = name;
    if (control.tagName === 'INPUT') control.type = type;
    if (type !== 'select') control.value = value;
    label.append(control);
    parent.append(label);
    return control;
  }

  function renderEditor() {
    const old = shifts.find(entry => entry.id === editing);
    const form = node('form');
    form.id = 'edit-form';
    const times = node('div', 'time-form');
    timeInput(times, 'С', 'start', old?.start);
    timeInput(times, 'До', 'end', old?.end);
    form.append(times);
    const dropdown = field(form, 'Статус', 'status', 'select');
    for (const key of ['booked','searching','done']) {
      const option = node('option', '', statuses[key].label);
      option.value = key;
      dropdown.append(option);
    }
    dropdown.value = old?.status ?? 'booked';
    const actual = node('fieldset', 'actual-times');
    actual.append(node('legend', '', 'Фактическое время обхода'));
    const actualInputs = node('div', 'time-form');
    timeInput(actualInputs, 'С', 'actual_start', old?.actual_start, false);
    timeInput(actualInputs, 'До', 'actual_end', old?.actual_end, false);
    actual.append(actualInputs, node('p', 'hint', 'Оставь пустым, если обход прошёл в назначенное время.'));
    form.append(actual);
    const toggleActual = () => {
      actual.hidden = dropdown.value !== 'done';
      actual.disabled = actual.hidden;
    };
    dropdown.addEventListener('change', toggleActual);
    toggleActual();
    const username = field(form, 'Telegram @username на карте', 'username', 'text', old?.username);
    username.placeholder = '@username';
    username.autocapitalize = 'off';
    username.spellcheck = false;
    username.maxLength = 33;
    form.append(node('p', 'hint', 'Эта ссылка появится для всех волонтёров.'));
    const contact = field(form, 'Личный контакт или ID', 'contact', 'text', old?.contact);
    contact.placeholder = '@username или ID';
    contact.maxLength = 100;
    const note = field(form, 'Личная заметка', 'note', 'textarea', old?.note);
    note.maxLength = 600;
    const actions = node('div', 'form-buttons');
    const save = node('button', 'primary', old ? 'Сохранить изменение' : 'Подтвердить назначение');
    save.type = 'submit';
    actions.append(save);
    if (old) actions.append(button('Отмена', () => { editing = ''; renderDetail(); }));
    const result = node('p', 'hint');
    result.setAttribute('role', 'status');
    form.append(actions, result);
    form.addEventListener('submit', event => {
      event.preventDefault();
      const id = old?.id || (globalThis.crypto?.randomUUID?.() ?? Date.now() + '-' + Math.random());
      const fields = Object.fromEntries(new FormData(form));
      const slot = clean({ ...fields, id, sector: selected }, true);
      if (!slot) { result.textContent = 'Проверь время начала и окончания.'; return; }
      if ((fields.actual_start || fields.actual_end) && !slot.actual_start) {
        result.textContent = 'Укажи фактическое время начала и окончания обхода.';
        return;
      }
      if (username.value.trim() && !slot.username) {
        result.textContent = 'Для ссылки в Telegram укажи @username.';
        username.focus();
        return;
      }
      if (hasOverlap(shifts, slot)) {
        result.textContent = 'В этом участке на это время уже есть назначение.';
        return;
      }
      shifts = shifts.filter(entry => entry.id !== slot.id).concat(slot);
      editing = '';
      storeShifts('Подтверждено. Для общей карты обнови публичную таблицу или schedule.csv.');
    });
    detail.append(node('h3', '', old ? 'Изменить назначение' : 'Назначить группу'), form);
  }

  function storeShifts(message) {
    shifts.sort(compare);
    storeReady = put(privateStore, { date: config.date, entries: shifts.concat(retiredShifts) });
    editorMessage.textContent = storeReady ? message : 'Браузер не сохранил изменения. Скачай личную копию перед закрытием.';
    updateIndexes();
    paintPolygons();
    renderList();
    renderDetail();
  }

  function getPrivateEntries(data) {
    if (!data || data.date !== config.date || !Array.isArray(data.entries) || data.entries.length > 10000) return null;
    const entries = [], retired = [];
    const seen = new Set();
    for (const raw of data.entries) {
      if (!raw || typeof raw !== 'object') return null;
      const isRetired = raw.status === 'partial';
      const row = clean(isRetired ? { ...raw, status: 'done' } : raw, true);
      if (!row || !row.id || seen.has(row.id) || !zones.has(row.sector)) return null;
      seen.add(row.id);
      if (isRetired) {
        // Keep old notes in the private backup without reserving the sector.
        retired.push({ ...row, status: 'partial' });
      } else {
        if (hasOverlap(entries, row)) return null;
        entries.push(row);
      }
    }
    return { entries: entries.sort(compare), retired };
  }

  function download(filename, value, type) {
    const url = URL.createObjectURL(new Blob([value], { type }));
    const anchor = node('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function copyText(value) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      const area = node('textarea');
      area.value = value;
      area.style.cssText = 'position:fixed;left:-9999px';
      document.body.append(area);
      area.select();
      try { return document.execCommand('copy'); } catch { return false; }
      finally { area.remove(); }
    }
  }

  function addCopyField(target, value) {
    if (target.nextElementSibling?.classList.contains('copy-field')) target.nextElementSibling.remove();
    const area = node('textarea', 'copy-field');
    area.value = value;
    area.readOnly = true;
    area.setAttribute('aria-label', 'Текст для копирования');
    target.after(area);
    area.focus();
    area.select();
  }

  function setupCoordinator() {
    document.title = 'Координатор · Секторы поиска Луны';
    document.getElementById('coordinator-tools').hidden = false;
    document.getElementById('refresh').hidden = true;
    document.getElementById('intro').textContent = 'Назначай группы и обновляй статусы после сообщений в Telegram.';
    syncStatus.textContent = 'Изменения в этом редакторе видны координатору.';
    const saved = getPrivateEntries(stored(privateStore));
    shifts = saved?.entries ?? [];
    retiredShifts = saved?.retired ?? [];
    updateIndexes();
    document.getElementById('export-sheet').addEventListener('click', async () => {
      const value = sheetCell(shifts);
      if (value.length > 50000) {
        editorMessage.textContent = 'Расписание не помещается в одну ячейку. Используй выгрузку schedule.csv.';
        return;
      }
      const ok = await copyText(value);
      editorMessage.textContent = ok ? 'Скопировано. Вставь в ячейку A1 публичной таблицы.' : 'Скопируй из поля ниже и вставь в ячейку A1.';
      if (!ok) addCopyField(editorMessage, value);
    });
    document.getElementById('export-csv').addEventListener('click', () => download('schedule.csv', serialize(shifts), 'text/csv;charset=utf-8'));
    document.getElementById('export-backup').addEventListener('click', () => download('luna-private-' + config.date + '.json',
      JSON.stringify({ date: config.date, entries: shifts.concat(retiredShifts) }, null, 2), 'application/json'));
    document.getElementById('import-backup').addEventListener('change', async event => {
      const input = event.currentTarget;
      const file = input.files[0];
      input.value = '';
      if (!file) return;
      try {
        const saved = getPrivateEntries(JSON.parse(await file.text()));
        if (!saved) throw new Error('Файл относится к другой дате или содержит ошибки.');
        if ((shifts.length || retiredShifts.length) && !confirm('Заменить текущие назначения записями из личной копии?')) return;
        shifts = saved.entries; retiredShifts = saved.retired; editing = ''; moving = '';
        storeShifts('Личная копия загружена.');
      } catch (error) { editorMessage.textContent = 'Копия не загружена. ' + error.message; }
    });
  }

  function closeSectorTip() {
    clearTimeout(tipCloseTimer);
    sectorTip?.remove();
    sectorTip = null;
  }

  function scheduleSectorTipClose() {
    clearTimeout(tipCloseTimer);
    tipCloseTimer = setTimeout(() => {
      if (!sectorTip?.getElement()?.matches(':hover, :focus-within')) closeSectorTip();
    }, 300);
  }

  function showSectorTip(id, latlng) {
    const schedule = bucket(id);
    if (!matchMedia('(any-hover:hover)').matches || !matches(id) || !schedule.length) return;
    closeSectorTip();
    const content = node('div', 'sector-tip-content');
    content.append(node('strong', '', 'Сота ' + id));
    const rows = node('div', 'sector-tip-rows');
    const clock = minskTime(new Date());
    for (const entry of schedule) {
      const row = node('div', 'sector-tip-row');
      const done = entry.status === 'done';
      row.append(node('span', '', (done ? 'Проверено ' : '') + shiftWindow(entry)));
      const contact = telegramLink(entry.username);
      if (contact) row.append(contact);
      if (awaitingReport(entry, config.date, clock)) row.append(node('span', 'tip-waiting', 'Ждём отчёт'));
      rows.append(row);
    }
    content.append(rows);
    sectorTip = L.tooltip({ className: 'sector-tip', opacity: 1, interactive: true, direction: 'auto' })
      .setLatLng(latlng).setContent(content).addTo(map);
    const element = sectorTip.getElement();
    element.setAttribute('role', 'group');
    element.setAttribute('aria-label', 'Расписание соты ' + id);
    element.addEventListener('mouseenter', () => clearTimeout(tipCloseTimer));
    element.addEventListener('mouseleave', scheduleSectorTipClose);
    element.addEventListener('focusout', scheduleSectorTipClose);
    L.DomEvent.disableClickPropagation(element);
    L.DomEvent.disableScrollPropagation(element);
  }

  function startMap() {
    if (!window.L) {
      mapNote.textContent = 'Карта недоступна. Можно найти участок по номеру.';
      return;
    }
    const westView = L.latLngBounds([[53.883,27.407], [53.945,27.53]]);
    const mainBounds = L.latLngBounds(boundary[0].map(([lon,lat]) => [lat,lon]));
    map = L.map('map', { scrollWheelZoom: false, minZoom: 9, maxZoom: 19, zoomSnap: 0.5, preferCanvas: true, tapTolerance: 16 });
    if (matchMedia('(max-width:800px)').matches) map.setView([53.919, 27.468], 13);
    else map.fitBounds(westView, { maxZoom: 14 });
    polygonLayer = L.layerGroup().addTo(map);
    labelsLayer = L.layerGroup().addTo(map);
    L.polygon(boundary.map(ring => ring.map(([lon,lat]) => [lat,lon])),
      { color: '#547364', weight: 2, fill: false, dashArray: '5 5', interactive: false }).addTo(polygonLayer);
    for (const [id, zone] of zones) {
      const vertices = zone.vertices.map(([lon,lat]) => [lat,lon]);
      const layer = L.polygon(vertices, styleFor(id)).addTo(polygonLayer);
      layer.on('click', () => select(id, { focus: true }));
      layer.on('mouseover', event => showSectorTip(id, event.latlng));
      layer.on('mouseout', scheduleSectorTipClose);
      polygons.set(id, layer);
    }
    L.control.scale({ imperial: false }).addTo(map);
    document.getElementById('west-view').addEventListener('click', () => map.fitBounds(westView));
    document.getElementById('city-view').addEventListener('click', () => map.fitBounds(mainBounds, { padding: [10, 10] }));
    map.on('moveend zoomend', paintLabels);
    map.on('movestart zoomstart', closeSectorTip);
    const region = map.getContainer();
    region.addEventListener('click', () => map.scrollWheelZoom.enable(), { capture: true });
    document.addEventListener('pointerdown', event => {
      if (!region.contains(event.target)) map.scrollWheelZoom.disable();
    }, { capture: true });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        map.scrollWheelZoom.disable();
        closeSectorTip();
      }
    });
    addBasemap();
  }

  function addBasemap() {
    const yandex = window.YANDEX_MAP;
    if (!yandex?.key) { addBackup(); return; }
    const tileUrl = 'https://tiles.api-maps.yandex.ru/v1/tiles/?x={x}&y={y}&z={z}' +
      '&lang=ru_RU&l=map&projection=web_mercator&apikey=' + encodeURIComponent(yandex.key);
    const tiles = L.tileLayer(tileUrl, {
      maxZoom:19, keepBuffer:1, referrerPolicy:'strict-origin-when-cross-origin',
      attribution:'© <a href="https://yandex.by/maps/">Яндекс</a>'
    });
    const brand = L.control({ position: 'topright' });
    brand.onAdd = () => {
      const container = node('div', 'yandex-map-brand');
      container.innerHTML = yandex.brand;
      return container;
    };
    let loadedInBatch = 0, errors = 0;
    const timer = setTimeout(useBackup, 8000);
    function useBackup() {
      if (!map.hasLayer(tiles)) return;
      clearTimeout(timer);
      map.removeLayer(tiles);
      brand.remove();
      addBackup();
    }
    tiles.on('loading', () => { loadedInBatch = 0; errors = 0; });
    tiles.on('tileload', () => { loadedInBatch++; clearTimeout(timer); });
    tiles.on('tileerror', () => { errors++; });
    tiles.on('load', () => { if (!loadedInBatch && errors) useBackup(); });
    brand.addTo(map);
    tiles.addTo(map);
  }

  function addBackup() {
    const osm = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
    mapNote.textContent = 'Яндекс Карты недоступны. Загружается запасная подложка.';
    const script = node('script');
    script.src = 'assets/fallback-map.js';
    script.addEventListener('error', useRaster, { once: true });
    script.addEventListener('load', () => {
      if (!L.maplibreGL) { useRaster(); return; }
      let layer, timeout;
      try {
        layer = L.maplibreGL({
          style: 'https://tiles.openfreemap.org/styles/liberty',
          attribution: '<a href="https://openfreemap.org/">OpenFreeMap</a> · © <a href="https://openmaptiles.org/">OpenMapTiles</a> · ' + osm
        }).addTo(map);
        const vector = layer.getMaplibreMap();
        let errors = 0;
        const fallBack = () => {
          clearTimeout(timeout);
          if (map.hasLayer(layer)) map.removeLayer(layer);
          useRaster();
        };
        timeout = setTimeout(fallBack, 6500);
        vector.once('load', () => {
          if (!map.hasLayer(layer)) return;
          clearTimeout(timeout);
          mapNote.textContent = 'Яндекс Карты недоступны. Включена подложка OpenFreeMap.';
        });
        vector.on('error', () => { if (++errors >= 3 && map.hasLayer(layer)) setTimeout(fallBack, 0); });
      } catch {
        if (layer && map.hasLayer(layer)) map.removeLayer(layer);
        useRaster();
      }
    }, { once: true });
    let raster;
    function useRaster() {
      if (raster) return;
      raster = L.tileLayer('https://a.tile.opentopomap.org/{z}/{x}/{y}.png', {
        maxZoom:19, maxNativeZoom:14,
        attribution:osm + ' · DEM: SRTM, Sonny · <a href="https://opentopomap.org/about">OpenTopoMap</a> (<a href="https://creativecommons.org/licenses/by-sa/3.0/">CC BY-SA</a>)'
      });
      let loaded = 0;
      const failure = setTimeout(() => {
        if (!loaded) mapNote.textContent = 'Подложка недоступна. Соты, список и ссылки на Яндекс Карты работают.';
      }, 7000);
      raster.on('tileload', () => {
        loaded++;
        clearTimeout(failure);
        mapNote.textContent = 'Яндекс Карты недоступны. Включена запасная подложка.';
      }).addTo(map);
    }
    document.head.append(script);
  }

  if (coordinator) setupCoordinator();
  makeFilters();
  startMap();
  renderList();
  renderDetail();
  search.addEventListener('input', renderList);
  search.addEventListener('keydown', event => {
    const id = normalizeSector(search.value);
    if (event.key === 'Enter' && zones.has(id)) select(id, { zoom: true, focus: true });
  });
  document.getElementById('refresh').addEventListener('click', refresh);
  let elapsedShifts = 0;
  setInterval(() => {
    if (document.hidden || !selected) return;
    const clock = minskTime(new Date());
    const expired = shifts.filter(row => awaitingReport(row, config.date, clock)).length;
    if (expired === elapsedShifts) return;
    elapsedShifts = expired;
    if (!editing && !detail.contains(document.activeElement)) renderDetail();
  }, 30000);
  try {
    const shared = normalizeSector(decodeURIComponent(location.hash.slice(1)));
    if (zones.has(shared)) select(shared, { zoom: true });
  } catch {}
  if (!coordinator) {
    refresh();
    setInterval(() => { if (!document.hidden) refresh(); }, 45000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  }
})();

