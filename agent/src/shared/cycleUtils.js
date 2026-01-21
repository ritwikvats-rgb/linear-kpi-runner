/* agent/src/shared/cycleUtils.js
 * Shared cycle calendar and date utilities
 * Used by both kpiComputer.js and runWeeklyKpi.js
 */
const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "../../..");
const CONFIG_DIR = path.join(REPO_ROOT, "config");

/**
 * Load cycle calendar from config/cycle_calendar.json
 * @returns {object|null} - Calendar object with pods or null if not found
 */
function loadCycleCalendar() {
  const fp = path.join(CONFIG_DIR, "cycle_calendar.json");
  if (!fs.existsSync(fp)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Load pod-specific calendars from cycle_calendar.json
 * @returns {object} - Pod calendars object
 * @throws {Error} - If file missing or invalid
 */
function loadPodCalendars() {
  const fp = path.join(CONFIG_DIR, "cycle_calendar.json");
  if (!fs.existsSync(fp)) {
    throw new Error(`Missing ${fp}`);
  }
  const obj = JSON.parse(fs.readFileSync(fp, "utf8"));
  if (!obj?.pods) {
    throw new Error(`Invalid cycle_calendar.json: missing "pods"`);
  }
  return obj.pods;
}

/**
 * Get cycle index (1-6) from cycle key string
 * @param {string} cycleKey - e.g., "C1", "C2"
 * @returns {number|null} - Cycle number or null if invalid
 */
function cycleIndex(cycleKey) {
  const m = String(cycleKey).toUpperCase().match(/^C([1-6])$/);
  return m ? Number(m[1]) : null;
}

/**
 * Get the current cycle key for a pod based on date
 * First checks for active cycle, then falls back to most recent ended
 * @param {object} podCalendar - Pod's cycle calendar
 * @param {Date} refDate - Reference date (defaults to now)
 * @returns {string} - Cycle key (e.g., "C1", "C2")
 */
function getCycleKeyByDate(podCalendar, refDate = new Date()) {
  if (!podCalendar) return "C1";

  // Find active cycle first
  for (let i = 1; i <= 6; i++) {
    const c = podCalendar[`C${i}`];
    if (!c) continue;
    const start = new Date(c.start).getTime();
    const end = new Date(c.end).getTime();
    const now = refDate.getTime();
    if (now >= start && now <= end) return `C${i}`;
  }

  // If no active, find most recent ended
  let best = null;
  let bestEnd = -Infinity;
  for (let i = 1; i <= 6; i++) {
    const c = podCalendar[`C${i}`];
    if (!c) continue;
    const end = new Date(c.end).getTime();
    if (end <= refDate.getTime() && end > bestEnd) {
      bestEnd = end;
      best = `C${i}`;
    }
  }

  return best || "C1";
}

/**
 * Check if a cycle is currently active for a pod
 * @param {object} podCalendar - Pod's cycle calendar
 * @param {string} cycleKey - Cycle key (e.g., "C1")
 * @param {Date} refDate - Reference date (defaults to now)
 * @returns {boolean}
 */
function isCycleActive(podCalendar, cycleKey, refDate = new Date()) {
  const c = podCalendar?.[cycleKey];
  if (!c) return false;
  const endMs = new Date(c.end).getTime();
  return refDate.getTime() <= endMs;
}

/**
 * Get the best cycle (with most committed DELs) for display
 * @param {Array} kpiRows - Array of KPI row objects with cycle and committed
 * @returns {object} - { bestCycle, bestCommittedSum }
 */
function getBestCycleByCommitted(kpiRows) {
  const cycleCommits = {};
  for (const row of kpiRows) {
    const cycle = row.cycle || row.Cycle;
    const committed = row.committed || row.Committed_DEL || 0;
    cycleCommits[cycle] = (cycleCommits[cycle] || 0) + committed;
  }

  let best = "C1";
  let bestSum = -1;
  for (const [cycle, sum] of Object.entries(cycleCommits)) {
    if (sum > bestSum) {
      bestSum = sum;
      best = cycle;
    }
  }
  return { bestCycle: best, bestCommittedSum: bestSum };
}

/**
 * Sum committed DELs for a specific cycle
 * @param {Array} kpiRows - Array of KPI row objects
 * @param {string} cycleKey - Cycle key to sum
 * @returns {number}
 */
function sumCommittedForCycle(kpiRows, cycleKey) {
  return kpiRows
    .filter(r => (r.cycle || r.Cycle) === cycleKey)
    .reduce((acc, r) => acc + Number(r.committed || r.Committed_DEL || 0), 0);
}

/**
 * Get cycle end date for a pod
 * @param {object} podCalendar - Pod's cycle calendar
 * @param {string} cycleKey - Cycle key
 * @returns {Date|null}
 */
function getCycleEndDate(podCalendar, cycleKey) {
  const c = podCalendar?.[cycleKey];
  return c?.end ? new Date(c.end) : null;
}

/**
 * Get freeze moment for early cycles (C1/C2 freeze after C2 ends by default)
 * @param {object} podCalendar - Pod's cycle calendar
 * @param {string} freezePolicyCycle - Freeze policy cycle (default "C2")
 * @returns {number|null} - Timestamp in ms or null
 */
function getFreezeMomentMs(podCalendar, freezePolicyCycle = "C2") {
  const fp = podCalendar?.[freezePolicyCycle];
  return fp ? new Date(fp.end).getTime() : null;
}

/**
 * Check if snapshot refresh is allowed for a cycle
 * @param {object} podCalendar - Pod's cycle calendar
 * @param {string} cycleKey - Cycle key
 * @param {Date} now - Current date
 * @param {string} freezePolicyCycle - Freeze policy cycle (default "C2")
 * @returns {boolean}
 */
function shouldAllowRefreshForCycle(podCalendar, cycleKey, now, freezePolicyCycle = "C2") {
  const idx = cycleIndex(cycleKey);
  const fpIdx = cycleIndex(freezePolicyCycle);

  if (!idx || !fpIdx) return false;

  if (idx <= fpIdx) {
    const freezeAt = getFreezeMomentMs(podCalendar, freezePolicyCycle);
    if (!freezeAt) return false;
    return now.getTime() <= freezeAt;
  }

  // For cycles after freeze policy, refresh allowed while cycle is active
  const c = podCalendar?.[cycleKey];
  if (!c) return false;
  return now.getTime() <= new Date(c.end).getTime();
}

/**
 * Check if snapshot should be frozen now
 * @param {object} podCalendar - Pod's cycle calendar
 * @param {string} cycleKey - Cycle key
 * @param {Date} now - Current date
 * @param {string} freezePolicyCycle - Freeze policy cycle (default "C2")
 * @returns {boolean}
 */
function shouldFreezeNow(podCalendar, cycleKey, now, freezePolicyCycle = "C2") {
  const idx = cycleIndex(cycleKey);
  const fpIdx = cycleIndex(freezePolicyCycle);

  if (!idx || !fpIdx) return false;

  if (idx <= fpIdx) {
    const freezeAt = getFreezeMomentMs(podCalendar, freezePolicyCycle);
    if (!freezeAt) return false;
    return now.getTime() > freezeAt;
  }

  const c = podCalendar?.[cycleKey];
  if (!c) return false;
  return now.getTime() > new Date(c.end).getTime();
}

module.exports = {
  loadCycleCalendar,
  loadPodCalendars,
  cycleIndex,
  getCycleKeyByDate,
  isCycleActive,
  getBestCycleByCommitted,
  sumCommittedForCycle,
  getCycleEndDate,
  getFreezeMomentMs,
  shouldAllowRefreshForCycle,
  shouldFreezeNow,
  CONFIG_DIR,
  REPO_ROOT,
};
