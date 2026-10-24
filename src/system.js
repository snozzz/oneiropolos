import { spawn } from 'node:child_process';

export function notify(title, message) {
  const esc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').slice(0, 220);
  try {
    spawn('/usr/bin/osascript', ['-e', `display notification "${esc(message)}" with title "${esc(title)}"`], {
      stdio: 'ignore',
      detached: true,
    }).unref();
  } catch {
    // notifications are best effort
  }
}

/** Prevents idle sleep while a task runs (closing the lid still sleeps). */
export class SleepGuard {
  constructor(enabled) {
    this.enabled = enabled;
    this.child = null;
  }

  hold() {
    if (!this.enabled || this.child) return;
    try {
      this.child = spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
      this.child.on('exit', () => {
        this.child = null;
      });
    } catch {
      this.child = null;
    }
  }

  release() {
    if (!this.child) return;
    try {
      this.child.kill();
    } catch {
      // gone
    }
    this.child = null;
  }
}
