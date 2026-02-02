/* agent/src/capacityCalculator.js
 * Sprint capacity calculator using 1 SP = 1 working day methodology
 * Reads from config/sprint_capacity.json
 */
const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "../..");
const CONFIG_PATH = path.resolve(REPO_ROOT, "config/sprint_capacity.json");
const CYCLE_CALENDAR_PATH = path.resolve(REPO_ROOT, "config/cycle_calendar.json");

/**
 * Load sprint capacity config
 */
function loadCapacityConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error("Sprint capacity config not found: config/sprint_capacity.json");
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

/**
 * Load cycle calendar config
 */
function loadCycleCalendar() {
  if (!fs.existsSync(CYCLE_CALENDAR_PATH)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(CYCLE_CALENDAR_PATH, "utf8"));
}

/**
 * Calculate capacity for a team in a specific cycle
 * @param {string} teamName - Team/pod name (e.g., "FTS")
 * @param {object} options - { leaveDays: number, cycleName: string }
 * @returns {object} Capacity breakdown
 */
function calculateCapacity(teamName, options = {}) {
  const config = loadCapacityConfig();
  const team = config.teams[teamName];

  if (!team) {
    throw new Error(`Team not found: ${teamName}. Available: ${Object.keys(config.teams).join(", ")}`);
  }

  const { leaveDays = 0, cycleName = "C1" } = options;
  const { workingDaysPerCycle } = config.quarter;
  const { roadmapPercent, adhocPercent } = config.allocation;
  const { primaryPercent, backupPercent } = config.onCallDeductions;

  // Team composition
  const members = team.members || [];
  const beCount = members.filter(m => m.role === "BE").length;
  const feCount = members.filter(m => m.role === "FE").length;
  const teamSize = members.length;

  // Gross working days
  const grossWorkingDays = teamSize * workingDaysPerCycle;

  // On-call deductions
  const { bePrimary = 0, beBackup = 0, fePrimary = 0, feBackup = 0 } = team.onCallRoles || {};
  const primaryDeduction = (bePrimary + fePrimary) * workingDaysPerCycle * (primaryPercent / 100);
  const backupDeduction = (beBackup + feBackup) * workingDaysPerCycle * (backupPercent / 100);
  const totalOnCallDeduction = Math.round(primaryDeduction + backupDeduction);

  // Available SP
  const availableSP = grossWorkingDays - leaveDays - totalOnCallDeduction;

  // Allocation
  const roadmapBudget = Math.round(availableSP * (roadmapPercent / 100));
  const adhocBudget = Math.round(availableSP * (adhocPercent / 100));

  return {
    teamName,
    cycleName,
    quarter: config.quarter.name,

    // Team composition
    teamSize,
    beCount,
    feCount,

    // Capacity
    workingDaysPerCycle,
    grossWorkingDays,
    leaveDays,
    onCallDeduction: totalOnCallDeduction,
    availableSP,

    // Allocation
    roadmapBudget,
    adhocBudget,
    roadmapPercent,
    adhocPercent,

    // On-call breakdown
    onCallBreakdown: {
      bePrimary: bePrimary * workingDaysPerCycle * (primaryPercent / 100),
      beBackup: beBackup * workingDaysPerCycle * (backupPercent / 100),
      fePrimary: fePrimary * workingDaysPerCycle * (primaryPercent / 100),
      feBackup: feBackup * workingDaysPerCycle * (backupPercent / 100),
    },

    // Formulas used (for documentation)
    formulas: config.formulas,
  };
}

/**
 * Calculate quarterly totals for a team
 * @param {string} teamName - Team/pod name
 * @param {object} cycleLeaves - { C1: 2, C2: 0, C3: 4, ... }
 */
