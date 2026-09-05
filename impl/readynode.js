'use strict';
/*
 * Linux stand-in for DeepCool's resources/event/ready.node.
 *
 * On Windows this addon waits on a named Win32 event that the DeepCool
 * background services signal once they are up:
 *
 *   new EventWatcher('deep-cool-sensor-data-service-ready', cb).start()
 *   new EventWatcher('DeepCool-Display-Service-Ready',      cb).start()
 *
 * The app's startup sequence blocks on those callbacks -- which is why the
 * splash screen sits on "Loading App..." forever with a recording stub: the
 * stub records the call and never calls back. There is no such service here,
 * and nothing downstream of the callback needs one (the sensor feed is stubbed
 * separately), so the watcher fires once, shortly after start().
 *
 * DC_READY_DELAY=ms tunes the delay; DC_READY_OFF=1 restores the old
 * never-fires behaviour, which is how the dependency was found.
 */

const DELAY = Number(process.env.DC_READY_DELAY || 300);
const OFF = process.env.DC_READY_OFF === '1';

/* Fire once per event name, not once per watcher. The app builds a fresh
 * watcher after every successful connect -- to notice a service restart -- and
 * firing that one too makes it tear the connection down and initialise all
 * over again, once every 300 ms. A service that is already up signals its
 * ready event once and then stays up. */
const fired = new Set();

class EventWatcher {
  constructor(name, callback) {
    this.name = name;
    this.callback = typeof callback === 'function' ? callback : null;
    this.timer = null;
    this.fired = false;
  }

  start() {
    if (OFF || !this.callback || this.timer) return true;
    if (fired.has(this.name)) return true;
    fired.add(this.name);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.fired = true;
      // The real addon reports which event woke it; callers seen so far ignore
      // the argument, but passing the name matches the shape and costs nothing.
      try { this.callback(this.name); } catch (e) { /* the app's problem */ }
    }, DELAY);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    return true;
  }

  stop() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    return true;
  }
}

module.exports = { EventWatcher };
