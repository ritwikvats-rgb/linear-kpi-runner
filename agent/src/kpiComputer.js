/* agent/src/kpiComputer.js
 * Computes KPI tables matching runWeeklyKpi.js output
 *
 * A) Pod-wise Cycle KPI table (DEL metrics)
 *    Pod | Committed DEL | Completed DEL | Delivery % | Spillover
 *
 * B) Feature Movement table
 *    Pod | Planned Features | Done | In-Flight | Not Started
 */
const fs = require("fs");
const path = require("path");
const { getClient, getConfig, normalizeState } = require("./liveLinear");
const { withCache } = require("./cache");

const REPO_ROOT = path.resolve(__dirname, "../..");
const CACHE_TTL = {
  issues: 3 * 60 * 1000,    // 3 min for issues
  projects: 5 * 60 * 1000,  // 5 min for projects
};

// ============== CONFIG LOADERS ==============

function loadCycleCalendar() {
  const fp = path.join(REPO_ROOT, "config", "cycle_calendar.json");
  if (!fs.existsSync(fp)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch {
    return null;
  }
}

function loadLabelIds() {
  const fp = path.join(REPO_ROOT, "config", "label_ids.json");
  if (!fs.existsSync(fp)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch {
    return null;
  }
}

function loadPodsConfig() {
  // Try linear_ids.json first (more complete)
  const linearIdsPath = path.join(REPO_ROOT, "config", "linear_ids.json");
  if (fs.existsSync(linearIdsPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(linearIdsPath, "utf8"));
      if (data?.pods) return { pods: data.pods, source: "linear_ids.json" };
    } catch {}
  }

  // Fall back to pods.json
  const podsPath = path.join(REPO_ROOT, "config", "pods.json");
  if (fs.existsSync(podsPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(podsPath, "utf8"));
      return { pods: data, source: "pods.json" };
    } catch {}
  }

  return null;
}

// ============== CYCLE HELPERS ==============

/**
 * Get the current cycle key for a pod based on date
 */
function getCycleKeyByDate(podCalendar, refDate = new Date()) {
  if (!podCalendar) return null;

  // Find active cycle first
  for (let i = 1; i <= 6; i++) {
    const c = podCalendar[`C${i}`];
    if (!c) continue;
    const start = new Date(c.start).getTime();
    const end = new Date(c.end).getTime();
    const now = refDate.getTime();
    if (now >= start && now <= end) return `C${i}`;
  }

  // If no active, find most recent ended
  let best = null;
  let bestEnd = -Infinity;
  for (let i = 1; i <= 6; i++) {
    const c = podCalendar[`C${i}`];
    if (!c) continue;
    const end = new Date(c.end).getTime();
    if (end <= refDate.getTime() && end > bestEnd) {
      bestEnd = end;
      best = `C${i}`;
    }
  }

  return best || "C1";
}

/**
 * Check if a cycle is currently active for a pod
 */
function isCycleActive(podCalendar, cycleKey, refDate = new Date()) {
  const c = podCalendar?.[cycleKey];
  if (!c) return false;
  const endMs = new Date(c.end).getTime();
  return refDate.getTime() <= endMs;
}

/**
 * Get the best cycle (with most committed DELs) for display
 */
function getBestCycleByCommitted(kpiRows) {
  const cycleCommits = {};
  for (const row of kpiRows) {
    cycleCommits[row.cycle] = (cycleCommits[row.cycle] || 0) + row.committed;
  }

  let best = "C1";
  let bestSum = -1;
  for (const [cycle, sum] of Object.entries(cycleCommits)) {
    if (sum > bestSum) {
      bestSum = sum;
      best = cycle;
    }
  }
  return { bestCycle: best, bestCommittedSum: bestSum };
}

// ============== GRAPHQL QUERIES ==============

