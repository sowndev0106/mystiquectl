'use strict';
/*
 * Read-only reconnaissance driver.
 *
 * Loaded by the shim inside DeepCool's main process (DC_DRIVER=<this file>) once
 * the app has settled. Calls the channels that only report state, so we learn
 * what the app already believes about the device before trying to change
 * anything.
 *
 * Every result lands in the capture log as a `driver.invoke` event.
 */

module.exports = async function probe(api) {
  const { invoke, log } = api;

  log('probe.start', { channels: api.channels.length });

  // Bootstrap-ish channels first: whatever the renderer would have called on
  // its way to the device page.
  const readOnly = [
    ['sys/get-userdata-path'],
    ['app/get-setting'],
    ['app/get-co-branding'],
    ['app/get-device-list'],
    ['app/get-fan-interface'],
    ['app/get-gpu-list'],
    ['app/get-disk-list'],
    ['app/get-systeminfo'],
    ['app/get-sensors-data'],
    ['sys/check-media-components'],
    ['media/getAllMedia'],
  ];

  for (const [channel, ...args] of readOnly) {
    await invoke(channel, ...args);
  }

  // Find the MYSTIQUE entry so later calls can use the app's own identifier
  // rather than one we assume.
  const list = await invoke('app/get-device-list');
  const devices = (list && (list.data || list)) || [];
  const entries = Array.isArray(devices) ? devices : (devices.deviceList || []);
  log('probe.devices', { count: entries.length, entries });

  const mystique = entries.find(
    (d) => d && String(d.productName || '').toUpperCase().includes('MYSTIQUE')
  );

  // Fall back to the USB serial: it is what the app logs during init
  // ("winusb device[MYSTIQUE] init: 00780031343832325031364C").
  const serial = (mystique && mystique.serialNumber) || '00780031343832325031364C';
  log('probe.serial', { fromDeviceList: !!(mystique && mystique.serialNumber), serial });

  for (const [channel, ...args] of [
    ['mystique/get-device-info', serial],
    ['sys/get-resources', serial],
    ['mystique/refresh-recorder-mode', serial],
  ]) {
    await invoke(channel, ...args);
  }

  log('probe.done', {});
};
