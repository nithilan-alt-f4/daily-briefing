const $ = sel => document.querySelector(sel);
const $$ = sel => document.querySelectorAll(sel);

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s);
  return isNaN(d) ? s : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function fmtDateTime(s) {
  if (!s) return '';
  const d = new Date(s);
  return isNaN(d) ? s : d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

function dayLabel(dateStr) {
  const d = new Date(dateStr);
  const today = new Date();
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - t) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

// ---------- Native + local cache ----------
// SyncWorker writes JSON files to app's internal files/cache/.
// We try to read them via Capacitor Filesystem; fall back to localStorage.
async function readNativeCache(name) {
  // Try Capacitor Filesystem (native cache written by SyncWorker)
  try {
    if (window.Capacitor?.Plugins?.Filesystem) {
      const result = await window.Capacitor.Plugins.Filesystem.readFile({
        path: `cache/${name}`,
        directory: 'DATA'
      });
      const raw = typeof result.data === 'string' ? result.data : (result.data || result);
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (parsed?.data) return parsed; // { data: ..., savedAt: ... }
    }
  } catch {}
  // Fallback to localStorage cache
  try {
    const raw = localStorage.getItem(`__cache_${name}`);
    if (raw) return JSON.parse(raw);
  } catch {}
  return null;
}

function writeLocalCache(name, data) {
  try {
    localStorage.setItem(`__cache_${name}`, JSON.stringify({
      data,
      savedAt: Date.now()
    }));
  } catch {}
}

function cacheAgeText(savedAt) {
  if (!savedAt) return '';
  const mins = Math.round((Date.now() - savedAt) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  return `${hrs}h ago`;
}

function updateCacheAge(text) {
  const el = $('#cache-age');
  if (el) el.textContent = text ? `updated ${text}` : '';
}

// ---------- Rich text: **bold** + [[News:/Mail:]] jump links ----------
const itemRegistry = {
  news: [], emails: [],
  find(kind, title) {
    const t = title.toLowerCase().replace(/\.\.\.$/, '');
    const list = kind === 'news' ? this.news : this.emails;
    return list.find(i => i.titleLower.includes(t) || t.includes(i.titleLower)) || null;
  },
  add(kind, id, title) {
    this[kind === 'news' ? 'news' : 'emails'].push({ id, titleLower: (title || '').toLowerCase() });
  }
};

function renderRichText(text, registry) {
  let html = escapeHtml(text || '');
  html = html.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  html = html.replace(/\[\[(News|Mail):\s*(.+?)\]\]/g, (m, kind, title) => {
    const target = registry.find(kind, title.trim());
    if (target) {
      return `<span class="jump-link" onclick="jumpTo('${kind.toLowerCase()}', '${target.id}')">${escapeHtml(title.trim())}</span>`;
    }
    return `<b>${escapeHtml(title.trim())}</b>`;
  });
  html = html.replace(/\s*[—–]\s*/g, ', ');
  return html;
}

function jumpTo(kind, id) {
  switchTab(kind === 'news' ? 'world' : 'inbox');
  setTimeout(() => {
    const el = document.querySelector(`[data-item-id="${id}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.remove('flash');
      void el.offsetWidth;
      el.classList.add('flash');
    }
  }, 350);
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  let body;
  try { body = await res.json(); } catch { body = await res.text(); }
  if (!res.ok) {
    const msg = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
    throw new Error(`HTTP ${res.status}: ${msg}`);
  }
  return body;
}

// ---------- Tabs ----------
function switchTab(name) {
  $$('.view').forEach(v => v.classList.remove('active'));
  $$('.tabbar-btn').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  $(`#view-${name}`).classList.add('active');
  window.scrollTo({ top: 0 });
  if (name === 'weather') loadWeatherFull();
  if (name === 'notes' && !notesLoaded) loadNotes();
}
window.switchTab = switchTab;

// ---------- Toast ----------
function toast(msg, ms = 2500) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), ms);
}

// ---------- Masthead ----------
function setDateline() {
  $('#dateline').textContent = new Date().toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
  });
}

