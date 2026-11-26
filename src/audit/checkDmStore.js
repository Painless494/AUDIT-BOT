// checkDmStore.js
//
// Settings and memory for the per-check DM reminders. Kept in their own file
// (data/<serverId>.checkdms.json) instead of the main settings file, so a
// background job that saves the main settings can never overwrite a toggle
// someone just changed, or forget who has already been messaged.

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "..", "data");
const KEEP_NOTES_DAYS = 60;

function defaultState() {
  return {
    enabled: false, // master switch - nothing is ever sent while this is off
    intervalHours: 12, // how often the automatic check runs
    cooldownHours: 48, // the same member isn't messaged about the same rule more often than this
    maxPerRun: 25, // at most this many members are messaged per run (the rest are picked up next run)
    checks: {}, // check key -> true when DMs are switched on for that rule
    lastRunAt: null,
    lastNotified: {} // "nationId:checkKey" -> when that member was last messaged about that rule
  };
}

function fileFor(guildId) {
  return path.join(DATA_DIR, `${guildId}.checkdms.json`);
}

// A missing file just means "not set up yet". A file that exists but can't be
// read is NOT treated as empty (that would wipe the saved data on the next
// save), so it throws instead.
function loadCheckDms(guildId) {
  const file = fileFor(guildId);
  const defaults = defaultState();
  if (!fs.existsSync(file)) return defaults;
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  return { ...defaults, ...saved, checks: saved.checks || {}, lastNotified: saved.lastNotified || {} };
}

function saveCheckDms(guildId, state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = fileFor(guildId);
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2));
  fs.renameSync(temp, file); // replace in one step so a crash can't leave half a file
}

// Read, change and save in one go with nothing awaited in between.
function updateCheckDms(guildId, mutate) {
  const state = loadCheckDms(guildId);
  const result = mutate(state);
  saveCheckDms(guildId, state);
  return result;
}

// Drops very old "already messaged" notes so the file doesn't grow forever.
function pruneNotes(state, nowMs = Date.now()) {
  const cutoff = nowMs - KEEP_NOTES_DAYS * 86400000;
  for (const [key, when] of Object.entries(state.lastNotified)) {
    if (new Date(when).getTime() < cutoff) delete state.lastNotified[key];
  }
}

function enabledKeys(state) {
  return Object.entries(state.checks).filter(([, on]) => on).map(([key]) => key);
}

module.exports = { loadCheckDms, saveCheckDms, updateCheckDms, pruneNotes, enabledKeys, defaultState };
