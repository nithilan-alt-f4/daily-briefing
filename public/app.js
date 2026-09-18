/**
 * app.js — Phase 4: Client-only Daily Briefing.
 * No server needed. Data comes from:
 *   - DataAPI (NPS + Gmail data via GitHub JSON export)
 *   - WeatherAPI (Open-Meteo / wttr.in)
 *   - NewsAPI (NewsAPI + Google News RSS)
 *   - CalendarAPI (Google Calendar REST API)
 *   - NarrativeAPI (Groq / Gemini on-device)
 *   - NotesAPI (localStorage)
 */

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

function istNow() {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000);
}

function istTodayKey() {
  return istNow().toISOString().slice(0, 10);
}

function istTomorrowKey() {
  return new Date(istNow().getTime() + 86400000).toISOString().slice(0, 10);
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
window.jumpTo = jumpTo;

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

function updateCacheAge(text) {
  const el = $('#cache-age');
  if (el) el.textContent = text ? `updated ${text}` : '';
}

function cacheAgeText(savedAt) {
  if (!savedAt) return '';
  const mins = Math.round((Date.now() - savedAt) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  return `${hrs}h ago`;
}

// ---------- School-related helpers ----------

function cleanTitle(title) {
  return (title || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
}

function groupClasses(classes) {
  const grouped = [];
  let i = 0;
  while (i < classes.length) {
    const name = classes[i];
    let count = 1;
    while (i + count < classes.length && classes[i + count] === name) count++;
    grouped.push(count > 1 ? `${name} — Block` : name);
    i += count;
  }
  return grouped;
}

const CLASS_EXCLUDE = /exam|test|akats|quiz|practical/i;

function isClassEvent(e) {
  return !CLASS_EXCLUDE.test(e.title) && !e.isBirthday && !/holiday/i.test(e.calendarName || '');
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
    $('#classes-body').innerHTML = `
      <p class="class-empty">No classes on the calendar yet.</p>
      <div style="display:flex;gap:8px;margin-top:0.6rem">
        <a href="debug.html" class="btn" style="flex:1;text-align:center;text-decoration:none">Add timetable photo</a>
        <a href="debug.html" class="btn ghost" style="flex:1;text-align:center;text-decoration:none">Enter manually</a>
      </div>
    `;
  } else {
    $('#classes-body').innerHTML = '<p class="class-empty">No classes today.</p>';
  }

  // Upcoming tests/practicals/exams
  const upcomingTests = sched.upcomingTests || [];
  if (upcomingTests.length > 0) {
    const testsHtml = upcomingTests.map(t => {
      const kindLabel = t.kind === 'practical' ? 'Practical' : t.kind === 'quiz' ? 'Quiz' : t.kind === 'exam' ? 'Exam' : 'Test';
      const kindClass = t.kind === 'practical' ? 'kind-practical' : t.kind === 'quiz' ? 'kind-quiz' : t.kind === 'exam' ? 'kind-exam' : 'kind-test';
      return `
        <div class="upcoming-test-item">
          <span class="test-kind ${kindClass}">${kindLabel}</span>
          <span class="test-date">${dayLabel(t.date)}</span>
          <span class="test-title">${escapeHtml(t.title)}</span>
        </div>
      `;
    }).join('');
    $('#exam-strip').innerHTML = `
      <div class="upcoming-tests-section">
        <div class="upcoming-tests-head">This Week's Tests & Practical</div>
        ${testsHtml}
      </div>
    `;
  } else {
    $('#exam-strip').innerHTML = '';
  }

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
    const w = await WeatherAPI.fetch();
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

// ---------- Briefing render ----------
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
  const today = istTodayKey();
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

  // School tab: everything
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

// ---------- Swipe to delete ----------
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
    DataAPI.deleteItemFromCache(id);
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
    const today = new Date();
    const monthEnd = new Date(today.getTime() + 60 * 86400000);
    const schoolCal = await DataAPI.getSchoolCalendar();

    // Try CalendarAPI if connected, otherwise just school calendar data
    let calEvents = [];
    if (CalendarAPI.isConnected()) {
      const raw = await CalendarAPI.fetchEventsInRange(today, monthEnd, 100);
      calEvents = raw.map(e => ({
        title: e.title,
        date: e.start,
        kind: /school/i.test(e.calendarName || '') ? 'school' : 'personal',
        location: e.location,
        isAllDay: e.isAllDay
      }));
    }

    // Add school calendar items (holidays, exams from NPS portal)
    const schoolItems = schoolCal.map(e => ({
      title: e.title,
      date: e.metadata?.startDate || (e.postedDate || '').slice(0, 10),
      kind: /exam|test/i.test(e.title) ? 'exam' : 'holiday',
      location: null,
      isAllDay: true
    }));

    monthEvents = [...calEvents, ...schoolItems];
    calListExpanded = false;
    renderCalendar();
    selectDay(istTodayKey());
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

  // Event list — holidays, birthdays, exams, AND personal events. No classes.
  const calKinds = new Set(['holiday', 'birthday', 'exam', 'personal']);
  const listEvents = monthEvents.filter(e => calKinds.has(e.kind));
  const total = listEvents.length;
  const visible = calListExpanded ? listEvents : listEvents.slice(0, CAL_LIST_INITIAL);
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
  const evs = monthEvents.filter(e => (e.date || '').slice(0, 10) === key);
  const orderLabel = e => {
    if (e.date && e.date.includes('T')) {
      const h = parseInt(e.date.slice(11, 13), 10);
      const m = e.date.slice(14, 16);
      const ampm = h >= 12 ? 'pm' : 'am';
      return `${h % 12 || 12}:${m}${ampm}`;
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
      toast('Syncing from GitHub…');
      try {
        await DataAPI.refreshBriefingData();
        toast('Sync complete');
      } catch (err) {
        toast('Sync failed: ' + (err.message || ''));
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
    const w = await WeatherAPI.fetch();
    if (w.error) { el.innerHTML = '<p class="empty-note">Weather unavailable.</p>'; return; }

    const c = w.current;
    const hours = w.hourly || [];
    const nowHour = istNow().toISOString().slice(0, 13);

    el.innerHTML = `
      <div class="wx-hero">
        <div class="wx-hero-temp">${c.temp}°</div>
        <div class="wx-hero-cond">${c.condition}</div>
        <div class="wx-hero-sub">Feels like ${c.feels}° · H ${w.today.max}° L ${w.today.min}° · ${w.location}</div>
      </div>
      <div class="wx-grid">
        <div class="wx-cell"><span class="lbl">Humidity</span><span class="val">${c.humidity}%</span></div>
        <div class="wx-cell"><span class="lbl">Wind</span><span class="val">${c.wind} ${c.windDir || ''}</span></div>
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

// ---------- Smart Note ----------
let smartNoteParsed = null;

async function submitSmartNote() {
  const input = $('#smart-note-input');
  const preview = $('#smart-note-preview');
  const text = (input.value || '').trim();
  if (!text) return;

  const goBtn = $('#smart-note-go');
  goBtn.disabled = true;
  goBtn.textContent = '…';
  preview.classList.remove('hidden');
  preview.innerHTML = '<p class="empty-note">Thinking…</p>';

  try {
    const parsed = await NarrativeAPI.parseSmartNote(text);
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

document.addEventListener('DOMContentLoaded', () => {
  const input = $('#smart-note-input');
  if (input) input.addEventListener('keydown', e => { if (e.key === 'Enter') submitSmartNote(); });
});

function renderSmartNotePreview(parsed) {
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
      details.push(`${parseInt(h) % 12 || 12}:${m} ${ampm}`);
    }
    if (parsed.location) details.push(escapeHtml(parsed.location));
    if (parsed.description) details.push(escapeHtml(parsed.description));
    const targetCal = parsed.isSchool ? 'School calendar' : 'Personal calendar';

    preview.innerHTML = `
      <span class="snp-type event">Event</span>
      <p class="snp-title">${escapeHtml(parsed.title)}</p>
      <p class="snp-details">${details.join(' · ')}</p>
      <p class="snp-details" style="font-size:0.8em;color:var(--muted)">→ ${targetCal}</p>
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
    if (!CalendarAPI.isConnected()) {
      throw new Error('Google Calendar not connected. Please sign in first.');
    }

    const tz = 'Asia/Kolkata';
    const { title, date, startTime, endTime, isSchool } = smartNoteParsed;
    const body = { summary: title, description: 'Added via Daily Briefing' };

    if (startTime) {
      const [sh, sm] = startTime.split(':').map(Number);
      const [eh, em] = (endTime || `${sh + 1}:${String(sm).padStart(2, '0')}`).split(':').map(Number);
      const pad = n => String(n).padStart(2, '0');
      let endDate = date;
      if (eh < sh || (eh === sh && em <= sm)) {
        const nd = new Date(date + 'T00:00:00+05:30');
        nd.setDate(nd.getDate() + 1);
        endDate = nd.toISOString().slice(0, 10);
      }
      body.start = { dateTime: `${date}T${pad(sh)}:${pad(sm)}:00+05:30`, timeZone: tz };
      body.end = { dateTime: `${endDate}T${pad(eh)}:${pad(em)}:00+05:30`, timeZone: tz };
    } else {
      body.start = { date };
      const nd = new Date(date + 'T00:00:00+05:30');
      nd.setDate(nd.getDate() + 1);
      body.end = { date: nd.toISOString().slice(0, 10) };
    }

    const targetCalId = isSchool ? 'primary' : 'primary';
    try {
      // Try live Calendar API first
      const result = await CalendarAPI.createEvent(body, targetCalId);
      preview.innerHTML = `
        <span class="snp-type event">Added</span>
        <p class="snp-title">${escapeHtml(smartNoteParsed.title)}</p>
        <p class="snp-details">Saved to Google Calendar</p>
      `;
    } catch (calErr) {
      // Calendar API failed (token expired, re-auth flaky) → queue via workflow dispatch
      console.warn('[SmartNote] Calendar API failed, trying workflow dispatch:', calErr.message);
      const inputs = {
        event_title: title,
        event_date: date,
        event_start: startTime || '',
        event_end: endTime || '',
        event_is_school: isSchool ? 'true' : 'false'
      };
      await DataAPI.triggerWorkflow('sync.yml', inputs);
      preview.innerHTML = `
        <span class="snp-type event">Queued</span>
        <p class="snp-title">${escapeHtml(smartNoteParsed.title)}</p>
        <p class="snp-details">Calendar write queued — will appear after next sync.</p>
      `;
    }
    $('#smart-note-input').value = '';
    smartNoteParsed = null;
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
  if (smartNoteParsed && !smartNoteParsed.isEvent && smartNoteParsed.title) {
    NotesAPI.add(smartNoteParsed.title).then(() => loadNotes());
  }
  $('#smart-note-preview').classList.add('hidden');
  $('#smart-note-input').value = '';
  smartNoteParsed = null;
}
window.dismissSmartNote = dismissSmartNote;

// ---------- Smart Note Photo ----------
let smartNotePhotoEvents = null;

async function handleSmartNotePhoto(input) {
  const file = input.files?.[0];
  if (!file) return;

  const preview = $('#smart-note-preview');
  preview.classList.remove('hidden');
  preview.innerHTML = '<p class="empty-note">Reading image…</p>';

  const reader = new FileReader();
  reader.onload = async () => {
    const base64 = reader.result.split(',')[1];
    preview.innerHTML = '<p class="empty-note">Analyzing with AI…</p>';

    try {
      const result = await NarrativeAPI.parseSmartNotePhoto(base64, file.type || 'image/jpeg');
      const events = result.events || [];
      if (events.length === 0) {
        preview.innerHTML = `
          <span class="snp-type note">No events found</span>
          <p class="snp-title">Couldn't find any calendar events in this image.</p>
          <div class="snp-actions">
            <button class="btn secondary" onclick="dismissSmartNotePhoto()">OK</button>
          </div>
        `;
        return;
      }

      smartNotePhotoEvents = events;
      renderSmartNotePhotoPreview(events);
    } catch (err) {
      preview.innerHTML = `<p class="empty-note" style="color:var(--accent)">Failed: ${escapeHtml(err.message)}</p>`;
    }
  };
  reader.readAsDataURL(file);
  input.value = '';
}
window.handleSmartNotePhoto = handleSmartNotePhoto;

function renderSmartNotePhotoPreview(events) {
  const preview = $('#smart-note-preview');

  if (events.length === 1) {
    const e = events[0];
    const details = [];
    if (e.date) {
      const d = new Date(e.date + 'T00:00:00');
      details.push(`<b>${d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</b>`);
    }
    if (e.startTime) {
      const [h, m] = e.startTime.split(':');
      const ampm = parseInt(h) >= 12 ? 'pm' : 'am';
      details.push(`${parseInt(h) % 12 || 12}:${m} ${ampm}`);
    }
    if (e.location) details.push(escapeHtml(e.location));
    const targetCal = e.isSchool ? 'School calendar' : 'Personal calendar';

    preview.innerHTML = `
      <span class="snp-type event">Event from Photo</span>
      <p class="snp-title">${escapeHtml(e.title)}</p>
      <p class="snp-details">${details.join(' · ') || 'All day'}</p>
      <p class="snp-details" style="font-size:0.8em;color:var(--muted)">→ ${targetCal}</p>
      <div class="snp-actions">
        <button class="btn" onclick="saveSmartNotePhotoEvent(0)">Add to Calendar</button>
        <button class="btn secondary" onclick="dismissSmartNotePhoto()">Dismiss</button>
      </div>
    `;
  } else {
    const html = events.map((e, i) => {
      const dayInfo = e.weekly && e.dayOfWeek ? `${e.dayOfWeek} weekly` :
                      e.date ? new Date(e.date + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) : '';
      const timeInfo = e.startTime ? `${e.startTime}${e.endTime ? '–' + e.endTime : ''}` : '';
      const targetCal = e.isSchool ? 'School' : 'Personal';
      return `
        <div class="photo-event-item">
          <div class="photo-event-title">${escapeHtml(e.title)}</div>
          <div class="photo-event-meta">${dayInfo}${timeInfo ? ' · ' + timeInfo : ''} → ${targetCal}</div>
          <button class="btn small" onclick="saveSmartNotePhotoEvent(${i})">Add</button>
        </div>
      `;
    }).join('');

    preview.innerHTML = `
      <span class="snp-type event">${events.length} events from Photo</span>
      <div class="photo-events-list">${html}</div>
      <div class="snp-actions">
        <button class="btn" onclick="saveAllSmartNotePhotoEvents()">Add All</button>
        <button class="btn secondary" onclick="dismissSmartNotePhoto()">Dismiss</button>
      </div>
    `;
  }
}

async function saveSmartNotePhotoEvent(idx) {
  if (!smartNotePhotoEvents || !smartNotePhotoEvents[idx]) return;
  const e = smartNotePhotoEvents[idx];
  const preview = $('#smart-note-preview');

  try {
    if (!CalendarAPI.isConnected()) throw new Error('Google Calendar not connected');

    const tz = 'Asia/Kolkata';
    const body = { summary: e.title, description: 'Added via Daily Briefing' };

    if (e.startTime) {
      const [sh, sm] = e.startTime.split(':').map(Number);
      const [eh, em] = (e.endTime || `${sh + 1}:${String(sm).padStart(2, '0')}`).split(':').map(Number);
      const pad = n => String(n).padStart(2, '0');
      let endDate = e.date;
      if (eh < sh || (eh === sh && em <= sm)) {
        const nd = new Date(e.date + 'T00:00:00+05:30');
        nd.setDate(nd.getDate() + 1);
        endDate = nd.toISOString().slice(0, 10);
      }
      body.start = { dateTime: `${e.date}T${pad(sh)}:${pad(sm)}:00+05:30`, timeZone: tz };
      body.end = { dateTime: `${endDate}T${pad(eh)}:${pad(em)}:00+05:30`, timeZone: tz };
    } else {
      body.start = { date: e.date };
      const nd = new Date(e.date + 'T00:00:00+05:30');
      nd.setDate(nd.getDate() + 1);
      body.end = { date: nd.toISOString().slice(0, 10) };
    }

    const result = await CalendarAPI.createEvent(body, 'primary').catch(async (calErr) => {
      // Calendar API failed → queue via workflow dispatch
      console.warn('[SmartNotePhoto] Calendar API failed, queuing:', calErr.message);
      await DataAPI.triggerWorkflow('sync.yml', {
        event_title: e.title,
        event_date: e.date,
        event_start: e.startTime || '',
        event_end: e.endTime || '',
        event_is_school: e.isSchool ? 'true' : 'false'
      });
      return null; // null signals queued, not directly added
    });

    smartNotePhotoEvents[idx]._saved = true;
    const wasQueued = result === null;

    if (smartNotePhotoEvents.length === 1) {
      preview.innerHTML = `
        <span class="snp-type event">${wasQueued ? 'Queued' : 'Added'}</span>
        <p class="snp-title">${escapeHtml(e.title)}</p>
        <p class="snp-details">${wasQueued ? 'Queued for next sync.' : 'Saved to Google Calendar'}</p>
      `;
      smartNotePhotoEvents = null;
      loadMonth();
    } else {
      const items = preview.querySelectorAll('.photo-event-item');
      if (items[idx]) {
        items[idx].querySelector('button').textContent = '✓ Saved';
        items[idx].querySelector('button').disabled = true;
        items[idx].style.opacity = '0.6';
      }
    }
  } catch (err) {
    alert(`Failed to save: ${err.message}`);
  }
}
window.saveSmartNotePhotoEvent = saveSmartNotePhotoEvent;

async function saveAllSmartNotePhotoEvents() {
  if (!smartNotePhotoEvents || smartNotePhotoEvents.length === 0) return;
  const preview = $('#smart-note-preview');

  let saved = 0, failed = 0;
  for (let i = 0; i < smartNotePhotoEvents.length; i++) {
    if (smartNotePhotoEvents[i]._saved) continue;
    try {
      await saveSmartNotePhotoEvent(i);
      saved++;
    } catch { failed++; }
  }

  preview.innerHTML = `
    <span class="snp-type event">Done</span>
    <p class="snp-title">${saved} event${saved !== 1 ? 's' : ''} saved${failed ? `, ${failed} failed` : ''}</p>
  `;
  smartNotePhotoEvents = null;
  loadMonth();
}
window.saveAllSmartNotePhotoEvents = saveAllSmartNotePhotoEvents;

function dismissSmartNotePhoto() {
  $('#smart-note-preview').classList.add('hidden');
  smartNotePhotoEvents = null;
}
window.dismissSmartNotePhoto = dismissSmartNotePhoto;

// ---------- Notes tab ----------
let notesLoaded = false;

async function loadNotes() {
  try {
    const notes = await NotesAPI.list();
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
    await NotesAPI.add(text);
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
    await NotesAPI.toggle(id);
    loadNotes();
  } catch (err) { toast('Failed'); }
}
window.toggleNote = toggleNote;

async function deleteNote(id) {
  try {
    await NotesAPI.remove(id);
    loadNotes();
  } catch (err) { toast('Failed'); }
}
window.deleteNote = deleteNote;

// ---------- Load ----------

/**
 * Build schedule data from calendar events + school calendar.
 */
async function buildSchedule() {
  const todayKey = istTodayKey();
  const tomorrowKey = istTomorrowKey();
  const now = new Date();
  const weekEnd = new Date(now.getTime() + 7 * 86400000);
  const endOfTomorrow = new Date(now.getTime() + 2 * 86400000);

  // Next Saturday
  const saturday = new Date(now);
  saturday.setDate(saturday.getDate() + ((6 - saturday.getDay() + 7) % 7 || 7));
  const satKey = saturday.toISOString().slice(0, 10);

  let calendarEvents = [];
  let schoolItems = [];

  // Fetch from both sources in parallel
  const [calResult, schoolResult] = await Promise.allSettled([
    CalendarAPI.isConnected()
      ? CalendarAPI.fetchEventsInRange(now, weekEnd, 100)
      : Promise.resolve([]),
    DataAPI.getSchoolCalendar()
  ]);

  if (calResult.status === 'fulfilled') calendarEvents = calResult.value;
  if (schoolResult.status === 'fulfilled') schoolItems = schoolResult.value;

  // Today's classes: calendar events that aren't exams/tests/holidays
  const istHour = istNow().getUTCHours();
  const nowTime = istNow().toISOString().slice(11, 16);

  let classesRaw;
  if (istHour < 17) {
    // Before 5 PM: remaining classes today
    classesRaw = calendarEvents
      .filter(e => (e.start || '').slice(0, 10) === todayKey)
      .filter(isClassEvent)
      .filter(e => (e.start || '').slice(11, 16) >= nowTime)
      .sort((a, b) => (a.start || '').localeCompare(b.start || ''))
      .map(e => cleanTitle(e.title));
  } else {
    // After 5 PM: tomorrow's classes
    classesRaw = [];
  }

  const classes = groupClasses(classesRaw);

  // If no classes today, show tomorrow's
  let showTomorrow = false;
  let tomorrowClasses = [];
  let tomorrowDay = null;
  if (!classes.length) {
    tomorrowClasses = calendarEvents
      .filter(e => (e.start || '').slice(0, 10) === tomorrowKey)
      .filter(isClassEvent)
      .sort((a, b) => (a.start || '').localeCompare(b.start || ''))
      .map(e => cleanTitle(e.title));
    const groupedTomorrow = groupClasses(tomorrowClasses);
    if (groupedTomorrow.length > 0) {
      showTomorrow = true;
      tomorrowDay = tomorrowKey;
    }
  }

  // Upcoming tests/practicals/exams from calendar
  const upcomingTests = calendarEvents
    .filter(e => /exam|test|akats|quiz|practical/i.test(e.title))
    .filter(e => new Date(e.start) >= now && new Date(e.start) <= weekEnd)
    .map(e => {
      const t = (e.title || '').toLowerCase();
      let kind = 'test';
      if (/practical/i.test(e.title)) kind = 'practical';
      else if (/exam/i.test(e.title)) kind = 'exam';
      else if (/quiz|akats/i.test(e.title)) kind = 'quiz';
      return { title: e.title, date: e.start, kind };
    })
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  // Saturday check
  const satHoliday = schoolItems.find(h => (h.metadata?.startDate || '') === satKey);
  const sat = {
    date: satKey,
    isHoliday: !!satHoliday,
    reason: satHoliday ? satHoliday.title : null
  };

  return {
    classes: classes,
    showTomorrow: showTomorrow,
    tomorrowDay: tomorrowDay,
    tomorrowClasses: groupClasses(tomorrowClasses),
    upcomingTests: upcomingTests,
    saturday: sat,
    classesPlaceholder: !classes.length && !showTomorrow
  };
}

/**
 * Build briefing data from DataAPI (NPS + Gmail) + NewsAPI.
 */
async function buildBriefing() {
  const [assignments, notifications, circulars, emails, newsArticles] = await Promise.allSettled([
    DataAPI.getAssignments(),
    DataAPI.getNotifications(),
    DataAPI.getCirculars(),
    DataAPI.getEmails(),
    SecureStore.getNewsKey().then(key => NewsAPI.fetch(key))
  ]);

  return {
    assignments: assignments.status === 'fulfilled' ? (assignments.value || []).map(a => ({
      id: a.id,
      title: a.title,
      subject: a.metadata?.subject,
      teacher: a.metadata?.teacher,
      content: a.content,
      summary: a.summary
    })) : [],
    notifications: notifications.status === 'fulfilled' ? (notifications.value || []).map(n => ({
      id: n.id,
      title: n.title,
      summary: n.summary,
      content: n.content,
      postedDate: n.postedDate
    })) : [],
    circulars: circulars.status === 'fulfilled' ? (circulars.value || []).map(c => ({
      id: c.id,
      title: c.title,
      category: c.metadata?.category,
      hasPdf: !!c.metadata?.circularId,
      postedDate: c.postedDate
    })) : [],
    emails: emails.status === 'fulfilled' ? (emails.value || []).map(e => ({
      id: e.id,
      title: e.title,
      from: e.metadata?.from,
      summary: e.summary,
      gmailUrl: e.metadata?.messageId ? `https://mail.google.com/mail/u/0/#inbox/${e.metadata.messageId}` : null
    })) : [],
    news: newsArticles.status === 'fulfilled' ? (newsArticles.value || []).map((n, i) => ({
      id: 'news-' + i,
      title: n.title,
      sourceName: n.source,
      url: n.url,
      summary: null
    })) : []
  };
}

/**
 * Build the narrative on-device using Groq API.
 */
async function buildNarrative(briefing, schedule, weather) {
  try {
    const now = new Date();
    const istHour = istNow().getUTCHours();
    const todayKey = istTodayKey();
    const tomorrowKey = istTomorrowKey();

    // Determine classes for narrative (same logic as buildSchedule)
    let classes = [];
    let classesLabel = '';
    if (schedule.classes.length) {
      if (schedule.showTomorrow) {
        classes = schedule.tomorrowClasses;
        classesLabel = 'Tomorrow';
      } else {
        classes = schedule.classes;
        classesLabel = istHour < 17 ? 'Remaining today' : 'Tomorrow';
      }
    }

    // Build weather line
    const weatherLine = weather
      ? `${weather.current.temp}C, ${weather.current.condition}, rain chance ${weather.today?.rainChance ?? 0}%`
      : 'unavailable';

    // Notifications for today
    const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
    const todayNotifs = briefing.notifications
      .filter(n => (n.postedDate || '').slice(0, 10) === todayKey)
      .map(n => `${n.title}: ${(n.content || '').substring(0, 300)}`);

    return await NarrativeAPI.generateNarrative({
      weather: weatherLine,
      classes: classes,
      classesLabel: classesLabel,
      todaySchoolNotifications: todayNotifs.length ? todayNotifs : briefing.notifications.slice(0, 3).map(n => `${n.title}: ${(n.content || '').substring(0, 300)}`),
      recentEmails: briefing.emails.map(e => e.title),
      news: briefing.news.map(n => n.title),
      eventsThisWeek: schedule.upcomingTests.map(t => `${t.title} (${(t.date || '').slice(0, 10)})`)
    });
  } catch (err) {
    console.error('[Narrative] Build failed:', err.message);
    return null;
  }
}

/**
 * Main load function. Fetches all data and renders.
 */
async function loadAll() {
  setDateline();
  updateCacheAge('loading…');

  try {
    // Run all data fetches in parallel
    const [briefing, weather, schedule] = await Promise.allSettled([
      buildBriefing(),
      WeatherAPI.fetch(),
      buildSchedule()
    ]);

    const briefingData = briefing.status === 'fulfilled' ? briefing.value : null;
    const weatherData = weather.status === 'fulfilled' ? weather.value : null;
    const scheduleData = schedule.status === 'fulfilled' ? schedule.value : null;

    // Render what we have
    if (scheduleData) renderSchedule(scheduleData);
    if (briefingData) renderBriefing(briefingData);
    if (weatherData && !weatherData.error) {
      $('#w-temp').textContent = `${weatherData.current.temp}°`;
      $('#w-cond').textContent = weatherData.current.condition;
      $('#w-range').textContent = `H ${weatherData.today.max}° · L ${weatherData.today.min}° · ${weatherData.today.rainChance}% rain`;
    }

    // Load month calendar
    loadMonth();

    // Generate narrative in background (don't block render)
    if (briefingData) {
      buildNarrative(briefingData, scheduleData, weatherData).then(narrative => {
        if (narrative) {
          briefingData.narrative = narrative;
          renderBriefing(briefingData);
        }
      }).catch(() => {});
    }

    updateCacheAge('just now');
  } catch (err) {
    console.error('[LoadAll] Fatal error:', err);
    updateCacheAge('failed');
  }
}

// ---------- Modal ----------
async function viewItem(id) {
  try {
    // Find the item from cached briefing data
    const all = await DataAPI.getAllItems();
    const i = all.find(item => item.id === id);
    if (!i) throw new Error('Item not found');

    const meta = i.metadata || {};
    let extra = '';
    if (i.type === 'circular' && meta.circularId) {
      extra = `<div id="circ-detail" class="muted">NPS portal detail not available in offline mode.</div>`;
    }

    const attachments = [];
    if (i.type === 'email' && i.metadata?.messageId) {
      const gmailUrl = `https://mail.google.com/mail/u/0/#inbox/${i.metadata.messageId}`;
      attachments.push(`<button class="btn" onclick="window.open('${gmailUrl}','_blank')">Open in Gmail</button>`);
    }
    if (i.type === 'news' && meta.url) {
      attachments.push(`<button class="btn" onclick="window.open('${escapeHtml(meta.url)}','_blank')">Read article</button>`);
    }

    const bodyHtml = i.type === 'email'
      ? ''
      : `<h2 class="rail-head">Content</h2><div class="rule-light"></div>
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
        <button class="btn danger" onclick="deleteItem('${i.id}')">Delete</button>
      </div>
    `;
    openModal();
  } catch (err) {
    alert(err.message);
  }
}
window.viewItem = viewItem;
window.closeModal = closeModal;
window.deleteItem = deleteItem;

function openModal() {
  const m = $('#modal');
  m.classList.remove('hidden');
  void m.offsetWidth;
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
    DataAPI.deleteItemFromCache(id);
    closeModal();
    loadAll();
  } catch (err) {
    alert(err.message);
  }
}

document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

// ---------- First launch setup check ----------
async function checkFirstLaunch() {
  const isFirst = await SecureStore.isFirstLaunch();
  if (isFirst) {
    // Show a gentle setup prompt
    const narr = $('#sec-narrative');
    narr.innerHTML = `
      <p class="narrative-text">Welcome to <b>The Daily Briefing</b>. To get started, you'll need to configure your GitHub PAT and API keys.</p>
      <p class="narrative-text muted" style="font-size:0.85em">Open the debug page to configure settings: <a href="debug.html">debug.html</a></p>
    `;
  }
}

// ---------- Init ----------
(async function init() {
  // Handle Google Calendar OAuth redirect callback (web preview only)
  try { await CalendarAPI.handleRedirectCallback(); } catch (e) { /* redirect in progress */ }

  // Load saved Google Calendar tokens from SecureStore
  try { await CalendarAPI.loadTokens(); } catch (e) { /* no saved tokens */ }

  initPullToRefresh();
  await checkFirstLaunch();
  await loadAll();
})();
