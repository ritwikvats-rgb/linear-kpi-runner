/* agent/src/kpiComputer.js
 * Computes KPI tables matching runWeeklyKpi.js output
 *
 * A) Pod-wise Cycle KPI table (DEL metrics)
 *    Pod | Committed DEL | Completed DEL | Delivery % | Spillover
 *
 * B) Feature Movement table
 *    Pod | Planned Features | Done | In-Flight | Not Started
 */
const { getClient, getConfig, normalizeState } = require("./liveLinear");
const { withCache } = require("./cache");
const {
  formatFeatureMovementBox,
  formatDelKpiBox,
  formatPendingDelsBox,
  formatTable,
  formatSummaryBox,
  truncate,
} = require("./tableFormatter");

// Import shared utilities
const {
  loadCycleCalendar,
  getCycleKeyByDate,
  isCycleActive,
  getBestCycleByCommitted,
} = require("./shared/cycleUtils");

const {
  loadLabelIds,
  enrichIssuesWithLabels,
  fetchDELIssues,
  extractDelTitle,
} = require("./shared/labelUtils");

const {
  loadPodsConfig,
  normalizeState: normalizeProjectState,
} = require("./shared/podsUtils");

const CACHE_TTL = {
  issues: 3 * 60 * 1000,    // 3 min for issues
  projects: 5 * 60 * 1000,  // 5 min for projects
};

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

  // PARALLEL: Fetch all pod issues concurrently for better performance
  const podEntries = Object.entries(podsConfig.pods);
  const podsWithTeamId = podEntries.filter(([, pod]) => pod.teamId);
  const podsWithoutTeamId = podEntries.filter(([, pod]) => !pod.teamId);

  // Add empty rows for pods without teamId
  for (const [podName] of podsWithoutTeamId) {
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
  }

  // Fetch all pod issues in parallel
  const fetchPromises = podsWithTeamId.map(async ([podName, pod]) => {
    const cacheKey = `del_issues_${pod.teamId}`;
    try {
      const issues = await withCache(cacheKey, async () => {
        return await fetchDELIssues(client, pod.teamId, delLabelId);
      }, CACHE_TTL.issues)();
      return { podName, pod, issues, success: true };
    } catch (e) {
      return { podName, pod, issues: [], success: false };
    }
  });

  const fetchResults = await Promise.all(fetchPromises);

  // Process results sequentially
  for (const { podName, issues, success } of fetchResults) {
    if (!success) {
      // Fetch failed, add empty rows
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

    const podCalendar = cycleCalendar.pods?.[podName];

    // Enrich issues with label sets (using shared utility)
    const enriched = enrichIssuesWithLabels(issues);

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

  // Return both KPIs even if one fails - partial success is better than total failure
  const hasDelData = cycleResult.success && cycleResult.cycleKpi?.length > 0;
  const hasFeatureData = featureResult.success && featureResult.featureMovement?.length > 0;

  if (!hasDelData && !hasFeatureData) {
    return {
      success: false,
      error: "Both KPI computations failed",
      message: `DEL: ${cycleResult.error || "No data"}. Feature Movement: ${featureResult.error || "No data"}`,
    };
  }

  return {
    success: true,
    cycleKpi: cycleResult.cycleKpi || [],
    currentCycle: cycleResult.currentCycle,
    fallbackCycle: cycleResult.fallbackCycle,
    featureMovement: featureResult.featureMovement || [],
    fetchedAt: cycleResult.fetchedAt || featureResult.fetchedAt || new Date().toISOString(),
    source: cycleResult.source || featureResult.source || "live",
    delSuccess: hasDelData,
    featureSuccess: hasFeatureData,
    delError: !hasDelData ? (cycleResult.error || "No DEL data") : null,
    featureError: !hasFeatureData ? (featureResult.error || "No feature data") : null,
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
 * Format complete KPI output (both tables) with beautified box tables
 */
function formatWeeklyKpiOutput(result) {
  if (!result.success) {
    return `Error computing KPI: ${result.error}\n${result.message}`;
  }

  let out = `## Weekly KPI Report\n\n`;

  // Use the primary cycle
  const cycle = result.fallbackCycle || result.currentCycle;
  const cycleRows = result.cycleKpi.filter(r => r.cycle === cycle);

  // Beautified DEL KPI table
  out += formatDelKpiBox(cycleRows, cycle, {
    title: `A) Pod-wise Cycle KPI (Cycle=${cycle})`
  });

  // Show fallback note if applicable
  if (result.fallbackCycle) {
    out += `[Note: ${result.currentCycle} has 0 committed. Showing ${result.fallbackCycle} which has data.]\n`;
  }

  out += `\n`;

  // Beautified Feature Movement table
  out += formatFeatureMovementBox(result.featureMovement, {
    title: "B) Feature Movement (Weekly Snapshot)"
  });

  out += `\n*Source: LIVE from Linear (${result.fetchedAt})*`;

  return out;
}

/**
 * Format combined KPI with beautified box tables and project summaries
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

  // ============== SECTION 1: DEL KPI (Beautified Box) ==============
  out += `## DEL KPI (Cycle ${cycle})\n\n`;
  out += `DEL = Delivery Excellence Level metrics tracking committed vs completed deliverables\n\n`;

  out += formatDelKpiBox(cycleRows, cycle, {
    title: `DEL Metrics (Cycle=${cycle})`
  });

  out += `\n`;

  // ============== SECTION 2: Feature Movement KPI (Beautified Box) ==============
  out += `## Weekly Feature Movement\n\n`;
  out += `Tracks planned features across pods: Done, In-Flight, Not Started\n\n`;

  out += formatFeatureMovementBox(fmRows, {
    title: "Feature Movement (Weekly Snapshot)"
  });

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

/**
 * Fetch DELs committed to a specific cycle for a pod or all pods
 * @param {string} cycle - Cycle key (e.g., "C1", "C2")
 * @param {string|null} podNameFilter - Optional pod name to filter by
 * @returns {object} - { success, dels: [...], fetchedAt, ... }
 */
async function fetchDELsByCycle(cycle, podNameFilter = null) {
  const labelIds = loadLabelIds();
  const podsConfig = loadPodsConfig();

  if (!labelIds) {
    return {
      success: false,
      error: "MISSING_LABEL_IDS",
      message: "config/label_ids.json not found. Run the weekly KPI script first to generate it.",
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

  // Validate cycle
  const cycleUpper = cycle.toUpperCase();
  const cycleMatch = cycleUpper.match(/^C([1-6])$/);
  if (!cycleMatch) {
    return {
      success: false,
      error: "INVALID_CYCLE",
      message: `Invalid cycle "${cycle}". Valid cycles are C1-C6.`,
    };
  }

  const baselineLabelKey = `2026Q1-${cycleUpper}`;
  const baselineLabelId = labelIds[baselineLabelKey];

  if (!baselineLabelId) {
    return {
      success: false,
      error: "MISSING_CYCLE_LABEL",
      message: `Cycle label "${baselineLabelKey}" not found in config/label_ids.json`,
    };
  }

  const client = getClient();
  const now = new Date();
  const dels = [];

  // Filter pods if requested
  let podsToProcess = Object.entries(podsConfig.pods);
  if (podNameFilter) {
    const filterLower = podNameFilter.toLowerCase();
    podsToProcess = podsToProcess.filter(([name]) => name.toLowerCase() === filterLower);
    if (podsToProcess.length === 0) {
      return {
        success: false,
        error: "POD_NOT_FOUND",
        message: `Pod "${podNameFilter}" not found.`,
        availablePods: Object.keys(podsConfig.pods),
      };
    }
  }

  for (const [podName, pod] of podsToProcess) {
    const teamId = pod.teamId;
    if (!teamId) continue;

    // Fetch DEL issues for this team (with caching)
    let issues = [];
    try {
      const cacheKey = `del_issues_${teamId}`;
      issues = await withCache(cacheKey, async () => {
        return await fetchDELIssues(client, teamId, delLabelId);
      }, CACHE_TTL.issues)();
    } catch (e) {
      continue;
    }

    // Enrich issues with label sets (using shared utility)
    const enriched = enrichIssuesWithLabels(issues);

    // Find DELs committed to the specified cycle
    for (const it of enriched) {
      // Skip cancelled
      if (cancelledLabelId && it._labelSet.has(cancelledLabelId)) continue;

      // Check if committed to the specified cycle
      const isCommitted = it._labelSet.has(baselineLabelId);
      if (!isCommitted) continue;

      // Check completion status
      const isCompleted = it.state?.type === "completed";

      dels.push({
        pod: podName,
        cycle: cycleUpper,
        identifier: it.identifier,
        title: extractDelTitle(it),
        state: it.state?.name || "Unknown",
        stateType: it.state?.type || "unknown",
        isCompleted,
        assignee: it.assignee?.name || "Unassigned",
        project: it.project?.name || "No Project",
        labels: it._labelNames.filter(n => !n.startsWith("2026Q1-") && n !== "DEL"),
        createdAt: it.createdAt,
        completedAt: it.completedAt,
      });
    }
  }

  // Sort by pod, then by identifier
  dels.sort((a, b) => {
    if (a.pod !== b.pod) return a.pod.localeCompare(b.pod);
    return a.identifier.localeCompare(b.identifier);
  });

  // Calculate stats
  const totalCommitted = dels.length;
  const totalCompleted = dels.filter(d => d.isCompleted).length;
  const totalPending = totalCommitted - totalCompleted;

  return {
    success: true,
    dels,
    cycle: cycleUpper,
    totalCommitted,
    totalCompleted,
    totalPending,
    deliveryPct: totalCommitted > 0 ? Math.round((totalCompleted / totalCommitted) * 100) : 0,
    podFilter: podNameFilter,
    fetchedAt: now.toISOString(),
  };
}

/**
 * Create JSON table marker for frontend rendering
 */
function jsonTable(title, columns, rows) {
  const tableData = { title, columns, rows };
  return `{{TABLE:${JSON.stringify(tableData)}:TABLE}}`;
}

/**
 * Format DELs by cycle for display - uses dynamic HTML tables
 * @param {object} result - The result from fetchDELsByCycle
 * @param {boolean} isMobile - Unused, kept for API compatibility
 */
function formatDELsByCycle(result, isMobile = false) {
  if (!result.success) {
    let msg = `Error: ${result.error}\n${result.message}`;
    if (result.availablePods) {
      msg += `\nAvailable pods: ${result.availablePods.join(", ")}`;
    }
    return msg;
  }

  const { dels, cycle, totalCommitted, totalCompleted, totalPending, deliveryPct, podFilter, fetchedAt } = result;

  if (totalCommitted === 0) {
    const podMsg = podFilter ? ` for ${podFilter}` : " across all pods";
    return `No DELs committed to cycle ${cycle}${podMsg}.\n\nSnapshot: ${fetchedAt}`;
  }

  const podMsg = podFilter ? `${podFilter}` : "All Pods";
  let out = "";

  // Summary table
  out += `## 📦 DELs in Cycle ${cycle} - ${podMsg}\n\n`;
  out += jsonTable("Summary", [
    { key: "metric", header: "Metric" },
    { key: "value", header: "Value" }
  ], [
    { metric: "Committed", value: totalCommitted },
    { metric: "Completed", value: totalCompleted },
    { metric: "Pending", value: totalPending },
    { metric: "Delivery Rate", value: `${deliveryPct}%`, deliveryPct: deliveryPct }
  ]);
  out += "\n\n";

  // Group by pod
  const byPod = {};
  for (const del of dels) {
    if (!byPod[del.pod]) byPod[del.pod] = [];
    byPod[del.pod].push(del);
  }

  // Format each pod's DELs as a table
  for (const [podName, podDels] of Object.entries(byPod)) {
    const completed = podDels.filter(d => d.isCompleted).length;
    const pending = podDels.length - completed;

    const rows = podDels.map(del => ({
      id: del.identifier,
      title: truncate(del.title, 35),
      state: del.isCompleted ? "Done" : del.state,
      assignee: del.assignee || "Unassigned"
    }));

    out += jsonTable(`${podName} (${completed} done, ${pending} pending)`, [
      { key: "id", header: "ID" },
      { key: "title", header: "Title" },
      { key: "state", header: "State" },
      { key: "assignee", header: "Assignee" }
    ], rows);
    out += "\n\n";
  }

  out += `---\nSnapshot: ${fetchedAt}`;
  return out;
}

/**
 * Fetch pending (committed but not completed) DELs for a pod or all pods
 * @param {string|null} podNameFilter - Optional pod name to filter by
 * @returns {object} - { success, pendingDELs: [...], fetchedAt, ... }
 */
async function fetchPendingDELs(podNameFilter = null) {
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
  const pendingDELs = [];

  // Filter pods if requested
  let podsToProcess = Object.entries(podsConfig.pods);
  if (podNameFilter) {
    const filterLower = podNameFilter.toLowerCase();
    podsToProcess = podsToProcess.filter(([name]) => name.toLowerCase() === filterLower);
    if (podsToProcess.length === 0) {
      return {
        success: false,
        error: "POD_NOT_FOUND",
        message: `Pod "${podNameFilter}" not found.`,
        availablePods: Object.keys(podsConfig.pods),
      };
    }
  }

  for (const [podName, pod] of podsToProcess) {
    const teamId = pod.teamId;
    if (!teamId) continue;

    const podCalendar = cycleCalendar?.pods?.[podName];

    // Get current cycle for this pod
    const currentCycle = getCycleKeyByDate(podCalendar, now);

    // Fetch DEL issues for this team (with caching)
    let issues = [];
    try {
      const cacheKey = `del_issues_${teamId}`;
      issues = await withCache(cacheKey, async () => {
        return await fetchDELIssues(client, teamId, delLabelId);
      }, CACHE_TTL.issues)();
    } catch (e) {
      continue;
    }

    // Enrich issues with label sets (using shared utility)
    const enriched = enrichIssuesWithLabels(issues);

    // Find pending DELs (committed to current cycle but not completed)
    for (const it of enriched) {
      // Skip cancelled
      if (cancelledLabelId && it._labelSet.has(cancelledLabelId)) continue;

      // Check if committed to current cycle
      const baselineLabelId = labelIds[`2026Q1-${currentCycle}`];
      const isCommitted = baselineLabelId && it._labelSet.has(baselineLabelId);
      if (!isCommitted) continue;

      // Check if NOT completed
      const isCompleted = it.state?.type === "completed";
      if (isCompleted) continue;

      // This is a pending DEL
      pendingDELs.push({
        pod: podName,
        cycle: currentCycle,
        identifier: it.identifier,
        title: extractDelTitle(it),
        state: it.state?.name || "Unknown",
        stateType: it.state?.type || "unknown",
        assignee: it.assignee?.name || "Unassigned",
        project: it.project?.name || "No Project",
        labels: it._labelNames.filter(n => !n.startsWith("2026Q1-") && n !== "DEL"),
        createdAt: it.createdAt,
      });
    }
  }

  // Sort by pod, then by identifier
  pendingDELs.sort((a, b) => {
    if (a.pod !== b.pod) return a.pod.localeCompare(b.pod);
    return a.identifier.localeCompare(b.identifier);
  });

  return {
    success: true,
    pendingDELs,
    totalPending: pendingDELs.length,
    podFilter: podNameFilter,
    fetchedAt: now.toISOString(),
  };
}


/**
 * Format pending DELs for display with beautified box tables
 */
/**
 * Format pending DELs for display - uses dynamic HTML tables
 * @param {object} result - The result from fetchPendingDELs
 * @param {boolean} isMobile - Unused, kept for API compatibility
 */
function formatPendingDELs(result, isMobile = false) {
  if (!result.success) {
    let msg = `Error: ${result.error}\n${result.message}`;
    if (result.availablePods) {
      msg += `\nAvailable pods: ${result.availablePods.join(", ")}`;
    }
    return msg;
  }

  const { pendingDELs, totalPending, podFilter, fetchedAt } = result;

  if (totalPending === 0) {
    const podMsg = podFilter ? ` for ${podFilter}` : " across all pods";
    return `No pending DELs found${podMsg}. All committed DELs are completed!\n\nSnapshot: ${fetchedAt}`;
  }

  const podMsg = podFilter ? `${podFilter}` : "All Pods";
  let out = "";

  out += `## ⏳ Pending DELs - ${podMsg}\n\n`;
  out += `**Total Pending: ${totalPending}**\n\n`;

  // Group by pod
  const byPod = {};
  for (const del of pendingDELs) {
    if (!byPod[del.pod]) byPod[del.pod] = [];
    byPod[del.pod].push(del);
  }

  // Format each pod's pending DELs as a table
  // Helper to clean project name - remove "Q1 2026 : " prefix
  const cleanProjectName = (name) => {
    if (!name) return "No Project";
    return name.replace(/^Q\d\s*\d{4}\s*:\s*/i, "").trim();
  };

  for (const [podName, dels] of Object.entries(byPod)) {
    const rows = dels.map(del => ({
      id: del.identifier,
      project: truncate(cleanProjectName(del.project), 35),
      title: truncate(del.title, 30),
      assignee: del.assignee || "Unassigned",
      state: del.state
    }));

    out += jsonTable(`${podName} (${dels.length} pending)`, [
      { key: "id", header: "ID" },
      { key: "project", header: "Project" },
      { key: "title", header: "Title" },
      { key: "assignee", header: "Assignee" },
      { key: "state", header: "State" }
    ], rows);
    out += "\n\n";
  }

  out += `---\nSnapshot: ${fetchedAt}`;
  return out;
}

module.exports = {
  computeWeeklyKpi,
  computeCycleKpi,
  computeFeatureMovement,
  computeCombinedKpi,
  fetchPendingDELs,
  fetchDELsByCycle,
  formatPendingDELs,
  formatDELsByCycle,
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
