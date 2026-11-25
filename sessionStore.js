const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const DAY_MS = 24 * 60 * 60 * 1000;
const CUTOFF_UTC_MS = 30 * 60 * 1000;
const emptySession = () => ({ usersession: "", userid: "" });

function nextExpiry(now) {
  return (Math.floor((now - CUTOFF_UTC_MS) / DAY_MS) + 1) * DAY_MS + CUTOFF_UTC_MS;
}

function createSessionStore(directory, clientId, onExpire = () => {}) {
  if (!directory || !path.isAbsolute(directory)) {
    throw new Error("An absolute state directory is required for broker sessions");
  }
  const file = path.join(directory, "broker-sessions.sqlite");
  const fd = fs.openSync(file, "a", 0o600);
  fs.closeSync(fd);
  fs.chmodSync(file, 0o600);
  const db = new DatabaseSync(file);
  db.exec("PRAGMA secure_delete = ON; CREATE TABLE IF NOT EXISTS broker_session (id INTEGER PRIMARY KEY CHECK(id = 1), userid TEXT NOT NULL, token TEXT NOT NULL, expires_at INTEGER NOT NULL)");
  const select = db.prepare("SELECT userid, token, expires_at FROM broker_session WHERE id = 1");
  const remove = db.prepare("DELETE FROM broker_session WHERE id = 1");
  const upsert = db.prepare("INSERT OR REPLACE INTO broker_session (id, userid, token, expires_at) VALUES (1, ?, ?, ?)");
  let cached = null;
  let timer;
  let blocked = false;

  const clear = () => {
    cached = null;
    clearTimeout(timer);
    blocked = true;
    remove.run();
    blocked = false;
  };
  const expire = () => {
    try {
      clear();
    } finally {
      Promise.resolve().then(onExpire).catch((error) => {
        console.error("Unable to stop expired broker stream", { code: error.code });
      });
    }
  };
  const schedule = (expiresAt) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        expire();
      } catch (error) {
        console.error("Unable to remove expired broker session", { code: error.code });
      }
    }, Math.max(0, expiresAt - Date.now()));
    timer.unref();
  };
  const get = () => {
    if (blocked) throw new Error("Broker session storage is unavailable");
    const row = cached || select.get();
    if (!row) return emptySession();
    if (
      !Number.isSafeInteger(row.expires_at) || row.expires_at <= Date.now() ||
      typeof row.userid !== "string" || typeof row.token !== "string" || !row.token ||
      !clientId || row.userid.toUpperCase() !== clientId.toUpperCase()
    ) {
      expire();
      return emptySession();
    }
    cached = row;
    schedule(row.expires_at);
    return { usersession: row.token, userid: row.userid, expiresAt: row.expires_at };
  };
  const set = ({ userid, usersession }) => {
    const expiresAt = nextExpiry(Date.now());
    upsert.run(userid, usersession, expiresAt);
    blocked = false;
    cached = { userid, token: usersession, expires_at: expiresAt };
    schedule(expiresAt);
    return expiresAt;
  };

  return {
    get,
    set,
    clear,
    close() {
      clearTimeout(timer);
      db.close();
    },
  };
}

module.exports = { createSessionStore, nextExpiry };
