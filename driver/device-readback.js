'use strict';
/* Second half of the persistence test: read back what a previous process
 * wrote, without writing anything new. */
const unwrap = (r) => (r && typeof r === 'object' && 'data' in r ? r.data : r);
module.exports = async function deviceReadback(api) {
  const { invoke, log } = api;
  const list = unwrap(await invoke('app/get-device-list')) || [];
  const entries = Array.isArray(list) ? list : (list.deviceList || []);
  const mystique = entries.find((d) => d && String(d.productName || '').toUpperCase().includes('MYSTIQUE'));
  if (!mystique) { log('rb.abort', { reason: 'no MYSTIQUE' }); return; }
  const info = unwrap(await invoke('mystique/get-device-info', mystique.serialNumber));
  log('rb.info', { info });
};
