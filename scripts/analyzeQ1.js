#!/usr/bin/env node
/**
 * Q1 2026 Analysis Script
 *
 * Run this at the end of Q1 to get precise answers about:
 * - What went well
 * - What went wrong
 * - Trends over time
 * - Pod rankings
 * - Actionable recommendations
 *
 * Usage:
 *   node scripts/analyzeQ1.js                    # Full analysis
 *   node scripts/analyzeQ1.js --json             # Output as JSON
 *   node scripts/analyzeQ1.js --pod FTS          # Analyze specific pod
 *   node scripts/analyzeQ1.js --cycle C3         # Analyze specific cycle
 */

const fs = require("fs");
const path = require("path");
const {
  openHistoryDb,
  generateQ1Analysis,
  getWeeklyTrend,
  getCycleClosings,
  getEvents,
  getQuarterlyGoals,
} = require("../agent/src/historicalDataService");

const {
  openContextDb,
  getBlockerComments,
  getRiskComments,
  getDecisionComments,
  getDELIssues,
  getSlackMessages,
  getContextSummary,
} = require("../agent/src/contextCaptureService");

const OUT_DIR = path.join(process.cwd(), "out");

/* -------------------- CLI ARGS -------------------- */

const args = process.argv.slice(2);
const jsonOutput = args.includes("--json");
const podFilter = args.includes("--pod") ? args[args.indexOf("--pod") + 1] : null;
const cycleFilter = args.includes("--cycle") ? args[args.indexOf("--cycle") + 1] : null;

/* -------------------- MAIN -------------------- */

function main() {
  const db = openHistoryDb();
  const contextDb = openContextDb();

  console.log("\n" + "=".repeat(60));
  console.log("  Q1 2026 ANALYSIS REPORT");
  console.log("  Generated: " + new Date().toISOString());
  console.log("=".repeat(60) + "\n");

  // Generate full analysis
  const analysis = generateQ1Analysis(db);

  // Enrich with context data
  const contextSummary = getContextSummary(contextDb);
  const blockerComments = getBlockerComments(contextDb, podFilter);
  const riskComments = getRiskComments(contextDb, podFilter);
  const decisionComments = getDecisionComments(contextDb, podFilter);
  const delIssues = getDELIssues(contextDb, podFilter);

  analysis.context = {
    summary: contextSummary,
    blockers: blockerComments.slice(0, 20),
    risks: riskComments.slice(0, 20),
    decisions: decisionComments.slice(0, 20),
    del_issues_count: delIssues.length,
  };

  if (jsonOutput) {
    const outputPath = path.join(OUT_DIR, "q1_analysis.json");
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(analysis, null, 2));
    console.log(`Analysis saved to: ${outputPath}`);
    db.close();
    contextDb.close();
    return;
  }

  // Print summary
  printSummary(analysis.summary);

  // Print context summary
  printContextSummary(analysis.context);

  // Print what went well
  printWentWell(analysis.went_well, podFilter);

  // Print what went wrong (enriched with context)
  printWentWrong(analysis.went_wrong, podFilter, analysis.context);

  // Print trends
  printTrends(analysis.trends);

  // Print pod rankings
  printPodRankings(analysis.pod_rankings, podFilter);

  // Print key decisions
  printDecisions(analysis.context.decisions, podFilter);

  // Print recommendations
  printRecommendations(analysis.recommendations, podFilter);

  // Save full report
  saveMarkdownReport(analysis);

  db.close();
  contextDb.close();
}

/* -------------------- PRINT FUNCTIONS -------------------- */

function printSummary(summary) {
  console.log("📊 SUMMARY");
  console.log("-".repeat(40));
  console.log(`  Cycles completed:  ${summary.total_cycles_completed}`);
  console.log(`  Events logged:     ${summary.total_events_logged}`);
  console.log(`  Blockers tracked:  ${summary.blockers_count}`);
  console.log(`  Wins celebrated:   ${summary.wins_count}`);
  console.log(`  Goals met:         ${summary.goals_met} / ${summary.goals_total}`);
  console.log();
}

function printContextSummary(context) {
  console.log("📝 CAPTURED CONTEXT");
  console.log("-".repeat(40));
  console.log(`  Linear comments:     ${context.summary.total_comments}`);
  console.log(`  DEL issues tracked:  ${context.del_issues_count}`);
  console.log(`  Slack messages:      ${context.summary.total_slack_messages}`);
  console.log(`  Blockers found:      ${context.summary.blockers_mentioned}`);
  console.log(`  Risks mentioned:     ${context.summary.risks_mentioned}`);
  console.log(`  Decisions captured:  ${context.summary.decisions_made}`);

  if (Object.keys(context.summary.by_pod).length > 0) {
    console.log("\n  By Pod:");
    for (const [pod, data] of Object.entries(context.summary.by_pod)) {
      console.log(`    ${pod}: ${data.comments} comments (${data.blockers} blockers, ${data.risks} risks)`);
    }
  }
  console.log();
}

