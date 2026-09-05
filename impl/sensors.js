'use strict';
/*
 * Live sensor readings for the fake SensorBridgeServer.
 *
 * The payload is keyed by display label -- "CPU Temperature", "Memory Used"
 * and so on -- with each entry a {Value, Unit} pair. Both the labels and the
 * pair shape come from the shipped service binary and from the app's own
 * bundle, which agree.
 *
 * Everything here is read from /proc and /sys. Rates (CPU load, disk, network)
 * are deltas against the previous call, so the first read reports zero for
 * those and every later one is a real per-second figure.
 */

const fs = require('fs');
const os = require('os');

const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; } };
const num = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : 0);

let prev = null;

function cpuTimes() {
  const line = read('/proc/stat').split('\n')[0];
  const f = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = (f[3] || 0) + (f[4] || 0);
  /* f[8]/f[9] (guest/guest_nice) are not disjoint from the rest: the kernel's
   * account_guest_time() adds the same cputime to user/nice *and* to
   * guest/guest_nice, which is why procps subtracts it back out. Summing all
   * ten columns double-counts guest time in the denominator, inflating usage
   * on any host running KVM guests -- invisible here since they read 0 on
   * this machine, but not in general. */
  const total = f.reduce((a, b) => a + (b || 0), 0) - (f[8] || 0) - (f[9] || 0);
  return { idle, total };
}

