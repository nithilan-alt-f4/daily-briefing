import { Item } from '../models/Item.js';
import { Settings } from '../models/Settings.js';

export async function buildBriefing(summarizer) {
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  const [assignments, notifications, circulars, emails, news, newToday] = await Promise.all([
    Item.find({ type: 'assignment' }).sort({ createdAt: -1 }).limit(15).lean(),
    Item.find({ type: 'notification' }).sort({ postedDate: -1, createdAt: -1 }).limit(8).lean(),
    Item.find({ type: 'circular' }).sort({ postedDate: -1, createdAt: -1 }).limit(5).lean(),
    Item.find({ type: 'email' }).sort({ postedDate: -1, createdAt: -1 }).limit(5).lean(),
    Item.find({ type: 'news' }).sort({ postedDate: -1, createdAt: -1 }).limit(8).lean(),
    Item.find({ createdAt: { $gte: todayStart } }).countDocuments()
  ]);

  const data = {
    date: now.toISOString().split('T')[0],
    stats: { newToday, assignments: assignments.length, emails: emails.length, news: news.length },
    assignments: assignments.map(a => ({
      id: a._id,
      title: a.title,
      subject: a.metadata?.subject,
      teacher: a.metadata?.teacher,
      summary: a.summary
    })),
    notifications: notifications.map(n => ({
      id: n._id,
      title: n.title,
      summary: n.summary,
      content: n.content,
      postedDate: n.postedDate
    })),
    circulars: circulars.map(c => ({
      id: c._id,
      title: c.title,
      category: c.metadata?.category,
      hasPdf: !!c.metadata?.circularId,
      postedDate: c.postedDate
    })),
    emails: emails.map(e => ({
      id: e._id,
      title: e.title,
      from: e.metadata?.from,
      summary: e.summary,
      gmailUrl: e.metadata?.messageId ? `https://mail.google.com/mail/u/0/#inbox/${e.metadata.messageId}` : null
    })),
    news: news.map(n => ({
      id: n._id,
      title: n.title,
      sourceName: n.metadata?.sourceName,
      url: n.metadata?.url,
      summary: n.summary
    }))
  };

  // Narrative: cached from last sync (generated with weather included).
  // Falls back to a rule-based line if never generated.
  const cached = await Settings.findOne({ key: 'narrative' }).lean();
  if (cached?.value?.text && cached.value.date === data.date) {
    data.narrative = cached.value.text;
  } else if (cached?.value?.text) {
    // stale but still better than nothing
    data.narrative = cached.value.text;
    data.narrativeStale = true;
  } else {
    data.narrative = null;
  }

  return data;
}

// Called during sync: generate and cache the narrative (weather included)
export async function generateAndCacheNarrative(summarizer, weather) {
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  const [notifications, emails, news, events] = await Promise.all([
    Item.find({ type: 'notification', postedDate: { $gte: todayStart } }).limit(6).lean(),
    Item.find({ type: 'email' }).sort({ postedDate: -1 }).limit(3).lean(),
    Item.find({ type: 'news' }).sort({ postedDate: -1 }).limit(5).lean(),
    Item.find({ type: 'holiday', postedDate: { $gte: now, $lte: new Date(now.getTime() + 7 * 86400000) } }).limit(5).lean()
  ]);

  const weatherLine = weather ? `${weather.current.temp}C, ${weather.current.condition}, rain chance ${weather.today?.rainChance ?? 0}%` : 'unavailable';

  const text = await summarizer.generateBriefingNarrative({
    weather: weatherLine,
    // Full notification text so instructions (dress code, timings, what to bring) are visible
    todaySchoolNotifications: notifications.map(n => `${n.title}: ${(n.content || '').substring(0, 300)}`),
    recentEmails: emails.map(e => e.title),
    news: news.map(n => n.title),
    eventsThisWeek: events.map(e => `${e.title} (${(e.metadata?.startDate || e.postedDate || '').slice(0, 10)})`)
  });

  if (text) {
    await Settings.findOneAndUpdate(
      { key: 'narrative' },
      { key: 'narrative', value: { text, date: now.toISOString().split('T')[0] }, updatedAt: now },
      { upsert: true }
    );
  }
  return text;
}
