import { Item } from '../models/Item.js';

const SEARCH_TOPICS = [
  'Donald Trump',
  'Narendra Modi',
  'D.K. Shivakumar',
  'Joseph Vijay TVK',
  'Abhijeet Dipke'
];

export class NewsConnector {
  constructor(config) {
    this.enabled = !!config.newsApiKey;
    this.newsApiKey = config.newsApiKey;
  }

  async fetchFromNewsAPI(topic, pageSize = 4) {
    const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(topic)}&language=en&sortBy=publishedAt&pageSize=${pageSize}&apiKey=${this.newsApiKey}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.status !== 'ok') throw new Error(`NewsAPI: ${data.message || 'unknown error'}`);
    return (data.articles || []).map(a => ({
      title: a.title,
      description: a.description,
      content: a.content,
      source: a.source?.name || '',
      url: a.url,
      publishedAt: a.publishedAt,
      topic
    }));
  }

  async fetchFromGoogleNewsRSS(topic, count = 4) {
    const feedUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(topic)}&hl=en-IN&gl=IN&ceid=IN:en`;
    const res = await fetch(feedUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const xml = await res.text();

    const articles = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(xml)) !== null && articles.length < count) {
      const itemXml = match[1];
      const title = this._extractTag(itemXml, 'title');
      const link = this._extractTag(itemXml, 'link');
      const pubDate = this._extractTag(itemXml, 'pubDate');
      const sourceTag = itemXml.match(/<source[^>]*>([\s\S]*?)<\/source>/);
      if (title) {
        articles.push({
          title: this._cleanEntities(title),
          description: '',
          content: '',
          source: sourceTag ? sourceTag[1].trim() : 'Google News',
          url: link,
          publishedAt: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
          topic
        });
      }
    }
    return articles;
  }

  _extractTag(xml, tag) {
    const regex = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?(.*?)(?:\\]\\]>)?<\\/${tag}>`, 's');
    const match = xml.match(regex);
    return match ? match[1].trim() : '';
  }

  _cleanEntities(str) {
    return str
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/<[^>]*>/g, '')
      .trim();
  }

  _dedupe(articles) {
    const seen = new Set();
    return articles.filter(a => {
      const key = (a.title || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').substring(0, 60);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  async sync() {
    // News is ephemeral: wipe anything older than today
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    await Item.deleteMany({ source: 'news', createdAt: { $lt: today } });

    let articles = [];
    for (const topic of SEARCH_TOPICS) {
      try {
        const [api, rss] = await Promise.all([
          this.fetchFromNewsAPI(topic),
          this.fetchFromGoogleNewsRSS(topic)
        ]);
        articles.push(...api, ...rss);
      } catch (err) {
        console.error(`[News] "${topic}" failed:`, err.message);
      }
    }

    articles = this._dedupe(articles).slice(0, 20);

    const saved = [];
    for (const a of articles) {
      const doc = await Item.findOneAndUpdate(
        { source: 'news', type: 'news', externalId: `news:${a.title.substring(0, 100)}` },
        {
          $setOnInsert: {
            source: 'news',
            type: 'news',
            externalId: `news:${a.title.substring(0, 100)}`,
            title: a.title,
            content: a.description || a.content || a.title,
            postedDate: a.publishedAt ? new Date(a.publishedAt) : new Date(),
            priority: 'low',
            metadata: { sourceName: a.source, url: a.url, topic: a.topic }
          }
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      if (doc?.createdAt && Date.now() - doc.createdAt.getTime() < 10000) saved.push(doc);
    }
    return saved;
  }
}