// ---------- Classes + exam strip + Saturday ----------
function renderSchedule(sched) {
  const classes = (sched.classes && sched.classes.length) ? sched.classes : [];
  const tomorrowLabel = sched.showTomorrow
    ? `<div class="class-subhead">Tomorrow${sched.tomorrowDay ? ' · ' + dayLabel(sched.tomorrowDay) : ''}</div>`
    : '';

  if (classes.length) {
    $('#classes-body').innerHTML = tomorrowLabel + classes.map(c =>
      `<div class="class-card"><span class="class-name">${escapeHtml(c)}</span></div>`
    ).join('');
  } else if (sched.classesPlaceholder) {
    // No Aakash classes on calendar — show add buttons (debug page only)
    $('#classes-body').innerHTML = `
      <p class="class-empty">No classes on the calendar yet.</p>
      <div style="display:flex;gap:8px;margin-top:0.6rem">
        <a href="/debug.html" class="btn" style="flex:1;text-align:center;text-decoration:none">Add timetable photo</a>
        <a href="/debug.html" class="btn ghost" style="flex:1;text-align:center;text-decoration:none">Enter manually</a>
      </div>
    `;
  } else {
    $('#classes-body').innerHTML = '<p class="class-empty">No classes today.</p>';
  }

  const exam = sched.exams?.[0];
  $('#exam-strip').innerHTML = exam
    ? `<div class="exam-strip"><span class="ex-date">${dayLabel(exam.date)}</span><span>${escapeHtml(exam.title)}</span></div>`
    : '';

  const sat = sched.saturday;
  $('#saturday-line').innerHTML = sat
    ? (sat.isHoliday
        ? `Saturday ${fmtDate(sat.date)}: <span class="hol">holiday</span> (${escapeHtml(sat.reason)})`
        : `Saturday ${fmtDate(sat.date)}: <b>regular school day</b>`)
    : '';
}

// ---------- Weather strip ----------
async function loadWeatherStrip() {
  try {
    const w = await api('/api/weather');
    if (w.error) { $('#w-cond').textContent = 'unavailable'; return; }
    $('#w-temp').textContent = `${w.current.temp}°`;
    $('#w-cond').textContent = w.current.condition;
    $('#w-range').textContent = `H ${w.today.max}° · L ${w.today.min}° · ${w.today.rainChance}% rain`;
  } catch {
    $('#w-cond').textContent = 'unavailable';
  }
}

// ---------- Stories ----------
function assignmentStory(a) {
  const meta = [a.subject, a.teacher].filter(Boolean).join('<span class="sep"></span>');
  return `
    <article class="story" data-item-id="${a.id}" onclick="viewItem('${a.id}')">
      <h3 class="story-title">${escapeHtml(a.title)}</h3>
      ${meta ? `<div class="story-meta">${meta}</div>` : ''}
      <p class="story-body">${escapeHtml((a.content || '').split('\n')[0].substring(0, 180))}${(a.content || '').length > 180 ? '…' : ''}</p>
    </article>`;
}

const ACTION_WORDS = /\b(wear|uniform|dress|bring|carry|submit|attend|report|reach|assemble|leave|deadline|must|required|instructions?)\b/i;

function notificationStory(n) {
  const isAction = ACTION_WORDS.test(n.content || '');
  return `
    <article class="story ${isAction ? 'action-item' : ''}" data-item-id="${n.id}" onclick="viewItem('${n.id}')">
      <h3 class="story-title">${escapeHtml(n.title)}${isAction ? '<span class="exam-tag">action</span>' : ''}</h3>
      <div class="story-meta">${fmtDateTime(n.postedDate)}</div>
      <p class="story-body">${escapeHtml((n.content || '').substring(0, 220))}${(n.content || '').length > 220 ? '…' : ''}</p>
    </article>`;
}

function circularStory(c) {
  return `
    <article class="story" data-item-id="${c.id}" onclick="viewItem('${c.id}')">
      <h3 class="story-title">${escapeHtml(c.title)}${c.hasPdf ? '<span class="pdf-tag">PDF</span>' : ''}</h3>
      <div class="story-meta">${escapeHtml(c.category || '')}<span class="sep"></span>${fmtDate(c.postedDate)}</div>
    </article>`;
}

