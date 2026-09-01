import { Router } from 'express';
import { join } from 'path';
import { Item } from '../models/Item.js';
import { Note } from '../models/Note.js';
import { dbStatus } from '../db.js';
import { getLogs } from '../logger.js';
import { validateConfig } from '../config.js';
import { buildBriefing } from '../services/briefing.js';

const router = Router();

const weatherCache = { data: null, at: 0 };

// Shared 5-minute cache for Google Calendar reads (schedule/today + calendar/month)
const CAL_CACHE_TTL = 5 * 60 * 1000;
const calendarCache = { events: null, at: 0, start: null, end: null };

async function getCachedCalendarEvents(calendar, start, end, maxPerCal) {
  const now = Date.now();
  // Reuse cache if fresh enough AND the cached range covers the request
  if (calendarCache.events && (now - calendarCache.at) < CAL_CACHE_TTL
      && calendarCache.start <= start && calendarCache.end >= end) {
    return calendarCache.events;
  }
  // Fetch the wider of: requested range or today→end of next month
  const wideEnd = new Date(Math.max(end.getTime(), new Date(now.getFullYear(), now.getMonth() + 2, 0).getTime()));
  const events = await calendar.fetchEventsInRange(start, wideEnd, maxPerCal);
  calendarCache.events = events;
  calendarCache.at = now;
  calendarCache.start = start;
  calendarCache.end = wideEnd;
  return events;
}

// Strip suffixes like "Lecture", "Lec", "Lect" from class names
function cleanTitle(t) {
  return (t || '').replace(/\s*[-–]?\s*(Lecture|Lec|Lect|Class)\s*$/i, '').trim();
}

