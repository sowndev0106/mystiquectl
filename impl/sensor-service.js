'use strict';
/*
 * Stand-in for DeepCool's SensorBridgeServer.
 *
 * The app will not finish starting without it: it waits on a service-ready
 * event, then connects to a Windows named pipe, and on failure rebuilds the
 * watcher and retries every 300 ms for ever -- which is what leaves the splash
 * screen on "Loading App..." with no error anywhere.
 *
 * The protocol is not guessed. The real service ships with the app at
 * resources/service/x64/SensorBridgeServer.exe, and its message types, JSON
 * keys and sensor labels are readable in the binary; the app's own half is in
 * out/main/index.jsc. Both were used, and the two agree.
 *
 * Control channel, newline-delimited JSON, envelope {type, seq, timestamp,
 * payload}:
 *
 *   app  -> SERVER_HELLO       {clientVersion}
 *   here <- CLIENT_HELLO       {ServerVersion}
 *   app  -> SETUP_DATA_CHANNEL {}
 *   here <- DATA_CHANNEL_READY {DataPipeName}
 *
 * then RPC by seq: GET_SYSTEM_INFO, GET_SENSOR_DATA, GET_GPU_LIST, SET_GPU,
 * GET_DISK_FREE_INFO, plus ACK and GOODBYE.
 *
 * The data channel is binary. Its frame builder is at 0x14004d3b0 in the
 * service:
 *
 *   DE AD BE EF | uint16LE payload length | payload | uint16LE CRC16/MODBUS
 *
 * with the CRC computed over the payload only -- not the magic or the length.
 * The payload is the same JSON envelope as the control channel.
 */

const sysinfo = require('./sysinfo.js');
const sensors = require('./sensors.js');

/* One data pipe per control pipe. Both bridges (sensor and display) share this
 * module, and handing them the same data-pipe name makes them collide. */
const dataPipeFor = (sock) => {
  const base = String(sock || 'deepcool_sensor_data').split('/').pop().replace(/^pipe-/, '');
  return `\\\\.\\pipe\\${base}_channel`;
};

/* Live data-channel connections, keyed by the pipe name handed out. */
const dataChannels = new Map();
const VERSION = '1.0.0';

let cachedInfo = null;
const systemInfo = () => (cachedInfo || (cachedInfo = sysinfo()));

/* The control channel is newline-delimited JSON in both directions and stays
 * that way after the handshake -- framing it instead makes the app JSON.parse
 * the magic bytes as text. Only the data channel is framed. */
function send(conn, type, payload, seq) {
  conn.write(JSON.stringify({ type, seq, timestamp: Date.now(), payload }) + '\n');
}

const RPC = {
  GET_SYSTEM_INFO: () => systemInfo(),
  GET_GPU_LIST: () => systemInfo().gpuList,
  GET_DISK_FREE_INFO: () => systemInfo().diskInfoList,
  GET_SENSOR_DATA: () => sensors.read(),
  SET_GPU: () => ({ ok: true }),
  ACK: () => ({}),
  GOODBYE: () => ({})
};

/* `|| 1000` only rescues an empty/unset value; a typo like "3s" or "8000ms"
 * survives it as NaN, and setInterval(fn, NaN) is clamped by Node to 1 ms --
 * measured on this machine, ~880 pushes/second per data channel instead of
 * 1/second, each one re-reading /proc/stat, /proc/diskstats, /proc/net/dev
 * and hwmon from scratch. */
const PUSH_MS_RAW = Number(process.env.DC_SENSOR_PUSH_MS);
const PUSH_MS = Number.isFinite(PUSH_MS_RAW) && PUSH_MS_RAW >= 1 ? PUSH_MS_RAW : 1000;
const MAGIC = Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]);

/* CRC16/MODBUS: init 0xFFFF, reflected polynomial 0xA001, no final xor.
 * Taken from the service's own inlined loop rather than assumed. */
function crc16modbus(buf) {
  let crc = 0xFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 1) ? ((crc >> 1) ^ 0xA001) : (crc >> 1);
    }
  }
  return crc & 0xFFFF;
}

function frame(obj) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(2);
  head.writeUInt16LE(payload.length, 0);
  const tail = Buffer.alloc(2);
  tail.writeUInt16LE(crc16modbus(payload), 0);
  return Buffer.concat([MAGIC, head, payload, tail]);
}

/* Exactly one of these may be running at a time (see the comment in attach()
 * below on why two ever ran at once, and the reconnect race that survived
 * fixing that): each sample it produces both feeds the wire and advances
 * impl/sensors.js's DC_SENSOR_SWEEP step, and a second concurrent timer
 * doubles the rate the step advances at relative to what actually reaches
 * the device -- exactly the mechanism that let a two-entry sweep plan
 * apply plan[1] only to frames the app never sees. */
let activeSensorTimer = null;

/* The service pushes sensor readings on the data channel; the app never sends
 * anything there. Framed, unlike the control channel. */
