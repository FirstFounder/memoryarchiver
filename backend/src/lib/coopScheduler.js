/**
 * Coop scheduled checks — runs only when COOP_ENABLED=true.
 *
 * At startup, reads OPEN_AT / CLOSE_AT from janus via app_status.sh and
 * registers two node-cron jobs:
 *   - OPEN_AT  + 5 min → runCheck('open_check',  'open')
 *   - CLOSE_AT + 5 min → runCheck('close_check', 'closed')
 *
 * On janus unreachable at startup: retries once after 60 s, then skips
 * schedule registration until next server restart.
 *
 * Hot-reload: each check run re-reads openAt/closeAt from the response and
 * re-registers both cron jobs if the times have changed.
 */

import cron from 'node-cron';
import nodemailer from 'nodemailer';
import db from '../db/client.js';
import config from '../config.js';
import { janusExec } from './coopSsh.js';

// Module-level cron task handles (so stopCoopScheduler can destroy them)
let openTask  = null;
let closeTask = null;

// Last-known schedule times — used to detect changes
let lastOpenAt  = null;
let lastCloseAt = null;

// ── Public API ────────────────────────────────────────────────────────────────

export function startCoopScheduler() {
  console.log('[coop-scheduler] Starting');
  initSchedule().catch(err => {
    console.warn('[coop-scheduler] Initial schedule registration failed:', err.message);
    console.warn('[coop-scheduler] Retrying in 60 s…');
    setTimeout(() => {
      initSchedule().catch(err2 => {
        console.warn('[coop-scheduler] Retry failed — skipping schedule until restart:', err2.message);
      });
    }, 60_000);
  });
}

export function stopCoopScheduler() {
  if (openTask)  { openTask.stop();  openTask  = null; }
  if (closeTask) { closeTask.stop(); closeTask = null; }
  console.log('[coop-scheduler] Stopped');
}

// ── Internal ──────────────────────────────────────────────────────────────────

async function initSchedule() {
  const raw = await janusExec('/opt/coopdoor/app_status.sh');
  const status = JSON.parse(raw);
  if (status.error) throw new Error(`janus error: ${status.error}`);

  const openAt  = status.openAt  || '';
  const closeAt = status.closeAt || '';

  if (!openAt || !closeAt) {
    throw new Error(`janus returned empty schedule times: openAt="${openAt}" closeAt="${closeAt}"`);
  }

  reregisterCronJobs(openAt, closeAt);
  console.log(`[coop-scheduler] Scheduled open_check at ${openAt}+5m, close_check at ${closeAt}+5m`);
}

function reregisterCronJobs(openAt, closeAt) {
  if (openTask)  { openTask.stop();  openTask  = null; }
  if (closeTask) { closeTask.stop(); closeTask = null; }

  lastOpenAt  = openAt;
  lastCloseAt = closeAt;

  const openCron  = timeToCron(openAt,  5);
  const closeCron = timeToCron(closeAt, 5);

  openTask = cron.schedule(openCron, () => {
    runCheck('open_check', 'open').catch(err =>
      console.error('[coop-scheduler] runCheck open_check error:', err.message),
    );
  }, { timezone: 'America/Chicago' });

  closeTask = cron.schedule(closeCron, () => {
    runCheck('close_check', 'closed').catch(err =>
      console.error('[coop-scheduler] runCheck close_check error:', err.message),
    );
  }, { timezone: 'America/Chicago' });
}

/**
 * Convert "HH:MM" + offsetMinutes into a cron expression "M H * * *".
 */
function timeToCron(timeStr, offsetMinutes) {
  const [hStr, mStr] = timeStr.split(':');
  let totalMinutes = parseInt(hStr, 10) * 60 + parseInt(mStr, 10) + offsetMinutes;
  const h = Math.floor(totalMinutes / 60) % 24;
  const m = totalMinutes % 60;
  return `${m} ${h} * * *`;
}

async function runCheck(checkType, expectedState) {
  const checkedAt = new Date().toISOString();
  let actualState      = null;
  let schedulerActive  = null;
  let openAt           = null;
  let closeAt          = null;
  let janusError       = null;
  let mismatch         = false;

  try {
    const raw    = await janusExec('/opt/coopdoor/app_status.sh');
    const status = JSON.parse(raw);

    if (status.error) {
      janusError = status.error;
      mismatch   = true;
    } else {
      actualState     = status.state           ?? null;
      schedulerActive = status.schedulerActive ?? null;
      openAt          = status.openAt          ?? null;
      closeAt         = status.closeAt         ?? null;
      mismatch        = actualState !== expectedState;

      // Hot-reload: re-register cron jobs if schedule times changed
      if (
        openAt && closeAt &&
        (openAt !== lastOpenAt || closeAt !== lastCloseAt)
      ) {
        console.log(
          `[coop-scheduler] Schedule times changed (${lastOpenAt}/${lastCloseAt} → ${openAt}/${closeAt}) — re-registering cron jobs`,
        );
        reregisterCronJobs(openAt, closeAt);
      }
    }
  } catch (err) {
    janusError = err.message.slice(0, 500);
    mismatch   = true;
  }

  let alertSent = 0;
  if (mismatch || janusError) {
    alertSent = await sendAlert({ checkType, expectedState, actualState, schedulerActive, openAt, closeAt, janusError, checkedAt }) ? 1 : 0;
  }

  db.prepare(`
    INSERT INTO coop_checks
      (checked_at, check_type, expected_state, actual_state, scheduler_active,
       open_at, close_at, mismatch, alert_sent, janus_error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    checkedAt,
    checkType,
    expectedState,
    actualState,
    schedulerActive === null ? null : (schedulerActive ? 1 : 0),
    openAt,
    closeAt,
    mismatch ? 1 : 0,
    alertSent,
    janusError,
  );

  console.log(
    `[coop-scheduler] ${checkType}: expected=${expectedState} actual=${actualState ?? 'null'} mismatch=${mismatch} alertSent=${alertSent}`,
  );
}

async function sendAlert({ checkType, expectedState, actualState, schedulerActive, openAt, closeAt, janusError, checkedAt }) {
  if (!config.smtpUser || !config.smtpPass) {
    console.warn('[coop-scheduler] SMTP not configured — skipping alert email');
    return false;
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: config.smtpUser,
      pass: config.smtpPass,
    },
  });

  const subject = janusError
    ? '[Coop] Janus unreachable at scheduled check'
    : `[Coop] Door check mismatch — expected ${expectedState}, got ${actualState}`;

  const lines = [
    `Check type:       ${checkType}`,
    `Expected state:   ${expectedState}`,
    `Actual state:     ${actualState ?? 'unknown'}`,
    `Scheduler active: ${schedulerActive ?? 'unknown'}`,
    `Opens at:         ${openAt  ?? 'unknown'}`,
    `Closes at:        ${closeAt ?? 'unknown'}`,
    `Timestamp:        ${checkedAt}`,
  ];
  if (janusError) lines.push(`Error:            ${janusError}`);

  try {
    await transporter.sendMail({
      from:    config.smtpUser,
      to:      config.coopAlertEmail,
      subject,
      text:    lines.join('\n'),
    });
    console.log(`[coop-scheduler] Alert email sent: ${subject}`);
    return true;
  } catch (err) {
    console.error('[coop-scheduler] Failed to send alert email:', err.message);
    return false;
  }
}