function renderBriefing(b) {
  const assignments = b.assignments || [];
  const notifs = b.notifications || [];
  const circs = b.circulars || [];
  const emails = b.emails || [];
  const news = b.news || [];

  itemRegistry.news = [];
  itemRegistry.emails = [];
  news.forEach(n => itemRegistry.add('news', n.id, n.title));
  emails.forEach(e => itemRegistry.add('emails', e.id, e.title));

  const narr = $('#sec-narrative');
  const today = new Date().toISOString().slice(0, 10);
  const todaysNotifs = notifs.filter(n => (n.postedDate || '').slice(0, 10) === today);
  const shown = todaysNotifs.length ? todaysNotifs : notifs.slice(0, 2);

  if (b.narrative) {
    narr.innerHTML = `<p class="narrative-text">${renderRichText(b.narrative, itemRegistry)}${b.narrativeStale ? ' <span class="muted" style="font-size:0.75em">(from earlier today)</span>' : ''}</p>`;
  } else {
    narr.innerHTML = `<p class="narrative-text muted">Briefing is being written. Check back after the next sync, or pull down to refresh.</p>`;
  }

  // Today tab: today's notifications only (max 3)
  $('#list-notifications').innerHTML = shown.length
    ? shown.slice(0, 3).map(n => wrapSwipe(notificationStory(n))).join('')
    : '<p class="empty-note">No notifications today. Older ones are in the School tab.</p>';

  // School tab accordions: everything
  $('#list-notifications-full').innerHTML = notifs.length
    ? notifs.map(n => wrapSwipe(notificationStory(n))).join('')
    : '<p class="empty-note">No notifications.</p>';

  $('#list-assignments').innerHTML = assignments.length
    ? assignments.map(a => wrapSwipe(assignmentStory(a))).join('')
    : '<p class="empty-note">No assignments on record.</p>';

  $('#list-circulars').innerHTML = circs.length
    ? circs.map(c => wrapSwipe(circularStory(c))).join('')
    : '<p class="empty-note">No circulars.</p>';

  // Inbox
  $('#list-emails').innerHTML = emails.length
    ? emails.map(e => `
        <div class="rail-item" data-item-id="${e.id}">
          ${wrapSwipeInner(`
            <p class="rail-title">${escapeHtml(e.title)}</p>
            <p class="rail-sub">${escapeHtml(e.from || '')}</p>
            ${e.summary ? `<p class="rail-sub">${renderRichText(e.summary, itemRegistry)}</p>` : ''}
            ${e.gmailUrl ? `<p class="rail-sub"><a class="gmail-link" href="${e.gmailUrl}" target="_blank" rel="noopener">Open in Gmail ↗</a></p>` : ''}
          `, e.id)}
        </div>
      `).join('')
    : '<p class="empty-note">Inbox quiet.</p>';

  // World
  $('#list-news').innerHTML = news.length
    ? news.map(n => `
        <div class="rail-item" data-item-id="${n.id}">
          ${wrapSwipeInner(`
            <p class="rail-title"><a href="${escapeHtml(n.url || '#')}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${escapeHtml(n.title)}</a></p>
            <p class="rail-sub">${escapeHtml(n.sourceName || '')} · ${fmtDate(n.postedDate)}</p>
            ${n.summary ? `<p class="rail-sub">${renderRichText(n.summary, itemRegistry)}</p>` : ''}
          `, n.id)}
        </div>
      `).join('')
    : '<p class="empty-note">No stories today.</p>';

  initSwipe();
}

// Wrap a story in swipe-to-delete scaffolding
function wrapSwipe(html) {
  const idMatch = html.match(/data-item-id="([^"]+)"/);
  const id = idMatch ? idMatch[1] : '';
  return wrapSwipeInner(html, id);
}

function wrapSwipeInner(html, id) {
  return `
    <div class="swipe-wrap" data-del-id="${id}">
      <div class="swipe-del" onclick="swipeDelete('${id}')">Delete</div>
      <div class="swipe-content">${html}</div>
    </div>
  `;
}

// ---------- Swipe to delete (touch + mouse) ----------
function initSwipe() {
  $$('.swipe-wrap').forEach(wrap => {
    const content = wrap.querySelector('.swipe-content');
    if (!content || content.dataset.swipeInit) return;
    content.dataset.swipeInit = '1';

    let startX = 0, startY = 0, dx = 0, dragging = false, locked = null;
    const THRESHOLD = -90;

    const onStart = e => {
      if (e.target.closest('a, button')) return;
      const touch = e.touches ? e.touches[0] : e;
      startX = touch.clientX; startY = touch.clientY;
      dx = 0; locked = null; dragging = true;
      wrap.classList.add('swipe-ready');
      content.style.transition = 'none';
    };
    const onMove = e => {
      if (!dragging) return;
      const touch = e.touches ? e.touches[0] : e;
      const mx = touch.clientX - startX;
      const my = touch.clientY - startY;
      if (locked === null && (Math.abs(mx) > 8 || Math.abs(my) > 8)) {
        locked = Math.abs(mx) > Math.abs(my) ? 'x' : 'y';
      }
      if (locked !== 'x') return;
      dx = Math.min(0, mx);
      content.style.transform = `translateX(${dx}px)`;
      if (e.cancelable) e.preventDefault();
    };
    const onEnd = () => {
      if (!dragging) return;
      dragging = false;
      content.style.transition = '';
      if (dx < THRESHOLD) {
        swipeDelete(wrap.dataset.delId, wrap);
      } else {
        content.style.transform = '';
        setTimeout(() => wrap.classList.remove('swipe-ready'), 250);
      }
    };

    content.addEventListener('touchstart', onStart, { passive: true });
    content.addEventListener('touchmove', onMove, { passive: false });
    content.addEventListener('touchend', onEnd);
    content.addEventListener('mousedown', onStart);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onEnd);
  });
}

async function swipeDelete(id, wrapEl) {
  if (!id) return;
  wrapEl = wrapEl || document.querySelector(`.swipe-wrap[data-del-id="${id}"]`);
  if (!wrapEl) return;
  try {
    await api(`/api/items/${id}`, { method: 'DELETE' });
    wrapEl.classList.add('removing');
    setTimeout(() => {
      wrapEl.remove();
      toast('Deleted');
    }, 320);
  } catch (err) {
    toast('Delete failed');
    const content = wrapEl.querySelector('.swipe-content');
    if (content) content.style.transform = '';
  }
}
window.swipeDelete = swipeDelete;

