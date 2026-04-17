import cron from 'node-cron';
import db from '../db/client.js';
import config from '../config.js';
import { computePlan, pushPlan } from './chargeScheduler.js';
import { checkForOverride } from './overrideDetector.js';

let scheduledTask = null;
let running = false;

function getSettings() {
  return db.prepare(`
    SELECT *
    FROM tesla_settings
    WHERE id = 1
  `).get();
}

function getActiveVehicles() {
  return db.prepare(`
    SELECT vin, display_name, nickname
    FROM tesla_config
    WHERE mode = 'active'
    ORDER BY created_at, id
  `).all();
}

async function runScheduler() {
  if (running) return;
  running = true;

  try {
    const vehicles = getActiveVehicles();

    for (const vehicle of vehicles) {
      try {
        const override = await checkForOverride(vehicle.vin);
        if (override.overridden) {
          console.info(`[teslaScheduler] ${vehicle.display_name ?? vehicle.nickname ?? vehicle.vin}: user override detected, skipping`);
          continue;
        }

        const plan = await computePlan(vehicle.vin);
        if (plan?.status === 'skipped') {
          console.info(`[teslaScheduler] ${vehicle.display_name ?? vehicle.nickname ?? vehicle.vin}: skipped (${plan.reason ?? 'no_reason'})`);
          continue;
        }

        const pushed = await pushPlan(plan, vehicle.vin);
        console.info(`[teslaScheduler] ${vehicle.display_name ?? vehicle.nickname ?? vehicle.vin}: ${pushed?.alert ?? 'scheduled'}`);
      } catch (error) {
        console.error(`[teslaScheduler] ${vehicle.display_name ?? vehicle.nickname ?? vehicle.vin}:`, error);
      }
    }
  } finally {
    running = false;
  }
}

export function startTeslaScheduler() {
  if (!config.teslaEnabled || scheduledTask) return;

  const settings = getSettings();
  const expression = settings?.eval_cron ?? '45 21 * * *';

  scheduledTask = cron.schedule(expression, () => {
    runScheduler().catch((error) => {
      console.error('[teslaScheduler] unhandled scheduler error', error);
    });
  }, {
    timezone: 'America/Chicago',
  });

  console.info(`[teslaScheduler] scheduled with cron "${expression}"`);
}

export function stopTeslaScheduler() {
  if (!scheduledTask) return;
  scheduledTask.stop();
  scheduledTask.destroy();
  scheduledTask = null;
}
