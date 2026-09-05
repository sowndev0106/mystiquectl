'use strict';
/*
 * Focused test: does mystique/get-device-info actually reflect what
 * update-device-info wrote, for every field, and does app/get-device-list
 * stay duplicate-free? Run twice in a row (see run wrapper) to also check
 * whether a restart preserves what was written -- the one behaviour that
 * could only ever have worked once LevelDB's wrapper bug was fixed.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const unwrap = (r) => (r && typeof r === 'object' && 'data' in r ? r.data : r);

function deepEqual(a, b, path, diffs) {
  if (a === b) return;
  if (typeof a !== typeof b || a === null || b === null) { diffs.push([path, a, b]); return; }
  if (typeof a === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) deepEqual(a[k], b[k], path + '.' + k, diffs);
    return;
  }
  diffs.push([path, a, b]);
}

module.exports = async function deviceRoundtrip(api) {
  const { invoke, log } = api;

  const list = unwrap(await invoke('app/get-device-list')) || [];
  const entries = Array.isArray(list) ? list : (list.deviceList || []);
  log('rt.device-list', { count: entries.length, names: entries.map((d) => d && d.productName) });
  const dupes = entries.length - new Set(entries.map((d) => d && d.serialNumber)).size;
  log('rt.device-list-dupes', { dupes });

  const mystique = entries.find((d) => d && String(d.productName || '').toUpperCase().includes('MYSTIQUE'));
  if (!mystique) { log('rt.abort', { reason: 'no MYSTIQUE in device list' }); return; }
  const sn = mystique.serialNumber;

  const before = unwrap(await invoke('mystique/get-device-info', sn));
  log('rt.before', { info: before });

  // Change EVERY field to a value distinguishable from its current one.
  const next = JSON.parse(JSON.stringify(before));
  next.mode.value = next.mode.value === 2 ? 3 : 2;
  next.options.noLoadScreen = next.options.noLoadScreen ? 0 : 1;
  next.options.gyroStatus = next.options.gyroStatus ? 0 : 1;
  next.options.screenRotate = (next.options.screenRotate + 1) % 4;
  next.options.screenBrightness = next.options.screenBrightness === 77 ? 66 : 77;
  next.options.rgbOptical = (next.options.rgbOptical + 1) % 3;
  next.options.temperatureDisplay = next.options.temperatureDisplay ? 0 : 1;
  next.situationalMode.mainAreaMode = (next.situationalMode.mainAreaMode + 1) % 6;
  next.situationalMode.auxiliaryAreaMode = (next.situationalMode.auxiliaryAreaMode + 1) % 3;
  next.situationalMode.styleType = (next.situationalMode.styleType + 1) % 3;
  next.situationalMode.spectrumType = (next.situationalMode.spectrumType + 1) % 3;
  next.motionMode.animation = (next.motionMode.animation + 1) % 4;
  next.motionMode.duration = (next.motionMode.duration + 1) % 4;
  next.motionMode.picRgbStatus = next.motionMode.picRgbStatus ? 0 : 1;
  next.motionMode.gifRgbStatus = next.motionMode.gifRgbStatus ? 0 : 1;
  next.recorderMode.cpuClock = next.recorderMode.cpuClock ? 0 : 1;
  next.recorderMode.cpuTemperature = next.recorderMode.cpuTemperature ? 0 : 1;

  const writeRes = await invoke('mystique/update-device-info', next);
  log('rt.write-result', { code: writeRes && writeRes.code, message: writeRes && writeRes.message });
  await sleep(600);

  const after = unwrap(await invoke('mystique/get-device-info', sn));
  log('rt.after', { info: after });

  const diffs = [];
  deepEqual(next, after, '', diffs);
  log('rt.diffs', { count: diffs.length, diffs });

  log('rt.done', {});
};