// ---------- Month calendar ----------
let monthEvents = [];
let selectedDay = null;
let calListExpanded = false;
const CAL_LIST_INITIAL = 3;

async function loadMonth() {
  try {
    const m = await api('/api/calendar/month');
    monthEvents = m.events || [];
    calListExpanded = false;
    renderCalendar();
    // Auto-show today's events (IST)
    const now = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    const todayKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
    selectDay(todayKey);
  } catch (err) {
    $('#cal-grid').innerHTML = `<p class="empty-note">Calendar unavailable: ${escapeHtml(err.message)}</p>`;
  }
}

function renderCalendar() {
  const now = new Date();
  const year = now.getFullYear(), month = now.getMonth();
  const first = new Date(year, month, 1);
  const startDow = first.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayNum = now.getDate();

  const eventsByDay = {};
  for (const e of monthEvents) {
    const key = (e.date || '').slice(0, 10);
    if (!eventsByDay[key]) eventsByDay[key] = [];
    eventsByDay[key].push(e);
  }

  const dows = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  let html = dows.map(d => `<span class="cal-dow">${d}</span>`).join('');
  for (let i = 0; i < startDow; i++) html += '<span class="cal-cell other"></span>';
  for (let d = 1; d <= daysInMonth; d++) {
    const key = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const evs = eventsByDay[key] || [];
    const kinds = [...new Set(evs.map(e => e.kind))];
    const dots = kinds.map(k => `<span class="cal-dot ${k}"></span>`).join('');
    html += `
      <button class="cal-cell ${d === todayNum ? 'today' : ''} ${selectedDay === key ? 'selected' : ''}"
              onclick="selectDay('${key}')">${d}${dots ? `<span class="cal-dots">${dots}</span>` : ''}</button>`;
  }
  $('#cal-grid').innerHTML = html;

  // Event list below — holidays, birthdays, exams, AND personal events (Aakash/coaching etc). No classes.
  const calKinds = new Set(['holiday', 'birthday', 'exam', 'personal']);
  const listEvents = monthEvents.filter(e => calKinds.has(e.kind));
  const total = listEvents.length;
  const visible = calListExpanded ? listEvents : listEvents.slice(0, CAL_LIST_INITIAL);
  const orderLabel = e => {
    if (e.order != null) return `P${e.order}`;
    if (e.date && e.date.includes('T')) {
      const h = parseInt(e.date.slice(11, 13), 10);
      const m = e.date.slice(14, 16);
      const ampm = h >= 12 ? 'pm' : 'am';
      const h12 = h % 12 || 12;
      return `${h12}:${m}${ampm}`;
    }
    return '';
  };
  $('#cal-list').innerHTML = total
    ? visible.map(e => `
        <div class="rail-item">
          <p class="rail-title">
            <span class="kind-badge ${e.kind}">${e.kind}</span>${escapeHtml(e.title)}
            ${/exam|test|akats/i.test(e.title) ? '<span class="exam-tag">exam</span>' : ''}
          </p>
          <p class="rail-sub">${dayLabel(e.date)}${e.location ? ' · ' + escapeHtml(e.location) : ''}</p>
        </div>
      `).join('') + (total > CAL_LIST_INITIAL && !calListExpanded
        ? `<div style="text-align:center;padding:0.6rem 0"><button class="btn ghost" onclick="expandCalList()">Show all ${total} events</button></div>`
        : '')
    : '<p class="empty-note">Nothing scheduled.</p>';
}

function selectDay(key) {
  selectedDay = key;
  renderCalendar();
  // Show ALL events for that day (including classes)
  const evs = monthEvents.filter(e => (e.date || '').slice(0, 10) === key);
  const orderLabel = e => {
    if (e.order != null) return `P${e.order}`;
    if (e.date && e.date.includes('T')) {
      const h = parseInt(e.date.slice(11, 13), 10);
      const m = e.date.slice(14, 16);
      const ampm = h >= 12 ? 'pm' : 'am';
      const h12 = h % 12 || 12;
      return `${h12}:${m}${ampm}`;
    }
    return '';
  };
  $('#cal-day-events').innerHTML = `
    <p class="cde-title">${new Date(key + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</p>
    ${evs.length
      ? evs.map(e => {
          const label = orderLabel(e);
          return `<div class="cde-item"><span class="kind-badge ${e.kind}">${e.kind}</span>${escapeHtml(e.title)}${label ? ` <span style="font-size:0.72rem;color:var(--muted)">${label}</span>` : ''}</div>`;
        }).join('')
      : '<p class="cde-empty">Nothing on this day.</p>'}
  `;
}
window.selectDay = selectDay;

function expandCalList() {
  calListExpanded = true;
  renderCalendar();
}
window.expandCalList = expandCalList;

