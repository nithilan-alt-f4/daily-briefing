import { chromium } from 'playwright';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SESSION_PATH = join(__dirname, '../../nps-session.json');
const DOWNLOADS_DIR = join(__dirname, '../../downloads');

export class NPSScraper {
  constructor() {
    this.browser = null;
    this.context = null;
    this.loggedIn = false;
    this.lastLoginAt = null;
    this.lastError = null;

    if (!existsSync(DOWNLOADS_DIR)) mkdirSync(DOWNLOADS_DIR, { recursive: true });
  }

  async _launch() {
    if (!this.browser) {
      this.browser = await chromium.launch({ headless: true });
      const opts = {};
      if (existsSync(SESSION_PATH)) {
        opts.storageState = SESSION_PATH;
      }
      this.context = await this.browser.newContext({
        viewport: { width: 1400, height: 900 },
        ...opts
      });
    }
    return this.context;
  }

  async login(force = false) {
    const ctx = await this._launch();
    const page = await ctx.newPage();

    try {
      await page.goto(config.nps.portalUrl, { waitUntil: 'networkidle', timeout: 45000 });

      if (!force && (await page.$('#username')) === null) {
        this.loggedIn = true;
        await page.close();
        return true;
      }

      console.log('[NPS] Logging in...');
      await page.fill('#username', config.nps.username);
      await page.fill('#password', config.nps.password);
      await page.click('button[type="submit"]');
      await page.waitForTimeout(8000);

      const stillOnLogin = (await page.$('#username')) !== null;
      if (stillOnLogin) {
        throw new Error('Login failed - still on login page (wrong credentials or captcha?)');
      }

      this.loggedIn = true;
      this.lastLoginAt = new Date();
      this.lastError = null;
      const state = await ctx.storageState();
      writeFileSync(SESSION_PATH, JSON.stringify(state));
      console.log('[NPS] Logged in, url:', page.url());
      await page.close();
      return true;
    } catch (err) {
      this.lastError = err.message;
      await page.close().catch(() => {});
      throw err;
    }
  }

  async _ensureLogin() {
    const ctx = await this._launch();
    if (!this.loggedIn) {
      await this.login(false);
    }
    return ctx;
  }