const Q_ISSUES_BY_TEAM_AND_LABEL = `
query IssuesByTeamAndLabel($teamId: ID!, $labelId: ID!, $first: Int!, $after: String) {
  issues(first: $first, after: $after, filter: {
    team: { id: { eq: $teamId } },
    labels: { id: { eq: $labelId } }
  }) {
    nodes {
      id
      identifier
      createdAt
      completedAt
      state { type name }
      labels { nodes { id name } }
    }
    pageInfo { hasNextPage endCursor }
  }
}
`;

/**
 * Fetch all issues with DEL label for a team (paginated)
 */
async function fetchDELIssues(client, teamId, delLabelId) {
  const issues = [];
  let after = null;

  while (true) {
    const data = await client.gql(Q_ISSUES_BY_TEAM_AND_LABEL, {
      teamId,
      labelId: delLabelId,
      first: 100,
      after,
    });

    const conn = data.issues;
    issues.push(...(conn.nodes || []));

    if (!conn.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }

  return issues;
}

// ============== KPI COMPUTATION ==============

/**
 * Compute DEL KPI for all pods and cycles
 * Returns: { cycleKpi: [...], currentCycle: "C1", fetchedAt: "..." }
 */
async function computeCycleKpi() {
  const labelIds = loadLabelIds();
  const cycleCalendar = loadCycleCalendar();
  const podsConfig = loadPodsConfig();

  if (!labelIds) {
    return {
      success: false,
      error: "MISSING_LABEL_IDS",
      message: "config/label_ids.json not found. Run the weekly KPI script first to generate it.",
    };
  }

  if (!cycleCalendar) {
    return {
      success: false,
      error: "MISSING_CYCLE_CALENDAR",
      message: "config/cycle_calendar.json not found.",
    };
  }

  if (!podsConfig) {
    return {
      success: false,
      error: "MISSING_PODS_CONFIG",
      message: "No pods configuration found.",
    };
  }

  const delLabelId = labelIds.DEL;
  const cancelledLabelId = labelIds["DEL-CANCELLED"];

  if (!delLabelId) {
    return {
      success: false,
      error: "MISSING_DEL_LABEL",
      message: "DEL label ID not found in config/label_ids.json",
    };
  }

  const client = getClient();
  const now = new Date();
  const rows = [];

  for (const [podName, pod] of Object.entries(podsConfig.pods)) {
    const teamId = pod.teamId;
    if (!teamId) {
      // Skip pods without teamId
      for (let i = 1; i <= 6; i++) {
        rows.push({
          pod: podName,
          cycle: `C${i}`,
          committed: 0,
          completed: 0,
          deliveryPct: "0%",
          spillover: 0,
          status: "NO_TEAM_ID",
        });
      }
      continue;
    }

    const podCalendar = cycleCalendar.pods?.[podName];

    // Fetch DEL issues for this team (with caching)
    let issues = [];
    try {
      const cacheKey = `del_issues_${teamId}`;
      issues = await withCache(cacheKey, async () => {
        return await fetchDELIssues(client, teamId, delLabelId);
      }, CACHE_TTL.issues)();
    } catch (e) {
      // Fetch failed, continue with empty
      for (let i = 1; i <= 6; i++) {
        rows.push({
          pod: podName,
          cycle: `C${i}`,
          committed: 0,
          completed: 0,
          deliveryPct: "0%",
          spillover: 0,
          status: "FETCH_FAILED",
        });
      }
      continue;
    }

    // Enrich issues with label sets
    const enriched = issues.map(it => {
      const labels = (it.labels?.nodes || []).map(x => ({ id: x.id, name: x.name }));
      const labelSet = new Set(labels.map(x => x.id));
      return { ...it, _labels: labels, _labelSet: labelSet };
    });

    // Compute KPI for each cycle
    for (let i = 1; i <= 6; i++) {
      const cycleKey = `C${i}`;
      const baselineLabelId = labelIds[`2026Q1-C${i}`];

      // Find committed issues (have baseline label, not cancelled)
      const committedIssues = [];
      for (const it of enriched) {
        if (!baselineLabelId) continue;
        if (!it._labelSet.has(baselineLabelId)) continue;
        if (cancelledLabelId && it._labelSet.has(cancelledLabelId)) continue;
        committedIssues.push(it);
      }

      const committed = committedIssues.length;

      // Get cycle end date
      const cycleEnd = podCalendar?.[cycleKey]?.end
        ? new Date(podCalendar[cycleKey].end)
        : null;

      // Count completed (by cycle end for closed cycles, by now for active)
      const active = isCycleActive(podCalendar, cycleKey, now);
      const cutoffDate = active ? now : cycleEnd;

      let completed = 0;
      for (const it of committedIssues) {
        const isDone = it.state?.type === "completed";
        if (!isDone) continue;

        const doneAt = it.completedAt ? new Date(it.completedAt) : null;
        if (doneAt && cutoffDate && doneAt.getTime() <= cutoffDate.getTime()) {
          completed++;
        }
      }

      // Spillover: 0 if active, else committed - completed
      const spillover = active ? 0 : Math.max(0, committed - completed);

      // Delivery %
      const pct = committed === 0 ? "0%" : `${Math.round((completed / committed) * 100)}%`;

      rows.push({
        pod: podName,
        cycle: cycleKey,
        committed,
        completed,
        deliveryPct: pct,
        spillover,
        status: "OK",
      });
    }
  }

  // Determine current cycle (use FTS calendar as reference)
  const ftsCalendar = cycleCalendar.pods?.["FTS"] || cycleCalendar.pods?.[Object.keys(cycleCalendar.pods)[0]];
  let currentCycle = getCycleKeyByDate(ftsCalendar, now);

  // If current cycle has 0 committed, find best cycle
  const currentCycleCommitted = rows
    .filter(r => r.cycle === currentCycle)
    .reduce((sum, r) => sum + r.committed, 0);

  let fallbackCycle = null;
  if (currentCycleCommitted === 0) {
    const { bestCycle, bestCommittedSum } = getBestCycleByCommitted(rows);
    if (bestCommittedSum > 0 && bestCycle !== currentCycle) {
      fallbackCycle = bestCycle;
    }
  }

  return {
    success: true,
    cycleKpi: rows,
    currentCycle,
    fallbackCycle,
    fetchedAt: now.toISOString(),
    source: podsConfig.source,
  };
}

/**
 * Compute Feature Movement table from live project data
 */
async function computeFeatureMovement() {
  const config = getConfig();
  const client = getClient();
  const rows = [];

  for (const [podName, pod] of Object.entries(config.pods)) {
    if (!pod.initiativeId) {
      rows.push({
        pod: podName,
        plannedFeatures: 0,
        done: 0,
        inFlight: 0,
        notStarted: 0,
        status: "NO_INITIATIVE",
      });
      continue;
    }

    try {
      const cacheKey = `projects_${pod.initiativeId}`;
      const projects = await withCache(cacheKey, async () => {
        return await client.getProjectsByInitiative(pod.initiativeId);
      }, CACHE_TTL.projects)();

      let done = 0, inFlight = 0, notStarted = 0;
      for (const p of projects) {
        const state = normalizeState(p.state);
        if (state === "done") done++;
        else if (state === "in_flight") inFlight++;
        else if (state === "not_started") notStarted++;
        else notStarted++; // default
      }

      rows.push({
        pod: podName,
        plannedFeatures: projects.length,
        done,
        inFlight,
        notStarted,
        status: "OK",
      });
    } catch (e) {
      rows.push({
        pod: podName,
        plannedFeatures: 0,
        done: 0,
        inFlight: 0,
        notStarted: 0,
        status: "FETCH_FAILED",
      });
    }
  }

  return {
    success: true,
    featureMovement: rows,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Compute both KPI tables (main entry point)
 */
async function computeWeeklyKpi() {
  const [cycleResult, featureResult] = await Promise.all([
    computeCycleKpi(),
    computeFeatureMovement(),
  ]);

  if (!cycleResult.success) {
    return cycleResult;
  }

  return {
    success: true,
    cycleKpi: cycleResult.cycleKpi,
    currentCycle: cycleResult.currentCycle,
    fallbackCycle: cycleResult.fallbackCycle,
    featureMovement: featureResult.featureMovement,
    fetchedAt: cycleResult.fetchedAt,
    source: cycleResult.source,
  };
}

// ============== TABLE FORMATTING ==============

/**
 * Format Cycle KPI table as text (matching runWeeklyKpi.js output)
 */
function formatCycleKpiTable(rows, cycleKey, title = null) {
  const filtered = rows.filter(r => r.cycle === cycleKey);
  if (filtered.length === 0) {
    return `No data for cycle ${cycleKey}`;
  }

  const header = title || `A) Pod-wise Cycle KPI table (cycle=${cycleKey})`;

  // Calculate column widths
  const cols = {
    pod: Math.max(3, ...filtered.map(r => r.pod.length)),
    committed: 13,
    completed: 13,
    delivery: 10,
    spillover: 9,
  };

  let out = `${header}\n`;
  out += `${"Pod".padEnd(cols.pod)} | ${"Committed DEL".padEnd(cols.committed)} | ${"Completed DEL".padEnd(cols.completed)} | ${"Delivery %".padEnd(cols.delivery)} | ${"Spillover".padEnd(cols.spillover)}\n`;
  out += `${"-".repeat(cols.pod)} | ${"-".repeat(cols.committed)} | ${"-".repeat(cols.completed)} | ${"-".repeat(cols.delivery)} | ${"-".repeat(cols.spillover)}\n`;

  for (const r of filtered) {
    out += `${r.pod.padEnd(cols.pod)} | ${String(r.committed).padStart(cols.committed)} | ${String(r.completed).padStart(cols.completed)} | ${r.deliveryPct.padStart(cols.delivery)} | ${String(r.spillover).padStart(cols.spillover)}\n`;
  }

  return out;
}

/**
 * Format Feature Movement table as text
 */
function formatFeatureMovementTable(rows) {
  const cols = {
    pod: Math.max(3, ...rows.map(r => r.pod.length)),
    planned: 16,
    done: 4,
    inFlight: 9,
    notStarted: 11,
  };

  let out = `B) Feature Movement (Weekly Snapshot)\n`;
  out += `${"Pod".padEnd(cols.pod)} | ${"Planned Features".padEnd(cols.planned)} | ${"Done".padEnd(cols.done)} | ${"In-Flight".padEnd(cols.inFlight)} | ${"Not Started".padEnd(cols.notStarted)}\n`;
  out += `${"-".repeat(cols.pod)} | ${"-".repeat(cols.planned)} | ${"-".repeat(cols.done)} | ${"-".repeat(cols.inFlight)} | ${"-".repeat(cols.notStarted)}\n`;

  for (const r of rows) {
    out += `${r.pod.padEnd(cols.pod)} | ${String(r.plannedFeatures).padStart(cols.planned)} | ${String(r.done).padStart(cols.done)} | ${String(r.inFlight).padStart(cols.inFlight)} | ${String(r.notStarted).padStart(cols.notStarted)}\n`;
  }

  return out;
}

/**
 * Format complete KPI output (both tables)
 */
function formatWeeklyKpiOutput(result) {
  if (!result.success) {
    return `Error computing KPI: ${result.error}\n${result.message}`;
  }

  let out = `## Weekly KPI Report\n\n`;

  // Cycle KPI table
  out += formatCycleKpiTable(result.cycleKpi, result.currentCycle);

  // Show fallback if current cycle has no data
  if (result.fallbackCycle) {
    out += `\n[Note: ${result.currentCycle} has 0 committed. Showing ${result.fallbackCycle} which has data.]\n\n`;
    out += formatCycleKpiTable(result.cycleKpi, result.fallbackCycle, `A) Pod-wise Cycle KPI table (cycle=${result.fallbackCycle}) [FALLBACK]`);
  }

  out += `\n`;

  // Feature movement table
  out += formatFeatureMovementTable(result.featureMovement);

  out += `\n*Source: LIVE from Linear (${result.fetchedAt})*`;

  return out;
}

/**
 * Format combined KPI with beautiful markdown tables and project summaries
 * This is the enhanced version showing both DEL and Weekly KPIs
 */
function formatCombinedKpiOutput(result, projectsByPod = null) {
  if (!result.success) {
    return `Error computing KPI: ${result.error}\n${result.message}`;
  }

  const cycle = result.fallbackCycle || result.currentCycle;
  const cycleRows = result.cycleKpi.filter(r => r.cycle === cycle);
  const fmRows = result.featureMovement || [];

  let out = "";

  // ============== SECTION 1: DEL KPI ==============
  out += `## DEL KPI (Cycle ${cycle})\n\n`;
  out += `> DEL = Delivery Excellence Level metrics tracking committed vs completed deliverables\n\n`;

  // Beautiful markdown table for DEL KPI
  out += `| Pod | Committed | Completed | Delivery % | Spillover | Status |\n`;
  out += `|-----|----------:|----------:|-----------:|----------:|--------|\n`;

  let totalCommitted = 0, totalCompleted = 0, totalSpillover = 0;

  for (const r of cycleRows) {
    const statusIcon = r.status === "OK" ? "OK" : `${r.status}`;
    out += `| ${r.pod} | ${r.committed} | ${r.completed} | ${r.deliveryPct} | ${r.spillover} | ${statusIcon} |\n`;
    totalCommitted += r.committed;
    totalCompleted += r.completed;
    totalSpillover += r.spillover;
  }

  // Totals row
  const totalPct = totalCommitted === 0 ? "0%" : `${Math.round((totalCompleted / totalCommitted) * 100)}%`;
  out += `| **TOTAL** | **${totalCommitted}** | **${totalCompleted}** | **${totalPct}** | **${totalSpillover}** | - |\n`;

  out += `\n`;

  // ============== SECTION 2: Feature Movement KPI ==============
  out += `## Weekly Feature Movement\n\n`;
  out += `> Tracks planned features across pods: Done, In-Flight, Not Started\n\n`;

  // Beautiful markdown table for Feature Movement
  out += `| Pod | Projects | Planned | In-Flight | Done | Not Started | Status |\n`;
  out += `|-----|:--------:|--------:|----------:|-----:|------------:|--------|\n`;

  let totalProjects = 0, totalInFlight = 0, totalDone = 0, totalNotStarted = 0;

  for (const r of fmRows) {
    const statusNote = r.plannedFeatures === 0 ? `*(0 projects; ${r.status})* ` : "";
    out += `| ${r.pod} | ${r.plannedFeatures} | ${r.plannedFeatures} | ${r.inFlight} | ${r.done} | ${r.notStarted} | ${r.status} ${statusNote}|\n`;
    totalProjects += r.plannedFeatures;
    totalInFlight += r.inFlight;
    totalDone += r.done;
    totalNotStarted += r.notStarted;
  }

  // Totals row
  out += `| **TOTAL** | **${totalProjects}** | **${totalProjects}** | **${totalInFlight}** | **${totalDone}** | **${totalNotStarted}** | - |\n`;

  out += `\n`;

  // ============== SECTION 3: Project-wise Summaries ==============
  if (projectsByPod && Object.keys(projectsByPod).length > 0) {
    out += `## Project-wise Summary by Pod\n\n`;

    for (const [podName, projects] of Object.entries(projectsByPod)) {
      if (!projects || projects.length === 0) {
        out += `### ${podName}\n`;
        out += `*No projects in this pod*\n\n`;
        continue;
      }

      out += `### ${podName} (${projects.length} projects)\n\n`;
      out += `| Project | State | Lead |\n`;
      out += `|---------|-------|------|\n`;

      for (const p of projects) {
        const state = normalizeProjectState(p.state);
        const stateEmoji = state === "done" ? "Done" : state === "in_flight" ? "In-Flight" : "Not Started";
        const lead = p.lead?.name || p.lead || "-";
        const name = p.name.length > 50 ? p.name.substring(0, 47) + "..." : p.name;
        out += `| ${name} | ${stateEmoji} | ${lead} |\n`;
      }

      out += `\n`;
    }
  }

  out += `---\n`;
  out += `*Snapshot: ${result.fetchedAt}*\n`;

  return out;
}

/**
 * Helper to normalize project state for display
 */
function normalizeProjectState(state) {
  const s = String(state || "").toLowerCase();
  if (s === "completed") return "done";
  if (s === "started" || s === "paused") return "in_flight";
  if (s === "planned" || s === "backlog") return "not_started";
  if (s === "canceled" || s === "cancelled") return "cancelled";
  return s || "unknown";
}

/**
 * Compute full combined KPI with project details
 */
async function computeCombinedKpi() {
  const baseResult = await computeWeeklyKpi();
  if (!baseResult.success) {
    return baseResult;
  }

  // Load projects by pod from config
  const podsConfig = loadPodsConfig();
  const projectsByPod = {};

  if (podsConfig?.pods) {
    for (const [podName, podData] of Object.entries(podsConfig.pods)) {
      projectsByPod[podName] = podData.projects || [];
    }
  }

  return {
    ...baseResult,
    projectsByPod,
  };
}

/**
 * Generate insights from KPI data
 */
function generateInsights(result) {
  if (!result.success) return "";

  const insights = [];
  const cycleRows = result.cycleKpi.filter(r => r.cycle === (result.fallbackCycle || result.currentCycle));

  // Find pods with high delivery %
  const highPerformers = cycleRows.filter(r => {
    const pct = parseInt(r.deliveryPct) || 0;
    return pct >= 80 && r.committed > 0;
  });

  if (highPerformers.length > 0) {
    insights.push(`High performers (80%+ delivery): ${highPerformers.map(r => `${r.pod} (${r.deliveryPct})`).join(", ")}`);
  }

  // Find pods with spillover
  const spilloverPods = cycleRows.filter(r => r.spillover > 0);
  if (spilloverPods.length > 0) {
    insights.push(`Pods with spillover: ${spilloverPods.map(r => `${r.pod} (${r.spillover} DELs)`).join(", ")}`);
  }

  // Find pods with 0 committed
  const zeroCommit = cycleRows.filter(r => r.committed === 0 && r.status === "OK");
  if (zeroCommit.length > 0) {
    insights.push(`Pods with 0 committed DELs: ${zeroCommit.map(r => r.pod).join(", ")}`);
  }

  // Feature movement insights
  const fmRows = result.featureMovement || [];
  const stuckPods = fmRows.filter(r => r.inFlight === 0 && r.notStarted > 0 && r.plannedFeatures > 0);
  if (stuckPods.length > 0) {
    insights.push(`Pods with features not yet started: ${stuckPods.map(r => r.pod).join(", ")}`);
  }

  const allDonePods = fmRows.filter(r => r.done === r.plannedFeatures && r.plannedFeatures > 0);
  if (allDonePods.length > 0) {
    insights.push(`Pods with all features done: ${allDonePods.map(r => r.pod).join(", ")}`);
  }

  return insights.length > 0 ? `\n### Insights\n- ${insights.join("\n- ")}` : "";
}

module.exports = {
  computeWeeklyKpi,
  computeCycleKpi,
  computeFeatureMovement,
  computeCombinedKpi,
  formatWeeklyKpiOutput,
  formatCombinedKpiOutput,
  formatCycleKpiTable,
  formatFeatureMovementTable,
  generateInsights,
  getCycleKeyByDate,
  loadCycleCalendar,
  loadLabelIds,
  normalizeProjectState,
};
