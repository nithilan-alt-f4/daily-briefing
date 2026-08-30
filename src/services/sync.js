import { Item } from '../models/Item.js';
import { generateAndCacheNarrative } from './briefing.js';

export class SyncService {
  constructor({ npsScraper, summarizer, gmail, news }) {
    this.nps = npsScraper;
    this.summarizer = summarizer;
    this.gmail = gmail;
    this.news = news;
    this.running = false;
    this.lastSync = null;
    this.lastResult = null;
  }

  async syncNps() {
    const saved = [];
    const errors = [];

    // Assignments
    try {
      const assignments = await this.nps.scrapeAssignments();
      for (const a of assignments) {
        const externalId = `assignment:${a.title}:${a.submissionDate}:${a.teacher}`;
        const doc = await Item.findOneAndUpdate(
          { source: 'nps', type: 'assignment', externalId },
          {
            $setOnInsert: {
              source: 'nps',
              type: 'assignment',
              externalId,
              title: a.title,
              content: [a.description, `Subject: ${a.subject}`, `Teacher: ${a.teacher}`].filter(Boolean).join('\n'),
              priority: 'medium',
              metadata: {
                subject: a.subject,
                teacher: a.teacher,
                submissionDate: a.submissionDate,
                downloadUrl: a.downloadUrl
              }
            }
          },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        if (this._isNew(doc)) saved.push(doc);
      }
      console.log(`[Sync] Assignments processed: ${assignments.length}`);
    } catch (err) {
      console.error('[Sync] Assignments failed:', err.message);
      errors.push(`assignments: ${err.message}`);
    }

    // Notifications
    try {
      const notifications = await this.nps.scrapeNotifications();
      for (const n of notifications) {
        const postedDate = this._parseNotifDate(n.dateStr, n.timeStr);
        const externalId = `notification:${n.dateStr}:${n.timeStr}:${n.title.substring(0, 60)}`;
        const doc = await Item.findOneAndUpdate(
          { source: 'nps', type: 'notification', externalId },
          {
            $setOnInsert: {
              source: 'nps',
              type: 'notification',
              externalId,
              title: n.title,
              content: n.body,
              postedDate,
              priority: /urgent|immediately|tomorrow|today/i.test(n.body) ? 'high' : 'medium'
            }
          },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        if (this._isNew(doc)) saved.push(doc);
      }
      console.log(`[Sync] Notifications processed: ${notifications.length}`);
    } catch (err) {
      console.error('[Sync] Notifications failed:', err.message);
      errors.push(`notifications: ${err.message}`);
    }

    // Circulars
    try {
      const circulars = await this.nps.scrapeCirculars();
      for (const c of circulars) {
        const externalId = `circular:${c.title.substring(0, 80)}:${c.dateStr}`;
        const doc = await Item.findOneAndUpdate(
          { source: 'nps', type: 'circular', externalId },
          {
            $setOnInsert: {
              source: 'nps',
              type: 'circular',
              externalId,
              title: c.title,
              content: c.title,
              postedDate: this._parseCircularDate(c.dateStr),
              priority: 'medium',
              metadata: {
                category: c.category,
                dateStr: c.dateStr,
                circularId: c.circularId
              }
            }
          },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        if (this._isNew(doc)) saved.push(doc);
      }
      console.log(`[Sync] Circulars processed: ${circulars.length}`);
    } catch (err) {
      console.error('[Sync] Circulars failed:', err.message);
      errors.push(`circulars: ${err.message}`);
    }

    // School calendar (holidays/exams/events)
    try {
      const events = await this.nps.scrapeSchoolCalendar();
      for (const ev of events) {
        // Strip the grade list suffix: "Onam ( LKG,UKG,... )"
        const cleanTitle = ev.title.replace(/\s*\(\s*[^)]*\)\s*$/, '').trim() || ev.title;
        const externalId = `schoolcal:${cleanTitle}:${ev.start}`;
        await Item.findOneAndUpdate(
          { source: 'nps', type: 'holiday', externalId },
          {
            $setOnInsert: {
              source: 'nps',
              type: 'holiday',
              externalId,
              title: cleanTitle,
              content: ev.title,
              postedDate: new Date(`${ev.start}T00:00:00`),
              priority: 'low',
              metadata: { startDate: ev.start, endDate: ev.end, rawTitle: ev.title }
            }
          },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
      }
      console.log(`[Sync] School calendar events processed: ${events.length}`);
    } catch (err) {
      console.error('[Sync] School calendar failed:', err.message);
      errors.push(`schoolCalendar: ${err.message}`);
    }

    await this._summarizeNew(saved);

    this.lastSync = new Date();
    this.lastResult = { saved: saved.length, errors };
    return { saved: saved.length, errors };
  }

  async syncGmail() {
    if (!this.gmail?.enabled) {
      console.log('[Sync] Gmail not configured, skipping');
      return { saved: 0, errors: ['gmail not configured'] };
    }
    if (!this.gmail.isConnected()) {
      console.log('[Sync] Gmail not authorized, skipping');
      return { saved: 0, errors: ['gmail not authorized'] };
    }
    const errors = [];
    try {
      const emails = await this.gmail.fetchRecentEmails();
      const saved = [];
      let dropped = 0;
      for (const e of emails) {
        // AI filter: drop marketing, keep updates/personal
        const verdict = await this.gmail.classify(e);
        if (verdict === 'drop') { dropped++; continue; }

        const doc = await Item.findOneAndUpdate(
          { source: 'gmail', type: 'email', externalId: `email:${e.id}` },
          {
            $setOnInsert: {
              source: 'gmail',
              type: 'email',
              externalId: `email:${e.id}`,
              title: e.subject,
              content: e.body,
              postedDate: e.date ? new Date(e.date) : new Date(),
              priority: 'medium',
              metadata: { messageId: e.id, from: e.from }
            }
          },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        if (this._isNew(doc)) saved.push(doc);
      }
      console.log(`[Sync] Emails processed: ${emails.length}, new: ${saved.length}, marketing dropped: ${dropped}`);
      await this._summarizeNew(saved);
      return { saved: saved.length, errors };
    } catch (err) {
      console.error('[Sync] Gmail failed:', err.message);
      errors.push(`gmail: ${err.message}`);
      return { saved: 0, errors };
    }
  }

  async syncNews() {
    if (!this.news?.enabled) {
      console.log('[Sync] News not configured, skipping');
      return { saved: 0, errors: ['news not configured'] };
    }
    try {
      const saved = await this.news.sync();
      console.log(`[Sync] News synced: ${saved.length} new`);
      await this._summarizeNew(saved);
      return { saved: saved.length, errors: [] };
    } catch (err) {
      console.error('[Sync] News failed:', err.message);
      return { saved: 0, errors: [`news: ${err.message}`] };
    }
  }

  async syncAll() {
    const nps = await this.syncNps();
    const gmail = await this.syncGmail();
    const news = await this.syncNews();

    // Refresh cached narrative (with weather)
    try {
      const weather = await this._fetchWeather();
      await generateAndCacheNarrative(this.summarizer, weather);
      console.log('[Sync] Narrative refreshed');
    } catch (err) {
      console.error('[Sync] Narrative generation failed:', err.message);
    }

    this.lastSync = new Date();
    this.lastResult = { nps, gmail, news };
    return this.lastResult;
  }

  async _fetchWeather() {
    try {
      const lat = 13.1007, lon = 77.5963;
      const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon +
        '&current=temperature_2m,weather_code&daily=precipitation_probability_max&timezone=auto&forecast_days=1';
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const d = await r.json();
      return {
        current: { temp: Math.round(d.current?.temperature_2m), condition: String(d.current?.weather_code) },
        today: { rainChance: d.daily?.precipitation_probability_max?.[0] }
      };
    } catch {
      return null;
    }
  }

  async _summarizeNew(saved) {
    if (saved.length > 0 && this.summarizer.enabled) {
      try {
        await this.summarizer.summarizeItems(saved);
      } catch (err) {
        console.error('[Sync] Summarization failed:', err.message);
      }
    }
  }

  _isNew(doc) {
    return doc?.createdAt && Date.now() - doc.createdAt.getTime() < 10000;
  }

  _parseNotifDate(dateStr, timeStr) {
    const base = this.nps.parseDate(dateStr);
    if (!base) return null;
    const m = timeStr?.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (m) {
      let h = parseInt(m[1], 10) % 12;
      if (m[3].toUpperCase() === 'PM') h += 12;
      base.setHours(h, parseInt(m[2], 10), 0, 0);
    }
    return base;
  }

  _parseCircularDate(str) {
    const m = str?.match(/(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/);
    if (!m) return null;
    const months = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
    const month = months[m[2]];
    if (month === undefined) return null;
    return new Date(parseInt(m[3], 10), month, parseInt(m[1], 10));
  }
}
