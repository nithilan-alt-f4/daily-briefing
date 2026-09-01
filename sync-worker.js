/**
 * Standalone sync worker — runs inside GitHub Actions.
 * Connects to MongoDB, runs all syncs (NPS, Gmail, News, Calendar, Aakash),
 * generates the briefing narrative, then exits.
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

async function main() {
  console.log('=== Sync Worker starting ===');
  const problems = validateConfig();
  if (problems.length) console.error('Config problems:', problems.join('; '));

  // Connect to MongoDB (same DB Render reads from)
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
    await generateAndCacheNarrative(summarizer, weather);
    console.log('Narrative refreshed');
  } catch (err) {
    console.error('Narrative generation failed:', err.message);
  }

  console.log('=== Sync Worker done ===');
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
