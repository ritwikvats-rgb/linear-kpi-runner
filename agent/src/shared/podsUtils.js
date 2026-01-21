/* agent/src/shared/podsUtils.js
 * Shared pod configuration loading utilities
 * Used by both kpiComputer.js and runWeeklyKpi.js
 */
const fs = require("fs");
const path = require("path");

const { CONFIG_DIR } = require("./cycleUtils");

/**
 * Load pods configuration from linear_ids.json or pods.json
 * @returns {object|null} - { pods, source } or null if not found
 */
function loadPodsConfig() {
  // Try linear_ids.json first (more complete)
  const linearIdsPath = path.join(CONFIG_DIR, "linear_ids.json");
  if (fs.existsSync(linearIdsPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(linearIdsPath, "utf8"));
      if (data?.pods) return { pods: data.pods, org: data.org, source: "linear_ids.json" };
    } catch {}
  }

  // Fall back to pods.json
  const podsPath = path.join(CONFIG_DIR, "pods.json");
  if (fs.existsSync(podsPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(podsPath, "utf8"));
      return { pods: data, source: "pods.json" };
    } catch {}
  }

  return null;
}

/**
 * Save resolved pods configuration to linear_ids.json
 * @param {object} org - Organization info
 * @param {object} podsResolved - Resolved pods with IDs and projects
 */
function savePodsConfig(org, podsResolved) {
  const fp = path.join(CONFIG_DIR, "linear_ids.json");
  fs.writeFileSync(fp, JSON.stringify({ org, pods: podsResolved }, null, 2), "utf8");
}

/**
 * Load raw pods.json configuration
 * @returns {object|null} - Pods configuration or null
 */
function loadRawPodsJson() {
  const fp = path.join(CONFIG_DIR, "pods.json");
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
 * Normalize project state for display
 * @param {string} state - Raw state string
 * @returns {string} - Normalized state (done, in_flight, not_started, cancelled)
 */
function normalizeState(state) {
  const s = String(state || "").toLowerCase();
  if (s === "completed") return "done";
  if (s === "started" || s === "paused" || s === "in_progress" || s === "inprogress") return "in_flight";
  if (s === "planned" || s === "backlog") return "not_started";
  if (s === "canceled" || s === "cancelled") return "cancelled";
  return s || "unknown";
}

/**
 * Get list of pod names from config
 * @param {object} podsConfig - Pods configuration object
 * @returns {Array<string>} - Array of pod names
 */
function getPodNames(podsConfig) {
  if (!podsConfig?.pods) return [];
  return Object.keys(podsConfig.pods);
}

/**
 * Compute feature movement stats for a list of projects
 * @param {Array} projects - Array of project objects with state
 * @returns {object} - { done, inFlight, notStarted, cancelled }
 */
function computeFeatureStats(projects) {
  const stats = { done: 0, inFlight: 0, notStarted: 0, cancelled: 0 };

  for (const p of projects) {
    const state = normalizeState(p.state);
    if (state === "done") stats.done++;
    else if (state === "in_flight") stats.inFlight++;
    else if (state === "cancelled") stats.cancelled++;
    else stats.notStarted++;
  }

  return stats;
}

module.exports = {
  loadPodsConfig,
  savePodsConfig,
  loadRawPodsJson,
  normalizeState,
  getPodNames,
  computeFeatureStats,
};
