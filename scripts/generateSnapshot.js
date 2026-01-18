/* scripts/generateSnapshot.js
 * Deterministic snapshot generator (NO LLM)
 * Writes agent/output/latest_snapshot.json
 */
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const { LinearClient } = require("../agent/src/linearClient");
const { buildSnapshot } = require("../agent/src/tools");

// Always resolve paths relative to repo root (parent of scripts/)
const REPO_ROOT = path.resolve(__dirname, "..");

/**
 * Read JSON file, throw if missing or invalid
 */
function readJsonRequired(filePath, description) {
  const absPath = path.resolve(REPO_ROOT, filePath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`Missing required config: ${description} at ${absPath}`);
  }
  try {
    return JSON.parse(fs.readFileSync(absPath, "utf8"));
  } catch (err) {
    throw new Error(`Invalid JSON in ${description} (${absPath}): ${err.message}`);
  }
}

/**
 * Read JSON file if it exists, return null otherwise
 */
function readJsonIfExists(filePath) {
  const absPath = path.resolve(REPO_ROOT, filePath);
  if (!fs.existsSync(absPath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(absPath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Load pods config from available sources.
 * Priority:
 *   1. config/linear_ids.json (has teamId, initiativeId, initiativeName, projects)
 *   2. config/pods.json (has teamId, initiativeName)
 *
 * Returns: [{ name: "PodName", teamId: "...", initiativeName: "...", initiativeId: "..." }, ...]
 */
function loadPodsConfig() {
  // Try linear_ids.json first (more complete data from runWeeklyKpi bootstrap)
  const linearIds = readJsonIfExists("config/linear_ids.json");

  // Fall back to pods.json
  const podsJson = readJsonIfExists("config/pods.json");

  // Determine which source to use
  let podsConfig = null;
  let configSource = null;

  if (linearIds?.pods && typeof linearIds.pods === "object") {
    podsConfig = linearIds.pods;
    configSource = "config/linear_ids.json";
  } else if (podsJson && typeof podsJson === "object" && !Array.isArray(podsJson)) {
    podsConfig = podsJson;
    configSource = "config/pods.json";
  }

  if (!podsConfig) {
    throw new Error(
      "No valid pods configuration found.\n" +
      "Expected either:\n" +
      '  - config/linear_ids.json with { "pods": { "PodName": { "teamId": "...", ... } } }\n' +
      '  - config/pods.json with { "PodName": { "teamId": "...", ... } }'
    );
  }

  console.log(`Using pods config from: ${configSource}`);

  const pods = [];
  const missingTeamIds = [];
  const invalidPods = [];

  for (const [podName, podData] of Object.entries(podsConfig)) {
    if (typeof podData !== "object" || podData === null) {
      invalidPods.push(podName);
      continue;
    }

    const teamId = podData.teamId;

    // Validate teamId is present and non-empty
    if (!teamId || typeof teamId !== "string" || teamId.trim() === "") {
      missingTeamIds.push(podName);
      continue;
    }

    pods.push({
      name: podName,
      teamId: teamId.trim(),
      initiativeName: podData.initiativeName || null,
      initiativeId: podData.initiativeId || null,
    });
  }

  // Throw error if any pods have missing teamIds
  if (missingTeamIds.length > 0) {
    throw new Error(
      `Missing teamId for pods in ${configSource}:\n` +
      missingTeamIds.map((p) => `  - ${p}`).join("\n") +
      `\n\nEvery pod must have a valid teamId.`
    );
  }

  // Throw error if any pods have invalid structure
  if (invalidPods.length > 0) {
    throw new Error(
      `Invalid pod configuration in ${configSource}:\n` +
      invalidPods.map((p) => `  - ${p}`).join("\n") +
      `\n\nEach pod must be an object with at least { "teamId": "..." }.`
    );
  }

  // Ensure we have at least one pod
  if (pods.length === 0) {
    throw new Error(
      `No valid pods found in ${configSource}.\n` +
      'Add at least one pod: { "PodName": { "teamId": "..." } }'
    );
  }

  return pods;
}

/**
 * Print debug table of pods with initiative info
 */
function printPodsTable(pods, snapshot) {
  console.log("\n┌──────────────────────┬──────────────────────────────────────────┬─────────────┬──────────────────────┬──────────┐");
  console.log("│ Pod                  │ Team ID                                  │ Initiative? │ Status               │ Projects │");
  console.log("├──────────────────────┼──────────────────────────────────────────┼─────────────┼──────────────────────┼──────────┤");

  for (const pod of pods) {
    const snapshotPod = snapshot?.pods?.find((p) => p.name === pod.name);
    const status = snapshotPod?.data_status || "NOT_IN_SNAPSHOT";
    const projectsCount = snapshotPod?.projectsCount ?? "-";
    const hasInitiative = pod.initiativeId ? "ID" : (pod.initiativeName ? "name" : "no");
    const podName = pod.name.padEnd(20);
    const teamId = (pod.teamId || "null").padEnd(40);
    const initStr = hasInitiative.padEnd(11);
    const statusStr = status.padEnd(20);
    const projectsStr = String(projectsCount).padEnd(8);
    console.log(`│ ${podName} │ ${teamId} │ ${initStr} │ ${statusStr} │ ${projectsStr} │`);
  }

  console.log("└──────────────────────┴──────────────────────────────────────────┴─────────────┴──────────────────────┴──────────┘");

  // Print initiative debug info for pods with issues
  const podsWithInitiativeIssues = snapshot?.pods?.filter(
    (p) => p.data_status === "INITIATIVE_NOT_FOUND" && p.initiativeDebug
  ) || [];

  if (podsWithInitiativeIssues.length > 0) {
    console.log("\n⚠️  Initiative matching issues:");
    for (const pod of podsWithInitiativeIssues) {
      const debug = pod.initiativeDebug;
      console.log(`\n  ${pod.name}:`);
      console.log(`    Configured initiative: "${debug.configuredInitiativeName || debug.configuredInitiativeId}"`);
      console.log(`    Total projects fetched: ${debug.totalProjectsFetched}`);
      console.log(`    Initiatives seen in projects:`);
      if (debug.initiativesSeen?.length > 0) {
        for (const name of debug.initiativesSeen) {
          console.log(`      - "${name}"`);
        }
      } else {
        console.log(`      (none - projects have no initiative assigned)`);
      }
    }
  }
}

async function main() {
  const isDebugMode = process.argv.includes("--debug");

  // Resolve snapshot path relative to repo root
  const snapshotPath = process.env.SNAPSHOT_PATH || "agent/output/latest_snapshot.json";
  const absSnapshotPath = path.resolve(REPO_ROOT, snapshotPath);

  const linearKey = process.env.LINEAR_API_KEY;
  const linearUrl = process.env.LINEAR_GQL_URL || "https://api.linear.app/graphql";
  if (!linearKey) {
    console.error("Missing LINEAR_API_KEY in .env (repo root).");
    process.exit(1);
  }

  // Load and validate pods config (will throw on errors)
  const pods = loadPodsConfig();
  console.log(`Loaded ${pods.length} pods from config/pods.json`);

  const linear = new LinearClient({ apiKey: linearKey, url: linearUrl });

  const snapshot = await buildSnapshot({ linear, pods });

  fs.mkdirSync(path.dirname(absSnapshotPath), { recursive: true });
  fs.writeFileSync(absSnapshotPath, JSON.stringify(snapshot, null, 2), "utf8");

  console.log(`✅ Snapshot written: ${absSnapshotPath}`);
  console.log(`Pods: ${snapshot.pods.length} | Generated: ${snapshot.generated_at}`);

  // Debug mode: print detailed table
  if (isDebugMode) {
    printPodsTable(pods, snapshot);
  }

  // Always print summary of data status
  const statusCounts = {};
  for (const p of snapshot.pods) {
    statusCounts[p.data_status] = (statusCounts[p.data_status] || 0) + 1;
  }
  console.log("\nData status summary:");
  for (const [status, count] of Object.entries(statusCounts)) {
    const icon = status === "OK" ? "✓" : "✗";
    console.log(`  ${icon} ${status}: ${count} pod(s)`);
  }

  if (!isDebugMode) {
    console.log("\nTip: Run with --debug flag for detailed pod table");
  }
}

main().catch((err) => {
  console.error("Snapshot generation failed:", err?.message || err);
  process.exit(1);
});
