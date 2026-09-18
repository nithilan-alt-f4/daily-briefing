/**
 * calendar.js — Client-side Google Calendar via REST API.
 * Uses @capawesome/capacitor-google-sign-in for native OAuth flow.
 * Tokens stored in SecureStore. All calendar ops are direct REST calls.
 *
 * Plugin API: GoogleSignIn.initialize({ clientId, scopes }) → GoogleSignIn.signIn()
 * On web: signIn() redirects, handleRedirectCallback() completes the flow.
 *
 * Exposes window.CalendarAPI globally.
 */
(function () {
  'use strict';

  var CFG = window.AppConfig;
  var CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
  var SCOPES = CFG.GOOGLE_SCOPES;

  // --- State ---
  var _tokens = null;   // { accessToken, refreshToken, expiresAt }
  var _connected = false;
  var _plugin = null;   // GoogleSignIn plugin reference
  var _initialized = false;

  // --- Plugin detection ---

  function getPlugin() {
    if (_plugin) return _plugin;
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.GoogleSignIn) {
      _plugin = window.Capacitor.Plugins.GoogleSignIn;
      return _plugin;
    }
    return null;
  }

  function isNative() {
    return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  }

  /**
   * Initialize the plugin. Must be called once before signIn().
   */
  function ensureInitialized() {
    if (_initialized) return Promise.resolve();
    var plugin = getPlugin();
    if (!plugin || !plugin.initialize) {
      _initialized = true;
      return Promise.resolve();
    }
    return plugin.initialize({
      clientId: CFG.GOOGLE_WEB_CLIENT_ID,
      scopes: SCOPES
    }).then(function () {
      _initialized = true;
      console.log('[Calendar] GoogleSignIn plugin initialized');
    }).catch(function (err) {
      console.warn('[Calendar] GoogleSignIn initialize failed:', err.message);
      _initialized = true; // Don't retry
    });
  }

  // --- Token management ---

  function saveTokens(tokens) {
    _tokens = tokens;
    _connected = !!(tokens && tokens.accessToken);
    return SecureStore.setGoogleTokens(tokens);
  }

  function loadTokens() {
    return SecureStore.getGoogleTokens().then(function (tokens) {
      _tokens = tokens;
      _connected = !!(tokens && tokens.accessToken);
      return tokens;
    });
  }

  function isTokenExpired() {
    if (!_tokens || !_tokens.expiresAt) return true;
    return Date.now() > (_tokens.expiresAt - 60000); // 1 min buffer
  }

  /**
   * Attempt silent re-authentication via the plugin.
   * On Android, Google Sign-In SDK caches credentials and can silently
   * re-issue an access token without showing the account picker
   * (if the user previously authorized and the token wasn't revoked).
   *
   * This replaces the refresh_token endpoint (which requires client_secret
   * for Web client types and therefore can't run client-side).
   */
  function reAuthenticate() {
    var plugin = getPlugin();
    if (plugin && plugin.signIn) {
      return ensureInitialized().then(function () {
        return plugin.signIn();
      }).then(function (result) {
        if (result.serverAuthCode) {
          return exchangeServerAuthCode(result.serverAuthCode);
        }
        if (result.accessToken) {
          return saveTokens({
            accessToken: result.accessToken,
            refreshToken: result.refreshToken || (_tokens && _tokens.refreshToken) || null,
            expiresAt: Date.now() + 3600 * 1000
          });
        }
        throw new Error('Silent re-auth: no accessToken in result');
      });
    }
    // Web fallback: try refresh_token endpoint (may need client_secret)
    if (_tokens && _tokens.refreshToken) {
      var params = new URLSearchParams({
        client_id: CFG.GOOGLE_WEB_CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: _tokens.refreshToken
      });
      return fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
      })
        .then(function (res) {
          if (!res.ok) throw new Error('Refresh failed HTTP ' + res.status);
          return res.json();
        })
        .then(function (data) {
          return saveTokens({
            accessToken: data.access_token,
            refreshToken: data.refresh_token || _tokens.refreshToken,
            expiresAt: Date.now() + (data.expires_in || 3600) * 1000
          });
        });
    }
    return Promise.reject(new Error('No re-auth method available'));
  }

  /**
   * Get a valid access token. Tries silent re-auth if expired.
   */
  function getAccessToken() {
    if (_tokens && _tokens.accessToken && !isTokenExpired()) {
      return Promise.resolve(_tokens.accessToken);
    }
    return reAuthenticate().then(function () {
      return _tokens.accessToken;
    }).catch(function (err) {
      console.warn('[Calendar] Re-auth failed, marking disconnected:', err.message);
      _connected = false;
      throw err;
    });
  }

  // --- OAuth sign-in ---

  /**
   * Start Google OAuth flow.
   * On native: uses @capawesome/capacitor-google-sign-in plugin.
   * On web: falls back to manual redirect-based OAuth.
   */
  function signIn() {
    var plugin = getPlugin();

    if (plugin && plugin.signIn) {
      // Native path: @capawesome/capacitor-google-sign-in
      return ensureInitialized().then(function () {
        return plugin.signIn();
      }).then(function (result) {
        // result: { idToken, accessToken, serverAuthCode, userId, email, displayName, ... }
        // Note: on native, accessToken is an OAuth access token if scopes were requested.

        // If we got a serverAuthCode, exchange it for proper OAuth tokens
        if (result.serverAuthCode) {
          return exchangeServerAuthCode(result.serverAuthCode);
        }

        // If we got an accessToken directly (scopes were requested in initialize)
        if (result.accessToken) {
          var tokens = {
            accessToken: result.accessToken,
            refreshToken: result.refreshToken || null,
            expiresAt: Date.now() + 3600 * 1000 // default 1hr, will refresh
          };
          return saveTokens(tokens);
        }

        // If we only got an idToken, we can't use it for Calendar API
        // (idToken is for auth, not API access). Need serverAuthCode.
        if (result.idToken && !result.accessToken) {
          throw new Error('Got idToken but no accessToken. Ensure scopes are passed in initialize().');
        }

        throw new Error('No tokens received from Google Sign-In');
      });
    }

    // Web fallback: redirect-based OAuth
    return signInRedirect();
  }

  /**
   * Exchange authorization code for access + refresh tokens.
   */
  function exchangeServerAuthCode(code) {
    var params = new URLSearchParams({
      code: code,
      client_id: CFG.GOOGLE_WEB_CLIENT_ID,
      grant_type: 'authorization_code',
      redirect_uri: 'http://localhost'
    });

    return fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    })
      .then(function (res) {
        if (!res.ok) throw new Error('Token exchange failed HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        var tokens = {
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
          expiresAt: Date.now() + (data.expires_in || 3600) * 1000
        };
        return saveTokens(tokens);
      });
  }

  /**
   * Redirect-based OAuth flow (web preview only).
   */
  function signInRedirect() {
    var redirectUri = window.location.origin + window.location.pathname;
    var authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' +
      'client_id=' + encodeURIComponent(CFG.GOOGLE_WEB_CLIENT_ID) +
      '&redirect_uri=' + encodeURIComponent(redirectUri) +
      '&response_type=code' +
      '&scope=' + encodeURIComponent(SCOPES.join(' ')) +
      '&prompt=consent' +
      '&access_type=offline';

    window.location.href = authUrl;
    return Promise.reject(new Error('Redirecting to Google...'));
  }

  /**
   * Handle redirect callback: extract code from URL and exchange for tokens.
   * Must be called on app load for web platform.
   */
  function handleRedirectCallback() {
    var plugin = getPlugin();

    // On native, the plugin handles the redirect internally
    if (plugin && plugin.handleRedirectCallback && isNative()) {
      return plugin.handleRedirectCallback().then(function (result) {
        if (result && result.serverAuthCode) {
          return exchangeServerAuthCode(result.serverAuthCode);
        }
        if (result && result.accessToken) {
          return saveTokens({
            accessToken: result.accessToken,
            refreshToken: result.refreshToken || null,
            expiresAt: Date.now() + 3600 * 1000
          });
        }
        return null;
      }).catch(function () { return null; });
    }

    // Web manual redirect handling
    var params = new URLSearchParams(window.location.search);
    var code = params.get('code');
    var error = params.get('error');
    if (error) {
      return Promise.reject(new Error('Google OAuth error: ' + error));
    }
    if (!code) {
      return Promise.resolve(null); // No code in URL
    }
    // Clean URL
    window.history.replaceState({}, '', window.location.pathname);
    return exchangeServerAuthCode(code);
  }

  /**
   * Sign out: clear tokens and call plugin signOut if available.
   */
  function signOut() {
    _tokens = null;
    _connected = false;
    var plugin = getPlugin();
    var p = (plugin && plugin.signOut) ? plugin.signOut() : Promise.resolve();
    return p.then(function () {
      return SecureStore.removeGoogleTokens();
    });
  }

  // --- Calendar REST API ---

  /**
   * Make an authenticated request to Google Calendar API.
   */
  function gcalFetch(path, opts) {
    return getAccessToken().then(function (token) {
      var url = CALENDAR_API + path;
      var headers = Object.assign({
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      }, (opts && opts.headers) || {});
      return fetch(url, Object.assign({}, opts, { headers: headers }));
    }).then(function (res) {
      if (res.status === 401) {
        // Token might be revoked — try re-auth once
        return reAuthenticate().then(function () {
          return getAccessToken();
        }).then(function (token) {
          var url = CALENDAR_API + path;
          return fetch(url, Object.assign({}, opts, {
            headers: {
              'Authorization': 'Bearer ' + token,
              'Content-Type': 'application/json'
            }
          }));
        });
      }
      return res;
    });
  }

  function gcalFetchJson(path, opts) {
    return gcalFetch(path, opts).then(function (res) {
      if (!res.ok) throw new Error('Calendar API ' + res.status);
      return res.json();
    });
  }

  // --- Public API ---

  /**
   * List all calendars.
   */
  function listCalendars() {
    return gcalFetchJson('/users/me/calendarList').then(function (data) {
      return (data.items || []).map(function (c) {
        return { id: c.id, name: c.summary, primary: c.primary };
      });
    });
  }

  /**
   * Fetch events from all non-holiday calendars in a time range.
   */
  function fetchEventsInRange(start, end, maxPerCalendar) {
    maxPerCalendar = maxPerCalendar || 60;
    return listCalendars().then(function (cals) {
      var targets = cals.filter(function (c) {
        return !/holidays in india/i.test(c.name || '');
      });

      var promises = targets.map(function (cal) {
        var params = new URLSearchParams({
          timeMin: start instanceof Date ? start.toISOString() : start,
          timeMax: end instanceof Date ? end.toISOString() : end,
          maxResults: String(maxPerCalendar),
          singleEvents: 'true',
          orderBy: 'startTime'
        });
        return gcalFetchJson('/calendars/' + encodeURIComponent(cal.id) + '/events?' + params.toString())
          .then(function (data) {
            return (data.items || []).map(function (e) {
              return {
                id: e.id,
                title: e.summary || '(no title)',
                start: (e.start && (e.start.dateTime || e.start.date)) || '',
                end: (e.end && (e.end.dateTime || e.end.date)) || '',
                location: e.location || null,
                isAllDay: !!(e.start && e.start.date),
                calendarName: cal.name || cal.id,
                isBirthday: /\b(birthday|bday)\b/i.test(e.summary || '') || !!(e.recurrence && e.recurrence.length)
              };
            });
          })
          .catch(function (err) {
            console.error('[Calendar] Failed to read "' + cal.name + '":', err.message);
            return [];
          });
      });

      return Promise.all(promises).then(function (arrays) {
        var all = [];
        arrays.forEach(function (arr) { all = all.concat(arr); });

        // Dedup: prefer school calendar over primary for same title+time
        var seen = {};
        var deduped = [];
        for (var i = 0; i < all.length; i++) {
          var e = all[i];
          var key = (e.title || '').toLowerCase().trim() + '|' + e.start;
          var existing = seen[key];
          if (!existing) {
            seen[key] = e;
            deduped.push(e);
          } else {
            var isSchool = /school/i.test(e.calendarName || '');
            var existingIsSchool = /school/i.test(existing.calendarName || '');
            if (isSchool && !existingIsSchool) {
              var idx = deduped.indexOf(existing);
              if (idx >= 0) deduped[idx] = e;
              seen[key] = e;
            }
          }
        }
        return deduped;
      });
    });
  }

  /**
   * Fetch upcoming events (convenience wrapper).
   */
  function fetchUpcomingEvents(maxResults, daysAhead) {
    maxResults = maxResults || 10;
    daysAhead = daysAhead || 14;
    var now = new Date();
    var later = new Date(now.getTime() + daysAhead * 86400000);
    return fetchEventsInRange(now, later, maxResults);
  }

  /**
   * Create a calendar event.
   */
  function createEvent(eventBody, calendarId) {
    calendarId = calendarId || 'primary';
    return gcalFetchJson(
      '/calendars/' + encodeURIComponent(calendarId) + '/events',
      {
        method: 'POST',
        body: JSON.stringify(eventBody)
      }
    ).then(function (result) {
      return { id: result.id, link: result.htmlLink };
    });
  }

  // --- Expose globally ---

  window.CalendarAPI = {
    signIn: signIn,
    signOut: signOut,
    handleRedirectCallback: handleRedirectCallback,
    loadTokens: loadTokens,
    isConnected: function () { return _connected; },
    listCalendars: listCalendars,
    fetchEventsInRange: fetchEventsInRange,
    fetchUpcomingEvents: fetchUpcomingEvents,
    createEvent: createEvent
  };
})();