function cpuClockMHz() {
  const m = read('/proc/cpuinfo').match(/^cpu MHz\s*:\s*([\d.]+)$/gm);
  if (!m || !m.length) return 0;
  const vals = m.map((s) => Number(s.split(':')[1]));
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/* hwmon is the only portable source for temperatures; which chip is the CPU
 * differs per board, so the package sensor is preferred and anything
 * coretemp/k10temp accepted as a fallback. */
function hwmonTemp() {
  let best = 0;
  let dirs = [];
  try { dirs = fs.readdirSync('/sys/class/hwmon'); } catch (e) { return 0; }
  for (const d of dirs) {
    const base = '/sys/class/hwmon/' + d;
    const name = read(base + '/name').trim();
    if (!/coretemp|k10temp|zenpower|cpu_thermal|acpitz/.test(name)) continue;
    let files = [];
    try { files = fs.readdirSync(base); } catch (e) { continue; }
    for (const f of files) {
      if (!/^temp\d+_input$/.test(f)) continue;
      const label = read(base + '/' + f.replace('_input', '_label')).trim();
      const v = Number(read(base + '/' + f)) / 1000;
      if (!Number.isFinite(v) || v <= 0) continue;
      if (/package/i.test(label)) return v;
      if (v > best) best = v;
    }
  }
  return best;
}

/* RAPL's energy_uj is monotonic only until it wraps: the counter is a fixed
 * width and resets to 0 at max_energy_range_uj (on this machine, ~262143 J --
 * at typical desktop draw that is roughly once every half hour). A plain
 * `later - earlier` across that wrap goes deeply negative -- verified against
 * this machine's own /sys/class/powercap/intel-rapl:0/max_energy_range_uj:
 * a same-magnitude negative delta divides out to about -262143 W for that one
 * sample, then recovers on the next tick. Cached once; the kernel does not
 * change it at runtime. */
let raplRangeUj;
function raplRange() {
  if (raplRangeUj === undefined) {
    const v = Number(read('/sys/class/powercap/intel-rapl:0/max_energy_range_uj'));
    raplRangeUj = Number.isFinite(v) && v > 0 ? v : null;
  }
  return raplRangeUj;
}

function cpuPowerW(dtSec) {
  // RAPL exposes a monotonic energy counter in microjoules.
  const p = '/sys/class/powercap/intel-rapl:0/energy_uj';
  const uj = Number(read(p));
  if (!Number.isFinite(uj) || !uj) return null;
  return { uj };
}

/* lm-sensors knows things sysfs does not.
 *
 * The SuperIO's rails arrive as unlabelled in* nodes: on this board in1, in2
 * and in3 are +3.3V, +12V and +5V sitting behind resistor ladders, reading
 * 2.05, 2.02 and 2.04 volts raw. Only a board config in /etc/sensors.d names
 * them and undoes the division, and applying that config is libsensors' job --
 * sysfs never sees it. So where the `sensors` binary exists it is the better
 * source. `sensors -j` costs about 6 ms; a short cache keeps a burst of
 * lookups within one poll down to a single call.
 *
 * Without lm-sensors, or before the SuperIO driver is loaded, this falls back
 * to whatever sysfs labels itself, and the rails read zero. */
let sensorsCache = { t: 0, data: null };
let sensorsMissing = false;

function libsensors() {
  if (sensorsMissing) return null;
  const now = Date.now();
  if (now - sensorsCache.t < 400) return sensorsCache.data;
  let data = null;
  try {
    data = JSON.parse(require('child_process').execFileSync('sensors', ['-j'], {
      encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore']
    }));
  } catch (e) {
    /* No lm-sensors on this machine: stop asking. Anything else -- a chip that
     * came and went, a malformed line -- is worth retrying on the next poll. */
    if (e && e.code === 'ENOENT') sensorsMissing = true;
    data = null;
  }
  sensorsCache = { t: now, data };
  return data;
}

/* Every *_input libsensors reports, as {chip, label, key, value}. */
function* sensorFeatures() {
  const data = libsensors();
  if (!data || typeof data !== 'object') return;
  for (const [chip, feats] of Object.entries(data)) {
    if (!feats || typeof feats !== 'object') continue;
    for (const [label, vals] of Object.entries(feats)) {
      if (!vals || typeof vals !== 'object') continue;
      for (const [key, value] of Object.entries(vals)) {
        if (key.endsWith('_input')) yield { chip, label, key, value };
      }
    }
  }
}

/* Rail names, most specific first. The tiers matter: a board that labels both
 * its main and its standby rail would otherwise hand over whichever the
 * directory listing happened to reach first, and 3VSB is not +3.3V. */
const RAILS = [
  ['v3', [/^\+?3\.3\s*V$/i, /^(3VCC|AVCC)$/i, /^\+?3VSB$/i]],
  ['v5', [/^\+?5\s*V$/i, /^(5VCC|VCC5)$/i, /^\+?5VSB$/i]],
  ['v12', [/^\+?12\s*V$/i, /^12VCC$/i]]
];

function pickRails(list) {
  const out = { v3: 0, v5: 0, v12: 0 };
  const depth = Math.max(...RAILS.map(([, pats]) => pats.length));
  for (let tier = 0; tier < depth; tier++) {
    for (const [key, pats] of RAILS) {
      if (out[key] || !pats[tier]) continue;
      for (const { label, volts } of list) {
        if (!pats[tier].test(label)) continue;
        if (Number.isFinite(volts) && volts > 0) { out[key] = volts; break; }
      }
    }
  }
  return out;
}

function sysfsVolts() {
  const list = [];
  let dirs = [];
  try { dirs = fs.readdirSync('/sys/class/hwmon'); } catch (e) { return list; }
  for (const d of dirs) {
    const base = '/sys/class/hwmon/' + d;
    let files = [];
    try { files = fs.readdirSync(base); } catch (e) { continue; }
    for (const f of files) {
      if (!/^in\d+_input$/.test(f)) continue;
      const label = read(base + '/' + f.replace('_input', '_label')).trim();
      if (!label) continue;
      list.push({ label, volts: Number(read(base + '/' + f)) / 1000 });
    }
  }
  return list;
}

function boardVolts() {
  const live = [];
  for (const f of sensorFeatures()) {
    if (!/^in\d+_input$/.test(f.key)) continue;
    live.push({ label: String(f.label).trim(), volts: Number(f.value) });
  }
  const out = pickRails(live);
  if (out.v3 && out.v5 && out.v12) return out;
  /* Fill whatever libsensors could not name from the raw sysfs labels. */
  const fallback = pickRails(sysfsVolts());
  for (const k of ['v3', 'v5', 'v12']) if (!out[k]) out[k] = fallback[k];
  return out;
}

/* Memory speed comes from SMBIOS type 17 (Memory Device). The raw structure is
 * readable without dmidecode, but only as root: /sys/firmware/dmi is 0400.
 *
 * Two speeds live in the structure and they are not the same thing: uint16 at
 * 0x15 is what the module is rated for, uint16 at 0x20 is what it is actually
 * running at. Prefer the configured one. Either can be 0xFFFF, meaning "too
 * large for 16 bits, read the uint32 extended field instead" -- 0x54 for the
 * rated speed, 0x58 for the configured one. Empty slots report 0 and are
 * skipped.
 *
 * The figure is MT/s, which is what DMI calls memory speed and what a DDR5
 * kit is sold as (5600). It is twice the actual bus clock; the app's label
 * says MHz but there is no ground truth for which of the two DeepCool's own
 * service reports, and this value never reaches the wire -- interface B's
 * frame has no memory-clock slot. */
/* Matches impl/dmi-cache.py's fingerprint(): board_vendor/board_name/bios_date
 * from /sys/class/dmi/id, mode 0444 -- world-readable, no root needed. */
function boardFingerprint() {
  const read1 = (name) => { try { return fs.readFileSync('/sys/class/dmi/id/' + name, 'utf8').trim(); } catch (e) { return ''; } };
  return [read1('board_vendor'), read1('board_name'), read1('bios_date')].join('|');
}

function dmiCache() {
  const p = process.env.DC_DMI_CACHE
    || (os.homedir() + '/.config/deepcool-linux/dmi.json');
  let c;
  try { c = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
  /* A cache from a since-replaced motherboard used to be trusted forever --
   * nothing here or in dmi-cache.py compared it against the machine actually
   * running. If the cache predates that field (fingerprint absent), still
   * trust it rather than force a re-run for existing installs. */
  if (c && c.boardFingerprint && c.boardFingerprint !== boardFingerprint()) return null;
  return c;
}

function memClockMTs() {
  let entries = [];
  try {
    entries = fs.readdirSync('/sys/firmware/dmi/entries').filter((d) => /^17-/.test(d));
  } catch (e) {
    /* 0400, so only root gets here. impl/dmi-cache.py writes what the app
     * needs to a readable file; none of it changes while the machine runs. */
    const c = dmiCache();
    return (c && c.memoryClockMTs) || 0;
  }
  const at = (b, off, extOff) => {
    if (b.length < off + 2) return 0;
    const v = b.readUInt16LE(off);
    if (v !== 0xFFFF) return v;
    return b.length >= extOff + 4 ? b.readUInt32LE(extOff) : 0;
  };
  for (const d of entries) {
    let b;
    try { b = fs.readFileSync('/sys/firmware/dmi/entries/' + d + '/raw'); } catch (e) { continue; }
    const mts = at(b, 0x20, 0x58) || at(b, 0x15, 0x54);
    if (mts > 0) return mts;
  }
  const c = dmiCache();
  return (c && c.memoryClockMTs) || 0;
}

function meminfo() {
  const t = read('/proc/meminfo');
  const g = (k) => Number((new RegExp('^' + k + ':\\s+(\\d+) kB$', 'm').exec(t) || [])[1]) || 0;
  const total = g('MemTotal');
  const avail = g('MemAvailable');
  return { totalKb: total, availKb: avail, usedKb: total - avail };
}

/* Whole disks, not partitions: /proc/diskstats lists both (a partition's
 * reads are a subset of its disk's, so summing both double-counts), and a
 * trailing digit does not tell them apart. sda1 is a partition of sda, but
 * nvme0n1 -- a WHOLE disk -- also ends in a digit, and so does its own
 * partition nvme0n1p1. The old /\d$/ filter excluded nvme0n1 outright, so
 * every read/write on an NVMe-only machine (this one included -- the root
 * filesystem is on nvme0n1) reported zero. /sys/block/<dev> only has an entry
 * for whole disks -- kernel partitions live one level down, under
 * /sys/block/<disk>/<partition> -- so that membership test works for every
 * bus type without guessing at naming conventions. */
function diskTotals() {
  let whole;
  try { whole = new Set(fs.readdirSync('/sys/block')); } catch (e) { whole = null; }
  let r = 0;
  let w = 0;
  for (const line of read('/proc/diskstats').split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10) continue;
    const dev = f[2];
    if (/^(loop|ram|zram|dm-)/.test(dev)) continue;
    if (whole ? !whole.has(dev) : /\d$/.test(dev)) continue;
    r += Number(f[5]) * 512;
    w += Number(f[9]) * 512;
  }
  return { r, w };
}

function netTotals() {
  let rx = 0;
  let tx = 0;
  const lines = read('/proc/net/dev').split('\n').slice(2);
  for (const line of lines) {
    const [name, rest] = line.split(':');
    if (!rest) continue;
    if (/^\s*(lo|docker|veth|br-|virbr)/.test(name)) continue;
    const f = rest.trim().split(/\s+/).map(Number);
    rx += f[0] || 0;
    tx += f[8] || 0;
  }
  return { rx, tx };
}

function hasIface(re) {
  try {
    return Object.entries(os.networkInterfaces())
      .some(([name, addrs]) => re.test(name) && (addrs || []).some((a) => !a.internal));
  } catch (e) { return false; }
}

/* nvidia-smi is a process launch, so it is cached just under the app's one
 * second poll rather than run per field. A machine without it reports zeros,
 * which is what the app shows for a GPU it cannot read. */
let gpuCache = { at: 0, v: null };
function gpu() {
  if (Date.now() - gpuCache.at < 900) return gpuCache.v;
  gpuCache = { at: Date.now(), v: null };
  try {
    const out = String(require('child_process').execFileSync('nvidia-smi', [
      '--query-gpu=clocks.current.graphics,clocks.current.memory,temperature.gpu,utilization.gpu,power.draw,memory.used',
      '--format=csv,noheader,nounits'
    ], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }));
    const f = out.trim().split('\n')[0].split(',').map((x) => Number(x.trim()));
    if (f.length >= 6) {
      gpuCache.v = {
        clock: f[0], memClock: f[1], temp: f[2], usage: f[3], power: f[4], memUsedMb: f[5]
      };
    }
  } catch (e) { /* no NVIDIA card, or no driver */ }
  return gpuCache.v;
}