  async _goto(path) {
    const ctx = await this._ensureLogin();
    const page = await ctx.newPage();
    await page.goto(config.nps.portalUrl + path, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(2500);
    if ((await page.$('#username')) !== null) {
      // session expired
      this.loggedIn = false;
      await page.close().catch(() => {});
      await this.login(true);
      return this._goto(path);
    }
    return page;
  }

  async scrapeAssignments() {
    const page = await this._goto('Assignment');
    try {
      const items = await page.evaluate(() => {
        const blocks = document.querySelectorAll('.notification__list');
        return Array.from(blocks).map(block => {
          const title = block.querySelector('.box-body h4')?.innerText?.trim() || '';
          const subject = block.querySelector('.text-orange')?.innerText?.replace('Subject:', '')?.trim() || '';
          const dateEl = block.querySelector('h6');
          const submissionDate = dateEl?.innerText?.replace('Submission Date :', '')?.trim() || '';
          const teacher = block.querySelector('h5')?.innerText?.replace('Teacher :', '')?.trim() || '';
          const description = Array.from(block.querySelectorAll('.box-body p'))
            .map(p => p.innerText.trim())
            .filter(p => p.length > 0)
            .join(' ');
          const downloadUrl = block.querySelector('a.btn.btn-info')?.href || '';
          return { title, subject, submissionDate, teacher, description, downloadUrl };
        }).filter(item => item.title);
      });
      return items;
    } finally {
      await page.close();
    }
  }

  async scrapeNotifications() {
    const page = await this._goto('Notifications');
    try {
      const items = await page.evaluate(() => {
        const blocks = document.querySelectorAll('.notification__list');
        return Array.from(blocks).map(block => {
          const modal = block.querySelector('.modal .modal-body');
          const modalText = modal?.innerText?.trim() || '';
          const cardText = block.querySelector('.box-body')?.innerText?.trim() || '';
          const body = modalText || cardText;

          const dateEls = block.querySelectorAll('.text-muted');
          const dateStr = dateEls[0]?.innerText?.trim() || '';
          const timeStr = dateEls[1]?.innerText?.trim() || '';

          return { body, dateStr, timeStr };
        }).filter(item => item.body);
      });

      return items.map(n => {
        const firstSentence = n.body.split(/[.!?\n]/)[0]?.trim() || 'Notification';
        return {
          title: firstSentence.substring(0, 120),
          body: n.body,
          dateStr: n.dateStr,
          timeStr: n.timeStr
        };
      });
    } finally {
      await page.close();
    }
  }

  async scrapeCirculars() {
    const page = await this._goto('Circular');
    try {
      const items = await page.evaluate(() => {
        const blocks = document.querySelectorAll('.attachment-block');
        return Array.from(blocks).map(block => {
          const dateStr = block.querySelector('h4.title-c')?.innerText?.trim() || '';
          const h5 = block.querySelector('h5');
          const title = h5?.getAttribute('title') || h5?.innerText?.trim() || '';
          const category = block.querySelector('h6')?.innerText?.replace('Category :', '')?.trim() || '';
          const onclick = block.querySelector('button[onclick*="modifyRow"]')?.getAttribute('onclick') || '';
          const idMatch = onclick.match(/modifyRow\('([^']+)'\)/);
          const circularId = idMatch ? idMatch[1] : null;
          return { title, dateStr, category, circularId };
        }).filter(item => item.title);
      });
      return items;
    } finally {
      await page.close();
    }
  }

  // Fetch full circular detail (body + PDF download link) via the same
  // AJAX endpoint the portal itself uses
  async fetchCircularDetail(circularId) {
    try {
      const ctx = await this._ensureLogin();
      const page = await ctx.newPage();
      try {
        const html = await page.evaluate(async (id) => {
          const resp = await fetch(
            'https://parent.npsnorthacadamis.com/Circular/parentcircular_desc?id=' + encodeURIComponent(id),
            { credentials: 'include' }
          );
          return await resp.text();
        }, circularId);

        return await page.evaluate((html) => {
          const doc = new DOMParser().parseFromString(html, 'text/html');
          const title = doc.querySelector('.cir_download h5')?.innerText?.trim() || '';
          const category = doc.querySelector('.cir_download h6')?.innerText?.replace('Category :', '')?.trim() || '';
          const downloadUrl = doc.querySelector('.cir_download a[href*="download_circular"]')?.href || '';
          const body = doc.querySelector('.cir_download')?.innerText?.trim() || '';
          return { title, category, downloadUrl, body };
        }, html);
      } finally {
        await page.close();
      }
    } catch (err) {
      console.error('[NPS] Circular detail failed:', err.message);
      return null;
    }
  }

  // Extract school calendar events (holidays/exams/events) from the
  // fullcalendar instance embedded in the Calendar page
  async scrapeSchoolCalendar() {
    const page = await this._goto('Calendar');
    try {
      return await page.evaluate(() => {
        try {
          const cal = window.jQuery && window.jQuery('#calendar');
          if (!cal.length || !cal.data('fullCalendar')) return [];
          return cal.fullCalendar('clientEvents').map(e => ({
            title: (e.title || '').trim(),
            start: e.start ? e.start.format('YYYY-MM-DD') : null,
            end: e.end ? e.end.format('YYYY-MM-DD') : null,
            allDay: !!e.allDay
          })).filter(e => e.title && e.start);
        } catch (err) {
          return [];
        }
      });
    } finally {
      await page.close();
    }
  }

  async downloadFile(downloadUrl, baseName) {
    try {
      const ctx = await this._ensureLogin();
      let response = await ctx.request.get(downloadUrl);
      if (!response.ok()) {
        console.error('[NPS] Download failed: HTTP', response.status());
        return null;
      }
      const contentType = response.headers()['content-type'] || '';
      if (contentType.includes('text/html')) {
        // Session likely expired; re-login and retry once
        this.loggedIn = false;
        await this.login(true);
        response = await this.context.request.get(downloadUrl);
        if (!response.ok()) return null;
        const ct2 = response.headers()['content-type'] || '';
        if (ct2.includes('text/html')) return null;
      }
      return await this._saveFile(response, baseName);
    } catch (err) {
      console.error('[NPS] Download error:', err.message);
      return null;
    }
  }

  async _saveFile(response, baseName) {
    const disposition = response.headers()['content-disposition'] || '';
    const serverName = disposition.match(/filename="?([^";\n]+)"?/)?.[1];
    const ext = serverName?.includes('.')
      ? '.' + serverName.split('.').pop()
      : (response.headers()['content-type'] || '').includes('pdf') ? '.pdf' : '.bin';
    const safe = (serverName || baseName).replace(/[^a-zA-Z0-9._-]/g, '_').substring(0, 100);
    const finalName = `${Date.now()}_${safe.endsWith(ext) ? safe : safe + ext}`;
    writeFileSync(join(DOWNLOADS_DIR, finalName), await response.body());
    console.log('[NPS] Downloaded:', finalName);
    return finalName;
  }

  parseDate(dateStr) {
    if (!dateStr) return null;
    const match = dateStr.match(/(\d{2})-(\d{2})-(\d{4})/);
    if (!match) return null;
    if (match[1] === '01' && match[2] === '01' && match[3] === '1970') return null;
    return new Date(`${match[3]}-${match[2]}-${match[1]}T00:00:00`);
  }

  async destroy() {
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
      this.context = null;
      this.loggedIn = false;
    }
  }
}