// ---------- Accordions ----------
function toggleAcc(id) {
  const acc = $(`#${id}`);
  const wasOpen = acc.classList.contains('open');
  $$('.acc').forEach(a => a.classList.remove('open'));
  if (!wasOpen) acc.classList.add('open');
}
window.toggleAcc = toggleAcc;

// ---------- Pull to refresh ----------
function initPullToRefresh() {
  const ptr = $('#ptr');
  const paper = document.querySelector('.paper');
  let startY = 0, pulling = false, distance = 0;
  const THRESHOLD = 80;

  window.addEventListener('touchstart', e => {
    if (window.scrollY > 2) return;
    startY = e.touches[0].clientY;
    pulling = true;
    paper.classList.add('pulling');
  }, { passive: true });

  window.addEventListener('touchmove', e => {
    if (!pulling) return;
    distance = e.touches[0].clientY - startY;
    if (distance > 0 && window.scrollY <= 2) {
      const clamped = Math.min(distance * 0.5, 100);
      // Push the whole page down; indicator sits in the revealed space
      paper.style.transform = `translateY(${clamped}px)`;
      ptr.style.transform = `translateY(${Math.max(0, clamped)}px)`;
      ptr.querySelector('.ptr-label').textContent = distance > THRESHOLD * 2 ? 'Release to sync' : 'Pull to refresh';
    }
  }, { passive: true });

  window.addEventListener('touchend', async () => {
    if (!pulling) return;
    pulling = false;
    paper.classList.remove('pulling');
    if (distance > THRESHOLD) {
      ptr.classList.add('loading');
      ptr.querySelector('.ptr-label').textContent = 'Syncing…';
      toast('Syncing school, mail and news…');
      try {
        await api('/api/sync/all', { method: 'POST' });
        toast('Sync complete');
      } catch (err) {
        toast('Sync failed');
      }
      ptr.classList.remove('loading');
      await loadAll();
      ptr.style.transform = '';
      paper.style.transform = '';
    } else {
      ptr.style.transform = '';
      paper.style.transform = '';
    }
  });
}

// ---------- Full weather tab ----------
let weatherLoaded = false;
async function loadWeatherFull() {
  const el = $('#weather-full');
  try {
    const w = await api('/api/weather');
    if (w.error) { el.innerHTML = '<p class="empty-note">Weather unavailable.</p>'; return; }

    const c = w.current;
    const hours = w.hourly || [];
    const nowHour = new Date().toISOString().slice(0, 13);

    el.innerHTML = `
      <div class="wx-hero">
        <div class="wx-hero-temp">${c.temp}°</div>
        <div class="wx-hero-cond">${c.condition}</div>
        <div class="wx-hero-sub">Feels like ${c.feels}° · H ${w.today.max}° L ${w.today.min}° · ${w.location}</div>
      </div>
      <div class="wx-grid">
        <div class="wx-cell"><span class="lbl">Humidity</span><span class="val">${c.humidity}%</span></div>
        <div class="wx-cell"><span class="lbl">Wind</span><span class="val">${c.wind} ${c.windDir}</span></div>
        <div class="wx-cell"><span class="lbl">Gusts</span><span class="val">${c.gusts}</span></div>
        <div class="wx-cell"><span class="lbl">Pressure</span><span class="val">${c.pressure}</span></div>
        <div class="wx-cell"><span class="lbl">Cloud</span><span class="val">${c.cloud}%</span></div>
        <div class="wx-cell"><span class="lbl">UV max</span><span class="val">${w.today.uvMax}</span></div>
        <div class="wx-cell"><span class="lbl">Rain today</span><span class="val">${w.today.rainSum ?? 0} mm</span></div>
        <div class="wx-cell"><span class="lbl">Rain chance</span><span class="val">${w.today.rainChance}%</span></div>
        <div class="wx-cell"><span class="lbl">Sunrise</span><span class="val">${w.today.sunrise?.slice(11, 16)}</span></div>
        <div class="wx-cell"><span class="lbl">Sunset</span><span class="val">${w.today.sunset?.slice(11, 16)}</span></div>
      </div>
      <h2 class="section-head">Next 24 Hours</h2>
      <div class="rule-light"></div>
      <div class="wx-h-scroll">
        ${hours.map(h => `
          <div class="wx-hour ${h.time.startsWith(nowHour) ? 'now' : ''}">
            <div class="h-time">${h.time.slice(11, 16)}</div>
            <div class="h-temp">${h.temp}°</div>
            <div class="h-rain">${h.rainChance}%</div>
          </div>
        `).join('')}
      </div>
      <h2 class="section-head">7 Day Forecast</h2>
      <div class="rule-light"></div>
      <div>
        ${(w.daily || []).map((d, i) => `
          <div class="wx-day">
            <span class="d-name">${i === 0 ? 'Today' : new Date(d.date).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })}</span>
            <span class="d-cond">${d.condition}</span>
            <span class="d-rain">${d.rainChance}%</span>
            <span class="d-range">${d.max}° <span class="lo">${d.min}°</span></span>
          </div>
        `).join('')}
      </div>
    `;
    weatherLoaded = true;
  } catch (err) {
    el.innerHTML = `<p class="empty-note">Weather failed: ${escapeHtml(err.message)}</p>`;
  }
}