/* Drive temperature comes from the nvme/drivetemp hwmon nodes. */
function diskTemp() {
  let dirs = [];
  try { dirs = fs.readdirSync('/sys/class/hwmon'); } catch (e) { return 0; }
  for (const d of dirs) {
    const base = '/sys/class/hwmon/' + d;
    if (!/nvme|drivetemp/.test(read(base + '/name').trim())) continue;
    const v = Number(read(base + '/temp1_input')) / 1000;
    if (Number.isFinite(v) && v > 0) return v;
  }
  return 0;
}

/* Fans that hwmon exposes, in the {name, speed} shape the app's "Fan list"
 * expects. A cooler plugged into the board rather than the CPU header still
 * shows up here, which is the same as Windows. */
/* Fan tachometers. libsensors first, for the same reason as the rails: it is
 * the only thing that turns fan5 into CPU_OPT. Headers with nothing plugged in
 * read a real 0 and are kept -- the app offers the list as the fan-interface
 * picker, and hiding a header the user might plug into later would be worse
 * than showing it idle. */
function fanList() {
  const out = [];
  for (const f of sensorFeatures()) {
    if (!/^fan\d+_input$/.test(f.key)) continue;
    const rpm = Number(f.value);
    if (!Number.isFinite(rpm)) continue;
    out.push({ Name: String(f.label).trim() || `${f.chip} ${f.key.slice(0, -6)}`, Value: rpm, Unit: 'RPM' });
  }
  if (out.length) return out;

  let dirs = [];
  try { dirs = fs.readdirSync('/sys/class/hwmon'); } catch (e) { return out; }
  for (const d of dirs) {
    const base = '/sys/class/hwmon/' + d;
    const chip = read(base + '/name').trim();
    let files = [];
    try { files = fs.readdirSync(base); } catch (e) { continue; }
    for (const f of files.sort()) {
      const m = /^fan(\d+)_input$/.exec(f);
      if (!m) continue;
      /* An ACPI fan object with no tachometer leaves the node there but
       * unreadable; read() turns that into '' and Number('') into a
       * confident 0. Reporting a fan that does not exist is worse than
       * reporting none, so require the read to have produced something. */
      const raw = read(base + '/' + f).trim();
      if (raw === '') continue;
      const rpm = Number(raw);
      if (!Number.isFinite(rpm)) continue;
      const label = read(base + `/fan${m[1]}_label`).trim();
      out.push({ Name: label || `${chip} fan${m[1]}`, Value: rpm, Unit: 'RPM' });
    }
  }
  return out;
}

