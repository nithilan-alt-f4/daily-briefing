/**
 * news.js — Client-side news fetch (NewsAPI + Google News RSS).
 * Extracted from src/connectors/news.js. Pure HTTP, no server needed.
 *
 * Exposes window.NewsAPI globally.
 */
(function () {
  'use strict';

  var RSS_TOPICS = ['India', 'world news today', 'technology', 'education India'];

  function cleanEntities(str) {
    return str
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/<[^>]*>/g, '').trim();
  }

  function extractTag(xml, tag) {
    var regex = new RegExp('<' + tag + '[^>]*>(?:<!\\[CDATA\\[)?(.*?)(?:\\]\\]>)?<\\/' + tag + '>', 's');
    var match = xml.match(regex);
    return match ? match[1].trim() : '';
  }

  function fetchTopHeadlines(apiKey) {
    if (!apiKey) return Promise.resolve([]);
    var url = 'https://newsapi.org/v2/top-headlines?country=in&pageSize=15&apiKey=' + apiKey;
    return fetch(url, { signal: AbortSignal.timeout(10000) })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.status !== 'ok') throw new Error(data.message || 'unknown');
        return (data.articles || []).map(function (a) {
          return {
            title: a.title || '',
            description: a.description || '',
            source: (a.source && a.source.name) || '',
            url: a.url || '',
            publishedAt: a.publishedAt || new Date().toISOString(),
            topic: 'top-headlines'
          };
        });
      })
      .catch(function (err) {
        console.error('[News] Top-headlines failed:', err.message);
        return [];
      });
  }

  function fetchFromRSS(topic, count) {
    count = count || 4;
    var feedUrl = 'https://news.google.com/rss/search?q=' + encodeURIComponent(topic) + '&hl=en-IN&gl=IN&ceid=IN:en';
    return fetch(feedUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) })
      .then(function (res) { return res.text(); })
      .then(function (xml) {
        var articles = [];
        var itemRegex = /<item>([\s\S]*?)<\/item>/g;
        var match;
        while ((match = itemRegex.exec(xml)) !== null && articles.length < count) {
          var itemXml = match[1];
          var title = cleanEntities(extractTag(itemXml, 'title'));
          var link = extractTag(itemXml, 'link');
          var pubDate = extractTag(itemXml, 'pubDate');
          var sourceTag = itemXml.match(/<source[^>]*>([\s\S]*?)<\/source>/);
          if (title) {
            articles.push({
              title: title,
              description: '',
              source: sourceTag ? sourceTag[1].trim() : 'Google News',
              url: link,
              publishedAt: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
              topic: topic
            });
          }
        }
        return articles;
      })
      .catch(function (err) {
        console.error('[News] RSS "' + topic + '" failed:', err.message);
        return [];
      });
  }

  function dedupe(articles) {
    var seen = {};
    return articles.filter(function (a) {
      var key = (a.title || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').substring(0, 60);
      if (!key || seen[key]) return false;
      seen[key] = true;
      return true;
    });
  }

  /**
   * Fetch all news: NewsAPI headlines + Google News RSS.
   * Returns array of { title, description, source, url, publishedAt, topic }.
   * newsKey can be null/undefined — skips NewsAPI, RSS still works.
   */
  function fetchNews(newsKey) {
    return fetchTopHeadlines(newsKey).then(function (headlines) {
      var rssPromises = RSS_TOPICS.map(function (topic) {
        return fetchFromRSS(topic, 3);
      });
      return Promise.all(rssPromises).then(function (rssArrays) {
        var all = headlines;
        rssArrays.forEach(function (rss) { all = all.concat(rss); });
        return dedupe(all).slice(0, 20);
      });
    });
  }

  window.NewsAPI = { fetch: fetchNews };
})();