// ---------- Upcoming (unused now but kept for month view fallback) ----------
function railUpcoming(events) {
  $('#list-upcoming') && ($('#list-upcoming').innerHTML = events.length
    ? events.map(e => `
        <div class="rail-item">
          <p class="rail-title"><span class="kind-badge ${e.kind}">${e.kind}</span>${escapeHtml(e.title)}</p>
          <p class="rail-sub">${fmtDate(e.date)}</p>
        </div>`).join('')
    : '');
}

// ---------- Smart Note ----------
let smartNoteParsed = null;

async function submitSmartNote() {
  const input = $('#smart-note-input');
  const preview = $('#smart-note-preview');
  const text = (input.value || '').trim();
  if (!text) return;

  // Disable button while processing
  const goBtn = $('#smart-note-go');
  goBtn.disabled = true;
  goBtn.textContent = '…';
  preview.classList.remove('hidden');
  preview.innerHTML = '<p class="empty-note">Thinking…</p>';

  try {
    const parsed = await api('/api/notes/parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    smartNoteParsed = parsed;
    renderSmartNotePreview(parsed, text);
  } catch (err) {
    preview.innerHTML = `<p class="empty-note" style="color:var(--accent)">Failed: ${escapeHtml(err.message)}</p>`;
  } finally {
    goBtn.disabled = false;
    goBtn.textContent = '→';
  }
}
window.submitSmartNote = submitSmartNote;

// Handle Enter key on the input
document.addEventListener('DOMContentLoaded', () => {
  const input = $('#smart-note-input');
  if (input) input.addEventListener('keydown', e => { if (e.key === 'Enter') submitSmartNote(); });
});

function renderSmartNotePreview(parsed, originalText) {
  const preview = $('#smart-note-preview');
  if (parsed.isEvent) {
    const details = [];
    if (parsed.date) {
      const d = new Date(parsed.date + 'T00:00:00');
      details.push(`<b>${d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</b>`);
    }
    if (parsed.startTime) {
      const [h, m] = parsed.startTime.split(':');
      const ampm = parseInt(h) >= 12 ? 'pm' : 'am';
      const h12 = parseInt(h) % 12 || 12;
      details.push(`${h12}:${m} ${ampm}`);
    }
    if (parsed.location) details.push(escapeHtml(parsed.location));
    if (parsed.description) details.push(escapeHtml(parsed.description));

    preview.innerHTML = `
      <span class="snp-type event">Event</span>
      <p class="snp-title">${escapeHtml(parsed.title)}</p>
      <p class="snp-details">${details.join(' · ')}</p>
      <div class="snp-actions">
        <button class="btn" onclick="saveSmartNote()">Add to Calendar</button>
        <button class="btn secondary" onclick="dismissSmartNote()">Dismiss</button>
      </div>
    `;
  } else {
    preview.innerHTML = `
      <span class="snp-type note">Note</span>
      <p class="snp-title">${escapeHtml(parsed.title)}</p>
      <p class="snp-details">Not calendar-worthy — just a note.</p>
      <div class="snp-actions">
        <button class="btn secondary" onclick="dismissSmartNote()">OK</button>
      </div>
    `;
  }
}

async function saveSmartNote() {
  if (!smartNoteParsed || !smartNoteParsed.isEvent) return;
  const goBtn = $('#smart-note-go');
  const preview = $('#smart-note-preview');
  goBtn.disabled = true;
  goBtn.textContent = '…';

  try {
    const r = await api('/api/calendar/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: smartNoteParsed.title,
        date: smartNoteParsed.date,
        startTime: smartNoteParsed.startTime,
        endTime: smartNoteParsed.endTime,
        weekly: false,
        dayOfWeek: null
      })
    });
    preview.innerHTML = `
      <span class="snp-type event">Added</span>
      <p class="snp-title">${escapeHtml(smartNoteParsed.title)}</p>
      <p class="snp-details">Saved to <a href="${r.link}" target="_blank" style="color:var(--accent)">Google Calendar</a></p>
    `;
    $('#smart-note-input').value = '';
    smartNoteParsed = null;
    // Refresh the month calendar to show the new event
    loadMonth();
  } catch (err) {
    preview.innerHTML = `<p class="empty-note" style="color:var(--accent)">Save failed: ${escapeHtml(err.message)}</p>`;
  } finally {
    goBtn.disabled = false;
    goBtn.textContent = '→';
  }
}
window.saveSmartNote = saveSmartNote;