function hasBluetooth() {
  try { return fs.readdirSync('/sys/class/bluetooth').length > 0; } catch (e) { return false; }
}

const pair = (Value, Unit) => ({ Value: num(Value), Unit });

/* DC_SENSOR_FAKE=1 replaces every reading with a unique ascending marker.
 * The app forwards these to the cooler over interface B command 0x01, so
 * whichever marker turns up in that frame names the field that fed it. That is
 * how the frame's slot layout in COMMANDS.md was measured. */
const FAKE_LABELS = [
  'CPU Clock', 'CPU Usage', 'CPU Temperature', 'CPU Power',
  'Gpu clock', 'Core GPU Clock', 'Gpu temperature', 'Gpu usage', 'Gpu power',
  'Gpu memory usage', 'Gpu memory clock',
  'Memory Load', 'Memory Used', 'Memory Available', 'Memory Clock', 'Memory Temp',
  'Disk Read Rate', 'Disk Write Rate', 'Disk Temperature',
  'Motherboard v3 volt', 'Motherboard v5 volt', 'Motherboard v12 volt',
  'Network download rate', 'Network upload rate',
  'Ethernet Status', 'WiFi Status', 'Bluetooth Status'
];

function fakeReadings() {
  const out = { 'Fan list': [{ Name: 'cpu', Value: 128, Unit: 'RPM' }] };
  FAKE_LABELS.forEach((k, i) => { out[k] = { Value: 101 + i, Unit: '' }; });
  return out;
}