function printWentWell(wentWell, podFilter) {
  console.log("✅ WHAT WENT WELL");
  console.log("-".repeat(40));

  // High performers
  if (wentWell.high_performers.length > 0) {
    console.log("\n  🏆 High Performers (>80% delivery):");
    for (const p of wentWell.high_performers) {
      if (podFilter && p.pod !== podFilter) continue;
      console.log(`     ${p.pod}: ${p.avg_delivery}% avg over ${p.weeks_tracked} weeks`);
    }
  }

  // Improving pods
  if (wentWell.improving_pods.length > 0) {
    console.log("\n  📈 Improving Pods:");
    for (const p of wentWell.improving_pods) {
      if (podFilter && p.pod !== podFilter) continue;
      console.log(`     ${p.pod}: +${p.improvement}% (${p.from}% → ${p.to}%)`);
    }
  }

  // Goals achieved
  if (wentWell.goals_achieved.length > 0) {
    console.log("\n  🎯 Goals Achieved:");
    for (const g of wentWell.goals_achieved) {
      if (podFilter && g.pod !== podFilter) continue;
      console.log(`     ${g.pod} - ${g.goal_type}: ${g.actual}/${g.target}`);
    }
  }

  // Wins
  if (wentWell.wins.length > 0) {
    console.log("\n  🎉 Wins:");
    for (const w of wentWell.wins.slice(0, 10)) {
      if (podFilter && w.pod !== podFilter) continue;
      console.log(`     [${w.date}] ${w.pod || 'All'}: ${w.title}`);
    }
  }

  // Milestones
  if (wentWell.milestones.length > 0) {
    console.log("\n  🏁 Milestones:");
    for (const m of wentWell.milestones.slice(0, 10)) {
      if (podFilter && m.pod !== podFilter) continue;
      console.log(`     [${m.date}] ${m.pod || 'All'}: ${m.title}`);
    }
  }

  if (!wentWell.high_performers.length && !wentWell.improving_pods.length &&
      !wentWell.goals_achieved.length && !wentWell.wins.length && !wentWell.milestones.length) {
    console.log("  No data yet. Keep capturing weekly snapshots and logging events!");
  }

  console.log();
}

function printWentWrong(wentWrong, podFilter, context = {}) {
  console.log("❌ WHAT WENT WRONG");
  console.log("-".repeat(40));

  // Low performers
  if (wentWrong.low_performers.length > 0) {
    console.log("\n  ⚠️ Low Performers (<50% delivery):");
    for (const p of wentWrong.low_performers) {
      if (podFilter && p.pod !== podFilter) continue;
      console.log(`     ${p.pod}: ${p.avg_delivery}% avg (lowest: ${p.lowest}%)`);
    }
  }

  // Declining pods
  if (wentWrong.declining_pods.length > 0) {
    console.log("\n  📉 Declining Pods:");
    for (const p of wentWrong.declining_pods) {
      if (podFilter && p.pod !== podFilter) continue;
      console.log(`     ${p.pod}: -${p.decline}% (${p.from}% → ${p.to}%)`);
    }
  }

  // High spillover
  if (wentWrong.high_spillover.length > 0) {
    console.log("\n  🔴 High Spillover (>30%):");
    for (const s of wentWrong.high_spillover) {
      if (podFilter && s.pod !== podFilter) continue;
      console.log(`     ${s.cycle} / ${s.pod}: ${s.spillover}/${s.committed} (${s.spillover_pct}%)`);
    }
  }

  // Logged blockers (from events)
  if (wentWrong.blockers.length > 0) {
    console.log("\n  🚧 Logged Blockers:");
    for (const b of wentWrong.blockers.slice(0, 10)) {
      if (podFilter && b.pod !== podFilter) continue;
      console.log(`     [${b.date}] ${b.pod || 'All'}: ${b.title}`);
      if (b.impact) console.log(`       Impact: ${b.impact}`);
    }
  }

  // Blockers from Linear comments (context)
  if (context.blockers && context.blockers.length > 0) {
    console.log("\n  💬 Blockers from Linear Comments:");
    for (const b of context.blockers.slice(0, 8)) {
      if (podFilter && b.pod !== podFilter) continue;
      const preview = (b.body || "").substring(0, 80).replace(/\n/g, " ");
      console.log(`     [${b.issue_identifier}] ${b.pod}: ${preview}...`);
      console.log(`       Author: ${b.author}, Date: ${b.created_at?.split('T')[0]}`);
    }
  }

  // Risks from Linear comments
  if (context.risks && context.risks.length > 0) {
    console.log("\n  ⚠️ Risks from Linear Comments:");
    for (const r of context.risks.slice(0, 5)) {
      if (podFilter && r.pod !== podFilter) continue;
      const preview = (r.body || "").substring(0, 80).replace(/\n/g, " ");
      console.log(`     [${r.issue_identifier}] ${r.pod}: ${preview}...`);
    }
  }

  // Goals missed
  if (wentWrong.goals_missed.length > 0) {
    console.log("\n  ❎ Goals Missed:");
    for (const g of wentWrong.goals_missed) {
      if (podFilter && g.pod !== podFilter) continue;
      console.log(`     ${g.pod} - ${g.goal_type}: ${g.actual || 0}/${g.target} (gap: ${g.gap})`);
    }
  }

  // Features stuck
  if (wentWrong.features_stuck.length > 0) {
    console.log("\n  🔒 Features Stuck:");
    for (const f of wentWrong.features_stuck) {
      if (podFilter && f.pod !== podFilter) continue;
      console.log(`     ${f.pod}: ${f.planned} planned, ${f.done} done, ${f.in_flight} in-flight`);
    }
  }

  const hasIssues = wentWrong.low_performers.length || wentWrong.declining_pods.length ||
      wentWrong.high_spillover.length || wentWrong.blockers.length ||
      wentWrong.goals_missed.length || wentWrong.features_stuck.length ||
      (context.blockers && context.blockers.length);

  if (!hasIssues) {
    console.log("  No major issues detected. Great job!");
  }

  console.log();
}

