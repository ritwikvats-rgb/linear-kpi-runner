#!/usr/bin/env node
/**
 * Set and Track Q1 Goals
 *
 * Define quarterly goals for each pod so you can measure
 * success at end of quarter.
 *
 * Usage:
 *   node scripts/setGoals.js set FTS delivery 80 "Maintain 80% delivery across all cycles"
 *   node scripts/setGoals.js set Platform features 5 "Complete 5 major features"
 *   node scripts/setGoals.js update FTS delivery 85 achieved
 *   node scripts/setGoals.js list
 */

const {
  openHistoryDb,
  setQuarterlyGoal,
  updateGoalProgress,
  getQuarterlyGoals,
} = require("../agent/src/historicalDataService");

const QUARTER = "2026-Q1";

/* -------------------- CLI ARGS -------------------- */

const args = process.argv.slice(2);
const command = args[0];

// Show help
if (!command || command === "--help" || command === "-h") {
  console.log(`
Set and Track Q1 Goals

Usage:
  node scripts/setGoals.js <command> [args]

Commands:
  set <pod> <type> <target> [description]    Set a goal
  update <pod> <type> <actual> [status]      Update progress
  list                                        List all goals

Goal Types:
  delivery     - Target delivery percentage
  features     - Number of features to complete
  spillover    - Max spillover percentage (lower is better)
  custom       - Any custom metric

Status Values:
  pending      - Goal in progress
  achieved     - Goal met
  missed       - Goal not met

Examples:
  node scripts/setGoals.js set FTS delivery 80 "80% delivery target"
  node scripts/setGoals.js set Platform features 5 "Ship 5 features"
  node scripts/setGoals.js set GTS spillover 20 "Keep spillover under 20%"
  node scripts/setGoals.js update FTS delivery 85 achieved
  node scripts/setGoals.js list
`);
  process.exit(0);
}

const db = openHistoryDb();

/* -------------------- COMMANDS -------------------- */

if (command === "list") {
  const goals = getQuarterlyGoals(db, QUARTER);

  console.log(`\n🎯 Q1 2026 Goals`);
  console.log("-".repeat(60));

  if (goals.length === 0) {
    console.log("  No goals set yet. Use 'set' command to add goals.");
  } else {
    // Group by pod
    const byPod = {};
    for (const g of goals) {
      if (!byPod[g.pod]) byPod[g.pod] = [];
      byPod[g.pod].push(g);
    }

    for (const [pod, podGoals] of Object.entries(byPod)) {
      console.log(`\n  ${pod}:`);
      for (const g of podGoals) {
        const statusEmoji = {
          pending: "⏳",
          achieved: "✅",
          missed: "❌",
        }[g.status] || "⏳";

        const progress = g.actual_value !== null
          ? `${g.actual_value}/${g.target_value}`
          : `?/${g.target_value}`;

        console.log(`    ${statusEmoji} ${g.goal_type}: ${progress} - ${g.target_description || ''}`);
      }
    }
  }

  console.log("\n");
  db.close();
  process.exit(0);
}

if (command === "set") {
  const pod = args[1];
  const goalType = args[2];
  const target = parseInt(args[3]);
  const description = args[4] || null;

  if (!pod || !goalType || isNaN(target)) {
    console.error("Error: pod, type, and target are required.");
    console.error("Usage: node scripts/setGoals.js set <pod> <type> <target> [description]");
    process.exit(1);
  }

  setQuarterlyGoal(db, QUARTER, pod, goalType, target, description);

  console.log(`\n🎯 Goal set successfully!`);
  console.log(`   Pod:    ${pod}`);
  console.log(`   Type:   ${goalType}`);
  console.log(`   Target: ${target}`);
  if (description) console.log(`   Description: ${description}`);
  console.log("");

  db.close();
  process.exit(0);
}

if (command === "update") {
  const pod = args[1];
  const goalType = args[2];
  const actual = parseInt(args[3]);
  const status = args[4] || null;

  if (!pod || !goalType || isNaN(actual)) {
    console.error("Error: pod, type, and actual value are required.");
    console.error("Usage: node scripts/setGoals.js update <pod> <type> <actual> [status]");
    process.exit(1);
  }

  updateGoalProgress(db, QUARTER, pod, goalType, actual, status);

  console.log(`\n📊 Goal updated!`);
  console.log(`   Pod:    ${pod}`);
  console.log(`   Type:   ${goalType}`);
  console.log(`   Actual: ${actual}`);
  if (status) console.log(`   Status: ${status}`);
  console.log("");

  db.close();
  process.exit(0);
}

console.error(`Unknown command: ${command}`);
console.error("Run with --help for usage.");
db.close();
process.exit(1);
