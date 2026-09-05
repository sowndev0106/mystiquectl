'use strict';
/*
 * Set the panel's display areas and hold them there.
 *
 * Loaded by the shim inside the app's main process (DC_DRIVER=<this file>).
 * DC_MAIN_MODE picks the main area; the values MYSTIQUE's own dropdown offers
 * are
 *
 *   0 CPU Frequency   1 Time   2 Pump RPM   3 CPU FanSpeed
 *   4 CPU FanSpeed + Pump RPM   5 Temperature
 *
 * DC_AUX_MODE picks the auxiliary row, left alone when unset.
 *
 * The three RPM modes are what proved slots 7-12 are never written: the panel
 * asks for them, the app has the tachometers, and the frame still carries
 * zeros. See COMMANDS.md §"Slots 7-12 are never written".
 */
const SETTLE_MS = Number(process.env.DC_MODE_SETTLE || 12000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const unwrap = (r) => (r && typeof r === 'object' && 'data' in r ? r.data : r);

module.exports = async function fanMode(api) {
  const { invoke, log } = api;
  const list = unwrap(await invoke('app/get-device-list')) || [];
  const dev = (Array.isArray(list) ? list : []).find(
    (d) => d && String(d.productName || '').toUpperCase().includes('MYSTIQUE'));
  if (!dev) { log('mode.abort', { reason: 'MYSTIQUE not in app/get-device-list' }); return; }

  const info = unwrap(await invoke('mystique/get-device-info', dev.serialNumber));
  if (!info) { log('mode.abort', { reason: 'no DeviceInfo' }); return; }
  log('mode.before', { situationalMode: info.situationalMode, options: info.options });

  const next = JSON.parse(JSON.stringify(info));
  const main = Number(process.env.DC_MAIN_MODE || 4);
  next.situationalMode.mainAreaMode = main;
  if (process.env.DC_AUX_MODE !== undefined) {
    next.situationalMode.auxiliaryAreaMode = Number(process.env.DC_AUX_MODE);
  }
  log('mode.set', { situationalMode: next.situationalMode });
  await invoke('mystique/update-device-info', next);

  /* Stay long enough for the 1 Hz push to be worth decoding. */
  await sleep(SETTLE_MS);
  log('mode.done', {});
};