function dismissSmartNote() {
  // If it was a non-event, auto-save to notes list
  if (smartNoteParsed && !smartNoteParsed.isEvent && smartNoteParsed.title) {
    api('/api/notes/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: smartNoteParsed.title })
    }).then(() => loadNotes());
  }
  $('#smart-note-preview').classList.add('hidden');
  $('#smart-note-input').value = '';
  smartNoteParsed = null;
}
window.dismissSmartNote = dismissSmartNote;

// ---------- Notes tab ----------
let notesLoaded = false;

async function loadNotes() {
  try {
    const notes = await api('/api/notes/list');
    renderNotes(notes);
    notesLoaded = true;
  } catch (err) {
    $('#notes-list').innerHTML = `<p class="empty-note">Failed to load notes.</p>`;
  }
}

function renderNotes(notes) {
  const list = $('#notes-list');
  if (!notes.length) {
    list.innerHTML = '<p class="empty-note">Nothing here yet. Add a note above.</p>';
    return;
  }
  list.innerHTML = notes.map(n => `
    <div class="swipe-wrap" data-del-id="${n._id}">
      <div class="swipe-del" onclick="deleteNote('${n._id}')">Delete</div>
      <div class="swipe-content">
        <div class="note-item" data-id="${n._id}">
          <button class="note-check ${n.done ? 'done' : ''}" onclick="toggleNote('${n._id}')"></button>
          <span class="note-text ${n.done ? 'done' : ''}">${escapeHtml(n.text)}</span>
        </div>
      </div>
    </div>
  `).join('');
  initSwipe();
}

