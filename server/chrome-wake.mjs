import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BridgeError } from './protocol.mjs';

const exec = promisify(execFile);

/**
 * Launch the user's STANDARD Chrome profile, even when unrelated isolated
 * Chrome instances already exist (Playwright, separate --user-data-dir).
 * macOS open -a alone may only activate those other running instances, leaving
 * the paired default profile offline. -n forces LaunchServices to start a
 * fresh app instance; Chromium then owns its normal default profile.
 * Do not pass a conversation URL, debugging flags, or a user data directory.
 */
export async function launchStandardChrome(run = exec) {
  await run('/usr/bin/open', ['-g', '-n', '-a', 'Google Chrome'], { timeout: 10000 });
}
const defaultLaunch = () => launchStandardChrome();

/**
 * Resume a paired browser from a user-initiated Paseo action.
 * A single in-flight OS launch serves concurrent callers. Opening Chrome is
 * NOT sending a ChatGPT message; that still requires a one-shot Broker lease.
 */
export function createChromeWake({
  platform = process.platform, launch = defaultLaunch,
  pause = ms => new Promise(resolve => setTimeout(resolve, ms)),
  attempts = 60, intervalMs = 500
} = {}) {
  let inFlight = null;
  // A 45-second health indicator can be stale immediately after Chrome quits.
  // Treat only a recently authenticated worker heartbeat as ready-to-send.
  const online = state => state?.connected === true &&
    (!Number.isFinite(state.lastSeenAt) || Date.now()-state.lastSeenAt < 5000);
  const waitForOnline = async status => {
    try { await launch(); }
    catch { throw new BridgeError('BROWSER_START_FAILED'); }
    for (let i = 0; i < attempts; i++) {
      if (online(status())) return { ready: true, launched: true };
      await pause(intervalMs);
    }
    if (online(status())) return { ready: true, launched: true };
    throw new BridgeError('BROWSER_UNAVAILABLE');
  };

  return async function wakeChrome({ status, signal } = {}) {
    if (signal?.aborted) throw new BridgeError('SEND_CANCELLED');
    const state = status?.();
    if (online(state)) return { ready: true, launched: false };
    if (!state?.paired) throw new BridgeError('BROWSER_NOT_PAIRED');
    if (platform !== 'darwin') throw new BridgeError('BROWSER_WAKE_UNSUPPORTED');
    if (!inFlight) {
      const task = waitForOnline(status);
      inFlight = task;
      void task.finally(() => { if (inFlight === task) inFlight = null; }).catch(() => {});
    }
    if (!signal) return inFlight;
    let onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(new BridgeError('SEND_CANCELLED'));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try { return await Promise.race([inFlight, aborted]); }
    finally { signal.removeEventListener('abort', onAbort); }
  };
}
