'use strict';
/*
 * Walks every MYSTIQUE setting one field at a time and lets the app emit the
 * USB frame for each change, so frames can be attributed to the setting that
 * produced them.
 *
 * Loaded by the shim inside the app's main process (DC_DRIVER=<this file>).
 * Each step logs a `sweep.set` marker immediately before the call; map.py
 * attributes every frame between one marker and the next.
 *
 * Only ONE field differs from the baseline per call — otherwise a frame that
 * changed could belong to either field.
 */

const SETTLE_MS = Number(process.env.DC_SWEEP_SETTLE || 350);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Field plan. Values are deliberately a little wider than the UI is likely to
 * allow: an out-of-range value that the app rejects is itself information, and
 * it costs one extra frame to find out. */
const PLAN = [
  ['options.screenStatus', [0, 1]],
  ['options.screenBrightness', [0, 50, 100]],
  ['options.screenRotate', [0, 1, 2, 3]],
  ['options.gyroStatus', [0, 1]],
  ['options.noLoadScreen', [0, 1, 2, 3]],
  ['options.rgbOptical', [0, 1, 2]],
  ['options.temperatureDisplay', [0, 1]],
  ['mode.value', [1, 2, 3, 4, 0]],
  ['situationalMode.mainAreaMode', [0, 1, 2, 3, 4, 5, 6]],
  ['situationalMode.auxiliaryAreaMode', [0, 1, 2, 3]],
  ['situationalMode.styleType', [0, 1, 2]],
  ['situationalMode.spectrumType', [0, 1, 2]],
  ['motionMode.animation', [0, 1, 2, 3]],
  ['motionMode.duration', [0, 1, 2, 3]],
  ['motionMode.picRgbStatus', [0, 1]],
  ['motionMode.gifRgbStatus', [0, 1]],
  ['recorderMode.cpuClock', [0, 1]],
  ['recorderMode.cpuTemperature', [0, 1]],
  ['options.cpuFanIOInterface', ['CPU_FAN', 'SYS_FAN1', '']],
  ['options.pumpFanIOInterface', ['PUMP_FAN', 'SYS_FAN2', '']],
];

function clone(o) {
  return JSON.parse(JSON.stringify(o));
}

function setPath(obj, path, value) {
  const parts = path.split('.');
  let node = obj;
  for (const part of parts.slice(0, -1)) {
    if (node[part] === undefined || node[part] === null) node[part] = {};
    node = node[part];
  }
  node[parts[parts.length - 1]] = value;
  return obj;
}

function getPath(obj, path) {
  return path.split('.').reduce((n, k) => (n == null ? undefined : n[k]), obj);
}

function unwrap(res) {
  // Every handler answers { code, message, data }.
  if (res && typeof res === 'object' && 'data' in res) return res.data;
  return res;
}

module.exports = async function sweepSettings(api) {
  const { invoke, log } = api;

  const list = unwrap(await invoke('app/get-device-list')) || [];
  const device = (Array.isArray(list) ? list : []).find(
    (d) => d && String(d.productName || '').toUpperCase().includes('MYSTIQUE')
  );
  if (!device) {
    log('sweep.abort', { reason: 'MYSTIQUE not in app/get-device-list' });
    return;
  }
  const serial = device.serialNumber;

  const baseline = unwrap(await invoke('mystique/get-device-info', serial));
  if (!baseline) {
    log('sweep.abort', { reason: 'mystique/get-device-info returned nothing', serial });
    return;
  }
  log('sweep.baseline', { serial, baseline });

  let steps = 0;
  for (const [path, values] of PLAN) {
    if (getPath(baseline, path) === undefined) {
      log('sweep.skip', { path, reason: 'not present in baseline DeviceInfo' });
      continue;
    }
    for (const value of values) {
      const params = setPath(clone(baseline), path, value);
      // Marker first: everything logged after this and before the next marker
      // belongs to this one change.
      log('sweep.set', { step: steps, path, value, from: getPath(baseline, path) });
      await invoke('mystique/update-device-info', params);
      await sleep(SETTLE_MS);
      steps += 1;
    }
    // Return to baseline so the next field starts from a known state.
    log('sweep.set', { step: steps, path, value: getPath(baseline, path), restore: true });
    await invoke('mystique/update-device-info', clone(baseline));
    await sleep(SETTLE_MS);
    steps += 1;
  }

  // motionModeScreen goes through its own channel rather than update-device-info.
  for (const screen of [{ type: 0, index: 0 }, { type: 1, index: 0 }, { type: 0, index: 1 }]) {
    log('sweep.set', { step: steps, path: 'motionModeScreen', value: screen });
    await invoke('mystique/update-motion-mode-screen', { serialNumber: serial, motionModeScreen: screen });
    await sleep(SETTLE_MS);
    steps += 1;
  }

  log('sweep.set', { step: steps, path: '(restore baseline)', value: null });
  await invoke('mystique/update-device-info', clone(baseline));
  await sleep(SETTLE_MS);

  log('sweep.done', { steps: steps + 1 });
};
