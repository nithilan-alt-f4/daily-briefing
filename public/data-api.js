/**
 * data-api.js — Fetches briefing data from GitHub + localStorage cache.
 * Uses Accept: application/vnd.github.raw to get raw JSON (no base64 decode).
 * PAT comes from SecureStore (SecureStorage).
 *
 * Loaded before app.js via <script> tag in index.html.
 * Exposes window.DataAPI globally.
 */
(function () {
  'use strict';

  var CFG = window.AppConfig;
  var CACHE_KEY = 'briefing_data';
  var CACHE_AT_KEY = 'briefing_data_at';

  // ---------- Error types ----------
  // Phase 4 UI needs to distinguish "you haven't configured this yet" from
  // "GitHub is unreachable". We attach a .code property to errors.

  function patNotSetError() {
    var err = new Error('PAT_NOT_SET: GitHub PAT not configured');
    err.code = 'PAT_NOT_SET';
    return err;
  }

  function networkError(cause) {
    var err = new Error('NETWORK_ERROR: ' + (cause.message || cause));
    err.code = 'NETWORK_ERROR';
    err.cause = cause;
    return err;
  }

  // ---------- GitHub fetch ----------

  function fetchFromGitHub(pat) {
    var url = 'https://api.github.com/repos/' +
      CFG.GITHUB_OWNER + '/' + CFG.GITHUB_REPO +
      '/contents/' + CFG.DATA_FILE + '?ref=' + CFG.DATA_BRANCH;

    return fetch(url, {
      headers: {
        Authorization: 'Bearer ' + pat,
        Accept: 'application/vnd.github.raw'
      }
    }).then(function (res) {
      if (!res.ok) throw new Error('GitHub ' + res.status + ' ' + res.statusText);
      return res.json();
    });
  }

  // ---------- Cache read/write ----------

  function readCache() {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      var at = parseInt(localStorage.getItem(CACHE_AT_KEY) || '0', 10);
      if (raw && at) {
        return { data: JSON.parse(raw), savedAt: at };
      }
    } catch (e) { /* corrupt cache, ignore */ }
    return null;
  }

  function writeCache(data) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(data));
      localStorage.setItem(CACHE_AT_KEY, String(Date.now()));
    } catch (e) { /* storage full, ignore */ }
  }

  function isCacheFresh() {
    var cached = readCache();
    if (!cached || !cached.savedAt) return false;
    return (Date.now() - cached.savedAt) < CFG.DATA_CACHE_TTL;
  }

  // ---------- Public API ----------

  /**
   * Get briefing data.
   *
   * Fetch strategy (fetch-or-fallback, NOT stale-while-revalidate):
   * 1. If cache is fresh (< DATA_CACHE_TTL), return it immediately. No network request.
   * 2. If cache is stale or missing, wait for GitHub fetch.
   * 3. If fetch succeeds, update cache and return fresh data.
   * 4. If fetch fails but stale cache exists, return stale cache (app still works).
   * 5. If fetch fails and no cache, throw.
   *
   * Phase 4 note: the promise ALWAYS resolves with data (or rejects).
   * There is no background revalidation — the caller blocks until fresh data
   * or stale fallback. This is intentional: simpler, no race conditions, and
   * the user sees updated data on the very next interaction that triggers this.
   *
   * Returns: { syncedAt, items: { assignments, notifications, circulars, schoolCalendar, emails } }
   */
  function getBriefingData() {
    // If cache is fresh, return it immediately
    var cached = readCache();
    if (cached && (Date.now() - cached.savedAt) < CFG.DATA_CACHE_TTL) {
      return Promise.resolve(cached.data);
    }

    // Fetch from GitHub
    return SecureStore.getGitHubPAT().then(function (pat) {
      if (!pat) throw patNotSetError();
      return fetchFromGitHub(pat);
    }).then(function (data) {
      writeCache(data);
      return data;
    }).catch(function (err) {
      console.error('[DataAPI] Fetch failed:', err.message);
      // PAT not set → throw immediately (Phase 4 shows setup screen)
      if (err.code === 'PAT_NOT_SET') throw err;
      // Network/server error → return stale cache if available
      if (cached) return cached.data;
      throw networkError(err);
    });
  }

  /**
   * Force-refresh from GitHub, ignoring cache TTL.
   * Same error handling as getBriefingData.
   */
  function refreshBriefingData() {
    return SecureStore.getGitHubPAT().then(function (pat) {
      if (!pat) throw patNotSetError();
      return fetchFromGitHub(pat);
    }).then(function (data) {
      writeCache(data);
      return data;
    }).catch(function (err) {
      if (err.code === 'PAT_NOT_SET') throw err;
      throw networkError(err);
    });
  }

  // ---------- Item helpers ----------
  // Map MongoDB _id to id for frontend compatibility

  function mapItem(doc) {
    if (!doc) return null;
    var item = Object.assign({}, doc);
    item.id = doc._id || doc.id;
    delete item._id;
    return item;
  }

  function mapItems(arr) {
    return (arr || []).map(mapItem);
  }

  function getAssignments() {
    return getBriefingData().then(function (d) {
      return mapItems(d.items && d.items.assignments);
    });
  }

  function getNotifications() {
    return getBriefingData().then(function (d) {
      return mapItems(d.items && d.items.notifications);
    });
  }

  function getCirculars() {
    return getBriefingData().then(function (d) {
      return mapItems(d.items && d.items.circulars);
    });
  }

  function getSchoolCalendar() {
    return getBriefingData().then(function (d) {
      return mapItems(d.items && d.items.schoolCalendar);
    });
  }

  function getEmails() {
    return getBriefingData().then(function (d) {
      return mapItems(d.items && d.items.emails);
    });
  }

  function getAllItems() {
    return getBriefingData().then(function (d) {
      if (!d.items) return [];
      var all = [];
      Object.keys(d.items).forEach(function (key) {
        all = all.concat(mapItems(d.items[key]));
      });
      return all;
    });
  }

  /**
   * Find a single item by id across all collections.
   */
  function getItemById(id) {
    return getAllItems().then(function (items) {
      return items.find(function (i) { return i.id === id; }) || null;
    });
  }

  /**
   * Remove an item from the local cache (view-only delete).
   * Reappears on next sync from GitHub.
   */
  function deleteItemFromCache(id) {
    var cached = readCache();
    if (!cached || !cached.data || !cached.data.items) return;
    Object.keys(cached.data.items).forEach(function (key) {
      cached.data.items[key] = cached.data.items[key].filter(function (item) {
        return (item._id || item.id) !== id;
      });
    });
    writeCache(cached.data);
  }

  /**
   * Get the raw cached data (for debugging / rendering).
   */
  function getCachedData() {
    return readCache();
  }

  /**
   * Get cache age in human-readable text.
   */
  function getCacheAgeText() {
    var cached = readCache();
    if (!cached || !cached.savedAt) return null;
    var diff = Date.now() - cached.savedAt;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    return Math.floor(diff / 86400000) + 'd ago';
  }

  // ---------- GitHub Actions workflow dispatch ----------

  /**
   * Trigger a GitHub Actions workflow_dispatch (e.g. for calendar writes, NPS sync).
   * Uses the user's own PAT with repo scope.
   * @param {string} workflow - workflow filename (e.g. 'sync.yml')
   * @param {Object} inputs - optional inputs payload
   */
  function triggerWorkflow(workflow, inputs) {
    return SecureStore.getGitHubPAT().then(function (pat) {
      if (!pat) throw patNotSetError();
      var url = 'https://api.github.com/repos/' +
        CFG.GITHUB_OWNER + '/' + CFG.GITHUB_REPO +
        '/actions/workflows/' + (workflow || 'sync.yml') + '/dispatches';
      return fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + pat,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28'
        },
        body: JSON.stringify({ ref: 'master', inputs: inputs || {} })
      }).then(function (res) {
        if (!res.ok) throw new Error('Workflow dispatch failed: ' + res.status);
        return { success: true };
      });
    });
  }

  // ---------- Expose globally ----------

  window.DataAPI = {
    getBriefingData: getBriefingData,
    refreshBriefingData: refreshBriefingData,
    getAssignments: getAssignments,
    getNotifications: getNotifications,
    getCirculars: getCirculars,
    getSchoolCalendar: getSchoolCalendar,
    getEmails: getEmails,
    getAllItems: getAllItems,
    getItemById: getItemById,
    deleteItemFromCache: deleteItemFromCache,
    getCachedData: getCachedData,
    getCacheAgeText: getCacheAgeText,
    isCacheFresh: isCacheFresh,
    triggerWorkflow: triggerWorkflow,
  };
})();