export function createRoutes({ npsScraper, syncService, summarizer, gmail, calendar, aakash }) {
  // ---- Health / status ----
  router.get('/health', (req, res) => {
    const problems = validateConfig();
    res.json({
      ok: problems.length === 0,
      problems,
      db: dbStatus(),
      nps: {
        loggedIn: npsScraper.loggedIn,
        lastLoginAt: npsScraper.lastLoginAt,
        lastError: npsScraper.lastError
      },
      gmail: gmail.isConnected() ? 'connected' : (gmail.enabled ? 'not-authorized' : 'not-configured'),
      calendar: calendar.isConnected() ? 'connected' : (calendar.enabled ? 'not-authorized' : 'not-configured'),
      summarizer: summarizer.enabled ? 'enabled' : 'disabled',
      lastSync: syncService.lastSync,
      lastSyncResult: syncService.lastResult,
      aakash: aakash.status()
    });
  });

  // ---- Today's schedule: classes + exams + Saturday check ----
  router.get('/schedule/today', async (req, res) => {
    try {
      const now = new Date();
      const endOfTomorrow = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);

      // Next Saturday
      const saturday = new Date(now);
      saturday.setDate(saturday.getDate() + ((6 - saturday.getDay() + 7) % 7 || 7));
      const satKey = saturday.toISOString().slice(0, 10);

      const [events, holidays] = await Promise.all([
        calendar.isConnected()
          ? getCachedCalendarEvents(calendar, now, endOfTomorrow, 80)
          : Promise.resolve([]),
        Item.find({ type: 'holiday' }).lean()
      ]);

      // Use ALL events from ALL calendars (not just /school/) so Aakash coaching, primary, etc. all show
      const istNow = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
      const todayKey = istNow.toISOString().slice(0, 10);
      const tomorrowKey = new Date(istNow.getTime() + 86400000).toISOString().slice(0, 10);
      console.log(`[Schedule] Calendars fetched: ${[...new Set(events.map(e => e.calendarName))].join(', ')} (${events.length} events total)`);

      // Today's classes: whatever is on any calendar today that isn't an exam, birthday, or holiday
      const classes = events
        .filter(e => (e.start || '').slice(0, 10) === todayKey)
        .filter(e => !/exam|test|akats|quiz/i.test(e.title))
        .filter(e => !e.isBirthday)
        .filter(e => !/holiday/i.test(e.calendarName || ''))
        .map(e => cleanTitle(e.title));

      // Tomorrow's classes (used when today has none and it's after 5 PM)
      const tomorrowClasses = events
        .filter(e => (e.start || '').slice(0, 10) === tomorrowKey)
        .filter(e => !/exam|test|akats|quiz/i.test(e.title))
        .filter(e => !e.isBirthday)
        .filter(e => !/holiday/i.test(e.calendarName || ''))
        .map(e => cleanTitle(e.title));

      const exams = events.filter(e => /exam|test|akats|quiz/i.test(e.title) && new Date(e.start) >= now)
        .map(e => ({ title: e.title, date: e.start }))
        .sort((a, b) => new Date(a.date) - new Date(b.date));

      // Saturday holiday check from NPS school calendar
      const saturdayHoliday = holidays.find(h => (h.metadata?.startDate || '') === satKey);

      const day = now.toLocaleDateString(undefined, { weekday: 'long' });

      // If no classes today and it's past 5 PM, show tomorrow's classes instead
      let showClasses = classes;
      let showTomorrow = false;
      let classesPlaceholder = classes.length === 0;
      if (classes.length === 0 && now.getHours() >= 17) {
        showClasses = tomorrowClasses;
        showTomorrow = true;
        classesPlaceholder = showClasses.length === 0;
      }

      res.json({
        day,
        classes: showClasses,
        hasClasses: showClasses.length > 0,
        showTomorrow,
        tomorrowDay: tomorrowKey,
        classesPlaceholder,
        exams,
        saturday: {
          date: satKey,
          isHoliday: !!saturdayHoliday,
          reason: saturdayHoliday?.title || null
        }
      });
    } catch (err) {
      console.error('[Schedule/today] Error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Month schedule: merged calendar + school events ----
  router.get('/calendar/month', async (req, res) => {
    try {
      const now = new Date();
      // Range: today to end of month; if in last week of month, extend through next month
      const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
      const lastWeekStart = new Date(monthEnd.getTime() - 7 * 24 * 60 * 60 * 1000);
      const rangeEnd = now >= lastWeekStart
        ? new Date(now.getFullYear(), now.getMonth() + 2, 0, 23, 59, 59)
        : monthEnd;

      const [events, holidays] = await Promise.all([
        calendar.isConnected()
          ? getCachedCalendarEvents(calendar, now, rangeEnd, 100)
          : Promise.resolve([]),
        Item.find({
          type: 'holiday',
          postedDate: { $gte: new Date(now.getFullYear(), now.getMonth(), now.getDate()), $lte: rangeEnd }
        }).lean()
      ]);

      const merged = [];

      for (const e of events) {
        const isSchool = /school/i.test(e.calendarName || '');
        const isExam = /exam|test|akats|quiz/i.test(e.title);
        // Compute class period order from start time (IST classes start ~8:00)
        let order = null;
        if (isSchool && !isExam && e.start && e.start.includes('T')) {
          const hour = parseInt(e.start.slice(11, 13), 10);
          if (hour >= 7 && hour <= 17) order = hour - 7; // P1=8am, P2=9am, etc.
        }
        merged.push({
          title: cleanTitle(e.title),
          date: e.start,
          kind: isExam ? 'exam' : (isSchool ? 'class' : (e.isBirthday ? 'birthday' : 'personal')),
          order
        });
      }

      for (const h of holidays) {
        merged.push({
          title: h.title,
          date: h.metadata?.startDate || h.postedDate,
          kind: 'holiday'
        });
      }

      // Birthdays: only upcoming (they already are, range starts now), dedupe similar titles on same date
      const seen = new Set();
      const deduped = merged.filter(e => {
        const key = `${e.date}|${e.title.toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 20)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      deduped.sort((a, b) => new Date(a.date) - new Date(b.date));

      res.json({
        rangeStart: now.toISOString().slice(0, 10),
        rangeEnd: rangeEnd.toISOString().slice(0, 10),
        events: deduped
      });
    } catch (err) {
      console.error('[Calendar/month] Error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Calendar ----

  // ---- Weather (Open-Meteo: hourly, daily, full detail) ----
  router.get('/weather', async (req, res) => {
    try {
      const now = Date.now();
      // Cache weather for 60 min to avoid hammering Open-Meteo (it rate-limits hard with 429)
      if (weatherCache.data && now - weatherCache.at < 60 * 60 * 1000) {
        return res.json(weatherCache.data);
      }

      // Yelahanka, Bangalore
      const lat = 13.1007, lon = 77.5963;
      const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon +
        '&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,cloud_cover,pressure_msl,surface_pressure,wind_speed_10m,wind_direction_10m,wind_gusts_10m' +
        '&hourly=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_gusts_10m,uv_index,visibility' +
        '&daily=weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,sunrise,sunset,uv_index_max,precipitation_sum,precipitation_probability_max,wind_speed_10m_max' +
        '&timezone=auto&forecast_days=7';

      // Retry up to 4 times with long exponential backoff for 429 (rate limit)
      let data = null;
      let lastErr = null;
      for (let attempt = 1; attempt <= 4; attempt++) {
        try {
          const r = await fetch(url, { signal: AbortSignal.timeout(25000) });
          if (r.status === 429) throw new Object.assign(new Error('HTTP 429 (rate limited)'), { rateLimit: true });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const json = await r.json();
          if (json.current) { data = json; break; }
          throw new Error('bad response from open-meteo');
        } catch (err) {
          lastErr = err;
          console.error(`[Weather] Attempt ${attempt} failed:`, err.message);
          // Long backoff for rate limits (10s, 20s, 40s); 3s for transient errors
          const wait = err.rateLimit ? 10 * 2 ** (attempt - 1) * 1000 : 3000;
          if (attempt < 4) await new Promise(r => setTimeout(r, wait));
        }
      }

      if (!data) {
        if (weatherCache.data) return res.json(weatherCache.data);
        throw lastErr || new Error('all weather attempts failed');
      }

      const WMO = code => ({
        0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
        45: 'Fog', 48: 'Rime fog', 51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
        56: 'Freezing drizzle', 57: 'Freezing drizzle', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
        66: 'Freezing rain', 67: 'Freezing rain', 71: 'Light snow', 73: 'Snow', 75: 'Heavy snow',
        77: 'Snow grains', 80: 'Light showers', 81: 'Showers', 82: 'Heavy showers',
        85: 'Snow showers', 86: 'Snow showers', 95: 'Thunderstorm', 96: 'Storm with hail', 99: 'Storm with hail'
      })[code] || 'Unknown';

      const dirName = deg => ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'][Math.round(deg / 22.5) % 16];

      // Next 24h from now
      const nowIso = new Date().toISOString().slice(0, 13);
      const hourly = data.hourly.time.map((t, i) => ({
        time: t,
        temp: Math.round(data.hourly.temperature_2m[i]),
        feels: Math.round(data.hourly.apparent_temperature[i]),
        humidity: data.hourly.relative_humidity_2m[i],
        rainChance: data.hourly.precipitation_probability[i],
        rain: data.hourly.precipitation[i],
        code: data.hourly.weather_code[i],
        condition: WMO(data.hourly.weather_code[i]),
        wind: Math.round(data.hourly.wind_speed_10m[i]),
        gusts: Math.round(data.hourly.wind_gusts_10m[i]),
        uv: data.hourly.uv_index[i],
        visibility: data.hourly.visibility[i]
      }));
      const next24 = hourly.filter(h => h.time >= nowIso).slice(0, 24);

      const daily = data.daily.time.map((t, i) => ({
        date: t,
        code: data.daily.weather_code[i],
        condition: WMO(data.daily.weather_code[i]),
        max: Math.round(data.daily.temperature_2m_max[i]),
        min: Math.round(data.daily.temperature_2m_min[i]),
        feelsMax: Math.round(data.daily.apparent_temperature_max[i]),
        feelsMin: Math.round(data.daily.apparent_temperature_min[i]),
        sunrise: data.daily.sunrise[i],
        sunset: data.daily.sunset[i],
        uvMax: Math.round(data.daily.uv_index_max[i]),
        rainSum: data.daily.precipitation_sum[i],
        rainChance: data.daily.precipitation_probability_max[i],
        windMax: Math.round(data.daily.wind_speed_10m_max[i])
      }));

      const c = data.current;
      const result = {
        location: 'Yelahanka, Bangalore',
        updated: new Date().toISOString(),
        current: {
          temp: Math.round(c.temperature_2m),
          feels: Math.round(c.apparent_temperature),
          humidity: c.relative_humidity_2m,
          condition: WMO(c.weather_code),
          code: c.weather_code,
          isDay: c.is_day === 1,
          rain: c.precipitation,
          cloud: c.cloud_cover,
          pressure: Math.round(c.pressure_msl),
          wind: Math.round(c.wind_speed_10m),
          windDir: dirName(c.wind_direction_10m),
          windDeg: c.wind_direction_10m,
          gusts: Math.round(c.wind_gusts_10m)
        },
        today: daily[0],
        hourly: next24,
        daily
      };

      weatherCache.data = result;
      weatherCache.at = now;
      // Also expose for SyncService._fetchWeather() so it reuses the same data (avoids 429s)
      global.__weatherCacheData = result;
      global.__weatherCacheAt = now;
      res.json(result);
    } catch (err) {
      if (weatherCache.data) return res.json(weatherCache.data);
      res.status(502).json({ error: `weather unavailable: ${err.message}` });
    }
  });

  // ---- Calendar ----
  router.get('/calendars', async (req, res) => {
    try {
      if (!calendar.isConnected()) return res.json({ connected: false, calendars: [] });
      const cals = await calendar._listCalendars();
      res.json({ connected: true, calendars: cals.map(c => ({ id: c.id, name: c.summary, primary: c.primary })) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/calendar/events', async (req, res) => {
    try {
      const days = parseInt(req.query.days || '14', 10);
      const events = await calendar.fetchUpcomingEvents(parseInt(req.query.limit || '10', 10), days);
      res.json({ connected: calendar.isConnected(), events, error: calendar.lastError });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Combined upcoming: personal calendar + school holidays/exams/events
  router.get('/calendar/upcoming', async (req, res) => {
    try {
      const days = parseInt(req.query.days || '30', 10);
      const limit = parseInt(req.query.limit || '10', 10);
      const cutoff = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

      const [personal, school] = await Promise.all([
        calendar.isConnected()
          ? calendar.fetchUpcomingEvents(limit, days)
          : Promise.resolve([]),
        Item.find({
          type: 'holiday',
          postedDate: { $gte: new Date(), $lte: cutoff }
        }).sort({ postedDate: 1 }).limit(limit).lean()
      ]);

      const merged = [
        ...personal.map(e => ({
          title: e.title,
          date: e.start,
          allDay: e.isAllDay,
          location: e.location,
          calendarName: e.calendarName,
          kind: /school/i.test(e.calendarName || '') ? 'school' : 'personal'
        })),
        ...school.map(e => ({
          title: e.title, date: e.metadata?.startDate || e.postedDate,
          allDay: true, location: null, kind: 'school'
        }))
      ].sort((a, b) => new Date(a.date) - new Date(b.date)).slice(0, limit);

      res.json({
        connected: calendar.isConnected(),
        calendarError: calendar.lastError,
        events: merged
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Sync ----
  const runSync = mode => async (req, res) => {
    if (syncService.running) return res.status(409).json({ error: 'Sync already running' });
    syncService.running = true;
    const background = mode === 'background';
    if (background) res.json({ started: true });
    try {
      let result;
      if (mode === 'nps') result = await syncService.syncNps();
      else if (mode === 'gmail') result = await syncService.syncGmail();
      else if (mode === 'news') result = await syncService.syncNews();
      else result = await syncService.syncAll();
      if (!background) res.json(result);
      else console.log('[API] background sync done:', JSON.stringify(result));
    } catch (err) {
      console.error('[API] sync error:', err.message);
      if (!background) res.status(500).json({ error: err.message });
    } finally {
      syncService.running = false;
    }
  };

  router.post('/sync/nps', runSync('nps'));
  router.post('/sync/gmail', runSync('gmail'));
  router.post('/sync/news', runSync('news'));
  router.post('/sync/all', runSync('all'));

  // ---- Briefing ----
  router.get('/briefing', async (req, res) => {
    try {
      res.json(await buildBriefing(summarizer));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Items ----
  router.get('/items', async (req, res) => {
    try {
      const { source, type, unread, limit = 100 } = req.query;
      const filter = {};
      if (source) filter.source = source;
      if (type) filter.type = type;
      if (unread === 'true') filter.isRead = false;
      const items = await Item.find(filter).sort({ createdAt: -1 }).limit(parseInt(limit, 10));
      res.json(items);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/items/:id', async (req, res) => {
    try {
      const item = await Item.findById(req.params.id);
      if (!item) return res.status(404).json({ error: 'Not found' });
      const json = item.toJSON();
      if (item.type === 'email' && item.metadata?.messageId) {
        json.gmailUrl = `https://mail.google.com/mail/u/0/#inbox/${item.metadata.messageId}`;
      }
      res.json(json);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.patch('/items/:id/read', async (req, res) => {
    try {
      res.json(await Item.findByIdAndUpdate(req.params.id, { isRead: true }, { new: true }));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.patch('/items/:id/complete', async (req, res) => {
    try {
      res.json(await Item.findByIdAndUpdate(req.params.id, { isCompleted: true }, { new: true }));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/items/:id', async (req, res) => {
    try {
      await Item.findByIdAndDelete(req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Attachments / PDFs ----

  // Download an assignment PDF (proxied through the NPS session)
  router.get('/attachments/assignment/:id', async (req, res) => {
    try {
      const item = await Item.findById(req.params.id);
      if (!item?.metadata?.downloadUrl) return res.status(404).json({ error: 'No attachment for this item' });
      const file = await npsScraper.downloadFile(item.metadata.downloadUrl, item.title);
      if (!file) return res.status(500).json({ error: 'Download failed (session expired or file gone)' });
      res.download(join(process.cwd(), 'downloads', file));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Download a circular PDF: fetch full detail (gets the real PDF link), then proxy
  router.get('/attachments/circular/:id', async (req, res) => {
    try {
      const item = await Item.findById(req.params.id);
      const circularId = item?.metadata?.circularId;
      if (!circularId) return res.status(404).json({ error: 'No PDF for this circular' });
      const detail = await npsScraper.fetchCircularDetail(circularId);
      if (!detail?.downloadUrl) return res.status(500).json({ error: 'Could not resolve PDF link' });
      const file = await npsScraper.downloadFile(detail.downloadUrl, item.title);
      if (!file) return res.status(500).json({ error: 'Download failed' });
      res.download(join(process.cwd(), 'downloads', file));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Full circular detail (title/body/pdf link)
  router.get('/circular/:id/detail', async (req, res) => {
    try {
      const item = await Item.findById(req.params.id);
      if (!item?.metadata?.circularId) return res.status(404).json({ error: 'No detail available' });
      const detail = await npsScraper.fetchCircularDetail(item.metadata.circularId);
      if (!detail) return res.status(500).json({ error: 'Fetch failed' });
      res.json(detail);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- NPS debug ----
  router.get('/nps/debug/:page', async (req, res) => {
    const valid = { assignment: 'Assignment', notifications: 'Notifications', circular: 'Circular' };
    const target = valid[req.params.page.toLowerCase()];
    if (!target) return res.status(400).json({ error: 'Unknown page. Use: ' + Object.keys(valid).join(', ') });
    try {
      const page = await npsScraper._goto(target);
      const bodyText = await page.evaluate(() => document.body.innerText);
      const counts = await page.evaluate(() => ({
        notificationLists: document.querySelectorAll('.notification__list').length,
        attachmentBlocks: document.querySelectorAll('.attachment-block').length,
        boxes: document.querySelectorAll('.box').length,
        downloadLinks: document.querySelectorAll('a.btn.btn-info').length
      }));
      await page.close();
      res.json({ url: page.url(), counts, bodyText: bodyText.substring(0, 5000) });
} catch (err) {
      console.error('[Schedule/today] Error:', err.message, err.stack);
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/nps/relogin', async (req, res) => {
    try {
      await npsScraper.login(true);
      res.json({ success: true, loggedIn: npsScraper.loggedIn });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ---- Gmail auth ----
  router.get('/gmail/auth', (req, res) => {
    if (!gmail.enabled) return res.status(400).json({ error: 'Gmail not configured in .env' });
    res.redirect(gmail.getAuthUrl());
  });

  // ---- Calendar auth ----
  router.get('/calendar/auth', (req, res) => {
    if (!calendar.enabled) return res.status(400).json({ error: 'Calendar not configured in .env' });
    res.redirect(calendar.getAuthUrl());
  });

  router.get('/calendar/callback', async (req, res) => {
    const { code } = req.query;
    try {
      await calendar.setCredentials(code);
      res.redirect('/?gcal=connected');
    } catch (err) {
      console.error('[Calendar] Auth failed:', err.message);
      res.redirect('/?gcal=error');
    }
  });

  router.get('/gmail/callback', async (req, res) => {
    const { code } = req.query;
    try {
      await gmail.setCredentials(code);
      console.log('[Gmail] Authorized OK');
      res.redirect('/?gmail=connected');
    } catch (err) {
      console.error('[Gmail] Auth failed:', err.message);
      res.redirect('/?gmail=error');
    }
  });

  router.get('/gmail/status', (req, res) => {
    res.json({ enabled: gmail.enabled, connected: gmail.isConnected() });
  });

  // ---- Summarizer ----
  router.post('/summarize', async (req, res) => {
    try {
      const results = await summarizer.summarizePending(parseInt(req.query.limit || '10', 10));
      res.json({ summarized: results.length, results });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Logs ----
  router.get('/logs', (req, res) => {
    res.json({ logs: getLogs(parseInt(req.query.n || '200', 10)) });
  });

  // ---- Aakash WhatsApp -> School calendar sync ----
  router.post('/aakash/sync', async (req, res) => {
    // Fire-and-forget spawn; respond immediately with started status
    const result = await aakash.run({ cause: 'manual-debug' });
    res.json(result);
  });

  router.get('/aakash/status', (req, res) => {
    res.json(aakash.status());
  });

  // ---- Manual calendar event add ----
  router.post('/calendar/add', async (req, res) => {
    try {
      if (!calendar.isConnected()) return res.status(400).json({ error: 'Calendar not connected' });
      const { title, date, startTime, endTime, weekly, dayOfWeek } = req.body;
      if (!title || !date) return res.status(400).json({ error: 'title and date required' });

      const tz = 'Asia/Kolkata';
      const body = { summary: title, description: 'Added via Daily Briefing debug console' };

      if (weekly && dayOfWeek) {
        // Build IST datetime strings
        const d = new Date(date + 'T00:00:00+05:30');
        const [sh, sm] = (startTime || '09:00').split(':').map(Number);
        const [eh, em] = (endTime || `${sh + 1}:${String(sm).padStart(2, '0')}`).split(':').map(Number);
        const pad = n => String(n).padStart(2, '0');
        const startStr = `${date}T${pad(sh)}:${pad(sm)}:00+05:30`;
        let endDate = date;
        if (eh < sh || (eh === sh && em <= sm)) {
          const nd = new Date(d.getTime() + 86400000);
          endDate = nd.toISOString().slice(0, 10);
        }
        const endStr = `${endDate}T${pad(eh)}:${pad(em)}:00+05:30`;
        const dayCode = dayOfWeek.substring(0, 2).toUpperCase();
        body.start = { dateTime: startStr, timeZone: tz };
        body.end = { dateTime: endStr, timeZone: tz };
        body.recurrence = [`RRULE:FREQ=WEEKLY;BYDAY=${dayCode};UNTIL=20270531T235959Z`];
      } else if (startTime) {
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
        // All-day
        body.start = { date };
        const nd = new Date(date + 'T00:00:00+05:30');
        nd.setDate(nd.getDate() + 1);
        body.end = { date: nd.toISOString().slice(0, 10) };
      }

      const result = await calendar.createEvent(body);
      res.json({ ok: true, id: result.id, link: result.htmlLink });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Extract events from timetable image via Gemini ----
  router.post('/calendar/extract', async (req, res) => {
    try {
      const { imageBase64, mimeType } = req.body;
      if (!imageBase64) return res.status(400).json({ error: 'imageBase64 required' });
      const key = process.env.GEMINI_API_KEY;
      if (!key) return res.status(400).json({ error: 'GEMINI_API_KEY not configured' });

      const CURRENT_YEAR = new Date().getFullYear();
      const prompt = `Extract all classes, exams, and events from this timetable image. Return ONLY a JSON array. Each item: { "title": "Class name", "singleDate": "YYYY-MM-DD" or null, "dayOfWeek": "Monday"/"Tuesday"/etc or null, "weekly": true/false, "startTime": "HH:MM" or null, "endTime": "HH:MM" or null }. Use year ${CURRENT_YEAR}. Dates: YYYY-MM-DD. If an event repeats weekly, set weekly=true and dayOfWeek. If one-off, set singleDate. No extra text, just JSON.`;

      const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: prompt },
              { inline_data: { mime_type: mimeType || 'image/jpeg', data: imageBase64 } }
            ]
          }]
        })
      });

      if (!resp.ok) {
        const err = await resp.text();
        throw new Error(`Gemini API error ${resp.status}: ${err}`);
      }

      const data = await resp.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) throw new Error('No JSON array in Gemini response');

      const events = JSON.parse(jsonMatch[0]);
      res.json({ events });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Notes (to-do list) ----
  router.get('/notes/list', async (req, res) => {
    try {
      const notes = await Note.find().sort({ createdAt: -1 });
      res.json(notes);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/notes/add', async (req, res) => {
    try {
      const { text } = req.body;
      if (!text || !text.trim()) return res.status(400).json({ error: 'text required' });
      const note = await Note.create({ text: text.trim() });
      res.json(note);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.patch('/notes/:id/toggle', async (req, res) => {
    try {
      const note = await Note.findById(req.params.id);
      if (!note) return res.status(404).json({ error: 'Not found' });
      note.done = !note.done;
      await note.save();
      res.json(note);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/notes/:id', async (req, res) => {
    try {
      await Note.findByIdAndDelete(req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Smart note: parse freeform text → calendar event or just a note ----
  router.post('/notes/parse', async (req, res) => {
    try {
      const { text } = req.body;
      if (!text || !text.trim()) return res.status(400).json({ error: 'text required' });
      const key = process.env.GEMINI_API_KEY;
      if (!key) return res.status(400).json({ error: 'GEMINI_API_KEY not configured' });

      const now = new Date();
      const istNow = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
      const istDate = istNow.toISOString().slice(0, 10);
      const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const istDay = dayNames[istNow.getUTCDay()];

      const prompt = `You are a smart calendar assistant. Parse this note from a school student.

Today is ${istDay}, ${istDate} (IST timezone, Asia/Kolkata).

Note: "${text.replace(/"/g, '\\"')}"

Determine if this is a calendar-worthy event (appointment, class, exam, party, deadline, meeting, trip, anything with a date/time). If it IS calendar-worthy, return JSON:
{ "isEvent": true, "title": "clean title (e.g. Kriti's Birthday Party)", "date": "YYYY-MM-DD", "startTime": "HH:MM" (24h, or null if no time given), "endTime": "HH:MM" (estimated end, or null), "location": "inferred location or null", "description": "short note about it" }

If it is NOT calendar-worthy (just a random thought, shopping list, etc.), return JSON:
{ "isEvent": false, "title": "the note as-is", "date": null, "startTime": null, "endTime": null, "location": null, "description": null }

Rules:
- "sunday" means the upcoming Sunday (not past). Same for any weekday.
- "tomorrow" = ${new Date(istNow.getTime() + 86400000).toISOString().slice(0, 10)}
- If someone says "moa" → location = "Mall of Asia". Infer common abbreviations.
- If no time given but it's an event, leave startTime null.
- If it mentions a deadline ("submit by", "due"), set startTime to null, it's an all-day reminder.
- "bday" or "birthday" → title should say "Birthday Party" or similar.
- Be smart about context. "dentist 3pm tuesday" → event. "buy milk" → not event.
- Return ONLY the JSON object, nothing else.`;

      const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }]
        })
      });

      if (!resp.ok) {
        const err = await resp.text();
        throw new Error(`Gemini API error ${resp.status}: ${err}`);
      }

      const data = await resp.json();
      const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON in Gemini response');

      const parsed = JSON.parse(jsonMatch[0]);
      res.json(parsed);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
