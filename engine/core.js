/*
 * The Rust engine (engine/trade_desk_core.wasm, built from core/), wrapped
 * for JavaScript.
 *
 * The wasm has no imports and no generated glue: bytes go in through memory
 * it allocates, and every reply is JSON. Runs the same in an Overwolf window
 * and under Node (the tests load it from disk).
 */
(function (root) {
  "use strict";

  var encoder = new TextEncoder();
  var decoder = new TextDecoder();

  function Core(instance) {
    this.x = instance.exports;
  }

  Core.prototype._put = function (text) {
    var bytes = encoder.encode(text);
    var ptr = this.x.td_alloc(bytes.length);
    new Uint8Array(this.x.memory.buffer, ptr, bytes.length).set(bytes);
    return { ptr: ptr, len: bytes.length };
  };

  Core.prototype._free = function (buf) {
    this.x.td_free(buf.ptr, buf.len);
  };

  Core.prototype._reply = function () {
    var ptr = this.x.td_result_ptr();
    var len = this.x.td_result_len();
    // Copy out before parsing: the next call reuses the buffer.
    return JSON.parse(decoder.decode(new Uint8Array(this.x.memory.buffer, ptr, len).slice()));
  };

  Core.prototype._pair = function (fn, a, b) {
    var ka = this._put(a);
    var kb = this._put(b);
    try {
      this.x[fn](ka.ptr, ka.len, kb.ptr, kb.len);
      return this._reply();
    } finally {
      this._free(ka);
      this._free(kb);
    }
  };

  /** A raw API body. Returns {ok, digest} - cache the digest, not the body. */
  Core.prototype.ingest = function (key, body) {
    return this._pair("td_ingest", key, body);
  };

  /** A digest from the cache. */
  Core.prototype.load = function (key, digest) {
    return this._pair("td_load", key, digest);
  };

  /** The game-events inventory payload, exactly as it arrived. */
  Core.prototype.inventory = function (payload) {
    var buf = this._put(typeof payload === "string" ? payload : JSON.stringify(payload));
    try {
      this.x.td_inventory(buf.ptr, buf.len);
      return this._reply();
    } finally {
      this._free(buf);
    }
  };

  /** {op: "needs" | "build" | "lookup" | "settings" | ...}. */
  Core.prototype.call = function (op, args) {
    var req = Object.assign({ op: op }, args || {});
    var buf = this._put(JSON.stringify(req));
    try {
      this.x.td_call(buf.ptr, buf.len);
      return this._reply();
    } finally {
      this._free(buf);
    }
  };

  Core.fromBytes = function (bytes) {
    return WebAssembly.instantiate(bytes, {}).then(function (r) {
      return new Core(r.instance);
    });
  };

  /** In an Overwolf window: the wasm ships next to this file. */
  Core.load = function (url) {
    return fetch(url || "engine/trade_desk_core.wasm")
      .then(function (res) {
        if (!res.ok) throw new Error("engine missing: HTTP " + res.status);
        return res.arrayBuffer();
      })
      .then(Core.fromBytes);
  };

  if (typeof module !== "undefined" && module.exports) module.exports = Core;
  else root.TradeDeskCore = Core;
})(typeof self !== "undefined" ? self : this);
