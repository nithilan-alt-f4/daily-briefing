import { google } from 'googleapis';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Token } from '../models/Token.js';

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

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
    }
  }

  // Call this after MongoDB is connected
  async init() {
    if (this.enabled) {
      await this._loadTokens();
      // Listen for token refresh events and persist to MongoDB
      this.oauth2Client.on('tokens', (tokens) => {
        // Capture refresh_token synchronously before the googleapis library mutates it
        const newRefreshToken = tokens.refresh_token;
        const newAccessToken = tokens.access_token;
        const newExpiryDate = tokens.expiry_date;
        
        // Run async persistence in background
        (async () => {
          try {
            const existing = await Token.findOne({ service: 'gmail' });
            if (newRefreshToken && existing?.tokens?.refresh_token) {
              console.log('[Gmail] New refresh_token received from Google — rotation detected');
            }
            const merged = {
              ...(existing?.tokens || {}),
              access_token: newAccessToken,
              expiry_date: newExpiryDate,
              refresh_token: newRefreshToken || existing?.tokens?.refresh_token
            };
            await Token.findOneAndUpdate(
              { service: 'gmail' },
              { $set: { tokens: merged, updatedAt: new Date() } },
              { upsert: true }
            );
            console.log('[Gmail] Auto-refreshed tokens persisted to MongoDB');
          } catch (err) {
            console.error('[Gmail] Failed to persist refreshed tokens:', err.message);
          }
        })();
      });
    }
    return this;
  }

  async _loadTokens() {
    try {
      const tokenDoc = await Token.findOne({ service: 'gmail' });
      if (tokenDoc) {
        this.oauth2Client.setCredentials(tokenDoc.tokens);
        console.log('[Gmail] Loaded saved tokens from MongoDB');
      } else {
        console.log('[Gmail] No saved tokens found in MongoDB');
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
    await Token.findOneAndUpdate(
      { service: 'gmail' },
      { tokens, updatedAt: new Date() },
      { upsert: true }
    );
    console.log('[Gmail] Tokens saved to MongoDB');
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

  // Detect calendar invitation emails and auto-accept them via Calendar API
  async autoAcceptCalendarInvites(calendar) {
    if (!this.isConnected() || !calendar?.isConnected()) return { accepted: 0 };
    try {
      const gmail = google.gmail({ version: 'v1', auth: this.oauth2Client });

      // Search for emails that contain calendar invitations (ICS attachment or calendar header)
      const res = await gmail.users.messages.list({
        userId: 'me',
        maxResults: 20,
        q: 'subject:(invitation OR invited OR "calendar event") newer_than:7d is:unread'
      });

      const messages = res.data.messages || [];
      let accepted = 0;

      for (const msg of messages) {
        try {
          const full = await gmail.users.messages.get({
            userId: 'me',
            id: msg.id,
            format: 'full'
          });

          const headers = full.data.payload.headers;
          const subject = headers.find(h => h.name === 'Subject')?.value || '';
          const from = headers.find(h => h.name === 'From')?.value || '';

          // Only process actual calendar invites (not regular emails about calendars)
          const isInvite = /invitation|invited|would like you to attend|RSVP|respond/i.test(subject)
            || full.data.payload.mimeType === 'text/calendar'
            || (full.data.payload.parts || []).some(p => p.mimeType === 'text/calendar');

          if (!isInvite) continue;

          // Extract the event title from subject (strip "Invite: " prefix etc.)
          const eventTitle = subject.replace(/^(invite|invitation|fwd?:\s*)/i, '').replace(/\s*[-–]\s*.*$/i, '').trim();

          // Try to find and accept this event via Calendar API
          try {
            const cal = google.calendar({ version: 'v3', auth: calendar.oauth2Client });
            const now = new Date();
            const events = await cal.events.list({
              calendarId: calendar.calendarId || 'primary',
              q: eventTitle,
              timeMin: new Date(now.getTime() - 7 * 86400000).toISOString(),
              timeMax: new Date(now.getTime() + 30 * 86400000).toISOString(),
              singleEvents: true,
              maxResults: 5
            });

            for (const event of (events.data.items || [])) {
              const self = (event.attendees || []).find(a => a.self);
              if (self && self.responseStatus === 'needsAction') {
                self.responseStatus = 'accepted';
                await cal.events.patch({
                  calendarId: calendar.calendarId || 'primary',
                  eventId: event.id,
                  requestBody: { attendees: event.attendees }
                });
                accepted++;
                console.log(`[Gmail] Auto-accepted calendar invite: "${event.summary}" from ${from}`);
              }
            }
          } catch (err) {
            console.error(`[Gmail] Failed to accept invite for "${eventTitle}":`, err.message);
          }
        } catch (err) {
          console.error(`[Gmail] Failed processing message ${msg.id}:`, err.message);
        }
      }

      console.log(`[Gmail] Auto-accepted ${accepted} calendar invites`);
      return { accepted };
    } catch (err) {
      console.error('[Gmail] autoAcceptCalendarInvites failed:', err.message);
      return { accepted: 0, error: err.message };
    }
  }
}
