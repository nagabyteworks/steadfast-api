const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createSessionStore, nextExpiry } = require("../sessionStore");

test("daily expiry is 6 AM India time, including at the cutoff", () => {
  assert.equal(nextExpiry(Date.parse("2026-11-24T00:29:59Z")), Date.parse("2026-11-24T00:30:00Z"));
  assert.equal(nextExpiry(Date.parse("2026-11-24T00:30:00Z")), Date.parse("2026-11-25T00:30:00Z"));
});

test("sessions survive restart, expire, and cannot be restored after clearing", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "steadfast-session-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse("2026-11-24T00:29:00Z") });
  let expired = 0;
  let store = createSessionStore(directory, "test-user", () => { expired++; });
  store.set({ userid: "test-user", usersession: "test-token" });
  assert.equal(fs.statSync(path.join(directory, "broker-sessions.sqlite")).mode & 0o777, 0o600);
  store.close();

  store = createSessionStore(directory, "test-user", () => { expired++; });
  assert.equal(store.get().usersession, "test-token");
  t.mock.timers.tick(60_000);
  await Promise.resolve();
  assert.equal(expired, 1);
  assert.equal(store.get().usersession, "");
  store.close();
  store = createSessionStore(directory, "test-user");
  assert.equal(store.get().usersession, "");
  store.set({ userid: "test-user", usersession: "new-token" });
  store.clear();
  store.close();
  store = createSessionStore(directory, "test-user");
  assert.equal(store.get().usersession, "");
  store.close();
});

test("expired and different-account sessions are deleted on recovery", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "steadfast-session-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-24T00:29:00Z") });
  let store = createSessionStore(directory, "test-user");
  store.set({ userid: "test-user", usersession: "test-token" });
  store.close();
  t.mock.timers.setTime(Date.parse("2026-11-24T00:31:00Z"));
  store = createSessionStore(directory, "test-user");
  assert.equal(store.get().usersession, "");
  store.set({ userid: "test-user", usersession: "new-token" });
  store.close();
  store = createSessionStore(directory, "another-user");
  assert.equal(store.get().usersession, "");
  store.close();
  store = createSessionStore(directory, "test-user");
  assert.equal(store.get().usersession, "");
  store.close();
});
