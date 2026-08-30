import { google } from 'googleapis';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
const TOKEN_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../gmail-tokens.json');

// AI classification cache: messageId -> 'keep' | 'drop'
const classifyCache = new Map();
const CACHE_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../gmail-classify-cache.json');

function loadCache() {
  try {
    if (existsSync(CACHE_PATH)) {
      const obj = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
      for (const [k, v] of Object.entries(obj)) classifyCache.set(k, v);
    }
  } catch {}
}
function saveCache() {
  try {
    writeFileSync(CACHE_PATH, JSON.stringify(Object.fromEntries(classifyCache)));
  } catch {}
}
loadCache();

export class GmailConnector {
  constructor(config) {
    this.enabled = !!(config.clientId && config.clientSecret);
    this.config = config;
    this.classifier = null; // set externally: async (subject, body) => 'keep' | 'drop'
    if (this.enabled) {
      this.oauth2Client = new google.auth.OAuth2(
        config.clientId,
        config.clientSecret,
        config.redirectUri
      );
      this._loadTokens();
    }
  }

  _loadTokens() {
    try {
      if (existsSync(TOKEN_PATH)) {
        this.oauth2Client.setCredentials(JSON.parse(readFileSync(TOKEN_PATH, 'utf8')));
        console.log('[Gmail] Loaded saved tokens');
      }
    } catch (err) {
      console.error('[Gmail] Failed to load tokens:', err.message);
    }
  }

  getAuthUrl() {
    return this.oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
      prompt: 'consent'
    });
  }

  async setCredentials(code) {
    const { tokens } = await this.oauth2Client.getToken(code);
    this.oauth2Client.setCredentials(tokens);
    writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
    console.log('[Gmail] Tokens saved');
    return tokens;
  }

  isConnected() {
    return this.enabled && !!(
      this.oauth2Client.credentials?.access_token || this.oauth2Client.credentials?.refresh_token
    );
  }

  // Broad fetch: category filters removed so Updates/announcements come through.
  // Marketing is filtered afterwards by AI classification.
  async fetchRecentEmails(maxResults = 25) {
    const gmail = google.gmail({ version: 'v1', auth: this.oauth2Client });

    const res = await gmail.users.messages.list({
      userId: 'me',
      maxResults,
      q: 'newer_than:2d'
    });

    const messages = res.data.messages || [];
    const emails = [];

    for (const msg of messages) {
      const full = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'full'
      });

      const headers = full.data.payload.headers;
      const subject = headers.find(h => h.name === 'Subject')?.value || '(no subject)';
      const from = headers.find(h => h.name === 'From')?.value || '';
      const date = headers.find(h => h.name === 'Date')?.value || '';
      const category = headers.find(h => h.name === 'X-Gmail-Labels')?.value
        || full.data.labelIds?.join(',') || '';

      let body = '';
      if (full.data.payload.body?.data) {
        body = Buffer.from(full.data.payload.body.data, 'base64').toString('utf-8');
      } else if (full.data.payload.parts) {
        const textPart = full.data.payload.parts.find(p => p.mimeType === 'text/plain');
        if (textPart?.body?.data) {
          body = Buffer.from(textPart.body.data, 'base64').toString('utf-8');
        }
      }

      emails.push({
        id: msg.id,
        subject,
        from,
        date,
        category,
        body: body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').substring(0, 1500)
      });
    }

    return emails;
  }

  // Classify an email as marketing or not. Cached per message id.
  async classify(email) {
    if (classifyCache.has(email.id)) return classifyCache.get(email.id);

    let verdict = null;
    if (this.classifier) {
      try {
        verdict = await this.classifier(email.subject, email.body, email.category);
      } catch (err) {
        console.error('[Gmail] AI classify failed:', err.message);
      }
    }

    // Fallback when AI unavailable: use Gmail category labels
    if (!verdict) {
      const cat = (email.category || '').toLowerCase();
      if (/category_promotions|category_social|category_forums/.test(cat)) verdict = 'drop';
      else if (/category_updates|category_personal/.test(cat) || !cat) verdict = 'keep';
      else verdict = 'keep';
    }

    classifyCache.set(email.id, verdict);
    saveCache();
    return verdict;
  }
}
