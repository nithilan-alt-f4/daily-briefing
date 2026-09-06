import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';

import { config, validateConfig } from './src/config.js';
import { connectDb, dbStatus } from './src/db.js';
import { NPSScraper } from './src/connectors/nps.js';
import { GmailConnector } from './src/connectors/gmail.js';
import { NewsConnector } from './src/connectors/news.js';
import { CalendarConnector } from './src/connectors/calendar.js';
import { SyncService } from './src/services/sync.js';
import { Summarizer } from './src/services/summarizer.js';
import { AakashSync } from './src/aakash.js';
import { createRoutes } from './src/routes/api.js';
import { migrateTokensToMongoDB } from './src/utils/migrateTokens.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(join(__dirname, 'public')));

const npsScraper = new NPSScraper();
const summarizer = new Summarizer(config.groqApiKey);
const gmail = new GmailConnector({
  clientId: process.env.GMAIL_CLIENT_ID,
  clientSecret: process.env.GMAIL_CLIENT_SECRET,
  redirectUri: process.env.GMAIL_REDIRECT_URI || `http://localhost:${config.port}/api/gmail/callback`
});
const news = new NewsConnector({ newsApiKey: process.env.NEWS_API_KEY });

// AI classifier for Gmail: marketing/ad -> drop, everything else -> keep
gmail.classifier = async (subject, body, category) => {
  if (!summarizer.enabled) return null; // fall back to category rules
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

const calendar = new CalendarConnector({
  clientId: process.env.GCAL_CLIENT_ID,
  clientSecret: process.env.GCAL_CLIENT_SECRET,
  calendarId: process.env.GCAL_CALENDAR_ID || 'primary',
  redirectUri: process.env.GCAL_REDIRECT_URI || `http://localhost:${config.port}/api/calendar/callback`
});
const syncService = new SyncService({ npsScraper, summarizer, gmail, news, calendar });
const aakash = new AakashSync();

app.use('/api', createRoutes({ npsScraper, syncService, summarizer, gmail, calendar, aakash }));

const problems = validateConfig();
if (problems.length > 0) {
  console.error('Config problems:', problems.join('; '));
}

// Listen IMMEDIATELY - DB connects in background so the server is never blocked
app.listen(config.port, () => {
  console.log(`Server running on http://localhost:${config.port} (db: ${dbStatus()})`);
});

connectDb(config.mongoUri)
  .then(async () => {
    console.log('Connected to MongoDB');
    // Migrate tokens from JSON files to MongoDB (one-time)
    await migrateTokensToMongoDB();
    // Load OAuth tokens now that DB is connected
    await Promise.all([gmail.init(), calendar.init()]);
    // Kick off initial sync after tokens are loaded
    safeSync('startup');
  })
  .catch(err => console.error('MongoDB connection FAILED:', err.message, '- API endpoints needing DB will error.'));

mkdirSync(join(__dirname, 'downloads'), { recursive: true });
mkdirSync(join(__dirname, 'media'), { recursive: true });

// Daily sync at 7:00 and 13:00
cron.schedule('0 7 * * *', () => safeSync('morning cron'));
cron.schedule('0 13 * * *', () => safeSync('afternoon cron'));

// Aakash WhatsApp -> School calendar sync every midnight
cron.schedule('0 0 * * *', () => safeAakashSync('midnight cron'));

// Note: startup sync moved to after DB connection and token loading

async function safeAakashSync(cause) {
  try {
    const result = await aakash.run({ cause });
    console.log(`[Aakash] ${cause} ->`, JSON.stringify({ running: result.running, success: result.success, needsReauth: result.needsReauth, exit: result.exit, skipped: result.skipped }));
  } catch (err) {
    console.error(`[Aakash] ${cause} failed:`, err.message);
  }
}

async function safeSync(cause) {
  if (syncService.running) return;
  syncService.running = true;
  try {
    console.log(`[Sync] Starting (${cause})...`);
    const result = await syncService.syncAll();
    console.log(`[Sync] Done (${cause}):`, JSON.stringify(result));
  } catch (err) {
    console.error(`[Sync] Failed (${cause}):`, err.message);
  } finally {
    syncService.running = false;
  }
}
