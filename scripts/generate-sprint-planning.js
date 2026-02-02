#!/usr/bin/env node
/* scripts/generate-sprint-planning.js
 * Generate sprint planning CSV from config
 *
 * Usage:
 *   node scripts/generate-sprint-planning.js FTS C3 --leaves 4
 *   node scripts/generate-sprint-planning.js FTS C3 --output ./my-plan.csv
 */

const path = require("path");
const fs = require("fs");

// Load from agent/src
const capacityCalculator = require("../agent/src/capacityCalculator");

function main() {
  const args = process.argv.slice(2);

  if (args.length < 2 || args.includes("--help")) {
    console.log(`
Sprint Planning CSV Generator
=============================

Usage: node scripts/generate-sprint-planning.js <team> <cycle> [options]

Arguments:
  team     Team name (e.g., FTS, ML, Platform)
  cycle    Cycle name (e.g., C1, C2, C3)

Options:
  --leaves <number>    Total leave days for this cycle (default: 0)
  --output <path>      Output file path (default: stdout)
  --format <type>      Output format: csv or text (default: csv)
  --quarterly          Generate quarterly summary instead

Examples:
  node scripts/generate-sprint-planning.js FTS C3
  node scripts/generate-sprint-planning.js FTS C3 --leaves 4
  node scripts/generate-sprint-planning.js FTS C3 --output ./FTS_C3.csv
  node scripts/generate-sprint-planning.js FTS --quarterly
`);
    process.exit(0);
  }

  const teamName = args[0];
  const cycleName = args[1];

  // Parse options
  let leaveDays = 0;
  let outputPath = null;
  let format = "csv";
  let quarterly = false;

  for (let i = 2; i < args.length; i++) {
    if (args[i] === "--leaves" && args[i + 1]) {
      leaveDays = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === "--output" && args[i + 1]) {
      outputPath = args[i + 1];
      i++;
    } else if (args[i] === "--format" && args[i + 1]) {
      format = args[i + 1];
      i++;
    } else if (args[i] === "--quarterly") {
      quarterly = true;
    }
  }

  try {
    let output;

    if (quarterly) {
      // Generate quarterly summary
      const result = capacityCalculator.calculateQuarterlyCapacity(teamName);
      output = formatQuarterly(result);
    } else if (format === "text") {
      // Generate text summary
      const capacity = capacityCalculator.calculateCapacity(teamName, { leaveDays, cycleName });
      output = capacityCalculator.formatCapacityText(capacity);
    } else {
      // Generate CSV
      output = capacityCalculator.generateSprintPlanningCSV(teamName, cycleName, { leaveDays });
    }

    if (outputPath) {
      fs.writeFileSync(outputPath, output);
      console.log(`Generated: ${outputPath}`);
    } else {
      console.log(output);
    }
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

function formatQuarterly(result) {
  const lines = [];
  lines.push(`${result.teamName} QUARTERLY CAPACITY - ${result.quarter}`);
  lines.push("");
  lines.push("Cycle,Gross Days,Leave Days,On-Call Deduction,Available SP,Roadmap,Adhoc");

  result.cycles.forEach(c => {
    lines.push(`${c.cycleName},${c.grossWorkingDays},${c.leaveDays},${c.onCallDeduction},${c.availableSP},${c.roadmapBudget},${c.adhocBudget}`);
  });

  lines.push("");
  lines.push(`TOTALS,${result.totals.grossWorkingDays},${result.totals.leaveDays},${result.totals.onCallDeduction},${result.totals.availableSP},${result.totals.roadmapBudget},${result.totals.adhocBudget}`);

  return lines.join("\n");
}

main();