async function addNote() {
  const input = $('#notes-input');
  const text = (input.value || '').trim();
  if (!text) return;
  try {
    await api('/api/notes/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    input.value = '';
    loadNotes();
  } catch (err) {
    toast('Failed to add note');
  }
}
window.addNote = addNote;

document.addEventListener('DOMContentLoaded', () => {
  const ni = $('#notes-input');
  if (ni) ni.addEventListener('keydown', e => { if (e.key === 'Enter') addNote(); });
});

async function toggleNote(id) {
  try {
    await api(`/api/notes/${id}/toggle`, { method: 'PATCH' });
    loadNotes();
  } catch (err) { toast('Failed'); }
}
window.toggleNote = toggleNote;

async function deleteNote(id) {
  try {
    await api(`/api/notes/${id}`, { method: 'DELETE' });
    loadNotes();
  } catch (err) { toast('Failed'); }
}
window.deleteNote = deleteNote;

// ---------- Load ----------
async function loadAll() {
  setDateline();
  updateCacheAge('');

  // --- Phase 1: Read native cache + render instantly ---
  const [schedCache, briefCache, calCache, wxCache] = await Promise.all([
    readNativeCache('schedule'),
    readNativeCache('briefing'),
    readNativeCache('calendar'),
    readNativeCache('weather')
  ]);

  if (schedCache?.data) renderSchedule(schedCache.data);
  if (briefCache?.data) renderBriefing(briefCache.data);
  if (calCache?.data?.events) {
    monthEvents = calCache.data.events;
    calListExpanded = false;
    renderCalendar();
    // Auto-select today
    const now = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    const todayKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
    selectDay(todayKey);
  }
  if (wxCache?.data) {
    const w = wxCache.data;
    if (!w.error) {
      $('#w-temp').textContent = `${w.current.temp}°`;
      $('#w-cond').textContent = w.current.condition;
      $('#w-range').textContent = `H ${w.today.max}° · L ${w.today.min}° · ${w.today.rainChance}% rain`;
    }
  }

  // Show cache age from the freshest cached item
  const ages = [schedCache, briefCache, calCache, wxCache]
    .filter(c => c?.savedAt).map(c => c.savedAt);
  if (ages.length) {
    updateCacheAge(cacheAgeText(Math.max(...ages)));
  } else {
    updateCacheAge('no cache');
  }

  // --- Phase 2: Background fetch from server, re-render in place ---
  const [schedResult, briefResult, calResult, wxResult] = await Promise.allSettled([
    api('/api/schedule/today'),
    api('/api/briefing'),
    api('/api/calendar/month'),
    api('/api/weather')
  ]);

  if (schedResult.status === 'fulfilled') {
    renderSchedule(schedResult.value);
    writeLocalCache('schedule', schedResult.value);
  }
  if (briefResult.status === 'fulfilled') {
    renderBriefing(briefResult.value);
    writeLocalCache('briefing', briefResult.value);
  }
  if (calResult.status === 'fulfilled') {
    monthEvents = calResult.value.events || [];
    calListExpanded = false;
    renderCalendar();
    writeLocalCache('calendar', calResult.value);
    const now = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    const todayKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
    selectDay(todayKey);
  }
  if (wxResult.status === 'fulfilled') {
    const w = wxResult.value;
    if (!w.error) {
      $('#w-temp').textContent = `${w.current.temp}°`;
      $('#w-cond').textContent = w.current.condition;
      $('#w-range').textContent = `H ${w.today.max}° · L ${w.today.min}° · ${w.today.rainChance}% rain`;
    }
    writeLocalCache('weather', wxResult.value);
  }

  updateCacheAge('just now');

  // Health check (fire-and-forget)
  try {
    const h = await api('/api/health');
    $('#footer-status').textContent = `db ${h.db} · nps ${h.nps?.loggedIn ? 'ok' : 'down'} · gmail ${h.gmail} · calendar ${h.calendar}`;
  } catch {
    $('#footer-status').textContent = 'server unreachable';
  }
}

// ---------- Modal ----------
async function viewItem(id) {
  try {
    const i = await api(`/api/items/${id}`);
    const meta = i.metadata || {};
    let extra = '';
    if (i.type === 'circular' && meta.circularId) {
      extra = `<div id="circ-detail" class="muted">loading circular detail…</div>`;
    }

    const attachments = [];
    if (i.type === 'assignment' && meta.downloadUrl) {
      attachments.push(`<button class="btn" onclick="window.open('/api/attachments/assignment/${i._id}')">Download file</button>`);
    }
    if (i.type === 'circular' && meta.circularId) {
      attachments.push(`<button class="btn" onclick="window.open('/api/attachments/circular/${i._id}')">Download PDF</button>`);
    }
    if (i.type === 'email' && i.gmailUrl) {
      attachments.push(`<button class="btn" onclick="window.open('${i.gmailUrl}','_blank')">Open in Gmail</button>`);
    }
    if (i.type === 'news' && meta.url) {
      attachments.push(`<button class="btn" onclick="window.open('${escapeHtml(meta.url)}','_blank')">Read article</button>`);
    }

    const isNps = i.source === 'nps';
    const bodyHtml = i.type === 'email'
      ? ''
      : `${!isNps && i.summary ? `<h2 class="rail-head">Summary</h2><div class="rule-light"></div><div class="content-block">${renderRichText(i.summary, itemRegistry)}</div>` : ''}
         <h2 class="rail-head">Content</h2><div class="rule-light"></div>
         <div class="content-block">${escapeHtml(i.content || '(empty)')}</div>`;

    $('#modal-content').innerHTML = `
      <span class="type-tag">${i.source} / ${i.type}</span>
      <h3>${escapeHtml(i.title || '')}</h3>
      <div class="kv"><b>Posted</b> ${fmtDateTime(i.postedDate)}</div>
      ${meta.subject ? `<div class="kv"><b>Subject</b> ${escapeHtml(meta.subject)}</div>` : ''}
      ${meta.teacher ? `<div class="kv"><b>Teacher</b> ${escapeHtml(meta.teacher)}</div>` : ''}
      ${meta.from ? `<div class="kv"><b>From</b> ${escapeHtml(meta.from)}</div>` : ''}
      ${meta.sourceName ? `<div class="kv"><b>Source</b> ${escapeHtml(meta.sourceName)}</div>` : ''}
      ${meta.category ? `<div class="kv"><b>Category</b> ${escapeHtml(meta.category)}</div>` : ''}
      ${bodyHtml}
      ${extra}
      ${attachments.length ? `<div class="btn-row">${attachments.join('')}</div>` : ''}
      <div class="btn-row">
        <button class="btn danger" onclick="deleteItem('${i._id}')">Delete</button>
      </div>
    `;
    openModal();

    if (i.type === 'circular' && meta.circularId) {
      try {
        const d = await api(`/api/circular/${i._id}/detail`);
        $('#circ-detail').innerHTML = `
          <h2 class="rail-head">From the portal</h2><div class="rule-light"></div>
          <div class="content-block">${escapeHtml(d.body || '(no body)')}</div>
          ${d.downloadUrl ? `<div class="btn-row"><button class="btn" onclick="window.open('/api/attachments/circular/${i._id}')">Download PDF</button></div>` : '<p class="empty-note">No PDF attached.</p>'}
        `;
      } catch (err) {
        $('#circ-detail').innerHTML = `<div class="content-block" style="color:var(--accent)">detail fetch failed: ${escapeHtml(err.message)}</div>`;
      }
    }
  } catch (err) {
    alert(err.message);
  }
}
window.viewItem = viewItem;
window.jumpTo = jumpTo;
window.closeModal = closeModal;
window.deleteItem = deleteItem;

function openModal() {
  const m = $('#modal');
  m.classList.remove('hidden');       // legacy no-op safety
  void m.offsetWidth;                 // force reflow so transition runs from base state
  m.classList.add('opening');
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  const m = $('#modal');
  m.classList.remove('opening');
  document.body.style.overflow = '';
}

async function deleteItem(id) {
  if (!confirm('Delete this item?')) return;
  try {
    await api(`/api/items/${id}`, { method: 'DELETE' });
    closeModal();
    loadAll();
  } catch (err) {
    alert(err.message);
  }
}

document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
initPullToRefresh();
loadAll();
