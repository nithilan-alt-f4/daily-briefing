import { google } from 'googleapis';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const TOKEN_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../calendar-tokens.json');
const SCOPES = ['https://www.googleapis.com/auth/calendar'];

export class CalendarConnector {
  constructor(config) {
    this.enabled = !!(config.clientId && config.clientSecret);
    this.calendarId = config.calendarId || 'primary';
    this.lastError = null;
    if (this.enabled) {
      this.oauth2Client = new google.auth.OAuth2(
        config.clientId,
        config.clientSecret,
        config.redirectUri || 'http://localhost'
      );
      this._loadTokens();
    }
  }

  _loadTokens() {
    try {
      if (existsSync(TOKEN_PATH)) {
        this.oauth2Client.setCredentials(JSON.parse(readFileSync(TOKEN_PATH, 'utf8')));
        console.log('[Calendar] Loaded saved tokens');
      } else {
        console.log('[Calendar] No saved tokens found at', TOKEN_PATH);
      }
    } catch (err) {
      console.error('[Calendar] Failed to load tokens:', err.message);
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
    console.log('[Calendar] Tokens saved');
    return tokens;
  }

  isConnected() {
    return this.enabled && !!(
      this.oauth2Client.credentials?.access_token || this.oauth2Client.credentials?.refresh_token
    );
  }

  async createEvent(eventBody) {
    const cal = google.calendar({ version: 'v3', auth: this.oauth2Client });
    const res = await cal.events.insert({
      calendarId: this.calendarId,
      requestBody: eventBody
    });
    return res.data;
  }

  async _listCalendars() {
    const calendar = google.calendar({ version: 'v3', auth: this.oauth2Client });
    const list = await calendar.calendarList.list();
    return list.data.items || [];
  }

  // Fetch events from all (non-holiday) calendars within a time range
  async fetchEventsInRange(start, end, maxPerCalendar = 60) {
    try {
      const calendar = google.calendar({ version: 'v3', auth: this.oauth2Client });
      const calendars = await this._listCalendars();
      const targets = calendars.filter(c => !/holidays in india/i.test(c.summary || ''));

      const all = [];
      for (const calInfo of targets) {
        try {
          const res = await calendar.events.list({
            calendarId: calInfo.id,
            timeMin: start.toISOString(),
            timeMax: end.toISOString(),
            maxResults: maxPerCalendar,
            singleEvents: true,
            orderBy: 'startTime'
          });
          for (const e of res.data.items || []) {
            all.push({
              id: e.id,
              title: e.summary || '(no title)',
              start: e.start?.dateTime || e.start?.date,
              end: e.end?.dateTime || e.end?.date,
              location: e.location || null,
              isAllDay: !e.start?.dateTime,
              calendarName: calInfo.summary || calInfo.id,
              isBirthday: /\b(birthday|bday)\b/i.test(e.summary || '') || !!e.recurrence
            });
          }
        } catch (err) {
          console.error(`[Calendar] Failed to read "${calInfo.summary}":`, err.message);
        }
      }
      return all;
    } catch (err) {
      console.error('[Calendar] fetchEventsInRange failed:', err.message);
      return [];
    }
  }

  async fetchUpcomingEvents(maxResults = 10, daysAhead = 14) {
    try {
      const calendar = google.calendar({ version: 'v3', auth: this.oauth2Client });
      const now = new Date();
      const later = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);
      const windowEnd = later.toISOString();

      const calendars = await this._listCalendars();
      // Skip the generic Indian holidays calendars (noise)
      const targets = calendars.filter(c => !/holidays in india/i.test(c.summary || ''));

      const all = [];
      for (const calInfo of targets) {
        try {
          const res = await calendar.events.list({
            calendarId: calInfo.id,
            timeMin: now.toISOString(),
            timeMax: windowEnd,
            maxResults: 20,
            singleEvents: true,
            orderBy: 'startTime'
          });
          for (const e of res.data.items || []) {
            all.push({
              id: e.id,
              title: e.summary || '(no title)',
              start: e.start?.dateTime || e.start?.date,
              end: e.end?.dateTime || e.end?.date,
              location: e.location || null,
              description: e.description || null,
              isAllDay: !e.start?.dateTime,
              hangoutLink: e.hangoutLink || null,
              calendarName: calInfo.summary || calInfo.id
            });
          }
        } catch (err) {
          console.error(`[Calendar] Failed to read "${calInfo.summary}":`, err.message);
        }
      }

      // Sort by start, dedupe by title+date
      all.sort((a, b) => new Date(a.start) - new Date(b.start));
      const seen = new Set();
      const items = all.filter(e => {
        const key = `${e.title}|${e.start}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      // If nothing in the window, show nearest upcoming (capped 60 days, no birthdays)
      let result = items.slice(0, maxResults);
      if (result.length === 0) {
        for (const calInfo of targets) {
          try {
            const res = await calendar.events.list({
              calendarId: calInfo.id,
              timeMin: now.toISOString(),
              timeMax: new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000).toISOString(),
              maxResults: 30,
              singleEvents: true,
              orderBy: 'startTime'
            });
            for (const e of res.data.items || []) {
              if (/birthday|bday/i.test(e.summary || '')) continue;
              all.push({
                id: e.id,
                title: e.summary || '(no title)',
                start: e.start?.dateTime || e.start?.date,
                end: e.end?.dateTime || e.end?.date,
                location: e.location || null,
                description: null,
                isAllDay: !e.start?.dateTime,
                hangoutLink: e.hangoutLink || null,
                calendarName: calInfo.summary || calInfo.id
              });
            }
          } catch {}
        }
        all.sort((a, b) => new Date(a.start) - new Date(b.start));
        const seen2 = new Set();
        result = all.filter(e => {
          const key = `${e.title}|${e.start}`;
          if (seen2.has(key)) return false;
          seen2.add(key);
          return true;
        }).slice(0, maxResults);
      }

      this.lastError = null;
      return result;
    } catch (err) {
      this.lastError = err.message;
      console.error('[Calendar] Fetch failed:', err.message);
      return [];
    }
  }
}
