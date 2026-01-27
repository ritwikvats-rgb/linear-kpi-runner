#!/usr/bin/env node
/**
 * Capture Context for Q1 Analysis
 *
 * Pulls in qualitative data from Linear and Slack to complement KPI metrics.
 * Run this weekly alongside your KPI script.
 *
 * Usage:
 *   node scripts/captureContext.js                  # Capture all context
 *   node scripts/captureContext.js --pod FTS        # Capture for specific pod
 *   node scripts/captureContext.js --slack          # Include Slack capture
 *   node scripts/captureContext.js --summary        # Show what's captured
 */

require("dotenv").config();

const {
  openContextDb,
  captureAllContext,
  captureDELComments,
  captureSlackMessages,
  captureSlackForAllProjects,
  getContextSummary,
  getBlockerComments,
  getRiskComments,
} = require("../agent/src/contextCaptureService");

const { loadPodsConfig } = require("../agent/src/shared/podsUtils");

/* -------------------- CLI ARGS -------------------- */

const args = process.argv.slice(2);
const showSummary = args.includes("--summary");
const includeSlack = args.includes("--slack");
const podFilter = args.includes("--pod") ? args[args.indexOf("--pod") + 1] : null;

/* -------------------- SLACK CONFIG -------------------- */

// Slack channels are automatically detected from Linear project labels!
// If a project has a label that matches Slack channel ID format (e.g., "C0A738HAPEC"),
// it will automatically capture messages from that channel.

/* -------------------- MAIN -------------------- */

async function main() {
  console.log("\n" + "=".repeat(60));
  console.log("  CONTEXT CAPTURE FOR Q1 ANALYSIS");
  console.log("  " + new Date().toISOString());
  console.log("=".repeat(60) + "\n");

  const db = openContextDb();

  // Show summary mode
  if (showSummary) {
    showContextSummary(db);
    db.close();
    return;
  }

  // Capture Linear context
  console.log("📋 Capturing Linear comments and DEL details...\n");

  if (podFilter) {
    // Single pod capture
    const podsConfig = loadPodsConfig();
    const pod = podsConfig?.pods?.[podFilter];

    if (!pod || !pod.teamId) {
      console.error(`Pod "${podFilter}" not found or has no teamId`);
      process.exit(1);
    }

    const result = await captureDELComments(db, podFilter, pod.teamId);
    console.log(`\n✅ ${podFilter}: ${result.captured} comments from ${result.issues} DEL issues`);
  } else {
    // All pods
    const result = await captureAllContext();
    console.log("\nLinear capture complete:");
    for (const [pod, data] of Object.entries(result.pods)) {
      if (data.error) {
        console.log(`  ❌ ${pod}: ${data.error}`);
      } else {
        console.log(`  ✅ ${pod}: ${data.captured} comments from ${data.issues || 0} issues`);
      }
    }
  }

  // Capture Slack if requested
  if (includeSlack) {
    console.log("\n📱 Capturing Slack messages...\n");

    const slackToken = process.env.SLACK_BOT_TOKEN;
    if (!slackToken) {
      console.log("⚠️  SLACK_BOT_TOKEN not set. Add it to .env to enable Slack capture.");
      console.log("   Get a token from: https://api.slack.com/apps\n");
    } else {
      // Automatically capture from all projects that have Slack channel labels
      console.log("  Auto-detecting project-to-channel mappings from Linear labels...\n");

      const slackResult = await captureSlackForAllProjects(db, {
        limit: 200,
        includeThreads: true,
      });

      if (slackResult.error) {
        console.log(`  ❌ Slack capture error: ${slackResult.error}`);
      } else {
        console.log(`\n  Slack capture results:`);
        for (const p of slackResult.projects) {
          if (p.error) {
            console.log(`    ❌ ${p.project}: ${p.error}`);
          } else {
            console.log(`    ✅ ${p.project}: ${p.captured} messages`);
          }
        }
        console.log(`\n  Total Slack messages: ${slackResult.total_captured}`);
      }
    }
  }

  // Show summary
  console.log("\n" + "-".repeat(60));
  showContextSummary(db);

  db.close();
}

function showContextSummary(db) {
  const summary = getContextSummary(db);

  console.log("\n📊 CONTEXT SUMMARY");
  console.log("=".repeat(40));
  console.log(`  Total Linear comments:   ${summary.total_comments}`);
  console.log(`  Total DEL issues:        ${summary.total_del_issues}`);
  console.log(`  Total Slack messages:    ${summary.total_slack_messages}`);
  console.log();
  console.log(`  🚧 Blockers mentioned:   ${summary.blockers_mentioned}`);
  console.log(`  ⚠️  Risks mentioned:      ${summary.risks_mentioned}`);
  console.log(`  ✅ Decisions captured:   ${summary.decisions_made}`);

  if (Object.keys(summary.by_pod).length > 0) {
    console.log("\n  BY POD:");
    for (const [pod, data] of Object.entries(summary.by_pod)) {
      console.log(`    ${pod}: ${data.comments} comments (${data.blockers} blockers, ${data.risks} risks)`);
    }
  }

  // Show recent blockers
  const recentBlockers = getBlockerComments(db).slice(0, 5);
  if (recentBlockers.length > 0) {
    console.log("\n  RECENT BLOCKERS:");
    for (const b of recentBlockers) {
      const preview = (b.body || "").substring(0, 60).replace(/\n/g, " ");
      console.log(`    [${b.issue_identifier}] ${preview}...`);
    }
  }

  // Show recent risks
  const recentRisks = getRiskComments(db).slice(0, 5);
  if (recentRisks.length > 0) {
    console.log("\n  RECENT RISKS:");
    for (const r of recentRisks) {
      const preview = (r.body || "").substring(0, 60).replace(/\n/g, " ");
      console.log(`    [${r.issue_identifier}] ${preview}...`);
    }
  }

  console.log();
}

/* -------------------- RUN -------------------- */

main().catch(err => {
  console.error("Error:", err.message);
  process.exit(1);
});
