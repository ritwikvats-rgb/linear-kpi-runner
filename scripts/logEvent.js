#!/usr/bin/env node
/**
 * Log Events for Q1 Analysis
 *
 * Capture blockers, wins, risks, and milestones as they happen
 * so you have precise data for Q1 retrospective.
 *
 * Usage:
 *   node scripts/logEvent.js blocker "API was down for 2 hours" --pod FTS --cycle C2
 *   node scripts/logEvent.js win "Launched new feature ahead of schedule" --pod Platform
 *   node scripts/logEvent.js risk "Key engineer on PTO next week" --pod GTS
 *   node scripts/logEvent.js milestone "C1 completed with 95% delivery" --cycle C1
 *
 * Event types: blocker, win, risk, milestone, note
 */

const {
  openHistoryDb,
  logEvent,
  logBlocker,
  logWin,
  logRisk,
  logMilestone,
  getEvents,
} = require("../agent/src/historicalDataService");

/* -------------------- CLI ARGS -------------------- */

const args = process.argv.slice(2);

// Show help
if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
  console.log(`
Log Events for Q1 Analysis

Usage:
  node scripts/logEvent.js <type> "<title>" [options]

Event Types:
  blocker    - Something blocking progress
  win        - A success or achievement
  risk       - A potential issue or concern
  milestone  - A significant checkpoint
  note       - General observation

Options:
  --pod <name>        Pod this relates to (FTS, GTS, etc.)
  --cycle <cycle>     Cycle this relates to (C1, C2, etc.)
  --impact <text>     Description of impact
  --desc <text>       Detailed description
  --date <YYYY-MM-DD> Date (defaults to today)
  --list              List recent events instead of logging

Examples:
  node scripts/logEvent.js blocker "Linear API rate limited" --pod FTS --cycle C2
  node scripts/logEvent.js win "Shipped cohort automation" --pod FTS --impact "Saves 2hrs/week"
  node scripts/logEvent.js milestone "C1 closed at 92% delivery" --cycle C1
  node scripts/logEvent.js --list --pod FTS
`);
  process.exit(0);
}

// List mode
if (args.includes("--list")) {
  const db = openHistoryDb();
  const podFilter = args.includes("--pod") ? args[args.indexOf("--pod") + 1] : null;
  const typeFilter = args.includes("--type") ? args[args.indexOf("--type") + 1] : null;

  let events = getEvents(db);

  if (podFilter) {
    events = events.filter(e => e.pod === podFilter);
  }
  if (typeFilter) {
    events = events.filter(e => e.event_type === typeFilter);
  }

  console.log("\n📋 Recent Events");
  console.log("-".repeat(60));

  if (events.length === 0) {
    console.log("  No events found. Start logging!");
  } else {
    for (const e of events.slice(0, 20)) {
      const typeEmoji = {
        blocker: "🚧",
        win: "🎉",
        risk: "⚠️",
        milestone: "🏁",
        note: "📝",
      }[e.event_type] || "📌";

      console.log(`\n  ${typeEmoji} [${e.event_date}] ${e.event_type.toUpperCase()}`);
      console.log(`     ${e.title}`);
      if (e.pod) console.log(`     Pod: ${e.pod}`);
      if (e.cycle) console.log(`     Cycle: ${e.cycle}`);
      if (e.impact) console.log(`     Impact: ${e.impact}`);
      if (e.description) console.log(`     Details: ${e.description}`);
    }
  }

  console.log("\n");
  db.close();
  process.exit(0);
}

// Parse event type and title
const eventType = args[0];
const title = args[1];

if (!eventType || !title) {
  console.error("Error: Event type and title are required.");
  console.error("Run with --help for usage.");
  process.exit(1);
}

const validTypes = ["blocker", "win", "risk", "milestone", "note"];
if (!validTypes.includes(eventType.toLowerCase())) {
  console.error(`Error: Invalid event type "${eventType}".`);
  console.error(`Valid types: ${validTypes.join(", ")}`);
  process.exit(1);
}

// Parse options
const options = {};

const podIdx = args.indexOf("--pod");
if (podIdx !== -1 && args[podIdx + 1]) {
  options.pod = args[podIdx + 1];
}

const cycleIdx = args.indexOf("--cycle");
if (cycleIdx !== -1 && args[cycleIdx + 1]) {
  options.cycle = args[cycleIdx + 1];
}

const impactIdx = args.indexOf("--impact");
if (impactIdx !== -1 && args[impactIdx + 1]) {
  options.impact = args[impactIdx + 1];
}

const descIdx = args.indexOf("--desc");
if (descIdx !== -1 && args[descIdx + 1]) {
  options.description = args[descIdx + 1];
}

const dateIdx = args.indexOf("--date");
if (dateIdx !== -1 && args[dateIdx + 1]) {
  options.date = args[dateIdx + 1];
}

/* -------------------- LOG EVENT -------------------- */

const db = openHistoryDb();

const typeEmoji = {
  blocker: "🚧",
  win: "🎉",
  risk: "⚠️",
  milestone: "🏁",
  note: "📝",
}[eventType.toLowerCase()];

logEvent(db, eventType.toLowerCase(), title, options);

console.log(`\n${typeEmoji} Event logged successfully!`);
console.log(`   Type:  ${eventType}`);
console.log(`   Title: ${title}`);
if (options.pod) console.log(`   Pod:   ${options.pod}`);
if (options.cycle) console.log(`   Cycle: ${options.cycle}`);
if (options.impact) console.log(`   Impact: ${options.impact}`);
console.log("");

db.close();
