/* agent/src/index.js
 * Interactive CLI for KPI Agent v2
 * Supports both snapshot-based and live Linear data queries
 */
require("dotenv").config();
const readline = require("readline");
const { readSnapshot, writeJsonl } = require("./kpiStore");
const path = require("path");
const { execSync } = require("child_process");
const { answer } = require("./answerer");
const { cacheStats, clearCache } = require("./cache");
const { listPods } = require("./liveLinear");

const snapshotPath = process.env.SNAPSHOT_PATH || "agent/output/latest_snapshot.json";
const logPath = "agent/output/answers.log.jsonl";

function printHelp() {
  console.log(`
=== KPI Agent v2 - Commands ===

POD QUERIES (Natural Language):
  what's going on in FTS?           → Narrative summary for FTS pod
  what's going on in Platform?      → Narrative summary for Platform pod
  status of Talent Studio           → Narrative summary
  how is GTS doing?                 → Narrative summary

ALL-PODS / KPI QUERIES:
  what's going on across all pods?  → Feature Movement + DEL tables + summary
  what are our KPIs this week?      → Same as above
  kpi                               → Feature Movement + DEL tables + summary
  weekly kpi                        → Same as above

SYSTEM COMMANDS:
  /help                 Show this help
  /refresh              Regenerate snapshot from Linear
  /snapshot             Show snapshot timestamp
  /exit                 Quit
  debug                 Show debug info (config, IDs, etc.)

LIVE DATA COMMANDS (real-time from Linear API):
  pods                  List all configured pods
  pod <name>            Show pod summary with projects & issues
  pod <name> projects   List all projects for a pod
  project <name>        Deep dive into a project (issues, blockers)
  project <name> blockers   Show blockers for a project
  project <name> comments   Summarize recent comments (last 7 days)

CACHE COMMANDS:
  cache                 Show cache stats
  clear cache           Clear the API cache

NATURAL LANGUAGE PROJECT QUERIES:
  what's going on in FTS Evals?     → Deep dive into specific project
  status of Data-Driven Cohorts     → Project details + activity
  tell me about tagging project     → Full project summary

EXAMPLES:
  what's going on in FTS?           → Pod narrative (summary + bullets + blockers)
  what's going on across all pods?  → Two KPI tables + summary paragraph
  kpi                               → Same as above (shortcut)
  pod fts                           → Live data summary of FTS pod
  pod fts projects                  → List all FTS projects
  project tagging                   → Details on "Tagging system V2" project
  what's going on in FTS Evals      → Deep dive into project with comments
`.trim());
}

function printBanner() {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║           KPI Agent v2 - Live Linear Data                ║
║  Type 'weekly kpi' for KPI tables, /help for commands    ║
╚══════════════════════════════════════════════════════════╝
`);
}

function loadOrExplain() {
  const snap = readSnapshot(snapshotPath);
  if (!snap) {
    console.log(`[INFO] No snapshot found at ${path.resolve(snapshotPath)}.`);
    console.log(`[INFO] Run '/refresh' to generate one, or use live commands like 'pods'.`);
    return null;
  }
  return snap;
}

async function main() {
  printBanner();

  // Show quick status
  const podsResult = listPods();
  console.log(`Config: ${podsResult.source} (${podsResult.podCount} pods)`);

  const cache = cacheStats();
  console.log(`Cache: ${cache.entries} entries (${cache.totalSizeKb} KB)`);

  let snapshot = loadOrExplain();
  if (snapshot) {
    console.log(`Snapshot: ${snapshot.generated_at}`);
  }
  console.log("");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "kpi> ",
  });

  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) return rl.prompt();

    // Slash commands
    if (input === "/exit" || input === "/quit" || input === "/q") {
      rl.close();
      return;
    }

    if (input === "/help" || input === "help") {
      printHelp();
      rl.prompt();
      return;
    }

    if (input === "/refresh") {
      try {
        console.log("Refreshing snapshot...");
        execSync("node scripts/generateSnapshot.js", { stdio: "inherit" });
        snapshot = loadOrExplain();
        console.log("Snapshot refreshed.");
      } catch (e) {
        console.error("Refresh failed:", e?.message || e);
      }
      rl.prompt();
      return;
    }

    if (input === "/snapshot") {
      if (!snapshot) snapshot = loadOrExplain();
      if (snapshot) {
        console.log(`Snapshot: ${snapshot.generated_at}`);
      }
      rl.prompt();
      return;
    }

    if (input === "/cache" || input === "cache" || input === "cache stats") {
      const stats = cacheStats();
      console.log(`Cache: ${stats.entries} entries, ${stats.totalSizeKb} KB`);
      rl.prompt();
      return;
    }

    if (input === "/clear-cache" || input === "clear cache") {
      clearCache();
      console.log("Cache cleared.");
      rl.prompt();
      return;
    }

    // Process with answer engine
    try {
      console.log(""); // spacing
      const out = await answer(input, snapshot);
      console.log(out);
      console.log(""); // spacing

      // Log Q&A
      writeJsonl(logPath, {
        ts: new Date().toISOString(),
        q: input,
        snapshot: snapshot?.generated_at || null,
        a: out.substring(0, 500), // truncate for logs
      });
    } catch (e) {
      console.error("Error:", e?.message || e);
      if (e.details) {
        console.error("Details:", JSON.stringify(e.details).substring(0, 200));
      }
    }

    rl.prompt();
  });

  rl.on("close", () => {
    console.log("\nBye.");
    process.exit(0);
  });
}

// Handle errors gracefully
process.on("unhandledRejection", (err) => {
  console.error("Unhandled error:", err?.message || err);
});

main();