function printTrends(trends) {
  console.log("📈 TRENDS OVER TIME");
  console.log("-".repeat(40));

  if (trends.overall_delivery_trend.length > 0) {
    console.log("\n  Delivery % Trend:");
    for (const t of trends.overall_delivery_trend) {
      const bar = "█".repeat(Math.floor(t.delivery_pct / 5));
      console.log(`     ${t.date}: ${bar} ${t.delivery_pct}%`);
    }
  }

  if (trends.feature_completion_trend.length > 0) {
    console.log("\n  Feature Completion Trend:");
    for (const t of trends.feature_completion_trend) {
      console.log(`     ${t.date}: ${t.features_done}/${t.features_total} (${t.completion_pct}%)`);
    }
  }

  if (trends.overall_delivery_trend.length === 0) {
    console.log("  No trend data yet. Run weekly KPI scripts to build history.");
  }

  console.log();
}

function printPodRankings(rankings, podFilter) {
  console.log("🏅 POD RANKINGS");
  console.log("-".repeat(40));

  if (rankings.length === 0) {
    console.log("  No ranking data yet.");
    console.log();
    return;
  }

  console.log("\n  Rank | Pod               | Avg Delivery | Spillover | Score");
  console.log("  " + "-".repeat(60));

  let rank = 1;
  for (const p of rankings) {
    if (podFilter && p.pod !== podFilter) continue;
    const medal = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : "  ";
    console.log(`  ${medal} ${rank}.  ${p.pod.padEnd(17)} | ${String(p.avg_delivery).padStart(11)}% | ${String(p.avg_spillover_pct).padStart(8)}% | ${p.score}`);
    rank++;
  }

  console.log();
}

function printDecisions(decisions, podFilter) {
  console.log("📋 KEY DECISIONS (from Linear comments)");
  console.log("-".repeat(40));

  if (!decisions || decisions.length === 0) {
    console.log("  No decisions captured yet. Decisions are detected from keywords like");
    console.log("  'decided', 'agreed', 'confirmed', 'approved' in Linear comments.");
    console.log();
    return;
  }

  const filtered = podFilter ? decisions.filter(d => d.pod === podFilter) : decisions;

  for (const d of filtered.slice(0, 10)) {
    const preview = (d.body || "").substring(0, 100).replace(/\n/g, " ");
    console.log(`\n  [${d.issue_identifier}] ${d.pod || 'Unknown'}`);
    console.log(`    "${preview}..."`);
    console.log(`    - ${d.author}, ${d.created_at?.split('T')[0]}`);
  }

  console.log();
}

function printRecommendations(recommendations, podFilter) {
  console.log("💡 RECOMMENDATIONS");
  console.log("-".repeat(40));

  if (recommendations.length === 0) {
    console.log("  No specific recommendations. Keep tracking data!");
    console.log();
    return;
  }

  const high = recommendations.filter(r => r.priority === 'high' && (!podFilter || r.pod === podFilter));
  const medium = recommendations.filter(r => r.priority === 'medium' && (!podFilter || r.pod === podFilter));
  const low = recommendations.filter(r => r.priority === 'low' && (!podFilter || r.pod === podFilter));

  if (high.length > 0) {
    console.log("\n  🔴 HIGH PRIORITY:");
    for (const r of high) {
      console.log(`     • ${r.recommendation}`);
    }
  }

  if (medium.length > 0) {
    console.log("\n  🟡 MEDIUM PRIORITY:");
    for (const r of medium) {
      console.log(`     • ${r.recommendation}`);
    }
  }

  if (low.length > 0) {
    console.log("\n  🟢 RECOGNITION:");
    for (const r of low) {
      console.log(`     • ${r.recommendation}`);
    }
  }

  console.log();
}

