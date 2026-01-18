/* agent/src/configLoader.js
 * Load pod configuration for the agent
 * Uses config/linear_ids.json (preferred) or config/pods.json
 */
const fs = require("fs");
const path = require("path");

// Repo root is parent of agent/src
const REPO_ROOT = path.resolve(__dirname, "../..");

/**
 * Read JSON file if exists
 */
function readJsonIfExists(relPath) {
  const absPath = path.resolve(REPO_ROOT, relPath);
  if (!fs.existsSync(absPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(absPath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Load pods configuration
 * Returns: { pods: { podName: { teamId, initiativeId, initiativeName, projects? } } }
 */
function loadConfig() {
  // Try linear_ids.json first (has initiativeId)
  const linearIds = readJsonIfExists("config/linear_ids.json");
  if (linearIds?.pods) {
    return {
      source: "config/linear_ids.json",
      org: linearIds.org || null,
      pods: linearIds.pods,
    };
  }

  // Fall back to pods.json
  const podsJson = readJsonIfExists("config/pods.json");
  if (podsJson && typeof podsJson === "object") {
    return {
      source: "config/pods.json",
      org: null,
      pods: podsJson,
    };
  }

  throw new Error("No pods configuration found. Expected config/linear_ids.json or config/pods.json");
}

/**
 * Get list of pod names
 */
function getPodNames(config) {
  return Object.keys(config.pods);
}

/**
 * Get pod by name (case-insensitive)
 */
function getPod(config, name) {
  const normalized = String(name || "").toLowerCase().trim();
  for (const [podName, podData] of Object.entries(config.pods)) {
    if (podName.toLowerCase() === normalized) {
      return { name: podName, ...podData };
    }
  }
  return null;
}

/**
 * Fuzzy match pod name (for typos)
 * Returns closest match if similarity > 0.5
 */
function fuzzyMatchPod(config, query) {
  const q = String(query || "").toLowerCase().trim();
  const podNames = getPodNames(config);

  // Exact match
  const exact = podNames.find(n => n.toLowerCase() === q);
  if (exact) return exact;

  // Prefix match
  const prefix = podNames.find(n => n.toLowerCase().startsWith(q));
  if (prefix) return prefix;

  // Contains match
  const contains = podNames.find(n => n.toLowerCase().includes(q));
  if (contains) return contains;

  // Levenshtein distance for typos
  let bestMatch = null;
  let bestScore = 0;

  for (const name of podNames) {
    const score = similarity(q, name.toLowerCase());
    if (score > bestScore && score > 0.5) {
      bestScore = score;
      bestMatch = name;
    }
  }

  return bestMatch;
}

/**
 * Simple string similarity (0-1)
 */
function similarity(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;

  const longer = a.length > b.length ? a : b;
  const shorter = a.length > b.length ? b : a;

  if (longer.length === 0) return 1;

  const editDistance = levenshtein(longer, shorter);
  return (longer.length - editDistance) / longer.length;
}

function levenshtein(a, b) {
  const matrix = [];
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

module.exports = {
  loadConfig,
  getPodNames,
  getPod,
  fuzzyMatchPod,
  REPO_ROOT,
};