/* DC_SENSOR_SWEEP is a JSON array of {label: value} objects. One entry is
 * applied per read, cycling, on top of whatever the real readings are. It is
 * how a slot's encoding gets pinned down: drive one field through known values
 * and read the bytes the app puts on the wire. `exports.sweep` names the step
 * that was applied so the push loop can log it alongside the frame. */
let sweepPlan = null;
let sweepStep = -1;
try {
  if (process.env.DC_SENSOR_SWEEP) sweepPlan = JSON.parse(process.env.DC_SENSOR_SWEEP);
} catch (e) { sweepPlan = null; }
exports.sweep = null;

exports.read = function readSensors() {
  if (process.env.DC_SENSOR_FAKE === '1') return applySweep(fakeReadings());
  /* hrtime is monotonic; Date.now() is wall clock and an NTP step or a manual
   * clock set moves it backwards between two polls, which used to flip the
   * sign on every rate for that one sample (dt negative, divides straight
   * through with no clamp). */
  const nowNs = process.hrtime.bigint();
  const cpu = cpuTimes();
  const disk = diskTotals();
  const net = netTotals();
  const rapl = cpuPowerW();
  const mem = meminfo();
  const volts = boardVolts();

  let load = 0;
  let diskR = 0;
  let diskW = 0;
  let netDown = 0;
  let netUp = 0;
  let power = 0;

  if (prev) {
    const dt = Number(nowNs - prev.nowNs) / 1e9 || 1;
    const dTotal = cpu.total - prev.cpu.total;
    const dIdle = cpu.idle - prev.cpu.idle;
    if (dTotal > 0) load = (1 - dIdle / dTotal) * 100;
    /* A counter total can shrink between polls -- vnet0 disappearing when a
     * VM shuts down, tun0/wg0 on a VPN disconnect, a drive unplugged --
     * without diskTotals()/netTotals() doing anything wrong; they correctly
     * sum whatever exists right now. A negative delta from that, or dt<=0
     * from the clock step above, is not a real negative rate: clamp both to
     * 0 rather than reporting a signed quotient nothing downstream expects. */
    if (dt > 0) {
      const dDiskR = disk.r - prev.disk.r, dDiskW = disk.w - prev.disk.w;
      const dNetDown = net.rx - prev.net.rx, dNetUp = net.tx - prev.net.tx;
      diskR = dDiskR > 0 ? dDiskR / dt / 1048576 : 0;
      diskW = dDiskW > 0 ? dDiskW / dt / 1048576 : 0;
      netDown = dNetDown > 0 ? dNetDown / dt / 1024 : 0;
      netUp = dNetUp > 0 ? dNetUp / dt / 1024 : 0;
      if (rapl && prev.rapl) {
        let dUj = rapl.uj - prev.rapl.uj;
        if (dUj < 0) {
          const range = raplRange();
          if (range) dUj += range;
        }
        power = dUj > 0 ? dUj / 1e6 / dt : 0;
      }
    }
  }
  prev = { nowNs, cpu, disk, net, rapl };
  const g = gpu() || {};

  return applySweep({
    /* Every label the app looks for. Its own list (out/main/index.jsc) and the
     * service's (SensorBridgeServer.exe) overlap but are not identical, so the
     * union is sent -- a reading Linux cannot produce is reported as zero
     * rather than omitted, because a missing key is not the same as a sensor
     * that reads nothing. */
    'CPU Clock': pair(cpuClockMHz(), 'MHz'),
    'CPU Usage': pair(load, '%'),
    'CPU Temperature': pair(hwmonTemp(), 'C'),
    'CPU Power': pair(power, 'W'),

    'Gpu clock': pair(g.clock || 0, 'MHz'),
    'Core GPU Clock': pair(g.clock || 0, 'MHz'),
    'Gpu temperature': pair(g.temp || 0, 'C'),
    'Gpu usage': pair(g.usage || 0, '%'),
    'Gpu power': pair(g.power || 0, 'W'),
    'Gpu memory usage': pair(g.memUsedMb || 0, 'MB'),
    'Gpu memory clock': pair(g.memClock || 0, 'MHz'),

    'Memory Load': pair(mem.totalKb ? (mem.usedKb / mem.totalKb) * 100 : 0, '%'),
    /* Megabytes, not gigabytes: the app divides by 1024 before display, the
     * same as it does with the GPU's memSize. */
    'Memory Used': pair(mem.usedKb / 1024, 'MB'),
    'Memory Available': pair(mem.availKb / 1024, 'MB'),
    /* The app displays twice what it is given here -- feeding it the DMI
     * figure of 5600 MT/s put "11200 MHz" on the dashboard. So send the bus
     * clock, half the transfer rate, and a DDR5-5600 kit reads 5600. */
    /* No Math.round here: the app displays 2x whatever this sends, so the
     * round-trip is display = 2 * (this value), and pair()/num() already
     * keeps two decimals. Rounding first made every odd-MT/s kit (DDR4-2933,
     * -3733; DDR5-4267 rated speeds all measured in MT/s) land 1 MHz high --
     * 2933 MT/s -> 1466.5 -> rounded to 1467 -> displays 2934. This
     * machine's DDR5-5600 is even, which is why the bug had not shown up. */
    'Memory Clock': pair(memClockMTs() / 2, 'MHz'),
    'Memory Temp': pair(0, 'C'),

    'Disk Read Rate': pair(diskR, 'MB/s'),
    'Disk Write Rate': pair(diskW, 'MB/s'),
    'Disk Temperature': pair(diskTemp(), 'C'),

    'Motherboard v3 volt': pair(volts.v3, 'V'),
    'Motherboard v5 volt': pair(volts.v5, 'V'),
    'Motherboard v12 volt': pair(volts.v12, 'V'),

    /* Every renderer chunk that reads mainboard.fan[cpuFanIOInterface] treats
     * it as a bare number -- numToArr(sensors.value.mainboard.fan[...]) in
     * three separate UI spots, `mainboard.fan[...] || 0` in a fourth, and the
     * main process's own handleSensorMessage() (`fanRpm =
     * mainboard.fan[deviceOptions.cpuFanIOInterface]`) does the same. None of
     * the four ever accesses a `.Value` field. SERVICE-PROTOCOL.md documents
     * "Fan list" as {Name, Value, Unit} objects, and that shape is still
     * right for whatever the general "Fan list" key is *for* -- but sending
     * it that way here is what the app's own bytecode, cross-checked across
     * every renderer build in this bundle, disagrees with: fanList()[index]
     * being an object instead of a number is exactly why selecting any real
     * CPU Fan I/O / Pump Fan I/O interface made the MYSTIQUE device card
     * render the raw `{ "Name": "SYS_FAN1", "Value": 0, "Unit": "RPM" }`
     * text overflowing the page instead of a number -- confirmed live via a
     * real UI click, not just by reading the bytecode. */
    'Fan list': fanList().map((f) => f.Value),

    'Network download rate': pair(netDown, 'KB/s'),
    'Network upload rate': pair(netUp, 'KB/s'),

    'Ethernet Status': pair(hasIface(/^(en|eth)/) ? 1 : 0, ''),
    'WiFi Status': pair(hasIface(/^(wl|wlan)/) ? 1 : 0, ''),
    'Bluetooth Status': pair(hasBluetooth() ? 1 : 0, '')
  });
};

function applySweep(out) {
  if (!Array.isArray(sweepPlan) || !sweepPlan.length) { exports.sweep = null; return out; }
  sweepStep = (sweepStep + 1) % sweepPlan.length;
  const step = sweepPlan[sweepStep];
  for (const k of Object.keys(step)) {
    const unit = (out[k] && out[k].Unit) || '';
    out[k] = { Value: step[k], Unit: unit };
  }
  exports.sweep = { step: sweepStep, values: step };
  return out;
}