function pushSensors(conn, log) {
  if (process.env.DC_SENSOR_PUSH_MS && !(Number.isFinite(PUSH_MS_RAW) && PUSH_MS_RAW >= 1)) {
    log('sensor.push-ms-rejected', { given: process.env.DC_SENSOR_PUSH_MS, using: PUSH_MS });
  }
  if (activeSensorTimer) {
    clearInterval(activeSensorTimer);
    log('sensor.push.superseded', {});
  }
  let seq = 0;

  /* System information is pushed once when the channel opens, the same way the
   * readings are pushed: the app's data-channel handler dispatches on `type`,
   * and an answer sent back down the control channel is parsed but never
   * stored. */
  setTimeout(() => {
    try {
      conn.write(frame({
        type: 'GET_SYSTEM_INFO',
        seq: 0,
        timestamp: Date.now(),
        payload: JSON.stringify(systemInfo())
      }));
      log('sensor.push.systeminfo', {});
    } catch (e) { /* channel gone */ }
  }, 200);

  // Only clear the shared slot if it is still this call's timer -- a
  // superseding pushSensors() call already cleared and replaced it, and this
  // connection's belated close/error must not null out someone else's timer.
  const stop = () => { clearInterval(timer); if (activeSensorTimer === timer) activeSensorTimer = null; };
  const timer = setInterval(() => {
    seq += 1;
    let payload;
    try {
      payload = sensors.read();
    } catch (err) {
      log('sensor.read-failed', { error: String(err && err.message) });
      return;
    }
    /* Logged before the write so the next 0x01 frame in usb.jsonl can be
     * attributed to the sweep step that produced it. */
    if (sensors.sweep) log('sensor.sweep', sensors.sweep);
    try {
      /* On the data channel `payload` is a JSON *string*, not an object: the
       * app calls JSON.parse on it a second time, and handing it an object
       * gives `"[object Object]" is not valid JSON` in onDataPipeData. */
      conn.write(frame({
        type: 'GET_SENSOR_DATA',
        seq,
        timestamp: Date.now(),
        payload: JSON.stringify(payload)
      }));
    } catch (err) {
      stop();
    }
    if (seq === 1) log('sensor.push.start', { every: PUSH_MS, keys: Object.keys(payload).length });
  }, PUSH_MS);
  activeSensorTimer = timer;
  if (typeof timer.unref === 'function') timer.unref();
  conn.on('close', stop);
  conn.on('error', stop);
}

/** Called by the shim's pipe listener for every accepted connection. */
module.exports = function attach(conn, log, sock) {
  const myDataPipe = dataPipeFor(sock);

  /* The data channel is the socket whose name the service handed out. This
   * module is shared by both the sensor bridge and the display bridge (see
   * the module comment above dataPipeFor), and both of their data-channel
   * pipes end in "_channel" -- deepcool_sensor_data_channel AND
   * DeepCool_display_server_channel -- so this used to start pushSensors()
   * on whichever one connected first, and again on the other whenever it
   * connected too: two independent 1 Hz timers, one of them writing
   * GET_SENSOR_DATA frames onto the display bridge's data channel, which
   * nothing on that pipe expects. Confirmed live: a single run logged
   * 'sensor.data-channel' for both pipes and 'sensor.push.start' twice.
   * Only the sensor bridge's own data channel should ever get a pusher. */
  if (sock && sock.endsWith('_channel')) {
    const key = `\\\\.\\pipe\\${String(sock).split('/').pop().replace(/^pipe-/, '')}`;
    dataChannels.set(key, conn);
    conn.on('close', () => { if (dataChannels.get(key) === conn) dataChannels.delete(key); });
    log('sensor.data-channel', { socket: sock, key });
    if (/sensor/i.test(sock)) pushSensors(conn, log);
  }

  let buffered = '';

  conn.on('data', (chunk) => {
    buffered += chunk.toString('utf8');
    let nl;
    while ((nl = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, nl).trim();
      buffered = buffered.slice(nl + 1);
      if (!line) continue;

      let msg;
      try {
        msg = JSON.parse(line);
      } catch (err) {
        log('sensor.bad-json', { line: line.slice(0, 200) });
        continue;
      }

      const type = msg.type || msg.TYPE;
      const seq = msg.seq;

      if (type === 'SERVER_HELLO') {
        send(conn, 'CLIENT_HELLO', { ServerVersion: VERSION }, seq);
        log('sensor.tx', { type: 'CLIENT_HELLO', seq });
      } else if (type === 'SETUP_DATA_CHANNEL') {
        send(conn, 'DATA_CHANNEL_READY', { DataPipeName: myDataPipe }, seq);
        log('sensor.tx', { type: 'DATA_CHANNEL_READY', seq, pipe: myDataPipe });
      } else if (RPC[type]) {
        let payload;
        try {
          payload = RPC[type](msg.payload);
        } catch (err) {
          log('sensor.rpc-failed', { type, error: String(err && err.message) });
          payload = {};
        }
        send(conn, type, payload, seq);
        log('sensor.tx', { type, seq, size: JSON.stringify(payload || {}).length });
      } else {
        log('sensor.unhandled', { type, seq });
      }
    }
  });

  conn.on('error', () => {});
};
