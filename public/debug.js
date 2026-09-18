/**
 * debug.js — Client-only debug console.
 * No server. Uses DataAPI, CalendarAPI, NarrativeAPI, SecureStore.
 */
const $ = sel => document.querySelector(sel);

document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    $(`#tab-${btn.dataset.tab}`).classList.add('active');
    if (btn.dataset.tab === 'items') loadItems();
  });
});

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtDate(s) {
  if (!s) return '-';
  const d = new Date(s);
  return isNaN(d) ? s : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function fmtDateTime(s) {
  if (!s) return '-';
  const d = new Date(s);
  return isNaN(d) ? s : d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

// ---- Health bar: local config status ----
async function loadHealth() {
  const el = $('#health-bar');
  try {
    const [pat, groqKey, geminiKey, newsKey, googleTokens] = await Promise.all([
      SecureStore.getGitHubPAT(),
      SecureStore.getGroqKey(),
      SecureStore.getGeminiKey(),
      SecureStore.getNewsKey(),
      SecureStore.getGoogleTokens()
    ]);
    const parts = [
      `PAT: <span class="${pat ? 'ok' : 'err'}">${pat ? 'set' : 'missing'}</span>`,
      `Groq: <span class="${groqKey ? 'ok' : 'warn'}">${groqKey ? 'set' : 'missing'}</span>`,
      `Gemini: <span class="${geminiKey ? 'ok' : 'warn'}">${geminiKey ? 'set' : 'missing'}</span>`,
      `News: <span class="${newsKey ? 'ok' : 'warn'}">${newsKey ? 'set' : 'missing'}</span>`,
      `Google Cal: <span class="${googleTokens ? 'ok' : 'warn'}">${googleTokens ? 'authorized' : 'not connected'}</span>`,
      `Platform: <span class="ok">${window.Capacitor?.isNativePlatform?.() ? 'native' : 'web'}</span>`,
    ];
    // Cache status
    const cached = DataAPI.getCachedData();
    if (cached) {
      const age = DataAPI.getCacheAgeText();
      parts.push(`Cache: <span class="ok">${age || 'fresh'}</span>`);
    } else {
      parts.push(`Cache: <span class="warn">empty</span>`);
    }
    el.innerHTML = parts.join(' &nbsp;|&nbsp; ');
  } catch (err) {
    el.innerHTML = `<span class="err">error: ${escapeHtml(err.message)}</span>`;
  }
}

// ---- Items browser ----
async function loadItems() {
  const list = $('#items-list');
  const status = $('#items-status');
  status.textContent = 'loading...';
  try {
    const allItems = await DataAPI.getAllItems();
    const source = $('#items-filter').value;
    const type = $('#items-type').value;

    let items = allItems;
    if (source) items = items.filter(i => i.source === source);
    if (type) items = items.filter(i => i.type === type);

    status.textContent = `${items.length} items`;
    list.innerHTML = items.map(i => `
      <div class="item-card" onclick="viewItem('${i.id}')">
        <div class="head">
          <span class="type">${i.source} / ${i.type}</span>
          <span class="badge ${i.priority}">${i.priority}</span>
        </div>
        <div class="title">${escapeHtml(i.title || '')}</div>
        ${i.summary ? `<div class="ai"><b>Summary:</b> ${escapeHtml(i.summary)}</div>` : ''}
        <div class="body">${escapeHtml((i.content || '').substring(0, 250))}${(i.content || '').length > 250 ? '...' : ''}</div>
        <div class="meta">
          <span>posted: ${fmtDateTime(i.postedDate)}</span>
        </div>
      </div>
    `).join('') || '<p class="muted">No items found in cache.</p>';
  } catch (err) {
    list.innerHTML = `<div class="item-card"><div class="title" style="color:var(--err)">Failed to load items</div><div class="body">${escapeHtml(err.message)}</div></div>`;
    status.textContent = 'error';
  }
}

async function viewItem(id) {
  try {
    const all = await DataAPI.getAllItems();
    const i = all.find(item => item.id === id);
    if (!i) throw new Error('Item not found');
    const meta = i.metadata || {};
    const attachments = [];
    if (i.type === 'email' && meta.messageId) {
      attachments.push(`<button onclick="window.open('https://mail.google.com/mail/u/0/#inbox/${meta.messageId}','_blank')">Open in Gmail</button>`);
    }
    if (i.type === 'news' && meta.url) {
      attachments.push(`<button onclick="window.open('${escapeHtml(meta.url)}','_blank')">Open news article</button>`);
    }

    $('#modal-content').innerHTML = `
      <span class="type-badge">${i.source} / ${i.type}</span>
      <h3>${escapeHtml(i.title || '')}</h3>
      <div class="kv"><b>Priority</b> <span class="badge ${i.priority}">${i.priority}</span></div>
      <div class="kv"><b>Posted</b> ${fmtDateTime(i.postedDate)}</div>
      <div class="kv"><b>ID</b> ${i.id}</div>
      ${meta.subject ? `<div class="kv"><b>Subject</b> ${escapeHtml(meta.subject)}</div>` : ''}
      ${meta.teacher ? `<div class="kv"><b>Teacher</b> ${escapeHtml(meta.teacher)}</div>` : ''}
      ${meta.from ? `<div class="kv"><b>From</b> ${escapeHtml(meta.from)}</div>` : ''}
      ${meta.sourceName ? `<div class="kv"><b>News source</b> ${escapeHtml(meta.sourceName)}</div>` : ''}
      ${meta.category ? `<div class="kv"><b>Category</b> ${escapeHtml(meta.category)}</div>` : ''}
      ${meta.rawTitle ? `<div class="kv"><b>Raw title</b> ${escapeHtml(meta.rawTitle)}</div>` : ''}
      ${meta.startDate ? `<div class="kv"><b>Event date</b> ${fmtDate(meta.startDate)}</div>` : ''}
      ${i.summary ? `<h2>Summary</h2><div class="content-block">${escapeHtml(i.summary)}</div>` : ''}
      <h2>Content</h2>
      <div class="content-block">${escapeHtml(i.content || '(empty)')}</div>
      <div class="kv"><b>Metadata</b> <pre style="white-space:pre-wrap;font-size:11px">${escapeHtml(JSON.stringify(meta, null, 1))}</pre></div>
      ${attachments.length ? `<div class="btn-row">${attachments.join('')}</div>` : ''}
      <div class="btn-row">
        <button class="danger" onclick="deleteItem('${i.id}')">Delete from cache</button>
      </div>
    `;
    $('#modal').classList.remove('hidden');
  } catch (err) {
    alert(err.message);
  }
}

function closeModal() {
  $('#modal').classList.add('hidden');
}

async function deleteItem(id) {
  if (!confirm('Delete this item from local cache?')) return;
  try {
    DataAPI.deleteItemFromCache(id);
    closeModal();
    loadItems();
  } catch (err) {
    alert(err.message);
  }
}

// ---- Actions ----

// GitHub Actions Sync (triggers workflow_dispatch)
async function triggerGitHubSync() {
  const el = $('#github-sync-out');
  el.innerHTML = '<div class="ok-line">Triggering GitHub Actions workflow...</div>';
  try {
    await DataAPI.triggerWorkflow('sync.yml');
    const repoUrl = `https://github.com/${AppConfig.GITHUB_OWNER}/${AppConfig.GITHUB_REPO}/actions`;
    el.innerHTML = `<div class="ok-line">Workflow triggered</div>
      <div style="margin-top:8px"><a href="${repoUrl}" target="_blank" style="font-size:12px">View workflow runs on GitHub →</a></div>`;
  } catch (err) {
    el.innerHTML = `<div class="err-box">${escapeHtml(err.message)}</div>`;
  }
}
window.triggerGitHubSync = triggerGitHubSync;

// Move school events (triggers workflow_dispatch)
async function moveSchoolEvents() {
  const el = $('#move-school-out');
  el.innerHTML = '<div class="ok-line">Triggering school event move via GitHub Actions...</div>';
  try {
    await DataAPI.triggerWorkflow('sync.yml', { action: 'move-school' });
    el.innerHTML = `<div class="ok-line">Workflow triggered — check GitHub Actions for results</div>`;
  } catch (err) {
    el.innerHTML = `<div class="err-box">${escapeHtml(err.message)}</div>`;
  }
}
window.moveSchoolEvents = moveSchoolEvents;

// Calendar: manual event add
async function addManualEvent() {
  const title = $('#cal-title').value.trim();
  const date = $('#cal-date').value;
  if (!title || !date) return alert('Title and date required');
  const weekly = $('#cal-weekly').checked;
  const el = $('#cal-add-out');
  el.innerHTML = '<div class="ok-line">adding...</div>';

  const tz = 'Asia/Kolkata';
  const body = { summary: title, description: 'Added via Daily Briefing debug' };

  try {
    if (weekly) {
      const dayCode = ($('#cal-day').value || 'MO').substring(0, 2).toUpperCase();
      const [sh, sm] = ($('#cal-start').value || '09:00').split(':').map(Number);
      const [eh, em] = ($('#cal-end').value || `${sh + 1}:${String(sm).padStart(2, '0')}`).split(':').map(Number);
      const pad = n => String(n).padStart(2, '0');
      let endDate = date;
      const d = new Date(date + 'T00:00:00+05:30');
      if (eh < sh || (eh === sh && em <= sm)) {
        endDate = new Date(d.getTime() + 86400000).toISOString().slice(0, 10);
      }
      body.start = { dateTime: `${date}T${pad(sh)}:${pad(sm)}:00+05:30`, timeZone: tz };
      body.end = { dateTime: `${endDate}T${pad(eh)}:${pad(em)}:00+05:30`, timeZone: tz };
      body.recurrence = [`RRULE:FREQ=WEEKLY;BYDAY=${dayCode};UNTIL=20270531T235959Z`];
    } else if ($('#cal-start').value) {
      const [sh, sm] = $('#cal-start').value.split(':').map(Number);
      const [eh, em] = ($('#cal-end').value || `${sh + 1}:${String(sm).padStart(2, '0')}`).split(':').map(Number);
      const pad = n => String(n).padStart(2, '0');
      let endDate = date;
      if (eh < sh || (eh === sh && em <= sm)) {
        endDate = new Date(new Date(date + 'T00:00:00+05:30').getTime() + 86400000).toISOString().slice(0, 10);
      }
      body.start = { dateTime: `${date}T${pad(sh)}:${pad(sm)}:00+05:30`, timeZone: tz };
      body.end = { dateTime: `${endDate}T${pad(eh)}:${pad(em)}:00+05:30`, timeZone: tz };
    } else {
      body.start = { date };
      const nd = new Date(date + 'T00:00:00+05:30');
      nd.setDate(nd.getDate() + 1);
      body.end = { date: nd.toISOString().slice(0, 10) };
    }

    if (CalendarAPI.isConnected()) {
      const result = await CalendarAPI.createEvent(body, 'primary');
      el.innerHTML = `<div class="ok-line">added — <a href="${result.link}" target="_blank">open in Google Calendar</a></div>`;
    } else {
      // Fallback: queue via workflow dispatch
      await DataAPI.triggerWorkflow('sync.yml', {
        event_title: title, event_date: date,
        event_start: $('#cal-start').value || '', event_end: $('#cal-end').value || '',
        event_is_school: 'false'
      });
      el.innerHTML = `<div class="ok-line">queued — will be created on next sync</div>`;
    }
    $('#cal-title').value = '';
  } catch (err) {
    el.innerHTML = `<div class="err-box">${escapeHtml(err.message)}</div>`;
  }
}
window.addManualEvent = addManualEvent;

// Extract events from timetable photo via Gemini (on-device)
async function extractFromSnap(input) {
  const file = input.files?.[0];
  if (!file) return;
  const el = $('#cal-snap-events');
  const out = $('#cal-snap-out');
  el.innerHTML = '<p class="muted">Reading image...</p>';
  out.innerHTML = '';

  const reader = new FileReader();
  reader.onload = async () => {
    const base64 = reader.result.split(',')[1];
    el.innerHTML = '<p class="muted">Asking Gemini to extract events...</p>';
    try {
      const data = await NarrativeAPI.extractTimetable(base64, file.type || 'image/jpeg');
      const events = data.events || data || [];
      if (!events.length) { el.innerHTML = '<p class="muted">No events found.</p>'; return; }
      el.innerHTML = events.map((e, i) => `
        <div style="border:1px solid var(--border);padding:8px;margin-bottom:6px;border-radius:4px;font-size:12px">
          <b>${escapeHtml(e.title)}</b>
          ${e.weekly ? ` · ${e.dayOfWeek || '?'} weekly` : ` · ${e.singleDate || e.date || '?'}`}
          ${e.startTime ? ` · ${e.startTime}${e.endTime ? '-' + e.endTime : ''}` : ''}
          <br><button onclick="saveExtracted(${i})" style="margin-top:4px;font-size:11px">Save this one</button>
        </div>
      `).join('') + `<button onclick="saveAllExtracted()" style="margin-top:4px">Save all ${events.length} events</button>`;
      window._extractedEvents = events;
    } catch (err) {
      el.innerHTML = '';
      out.innerHTML = `<div class="err-box">${escapeHtml(err.message)}</div>`;
    }
  };
  reader.readAsDataURL(file);
}

async function saveExtracted(idx) {
  const ev = window._extractedEvents?.[idx];
  if (!ev) return;
  const out = $('#cal-snap-out');
  out.innerHTML = '<div class="ok-line">saving...</div>';

  const tz = 'Asia/Kolkata';
  const title = ev.title;
  const date = ev.date || ev.singleDate;
  if (!title || !date) { out.innerHTML = '<div class="err-box">Missing title or date</div>'; return; }

  const body = { summary: title, description: 'Added via Daily Briefing debug (photo)' };
  try {
    if (ev.startTime) {
      const [sh, sm] = ev.startTime.split(':').map(Number);
      const [eh, em] = (ev.endTime || `${sh + 1}:${String(sm).padStart(2, '0')}`).split(':').map(Number);
      const pad = n => String(n).padStart(2, '0');
      let endDate = date;
      if (eh < sh || (eh === sh && em <= sm)) {
        endDate = new Date(new Date(date + 'T00:00:00+05:30').getTime() + 86400000).toISOString().slice(0, 10);
      }
      body.start = { dateTime: `${date}T${pad(sh)}:${pad(sm)}:00+05:30`, timeZone: tz };
      body.end = { dateTime: `${endDate}T${pad(eh)}:${pad(em)}:00+05:30`, timeZone: tz };
      if (ev.weekly && ev.dayOfWeek) {
        body.recurrence = [`RRULE:FREQ=WEEKLY;BYDAY=${ev.dayOfWeek.substring(0, 2).toUpperCase()};UNTIL=20270531T235959Z`];
      }
    } else {
      body.start = { date };
      const nd = new Date(date + 'T00:00:00+05:30');
      nd.setDate(nd.getDate() + 1);
      body.end = { date: nd.toISOString().slice(0, 10) };
    }

    if (CalendarAPI.isConnected()) {
      const r = await CalendarAPI.createEvent(body, 'primary');
      out.innerHTML = `<div class="ok-line">saved — <a href="${r.link}" target="_blank">open</a></div>`;
    } else {
      await DataAPI.triggerWorkflow('sync.yml', {
        event_title: title, event_date: date,
        event_start: ev.startTime || '', event_end: ev.endTime || '',
        event_is_school: ev.isSchool ? 'true' : 'false'
      });
      out.innerHTML = `<div class="ok-line">queued for next sync</div>`;
    }
  } catch (err) {
    out.innerHTML = `<div class="err-box">${escapeHtml(err.message)}</div>`;
  }
}
window.saveExtracted = saveExtracted;

async function saveAllExtracted() {
  const events = window._extractedEvents || [];
  const out = $('#cal-snap-out');
  out.innerHTML = `<div class="ok-line">saving ${events.length} events...</div>`;
  let saved = 0, failed = 0;
  for (let i = 0; i < events.length; i++) {
    try { await saveExtracted(i); saved++; } catch { failed++; }
  }
  out.innerHTML = `<div class="ok-line">${saved} saved, ${failed} failed</div>`;
}
window.saveAllExtracted = saveAllExtracted;

// ---- Config setup ----
async function saveConfig() {
  const pat = $('#cfg-pat').value.trim();
  const groq = $('#cfg-groq').value.trim();
  const gemini = $('#cfg-gemini').value.trim();
  const news = $('#cfg-news').value.trim();
  const out = $('#config-out');
  try {
    if (pat) await SecureStore.setGitHubPAT(pat);
    if (groq) await SecureStore.setGroqKey(groq);
    if (gemini) await SecureStore.setGeminiKey(gemini);
    if (news) await SecureStore.setNewsKey(news);
    out.innerHTML = '<div class="ok-line">Saved</div>';
    loadHealth();
    // Clear input fields after save
    $('#cfg-pat').value = '';
    $('#cfg-groq').value = '';
    $('#cfg-gemini').value = '';
    $('#cfg-news').value = '';
  } catch (err) {
    out.innerHTML = `<div class="err-box">${escapeHtml(err.message)}</div>`;
  }
}
window.saveConfig = saveConfig;

async function connectCalendar() {
  const out = $('#config-out');
  try {
    await CalendarAPI.signIn();
    out.innerHTML = '<div class="ok-line">Calendar connected</div>';
    loadHealth();
  } catch (err) {
    out.innerHTML = `<div class="err-box">${escapeHtml(err.message)}</div>`;
  }
}
window.connectCalendar = connectCalendar;

document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
loadHealth();
setInterval(loadHealth, 10000);
loadItems();

// Force refresh data from GitHub
async function refreshData() {
  const el = $('#data-out');
  el.innerHTML = '<div class="ok-line">Fetching from GitHub...</div>';
  try {
    await DataAPI.refreshBriefingData();
    el.innerHTML = '<div class="ok-line">Data refreshed from GitHub</div>';
    loadHealth();
    loadItems();
  } catch (err) {
    el.innerHTML = `<div class="err-box">${escapeHtml(err.message)}</div>`;
  }
}
window.refreshData = refreshData;
