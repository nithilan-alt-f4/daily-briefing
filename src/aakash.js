import { spawn } from 'child_process';
import { join } from 'path';

const AAKASH_BOT_DIR = process.env.AAKASH_BOT_DIR || 'C:/Users/Nithilan/aakash-cal-bot';

export class AakashSync {
  constructor({ log = console.log } = {}) {
    this.log = log;
    this.running = false;
    this.lastSync = null;
    this.lastResult = null;
    this.lastError = null;
  }

  /**
   * Spawn the standalone aakash-cal-bot in --once mode (connect -> history sync -> process -> exit).
   * Resolves when the child process exits. Capture stdout/stderr into logger.
   */
  run({ cause = 'manual' } = {}) {
    return new Promise((resolve) => {
      if (this.running) {
        this.log(`[Aakash] Already running; skipping (${cause})`);
        return resolve({ skipped: true, running: true });
      }

      this.running = true;
      this.lastSync = new Date().toISOString();
      this.lastError = null;
      this.log(`[Aakash] Starting sync (${cause})...`);

      const args = ['src/index.js', '--once'];
      const child = spawn(process.execPath, args, {
        cwd: AAKASH_BOT_DIR,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let output = '';
      const collect = (chunk) => {
        const text = chunk.toString();
        output += text;
        // Forward to backend logger (strip ANSI/QR block chars for readability)
        const clean = text
          .split('\n')
          .filter(l => !/[▄█▀▌ ░▒▓█]/.test(l) || /\[wa\]|\[run\]|\[calendar\]|\[parser\]|connected|group|QR/.test(l))
          .join('\n');
        if (clean.trim()) this.log(`[Aakash] ${clean.trim()}`);
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);

      child.on('error', (err) => {
        this.lastError = err.message;
        this.log(`[Aakash] Failed to start child: ${err.message}`);
        this.running = false;
        resolve({ started: false, error: err.message });
      });

      child.on('close', (code) => {
        this.running = false;
        if (code === 0) {
          this.lastResult = 'success';
          this.log('[Aakash] Sync done (success).');
          resolve({ success: true, exit: code });
        } else if (/logged out|scan a new QR|Session expired/i.test(output)) {
          this.lastResult = 'needs-reauth';
          this.log('[Aakash] Session expired. Run START.bat in aakash-cal-bot to rescan QR.');
          resolve({ success: false, needsReauth: true, exit: code });
        } else {
          this.lastResult = 'error';
          this.log(`[Aakash] Sync failed (exit ${code}).`);
          resolve({ success: false, exit: code });
        }
      });
    });
  }

  status() {
    return {
      running: this.running,
      lastSync: this.lastSync,
      lastResult: this.lastResult,
      lastError: this.lastError
    };
  }
}