/* -------------------- SAVE MARKDOWN -------------------- */

function saveMarkdownReport(analysis) {
  const md = [];

  md.push("# Q1 2026 Analysis Report");
  md.push(`Generated: ${analysis.generated_at}`);
  md.push("");

  // Summary
  md.push("## Summary");
  md.push(`- Cycles completed: ${analysis.summary.total_cycles_completed}`);
  md.push(`- Events logged: ${analysis.summary.total_events_logged}`);
  md.push(`- Blockers tracked: ${analysis.summary.blockers_count}`);
  md.push(`- Wins celebrated: ${analysis.summary.wins_count}`);
  md.push(`- Goals met: ${analysis.summary.goals_met}/${analysis.summary.goals_total}`);
  md.push("");

  // What went well
  md.push("## What Went Well");
  md.push("");

  if (analysis.went_well.high_performers.length > 0) {
    md.push("### High Performers (>80% delivery)");
    for (const p of analysis.went_well.high_performers) {
      md.push(`- **${p.pod}**: ${p.avg_delivery}% average over ${p.weeks_tracked} weeks`);
    }
    md.push("");
  }

  if (analysis.went_well.improving_pods.length > 0) {
    md.push("### Improving Pods");
    for (const p of analysis.went_well.improving_pods) {
      md.push(`- **${p.pod}**: +${p.improvement}% improvement (${p.from}% → ${p.to}%)`);
    }
    md.push("");
  }

  if (analysis.went_well.wins.length > 0) {
    md.push("### Wins");
    for (const w of analysis.went_well.wins) {
      md.push(`- [${w.date}] ${w.pod || 'All'}: ${w.title}`);
    }
    md.push("");
  }

  // What went wrong
  md.push("## What Went Wrong");
  md.push("");

  if (analysis.went_wrong.low_performers.length > 0) {
    md.push("### Low Performers (<50% delivery)");
    for (const p of analysis.went_wrong.low_performers) {
      md.push(`- **${p.pod}**: ${p.avg_delivery}% average (lowest: ${p.lowest}%)`);
    }
    md.push("");
  }

  if (analysis.went_wrong.high_spillover.length > 0) {
    md.push("### High Spillover (>30%)");
    for (const s of analysis.went_wrong.high_spillover) {
      md.push(`- **${s.cycle} / ${s.pod}**: ${s.spillover}/${s.committed} DELs (${s.spillover_pct}% spillover)`);
    }
    md.push("");
  }

  if (analysis.went_wrong.blockers.length > 0) {
    md.push("### Blockers");
    for (const b of analysis.went_wrong.blockers) {
      md.push(`- [${b.date}] ${b.pod || 'All'}: ${b.title}`);
      if (b.impact) md.push(`  - Impact: ${b.impact}`);
    }
    md.push("");
  }

  // Pod rankings
  md.push("## Pod Rankings");
  md.push("");
  md.push("| Rank | Pod | Avg Delivery | Spillover | Score |");
  md.push("|------|-----|-------------|-----------|-------|");
  let rank = 1;
  for (const p of analysis.pod_rankings) {
    md.push(`| ${rank} | ${p.pod} | ${p.avg_delivery}% | ${p.avg_spillover_pct}% | ${p.score} |`);
    rank++;
  }
  md.push("");

  // Recommendations
  md.push("## Recommendations");
  md.push("");

  const high = analysis.recommendations.filter(r => r.priority === 'high');
  const medium = analysis.recommendations.filter(r => r.priority === 'medium');

  if (high.length > 0) {
    md.push("### High Priority");
    for (const r of high) {
      md.push(`- ${r.recommendation}`);
    }
    md.push("");
  }

  if (medium.length > 0) {
    md.push("### Medium Priority");
    for (const r of medium) {
      md.push(`- ${r.recommendation}`);
    }
    md.push("");
  }

  // Save
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outputPath = path.join(OUT_DIR, "q1_analysis_report.md");
  fs.writeFileSync(outputPath, md.join("\n"));
  console.log("=".repeat(60));
  console.log(`📄 Full report saved to: ${outputPath}`);
  console.log("=".repeat(60));
}

/* -------------------- RUN -------------------- */

main();
