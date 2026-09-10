import { google } from 'googleapis';
import { Token } from '../models/Token.js';
import { isSchoolRelated } from '../utils/isSchoolRelated.js';

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
            const existing = await Token.findOne({ service: 'calendar' });
            if (newRefreshToken && existing?.tokens?.refresh_token) {
              console.log('[Calendar] New refresh_token received from Google — rotation detected');
            }
            const merged = {
              ...(existing?.tokens || {}),
              access_token: newAccessToken,
              expiry_date: newExpiryDate,
              refresh_token: newRefreshToken || existing?.tokens?.refresh_token
            };
            await Token.findOneAndUpdate(
              { service: 'calendar' },
              { $set: { tokens: merged, updatedAt: new Date() } },
              { upsert: true }
            );
            console.log('[Calendar] Auto-refreshed tokens persisted to MongoDB');
          } catch (err) {
            console.error('[Calendar] Failed to persist refreshed tokens:', err.message);
          }
        })();
      });
    }
    return this;
  }

  async _loadTokens() {
    try {
      const tokenDoc = await Token.findOne({ service: 'calendar' });
      if (tokenDoc) {
        this.oauth2Client.setCredentials(tokenDoc.tokens);
        console.log('[Calendar] Loaded saved tokens from MongoDB');
      } else {
        console.log('[Calendar] No saved tokens found in MongoDB');
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
    await Token.findOneAndUpdate(
      { service: 'calendar' },
      { tokens, updatedAt: new Date() },
      { upsert: true }
    );
    console.log('[Calendar] Tokens saved to MongoDB');
    return tokens;
  }

  isConnected() {
    return this.enabled && !!(
      this.oauth2Client.credentials?.access_token || this.oauth2Client.credentials?.refresh_token
    );
  }

  async createEvent(eventBody, calendarId) {
    const cal = google.calendar({ version: 'v3', auth: this.oauth2Client });
    const res = await cal.events.insert({
      calendarId: calendarId || this.calendarId,
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

      // Dedup: prefer school calendar over primary calendar for same title+time
      const seen = new Map();
      const deduped = [];
      for (const e of all) {
        const key = `${(e.title || '').toLowerCase().trim()}|${e.start || ''}`;
        const existing = seen.get(key);
        if (!existing) {
          seen.set(key, e);
          deduped.push(e);
        } else {
          // Prefer school calendar over primary
          const isSchool = /school/i.test(e.calendarName || '');
          const existingIsSchool = /school/i.test(existing.calendarName || '');
          if (isSchool && !existingIsSchool) {
            // Replace primary version with school version
            const idx = deduped.indexOf(existing);
            if (idx >= 0) deduped[idx] = e;
            seen.set(key, e);
          }
          // Otherwise skip duplicate
        }
      }

      return deduped;
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

  // Auto-accept pending event invitations (online class invites)
  // and remove duplicates: same event on both primary + school calendar → keep school one
  async acceptPendingInvitations() {
    try {
      const calendar = google.calendar({ version: 'v3', auth: this.oauth2Client });
      const calendars = await this._listCalendars();
      let accepted = 0;

      for (const calInfo of calendars) {
        try {
          const now = new Date();
          const future = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
          const res = await calendar.events.list({
            calendarId: calInfo.id,
            timeMin: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(),
            timeMax: future.toISOString(),
            maxResults: 100,
            singleEvents: true,
            orderBy: 'startTime'
          });

          for (const e of (res.data.items || [])) {
            // Find this user's attendee entry
            const attendees = e.attendees || [];
            const self = attendees.find(a => a.self);
            if (self && self.responseStatus === 'needsAction') {
              try {
                self.responseStatus = 'accepted';
                await calendar.events.patch({
                  calendarId: calInfo.id,
                  eventId: e.id,
                  requestBody: { attendees }
                });
                accepted++;
                console.log(`[Calendar] Auto-accepted: "${e.summary}" on ${calInfo.summary}`);
              } catch (err) {
                console.error(`[Calendar] Failed to accept "${e.summary}":`, err.message);
              }
            }
          }
        } catch (err) {
          console.error(`[Calendar] Failed scanning "${calInfo.summary}" for invites:`, err.message);
        }
      }

      // Dedup: remove primary calendar events that already exist on a school calendar
      // (same title + same start time → the school calendar version is the "real" one)
      let deduped = 0;
      try {
        const schoolCal = calendars.find(c => /school/i.test(c.summary || ''));
        const primaryCal = calendars.find(c => c.primary === true) || calendars.find(c => !/school/i.test(c.summary || ''));
        if (schoolCal && primaryCal) {
          const now = new Date();
          const future = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);
          const [schoolEvents, primaryEvents] = await Promise.all([
            calendar.events.list({
              calendarId: schoolCal.id,
              timeMin: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(),
              timeMax: future.toISOString(),
              maxResults: 200,
              singleEvents: true
            }),
            calendar.events.list({
              calendarId: primaryCal.id,
              timeMin: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(),
              timeMax: future.toISOString(),
              maxResults: 200,
              singleEvents: true
            })
          ]);

          // Build set of school event signatures
          const schoolSigs = new Set();
          for (const e of (schoolEvents.data.items || [])) {
            const start = e.start?.dateTime || e.start?.date || '';
            schoolSigs.add(`${(e.summary || '').toLowerCase().trim()}|${start}`);
          }

          // Delete primary calendar events that match a school event
          for (const e of (primaryEvents.data.items || [])) {
            const start = e.start?.dateTime || e.start?.date || '';
            const sig = `${(e.summary || '').toLowerCase().trim()}|${start}`;
            if (schoolSigs.has(sig)) {
              try {
                await calendar.events.delete({
                  calendarId: primaryCal.id,
                  eventId: e.id
                });
                deduped++;
                console.log(`[Calendar] Removed duplicate: "${e.summary}" from primary`);
              } catch (err) {
                console.error(`[Calendar] Failed to delete duplicate "${e.summary}":`, err.message);
              }
            }
          }
        }
      } catch (err) {
        console.error('[Calendar] Dedup failed:', err.message);
      }

      console.log(`[Calendar] Auto-accepted ${accepted}, deduped ${deduped}`);
      return { accepted, deduped };
    } catch (err) {
      console.error('[Calendar] acceptPendingInvitations failed:', err.message);
      return { accepted: 0, deduped: 0, error: err.message };
    }
  }

  // Scan personal calendar for school-related events, move them to school calendar
  async moveSchoolEvents() {
    try {
      const cal = google.calendar({ version: 'v3', auth: this.oauth2Client });
      const calendars = await this._listCalendars();
      const schoolCalendarId = process.env.GCAL_SCHOOL_CALENDAR_ID;

      // Find calendars: primary has .primary === true, school by name or ID
      const primaryCal = calendars.find(c => c.primary === true) || calendars.find(c => !/school/i.test(c.summary || ''));
      const schoolCal = calendars.find(c => /school/i.test(c.summary || ''))
        || (schoolCalendarId ? calendars.find(c => c.id === schoolCalendarId) : null);

      if (!schoolCal) {
        console.log('[Calendar] No school calendar found — skipping move');
        return { moved: 0, skipped: 0, errors: [], error: 'No school calendar found' };
      }
      if (!primaryCal) {
        console.log('[Calendar] No primary calendar found — skipping move');
        return { moved: 0, skipped: 0, errors: [], error: 'No primary calendar found' };
      }

      console.log(`[Calendar] Scanning "${primaryCal.summary}" for school events to move to "${schoolCal.summary}"`);

      // Log all calendars found for debugging
      console.log(`[Calendar] Available calendars: ${calendars.map(c => `${c.summary} (${c.id}, primary=${c.primary})`).join(', ')}`);

      // Fetch events from primary calendar (last 7 days to 60 days ahead)
      const now = new Date();
      const past = new Date(now.getTime() - 7 * 86400000);
      const future = new Date(now.getTime() + 60 * 86400000);
      const res = await cal.events.list({
        calendarId: primaryCal.id,
        timeMin: past.toISOString(),
        timeMax: future.toISOString(),
        maxResults: 200,
        singleEvents: true,
        orderBy: 'startTime'
      });

      const events = res.data.items || [];
      console.log(`[Calendar] Found ${events.length} events on primary calendar`);

      // Check which school events already exist on school calendar (to avoid duplicates)
      const schoolRes = await cal.events.list({
        calendarId: schoolCal.id,
        timeMin: past.toISOString(),
        timeMax: future.toISOString(),
        maxResults: 200,
        singleEvents: true
      });
      const schoolSigs = new Set();
      for (const e of (schoolRes.data.items || [])) {
        const start = e.start?.dateTime || e.start?.date || '';
        schoolSigs.add(`${(e.summary || '').toLowerCase().trim()}|${start}`);
      }

      let moved = 0;
      let skipped = 0;
      const errors = [];

      for (const event of events) {
        const title = event.summary || '';
        const isSchool = isSchoolRelated(title);

        if (!isSchool) {
          skipped++;
          continue;
        }

        // Check if already on school calendar
        const start = event.start?.dateTime || event.start?.date || '';
        const sig = `${title.toLowerCase().trim()}|${start}`;
        if (schoolSigs.has(sig)) {
          // Already on school calendar — just delete from primary
          try {
            await cal.events.delete({
              calendarId: primaryCal.id,
              eventId: event.id
            });
            moved++;
            console.log(`[Calendar] Removed duplicate school event from primary: "${title}"`);
          } catch (err) {
            errors.push(`Failed to delete "${title}": ${err.message}`);
          }
          continue;
        }

        // Copy to school calendar, then delete from primary
        try {
          const newEvent = {
            summary: event.summary,
            description: event.description || 'Moved from personal calendar by Daily Briefing',
            start: event.start,
            end: event.end,
            location: event.location || null,
            recurrence: event.recurrence || null,
            reminders: event.reminders || null
          };
          await cal.events.insert({
            calendarId: schoolCal.id,
            requestBody: newEvent
          });
          await cal.events.delete({
            calendarId: primaryCal.id,
            eventId: event.id
          });
          moved++;
          console.log(`[Calendar] Moved "${title}" → school calendar`);
        } catch (err) {
          errors.push(`Failed to move "${title}": ${err.message}`);
        }
      }

      console.log(`[Calendar] Move complete: ${moved} moved, ${skipped} skipped, ${errors.length} errors`);
      return { moved, skipped, errors };
    } catch (err) {
      console.error('[Calendar] moveSchoolEvents failed:', err.message);
      return { moved: 0, skipped: 0, errors: [], error: err.message };
    }
  }
}