function calculateQuarterlyCapacity(teamName, cycleLeaves = {}) {
  const config = loadCapacityConfig();
  const { cycles } = config.quarter;

  const cycleResults = [];
  let totalGross = 0;
  let totalLeaves = 0;
  let totalOnCall = 0;
  let totalAvailable = 0;
  let totalRoadmap = 0;
  let totalAdhoc = 0;

  for (let i = 1; i <= cycles; i++) {
    const cycleName = `C${i}`;
    const leaveDays = cycleLeaves[cycleName] || 0;
    const result = calculateCapacity(teamName, { leaveDays, cycleName });

    cycleResults.push(result);
    totalGross += result.grossWorkingDays;
    totalLeaves += result.leaveDays;
    totalOnCall += result.onCallDeduction;
    totalAvailable += result.availableSP;
    totalRoadmap += result.roadmapBudget;
    totalAdhoc += result.adhocBudget;
  }

  return {
    teamName,
    quarter: config.quarter.name,
    cycles: cycleResults,
    totals: {
      grossWorkingDays: totalGross,
      leaveDays: totalLeaves,
      onCallDeduction: totalOnCall,
      availableSP: totalAvailable,
      roadmapBudget: totalRoadmap,
      adhocBudget: totalAdhoc,
    },
  };
}

/**
 * Get adhoc budget breakdown
 */
function getAdhocBreakdown(teamName) {
  const config = loadCapacityConfig();
  const capacity = calculateCapacity(teamName);
  const adhocBudget = capacity.adhocBudget;

  // If only one category, use full adhoc budget
  if (config.adhocCategories.length === 1) {
    return [{
      name: config.adhocCategories[0].name,
      reason: config.adhocCategories[0].reason || "",
      allocatedSP: adhocBudget,
    }];
  }

  // Scale default adhoc categories to fit actual budget
  const defaultTotal = config.adhocCategories.reduce((sum, cat) => sum + cat.defaultSP, 0);
  const scale = adhocBudget / defaultTotal;

  return config.adhocCategories.map(cat => ({
    name: cat.name,
    reason: cat.reason || "",
    allocatedSP: Math.round(cat.defaultSP * scale),
  }));
}

/**
 * Generate sprint planning CSV content
 * @param {string} teamName - Team name
 * @param {string} cycleName - Cycle name (e.g., "C3")
 * @param {object} options - { leaveDays, leaves: [{name, days}], onCallRotation: [{role, name}] }
 */
