import { spawn } from 'node:child_process';

export function notify(title, message) {
  if (process.platform === 'win32') {
    const xmlEscape = (text) => String(text ?? '').slice(0, 500).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
    const xml = `<toast><visual><binding template="ToastGeneric"><text>${xmlEscape(title)}</text><text>${xmlEscape(message)}</text></binding></visual></toast>`;
    const code = `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null; [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null; $doc = New-Object Windows.Data.Xml.Dom.XmlDocument; $doc.LoadXml('${xml}'); [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('local.oneiropolos.app').Show([Windows.UI.Notifications.ToastNotification]::new($doc))`;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return;
  }
  if (process.platform !== 'darwin') return;
  const esc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').slice(0, 220);
  try {
    const child = spawn('/usr/bin/osascript', ['-e', `display notification "${esc(message)}" with title "${esc(title)}"`], {
      stdio: 'ignore',
      detached: true,
    });
    child.on('error', () => {});
    child.unref();
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
      if (process.platform === 'win32') {
        const code = `Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class Awake { [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags); }'; [Awake]::SetThreadExecutionState(2147483649) | Out-Null; try { Wait-Process -Id ${process.pid} -ErrorAction SilentlyContinue } finally { [Awake]::SetThreadExecutionState(2147483648) | Out-Null }`;
        this.child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', code], { stdio: 'ignore', windowsHide: true });
      } else if (process.platform === 'darwin') this.child = spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
      else return;
      this.child.on('error', () => { this.child = null; });
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
