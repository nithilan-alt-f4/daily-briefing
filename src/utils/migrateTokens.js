import { readFileSync, existsSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Token } from '../models/Token.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CALENDAR_TOKEN_PATH = join(__dirname, '../../calendar-tokens.json');
const GMAIL_TOKEN_PATH = join(__dirname, '../../gmail-tokens.json');

export async function migrateTokensToMongoDB() {
  try {
    let migrated = 0;

    // Migrate calendar tokens
    if (existsSync(CALENDAR_TOKEN_PATH)) {
      const tokens = JSON.parse(readFileSync(CALENDAR_TOKEN_PATH, 'utf8'));
      await Token.findOneAndUpdate(
        { service: 'calendar' },
        { tokens, updatedAt: new Date() },
        { upsert: true }
      );
      console.log('[Migration] Calendar tokens migrated to MongoDB');
      // Rename the file so we don't migrate again
      renameSync(CALENDAR_TOKEN_PATH, CALENDAR_TOKEN_PATH + '.migrated');
      migrated++;
    }

    // Migrate Gmail tokens
    if (existsSync(GMAIL_TOKEN_PATH)) {
      const tokens = JSON.parse(readFileSync(GMAIL_TOKEN_PATH, 'utf8'));
      await Token.findOneAndUpdate(
        { service: 'gmail' },
        { tokens, updatedAt: new Date() },
        { upsert: true }
      );
      console.log('[Migration] Gmail tokens migrated to MongoDB');
      // Rename the file so we don't migrate again
      renameSync(GMAIL_TOKEN_PATH, GMAIL_TOKEN_PATH + '.migrated');
      migrated++;
    }

    if (migrated > 0) {
      console.log(`[Migration] Successfully migrated ${migrated} token file(s) to MongoDB`);
    }
  } catch (err) {
    console.error('[Migration] Failed to migrate tokens:', err.message);
  }
}
