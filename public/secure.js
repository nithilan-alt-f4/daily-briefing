/**
 * secure.js — SecureStorage wrapper for secrets + token management.
 * Uses capacitor-secure-storage-plugin (accessed via window.Capacitor.Plugins).
 * Loaded before app.js via <script> tag in index.html.
 *
 * On web (no native bridge), falls back to localStorage with a warning.
 */
(function () {
  'use strict';

  var KEYS = window.AppConfig.KEYS;
  var PLUGIN = function () {
    return window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.SecureStoragePlugin;
  };

  // Detect platform
  var isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

  // ---------- Generic helpers ----------

  function secureGet(key) {
    var plugin = PLUGIN();
    if (plugin) {
      return plugin.get({ key: key }).then(function (r) { return r.value; }).catch(function () { return null; });
    }
    // Web fallback
    return Promise.resolve(localStorage.getItem('cap_sec_' + key));
  }

  function secureSet(key, value) {
    var plugin = PLUGIN();
    if (plugin) {
      return plugin.set({ key: key, value: String(value) });
    }
    // Web fallback
    localStorage.setItem('cap_sec_' + key, String(value));
    return Promise.resolve();
  }

  function secureRemove(key) {
    var plugin = PLUGIN();
    if (plugin) {
      return plugin.remove({ key: key }).catch(function () {});
    }
    localStorage.removeItem('cap_sec_' + key);
    return Promise.resolve();
  }

  // ---------- GitHub PAT ----------

  function getGitHubPAT() {
    return secureGet(KEYS.PAT);
  }

  function setGitHubPAT(pat) {
    return secureSet(KEYS.PAT, pat);
  }

  function getGitHubPATExpiry() {
    return secureGet(KEYS.PAT_EXPIRY).then(function (val) {
      return val ? new Date(val) : null;
    });
  }

  function setGitHubPATExpiry(date) {
    return secureSet(KEYS.PAT_EXPIRY, date.toISOString());
  }

  function isPATExpired() {
    return getGitHubPATExpiry().then(function (expiry) {
      if (!expiry) return false; // no expiry set = assume valid
      return Date.now() > expiry.getTime();
    });
  }

  // ---------- API Keys ----------

  function getGroqKey() { return secureGet(KEYS.GROQ_KEY); }
  function setGroqKey(key) { return secureSet(KEYS.GROQ_KEY, key); }

  function getGeminiKey() { return secureGet(KEYS.GEMINI_KEY); }
  function setGeminiKey(key) { return secureSet(KEYS.GEMINI_KEY, key); }

  function getNewsKey() { return secureGet(KEYS.NEWS_KEY); }
  function setNewsKey(key) { return secureSet(KEYS.NEWS_KEY, key); }

  // ---------- Google Calendar Tokens ----------

  // Token structure: { accessToken, refreshToken, expiresAt }

  function getGoogleTokens() {
    return secureGet(KEYS.GOOGLE_TOKENS).then(function (raw) {
      if (!raw) return null;
      try { return JSON.parse(raw); } catch (e) { return null; }
    });
  }

  function setGoogleTokens(tokens) {
    return secureSet(KEYS.GOOGLE_TOKENS, JSON.stringify(tokens));
  }

  function removeGoogleTokens() {
    return secureRemove(KEYS.GOOGLE_TOKENS);
  }

  function isGoogleTokenExpired() {
    return getGoogleTokens().then(function (tokens) {
      if (!tokens) return true;
      return Date.now() > (tokens.expiresAt || 0) - 60000;
    });
  }

  // ---------- Setup helpers ----------

  function isFirstLaunch() {
    return getGitHubPAT().then(function (pat) { return !pat; });
  }

  function validateConfig() {
    return Promise.all([getGitHubPAT(), getGroqKey()]).then(function (results) {
      var pat = results[0];
      var groq = results[1];
      var missing = [];
      if (!pat) missing.push('GitHub PAT');
      if (!groq) missing.push('Groq API Key');
      return { valid: missing.length === 0, missing: missing };
    });
  }

  // ---------- Expose globally ----------

  window.SecureStore = {
    getGitHubPAT: getGitHubPAT,
    setGitHubPAT: setGitHubPAT,
    getGitHubPATExpiry: getGitHubPATExpiry,
    setGitHubPATExpiry: setGitHubPATExpiry,
    isPATExpired: isPATExpired,
    getGroqKey: getGroqKey,
    setGroqKey: setGroqKey,
    getGeminiKey: getGeminiKey,
    setGeminiKey: setGeminiKey,
    getNewsKey: getNewsKey,
    setNewsKey: setNewsKey,
    getGoogleTokens: getGoogleTokens,
    setGoogleTokens: setGoogleTokens,
    removeGoogleTokens: removeGoogleTokens,
    isGoogleTokenExpired: isGoogleTokenExpired,
    isFirstLaunch: isFirstLaunch,
    validateConfig: validateConfig,
    isNative: isNative,
  };

  if (!isNative) {
    console.warn('[SecureStore] Running in web mode — secrets stored in localStorage (insecure). This is fine for development.');
  }
})();
