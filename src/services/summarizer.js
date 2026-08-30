import Groq from 'groq-sdk';
import { Item } from '../models/Item.js';

export class Summarizer {
  constructor(apiKey) {
    this.enabled = !!apiKey;
    if (this.enabled) {
      this.client = new Groq({ apiKey });
      this.model = 'openai/gpt-oss-120b';
    }
  }

  async _chat(prompt, maxTokens = 1500) {
    const response = await this.client.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: this.model,
      max_tokens: maxTokens,
      temperature: 0.3
    });
    let content = response.choices[0]?.message?.content || '';
    content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    return content;
  }

  async summarizeItem(item) {
    if (!this.enabled) return null;
    // NPS items show exact portal text - never AI-summarized
    if (item.source === 'nps') return null;
    try {
      const linkTarget = item.type === 'news' ? 'News' : 'Mail';
      const summary = await this._chat(
        `Summarize this ${item.type} in 1-2 short sentences for a school student. Rules:\n` +
        `- Use **double asterisks** around the 1-2 most important words or names (they will render bold)\n` +
        `- If the text references a specific news story or email subject listed below, wrap its exact title in [[News: ]] or [[Mail: ]] so it becomes a clickable link\n` +
        `- Never use em dashes (the - character). Use commas or periods instead\n` +
        `- Address the student as "you"\n` +
        `Available ${item.type === 'news' ? 'news stories' : 'emails'}: ${item._linkedTitles || '(none)'}\n` +
        `Item:\n${item.title}\n${item.content?.substring(0, 1500)}`
      );
      item.summary = summary || null;
      await Item.updateOne({ _id: item._id }, { summary: item.summary });
      return summary;
    } catch (err) {
      console.error(`[Summarizer] Failed for item ${item._id}:`, err.message);
      return null;
    }
  }

  async summarizeItems(items) {
    // Group pass: give each item the titles of its siblings so summaries can link to them
    for (const item of items) {
      if (item.source === 'nps') continue;
      if (!item.summary) await this.summarizeItem(item);
    }
  }

  async summarizePending(limit = 10) {
    if (!this.enabled) return [];
    const pending = await Item.find({ summary: null, source: { $ne: 'nps' } }).limit(limit);
    // Sibling titles for cross-linking
    const newsTitles = (await Item.find({ type: 'news' }).sort({ createdAt: -1 }).limit(10).lean()).map(i => i.title);
    const emailTitles = (await Item.find({ type: 'email' }).sort({ createdAt: -1 }).limit(10).lean()).map(i => i.title);
    const results = [];
    for (const item of pending) {
      item._linkedTitles = item.type === 'news' ? newsTitles : emailTitles;
      const s = await this.summarizeItem(item);
      if (s) results.push({ id: item._id, summary: s });
    }
    return results;
  }

  async generateBriefingNarrative(briefingData) {
    if (!this.enabled) return null;
    try {
      return await this._chat(
        `You are writing a daily briefing addressed directly to a school student (the user). ` +
        `Write a short natural paragraph (4-5 sentences) telling them what matters today. Rules:\n` +
        `- Use "you" and "your". Never mention parents\n` +
        `- IMPORTANT: if a school notification contains instructions (what to wear, what to bring, timings, deadlines), state them explicitly, e.g. "Wear your sports uniform on Friday"\n` +
        `- Mention the weather and whether they need an umbrella\n` +
        `- Use **double asterisks** around the 1-3 most important words or instructions (they render bold)\n` +
        `- When mentioning a specific news story or email, wrap its exact title in [[News: title]] or [[Mail: title]] so it becomes a link\n` +
        `- NEVER use em dashes (the - character). Use commas, periods or colons instead\n` +
        `- Keep it under 100 words\n` +
        `Data:\n${JSON.stringify(briefingData, null, 2).substring(0, 5000)}`
      );
    } catch (err) {
      console.error('[Summarizer] Briefing narrative failed:', err.message);
      return null;
    }
  }
}
