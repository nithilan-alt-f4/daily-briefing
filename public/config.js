/**
 * config.js — Non-secret app constants.
 * Loaded before app.js via <script> tag in index.html.
 * Secrets (PAT, API keys) live in SecureStorage, set at runtime.
 */
window.AppConfig = {
  // GitHub repo for data fetch
  GITHUB_OWNER: 'nithilan-alt-f4',
  GITHUB_REPO: 'daily-briefing',
  DATA_BRANCH: 'data',
  DATA_FILE: 'briefing-data.json',

  // How long to trust cached briefing data (ms)
  DATA_CACHE_TTL: 6 * 60 * 60 * 1000, // 6 hours

  // Google OAuth web client ID (from Google Cloud Console, Web application type)
  // Set this before first launch
  GOOGLE_WEB_CLIENT_ID: '82787230727-nef3mjbg3vq6egrcdr7g6ft2uk3jpoae.apps.googleusercontent.com',

  // Google Calendar scopes
  GOOGLE_SCOPES: ['https://www.googleapis.com/auth/calendar'],

  // SecureStorage key names
  KEYS: {
    PAT: 'github_pat',
    PAT_EXPIRY: 'github_pat_expiry',
    GROQ_KEY: 'groq_api_key',
    GEMINI_KEY: 'gemini_api_key',
    NEWS_KEY: 'news_api_key',
    GOOGLE_TOKENS: 'google_calendar_tokens',
  },

  // Bangalore coordinates for weather
  LAT: 13.1007,
  LON: 77.5963,

  // App version
  VERSION: '3.0.0',
};
