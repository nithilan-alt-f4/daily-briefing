import 'dotenv/config';

export const config = {
  port: process.env.PORT || 3000,
  mongoUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/nps-dashboard',
  groqApiKey: process.env.GROQ_API_KEY || '',
  newsApiKey: process.env.NEWS_API_KEY || '',
  gcal: {
    clientId: process.env.GCAL_CLIENT_ID || '',
    clientSecret: process.env.GCAL_CLIENT_SECRET || '',
    calendarId: process.env.GCAL_CALENDAR_ID || 'primary'
  },
  nps: {
    portalUrl: process.env.NPS_PORTAL_URL || 'https://parent.npsnorthacadamis.com/',
    username: process.env.NPS_USERNAME || '',
    password: process.env.NPS_PASSWORD || ''
  }
};

export function validateConfig() {
  const problems = [];
  if (!config.nps.username) problems.push('NPS_USERNAME missing');
  if (!config.nps.password) problems.push('NPS_PASSWORD missing');
  if (!config.groqApiKey) problems.push('GROQ_API_KEY missing (summarization will be skipped)');
  return problems;
}
