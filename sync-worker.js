/**
 * Standalone sync worker — runs inside GitHub Actions.
 * Connects to MongoDB, runs all syncs (NPS, Gmail, News, Calendar),
 * generates the briefing narrative, then exports everything as JSON
 * and force-pushes to the `data` branch for the phone app to consume.
 *
 * All config comes from environment variables (GitHub Secrets).
 */
import 'dotenv/config';
import { connectDb } from './src/db.js';
import { config, validateConfig } from './src/config.js';
import { NPSScraper } from './src/connectors/nps.js';
import { GmailConnector } from './src/connectors/gmail.js';
import { NewsConnector } from './src/connectors/news.js';
import { CalendarConnector } from './src/connectors/calendar.js';
import { SyncService } from './src/services/sync.js';
import { Summarizer } from './src/services/summarizer.js';
import { generateAndCacheNarrative } from './src/services/briefing.js';
import { Item } from './src/models/Item.js';
import { Settings } from './src/models/Settings.js';

async function main() {
  console.log('=== Sync Worker starting ===');
  const problems = validateConfig();
  if (problems.length) console.error('Config problems:', problems.join('; '));

  // Connect to MongoDB
  try {
    await connectDb(config.mongoUri);
    console.log('Connected to MongoDB');
  } catch (err) {
    console.error('MongoDB FAILED:', err.message);
    process.exit(1);
  }

  // Build connectors
  const npsScraper = new NPSScraper();
  const summarizer = new Summarizer(config.groqApiKey);

  const gmail = new GmailConnector({
    clientId: process.env.GMAIL_CLIENT_ID,
    clientSecret: process.env.GMAIL_CLIENT_SECRET,
    redirectUri: process.env.GMAIL_REDIRECT_URI || 'https://daily-briefing-6ahp.onrender.com/api/gmail/callback'
  });

  gmail.classifier = async (subject, body, category) => {
    if (!summarizer.enabled) return null;
    const prompt =
      `Classify this email for a school student's briefing. Respond with ONLY one word:\n` +
      `"drop" if it is marketing, an advertisement, a promotion, a newsletter, a coupon, or a sales blast.\n` +
      `"keep" if it is a useful update, announcement, transactional message, account notice, school communication, or personal email.\n\n` +
      `Subject: ${subject}\nCategory labels: ${category}\nBody: ${(body || '').substring(0, 800)}`;
    const out = await summarizer._chat(prompt, 200);
    const word = (out || '').toLowerCase();
    if (word.includes('drop')) return 'drop';
    if (word.includes('keep')) return 'keep';
    return null;
  };

  const news = new NewsConnector({ newsApiKey: process.env.NEWS_API_KEY });
  const calendar = new CalendarConnector({
    clientId: process.env.GCAL_CLIENT_ID,
    clientSecret: process.env.GCAL_CLIENT_SECRET,
    calendarId: process.env.GCAL_CALENDAR_ID || 'primary',
    redirectUri: process.env.GCAL_REDIRECT_URI || 'https://daily-briefing-6ahp.onrender.com/api/calendar/callback'
  });

  await Promise.all([gmail.init(), calendar.init()]);

  const syncService = new SyncService({ npsScraper, summarizer, gmail, news, calendar });

  // Run full sync
  console.log('Starting full sync...');
  try {
    const result = await syncService.syncAll();
    console.log('Sync result:', JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('Sync failed:', err.message);
  }

  // Generate narrative (with weather)
  try {
    let weather = null;
    try {
      const lat = 13.1007, lon = 77.5963;
      const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon +
        '&current=temperature_2m,weather_code&daily=precipitation_probability_max&timezone=auto&forecast_days=1';
      const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
      const d = await r.json();
      weather = {
        current: { temp: Math.round(d.current?.temperature_2m), condition: String(d.current?.weather_code) },
        today: { rainChance: d.daily?.precipitation_probability_max?.[0] }
      };
    } catch {}
    await generateAndCacheNarrative(summarizer, weather, calendar);
    console.log('Narrative refreshed');
  } catch (err) {
    console.error('Narrative generation failed:', err.message);
  }

  // ======== Handle calendar event from workflow_dispatch ========
  if (process.env.EVENT_TITLE) {
    console.log(`Creating calendar event: ${process.env.EVENT_TITLE}`);
    try {
      const tz = 'Asia/Kolkata';
      const title = process.env.EVENT_TITLE;
      const date = process.env.EVENT_DATE;
      const startTime = process.env.EVENT_START;
      const endTime = process.env.EVENT_END;
      const isSchool = process.env.EVENT_IS_SCHOOL === 'true';

      if (!date) throw new Error('EVENT_DATE required');

      const eventBody = {
        summary: title,
        description: `Created via Daily Briefing workflow_dispatch${isSchool ? ' (school event)' : ''}`
      };

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
        eventBody.start = { dateTime: `${date}T${pad(sh)}:${pad(sm)}:00+05:30`, timeZone: tz };
        eventBody.end = { dateTime: `${endDate}T${pad(eh)}:${pad(em)}:00+05:30`, timeZone: tz };
      } else {
        eventBody.start = { date };
        const nd = new Date(date + 'T00:00:00+05:30');
        nd.setDate(nd.getDate() + 1);
        eventBody.end = { date: nd.toISOString().slice(0, 10) };
      }

      const calId = process.env.GCAL_CALENDAR_ID || 'primary';
      const result = await calendar.createEvent(eventBody, calId);
      console.log('Calendar event created:', result.link || 'ok');
    } catch (err) {
      console.error('Calendar event creation failed:', err.message);
    }
  }

  // ======== Export to JSON for phone app ========
  console.log('Exporting data to JSON...');
  try {
    const [assignments, notifications, circulars, schoolCalendar, emails, newsArticles, narrativeDoc] = await Promise.all([
      Item.find({ type: 'assignment' }).sort({ createdAt: -1 }).limit(15).lean(),
      Item.find({ type: 'notification' }).sort({ postedDate: -1, createdAt: -1 }).limit(8).lean(),
      Item.find({ type: 'circular' }).sort({ postedDate: -1, createdAt: -1 }).limit(5).lean(),
      Item.find({ type: 'holiday' }).sort({ postedDate: 1 }).lean(),
      Item.find({ type: 'email' }).sort({ postedDate: -1, createdAt: -1 }).limit(5).lean(),
      Item.find({ type: 'news' }).sort({ postedDate: -1, createdAt: -1 }).limit(8).lean(),
      Settings.findOne({ key: 'narrative' }).lean()
    ]);

    const exportData = {
      syncedAt: new Date().toISOString(),
      items: {
        assignments: assignments.map(a => ({
          _id: String(a._id),
          title: a.title,
          content: a.content,
          source: a.source,
          type: a.type,
          postedDate: a.postedDate,
          priority: a.priority,
          summary: a.summary || null,
          metadata: a.metadata || {},
          createdAt: a.createdAt
        })),
        notifications: notifications.map(n => ({
          _id: String(n._id),
          title: n.title,
          content: n.content,
          source: n.source,
          type: n.type,
          postedDate: n.postedDate,
          priority: n.priority,
          summary: n.summary || null,
          createdAt: n.createdAt
        })),
        circulars: circulars.map(c => ({
          _id: String(c._id),
          title: c.title,
          content: c.content,
          source: c.source,
          type: c.type,
          postedDate: c.postedDate,
          priority: c.priority,
          metadata: c.metadata || {},
          createdAt: c.createdAt
        })),
        schoolCalendar: schoolCalendar.map(h => ({
          _id: String(h._id),
          title: h.title,
          content: h.content,
          source: h.source,
          type: h.type,
          postedDate: h.postedDate,
          metadata: h.metadata || {},
          createdAt: h.createdAt
        })),
        emails: emails.map(e => ({
          _id: String(e._id),
          title: e.title,
          content: e.content,
          source: e.source,
          type: e.type,
          postedDate: e.postedDate,
          priority: e.priority,
          summary: e.summary || null,
          metadata: e.metadata || {},
          createdAt: e.createdAt
        }))
      },
      news: newsArticles.map(n => ({
        _id: String(n._id),
        title: n.title,
        content: n.content,
        source: n.source,
        type: n.type,
        postedDate: n.postedDate,
        priority: n.priority,
        summary: n.summary || null,
        metadata: n.metadata || {},
        createdAt: n.createdAt
      })),
      narrative: narrativeDoc?.value?.text || null,
      narrativeDate: narrativeDoc?.value?.date || null
    };

    const fs = await import('fs');
    fs.writeFileSync('/tmp/briefing-data.json', JSON.stringify(exportData, null, 2));
    console.log(`Export complete: ${JSON.stringify(exportData).length} bytes, ${exportData.items.assignments.length} assignments, ${exportData.items.notifications.length} notifications, ${exportData.items.circulars.length} circulars, ${exportData.news.length} news`);
  } catch (err) {
    console.error('Export failed:', err.message);
  }

  console.log('=== Sync Worker done ===');
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