function generateSprintPlanningCSV(teamName, cycleName, options = {}) {
  const config = loadCapacityConfig();
  const cycleCalendar = loadCycleCalendar();
  const capacity = calculateCapacity(teamName, {
    leaveDays: options.leaveDays || 0,
    cycleName
  });

  // Get cycle dates if available
  let cycleStart = "TBD";
  let cycleEnd = "TBD";
  if (cycleCalendar?.pods?.[teamName]?.[cycleName]) {
    const cycle = cycleCalendar.pods[teamName][cycleName];
    cycleStart = cycle.start.split("T")[0];
    cycleEnd = cycle.end.split("T")[0];
  }

  const team = config.teams[teamName];
  const members = team?.members || [];

  // Build CSV content
  const lines = [];

  // Header
  lines.push(`${teamName} SPRINT PLANNING - ${cycleName} (${cycleStart} to ${cycleEnd})`);
  lines.push("");

  // Methodology section
  lines.push("METHODOLOGY");
  lines.push("1 SP (Story Point) is equal to 1 working day of effort for 1 person");
  lines.push(`Working days per cycle: ${capacity.workingDaysPerCycle}`);
  lines.push(`Allocation: ${capacity.roadmapPercent}% Roadmap / ${capacity.adhocPercent}% Adhoc`);
  lines.push("");

  // Capacity calculation
  lines.push("CAPACITY CALCULATION");
  lines.push("Metric,Value,Formula");
  lines.push(`Team Size,${capacity.teamSize},BE: ${capacity.beCount} + FE: ${capacity.feCount}`);
  lines.push(`Gross Working Days,${capacity.grossWorkingDays},${capacity.teamSize} x ${capacity.workingDaysPerCycle}`);
  lines.push(`Leave Days,${capacity.leaveDays},Sum of all planned leaves`);
  lines.push(`On-Call Deduction,${capacity.onCallDeduction},Primary (40%) + Backup (20%)`);
  lines.push(`Available SP,${capacity.availableSP},${capacity.grossWorkingDays} - ${capacity.leaveDays} - ${capacity.onCallDeduction}`);
  lines.push("");

  // Allocation
  lines.push("SP ALLOCATION");
  lines.push("Category,SP,Percentage");
  lines.push(`Roadmap Budget,${capacity.roadmapBudget},${capacity.roadmapPercent}%`);
  lines.push(`Adhoc Budget,${capacity.adhocBudget},${capacity.adhocPercent}%`);
  lines.push(`Total,${capacity.availableSP},100%`);
  lines.push("");

  // On-call deduction breakdown
  lines.push("ON-CALL DEDUCTION BREAKDOWN");
  lines.push("Role,Deduction SP,Calculation");
  lines.push(`BE Primary,${capacity.onCallBreakdown.bePrimary},${capacity.workingDaysPerCycle} x 40%`);
  lines.push(`BE Backup,${capacity.onCallBreakdown.beBackup},${capacity.workingDaysPerCycle} x 20%`);
  lines.push(`FE Primary,${capacity.onCallBreakdown.fePrimary},${capacity.workingDaysPerCycle} x 40%`);
  lines.push(`FE Backup,${capacity.onCallBreakdown.feBackup},${capacity.workingDaysPerCycle} x 20%`);
  lines.push(`Total,${capacity.onCallDeduction},`);
  lines.push("");

  // Team members
  lines.push("TEAM MEMBERS");
  lines.push("Name,Role,Available Days,Leave Days,On-Call Role,Net SP");
  members.forEach(m => {
    lines.push(`${m.name},${m.role},${m.availableDaysPerCycle},0,,${m.availableDaysPerCycle}`);
  });
  lines.push("");

  // Adhoc breakdown - for FTS, all adhoc goes to "Adhoc BW"
  lines.push("WHAT ADHOC COVERS");
  lines.push("Category,SP Allocated,Why This Amount");
  config.adhocCategories.forEach(cat => {
    // Use actual adhoc budget from capacity (accounts for leaves)
    const sp = config.adhocCategories.length === 1 ? capacity.adhocBudget : cat.defaultSP;
    lines.push(`${cat.name},${sp},"${cat.reason || ''}"`);
  });
  lines.push(`TOTAL ADHOC,${capacity.adhocBudget},`);
  lines.push("");

  // Execution tracker placeholder
  lines.push("ROADMAP TICKETS");
  lines.push("Ticket ID,Initiative,Owner,SP,Status,Completed,Spillover Reason");
  lines.push("(Add tickets here),,,,Backlog,No,");
  lines.push("");

  // Summary metrics placeholder
  lines.push("EXECUTION SUMMARY");
  lines.push("Metric,Committed,Completed,Rate");
  lines.push("Roadmap,,,");
  lines.push("Adhoc,,,");
  lines.push("Total,,,");

  return lines.join("\n");
}

/**
 * Format capacity as readable text
 */
function formatCapacityText(capacity) {
  return `
${capacity.teamName} Sprint Capacity - ${capacity.cycleName}
${"=".repeat(40)}

Team Size: ${capacity.teamSize} (BE: ${capacity.beCount}, FE: ${capacity.feCount})
Working Days/Cycle: ${capacity.workingDaysPerCycle}

CAPACITY CALCULATION:
  Gross Working Days: ${capacity.grossWorkingDays} (${capacity.teamSize} x ${capacity.workingDaysPerCycle})
  - Leave Days: ${capacity.leaveDays}
  - On-Call Deduction: ${capacity.onCallDeduction}
  = Available SP: ${capacity.availableSP}

SP ALLOCATION:
  Roadmap (${capacity.roadmapPercent}%): ${capacity.roadmapBudget} SP
  Adhoc (${capacity.adhocPercent}%): ${capacity.adhocBudget} SP
  Total: ${capacity.availableSP} SP
`.trim();
}

module.exports = {
  loadCapacityConfig,
  calculateCapacity,
  calculateQuarterlyCapacity,
  getAdhocBreakdown,
  generateSprintPlanningCSV,
  formatCapacityText,
};
