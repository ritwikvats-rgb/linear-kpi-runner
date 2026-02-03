/* agent/src/spilloverService.js
 * Spillover tracking service for cycle-to-cycle DEL spillover
 *
 * Tracks:
 * - DELs committed to each cycle via labels (2026Q1-C1, C2, etc.)
 * - Completion status by cycle end date
 * - Spillover = Committed - Completed
 */

const { getClient } = require("./liveLinear");
const { withCache } = require("./cache");
const {
  loadCycleCalendar,
  getCycleKeyByDate,
  isCycleActive,
} = require("./shared/cycleUtils");
const {
  loadLabelIds,
  fetchDELIssues,
  enrichIssuesWithLabels,
  extractDelTitle,
} = require("./shared/labelUtils");
const { loadPodsConfig } = require("./shared/podsUtils");

const CACHE_TTL = {
  spillover: 3 * 60 * 1000, // 3 min cache
};

/**
 * Get spillover data for a specific cycle across all pods
 * @param {string} cycleKey - Cycle key (C1, C2, C3, etc.)
 * @returns {object} - Spillover data by pod
 */
async function getSpilloverByCycle(cycleKey) {
  const labelIds = loadLabelIds();
  const cycleCalendar = loadCycleCalendar();
  const podsConfig = loadPodsConfig();

  if (!labelIds || !cycleCalendar || !podsConfig) {
    return {
      success: false,
      error: "MISSING_CONFIG",
      message: "Required configuration files not found.",
    };
  }

  const delLabelId = labelIds.DEL;
  const cancelledLabelId = labelIds["DEL-CANCELLED"];
  const cycleUpper = cycleKey.toUpperCase();
  const cycleLabelId = labelIds[`2026Q1-${cycleUpper}`];

  if (!cycleLabelId) {
    return {
      success: false,
      error: "INVALID_CYCLE",
      message: `Cycle label for ${cycleUpper} not found.`,
    };
  }

  const client = getClient();
  const now = new Date();
  const results = [];

  // Process each pod
  for (const [podName, pod] of Object.entries(podsConfig.pods)) {
    if (!pod.teamId) continue;

    const podCalendar = cycleCalendar.pods?.[podName];
    const cycleEnd = podCalendar?.[cycleUpper]?.end
      ? new Date(podCalendar[cycleUpper].end)
      : null;

    const isActive = isCycleActive(podCalendar, cycleUpper, now);

    try {
      const cacheKey = `spillover_${podName}_${cycleUpper}`;
      const issues = await withCache(cacheKey, async () => {
        return await fetchDELIssues(client, pod.teamId, delLabelId);
      }, CACHE_TTL.spillover)();

      const enriched = enrichIssuesWithLabels(issues);

      let committed = 0;
      let completed = 0;
      const spilloverDELs = [];
      const completedDELs = [];

      for (const issue of enriched) {
        // Skip cancelled
        if (cancelledLabelId && issue._labelSet.has(cancelledLabelId)) continue;

        // Check if committed to this cycle
        if (!issue._labelSet.has(cycleLabelId)) continue;

        committed++;

        // Check completion status
        const isCompleted = issue.state?.type === "completed";
        const completedAt = issue.completedAt ? new Date(issue.completedAt) : null;

        // For active cycles, just check if completed
        // For closed cycles, check if completed by cycle end
        let completedInTime = false;
        if (isActive) {
          completedInTime = isCompleted;
        } else if (cycleEnd) {
          completedInTime = isCompleted && completedAt && completedAt <= cycleEnd;
        }

        if (completedInTime) {
          completed++;
          completedDELs.push({
            id: issue.identifier,
            title: extractDelTitle(issue),
            assignee: issue.assignee?.name || "Unassigned",
            project: (issue.project?.name || "No Project").replace(/^Q\d\s*\d{4}\s*:\s*/i, ""),
            completedAt: issue.completedAt,
          });
        } else {
          spilloverDELs.push({
            id: issue.identifier,
            title: extractDelTitle(issue),
            assignee: issue.assignee?.name || "Unassigned",
            project: (issue.project?.name || "No Project").replace(/^Q\d\s*\d{4}\s*:\s*/i, ""),
            state: issue.state?.name || "Unknown",
            stateType: issue.state?.type || "unknown",
          });
        }
      }

      const spillover = committed - completed;
      const deliveryPct = committed > 0 ? Math.round((completed / committed) * 100) : 0;

      results.push({
        pod: podName,
        cycle: cycleUpper,
        committed,
        completed,
        spillover,
        deliveryPct,
        isActive,
        cycleEnd: cycleEnd?.toISOString() || null,
        spilloverDELs,
        completedDELs,
      });
    } catch (e) {
      results.push({
        pod: podName,
        cycle: cycleUpper,
        committed: 0,
        completed: 0,
        spillover: 0,
        deliveryPct: 0,
        isActive,
        error: e.message,
        spilloverDELs: [],
        completedDELs: [],
      });
    }
  }

  // Calculate totals
  const totals = results.reduce(
    (acc, r) => {
      acc.committed += r.committed;
      acc.completed += r.completed;
      acc.spillover += r.spillover;
      return acc;
    },
    { committed: 0, completed: 0, spillover: 0 }
  );

  totals.deliveryPct = totals.committed > 0
    ? Math.round((totals.completed / totals.committed) * 100)
    : 0;

  // Sort by delivery %
  results.sort((a, b) => b.deliveryPct - a.deliveryPct);

  return {
    success: true,
    cycle: cycleUpper,
    isActive: results.some(r => r.isActive),
    fetchedAt: now.toISOString(),
    totals,
    pods: results,
  };
}

/**
 * Get spillover data for all cycles (C1-C6)
 * Used for trend charts
 */
async function getAllCyclesSpillover() {
  const cycles = ["C1", "C2", "C3", "C4", "C5", "C6"];
  const results = {};

  for (const cycle of cycles) {
    results[cycle] = await getSpilloverByCycle(cycle);
  }

  return {
    success: true,
    fetchedAt: new Date().toISOString(),
    cycles: results,
  };
}

/**
 * Get current cycle spillover
 */
async function getCurrentCycleSpillover() {
  const cycleCalendar = loadCycleCalendar();
  const now = new Date();

  // Use FTS calendar as reference
  const ftsCalendar = cycleCalendar?.pods?.FTS;
  const currentCycle = getCycleKeyByDate(ftsCalendar, now);

  return await getSpilloverByCycle(currentCycle);
}

/**
 * Get previous cycle spillover (useful for comparing)
 */
async function getPreviousCycleSpillover() {
  const cycleCalendar = loadCycleCalendar();
  const now = new Date();

  const ftsCalendar = cycleCalendar?.pods?.FTS;
  const currentCycle = getCycleKeyByDate(ftsCalendar, now);

  // Get previous cycle
  const cycleNum = parseInt(currentCycle.replace("C", ""));
  const prevCycle = cycleNum > 1 ? `C${cycleNum - 1}` : null;

  if (!prevCycle) {
    return { success: false, error: "NO_PREVIOUS_CYCLE", message: "No previous cycle available." };
  }

  return await getSpilloverByCycle(prevCycle);
}

/**
 * Build spillover chart data for dashboard
 */
async function getSpilloverChartData() {
  const cycles = ["C1", "C2", "C3", "C4", "C5", "C6"];
  const podsConfig = loadPodsConfig();
  const podNames = Object.keys(podsConfig?.pods || {});

  // Fetch all cycle data
  const allData = await getAllCyclesSpillover();

  if (!allData.success) {
    return { success: false, error: allData.error };
  }

  // Build spillover by cycle chart (stacked bar)
  const spilloverByCycleChart = buildSpilloverByCycleChart(allData.cycles, podNames);

  // Build spillover trend chart (line)
  const spilloverTrendChart = buildSpilloverTrendChart(allData.cycles, podNames);

  // Build current cycle spillover breakdown (pie/donut)
  const cycleCalendar = loadCycleCalendar();
  const now = new Date();
  const ftsCalendar = cycleCalendar?.pods?.FTS;
  const currentCycle = getCycleKeyByDate(ftsCalendar, now);
  const currentData = allData.cycles[currentCycle];

  const spilloverBreakdownChart = buildSpilloverBreakdownChart(currentData);

  // Build delivery comparison chart
  const deliveryComparisonChart = buildDeliveryComparisonChart(allData.cycles, currentCycle);

  return {
    success: true,
    currentCycle,
    fetchedAt: allData.fetchedAt,
    spilloverByCycleChart,
    spilloverTrendChart,
    spilloverBreakdownChart,
    deliveryComparisonChart,
    currentCycleData: currentData,
  };
}

/**
 * Build stacked bar chart showing spillover by cycle
 */
function buildSpilloverByCycleChart(cyclesData, podNames) {
  const cycles = ["C1", "C2", "C3", "C4", "C5", "C6"];

  const POD_COLORS = {
    ML: "#ef4444",
    "Control Center": "#f97316",
    BTS: "#eab308",
    FTS: "#22c55e",
    GTS: "#14b8a6",
    Platform: "#3b82f6",
    FOT: "#6366f1",
    "Talent Studio": "#8b5cf6",
    "Growth & Reuse": "#ec4899",
  };

  const datasets = podNames.map(pod => {
    const data = cycles.map(cycle => {
      const cycleData = cyclesData[cycle];
      if (!cycleData?.success) return 0;
      const podData = cycleData.pods?.find(p => p.pod === pod);
      return podData?.spillover || 0;
    });

    return {
      label: pod,
      data,
      backgroundColor: POD_COLORS[pod] || "#64748b",
      borderRadius: 4,
    };
  });

  return {
    type: "stackedBar",
    title: "Spillover by Cycle (All Pods)",
    data: {
      labels: cycles,
      datasets,
    },
    meta: {
      totals: cycles.map(cycle => cyclesData[cycle]?.totals?.spillover || 0),
    },
  };
}

/**
 * Build line chart showing spillover trend per pod
 */
function buildSpilloverTrendChart(cyclesData, podNames) {
  const cycles = ["C1", "C2", "C3", "C4", "C5", "C6"];

  const POD_COLORS = {
    ML: "#ef4444",
    "Control Center": "#f97316",
    BTS: "#eab308",
    FTS: "#22c55e",
    GTS: "#14b8a6",
    Platform: "#3b82f6",
    FOT: "#6366f1",
    "Talent Studio": "#8b5cf6",
    "Growth & Reuse": "#ec4899",
  };

  const datasets = podNames.map(pod => {
    const data = cycles.map(cycle => {
      const cycleData = cyclesData[cycle];
      if (!cycleData?.success) return null;
      const podData = cycleData.pods?.find(p => p.pod === pod);
      // Only show data for cycles with commits
      if (!podData || podData.committed === 0) return null;
      return podData.spillover;
    });

    return {
      label: pod,
      data,
      borderColor: POD_COLORS[pod] || "#64748b",
      backgroundColor: `${POD_COLORS[pod] || "#64748b"}20`,
      fill: false,
      tension: 0.4,
      pointRadius: 5,
      spanGaps: false,
    };
  });

  return {
    type: "line",
    title: "Spillover Trend by Pod",
    data: {
      labels: cycles,
      datasets,
    },
  };
}

/**
 * Build donut chart showing spillover breakdown by pod for current cycle
 */
function buildSpilloverBreakdownChart(currentCycleData) {
  if (!currentCycleData?.success) {
    return { type: "doughnut", title: "Spillover Breakdown", data: { labels: [], datasets: [] } };
  }

  const POD_COLORS = {
    ML: "#ef4444",
    "Control Center": "#f97316",
    BTS: "#eab308",
    FTS: "#22c55e",
    GTS: "#14b8a6",
    Platform: "#3b82f6",
    FOT: "#6366f1",
    "Talent Studio": "#8b5cf6",
    "Growth & Reuse": "#ec4899",
  };

  // Filter pods with spillover
  const podsWithSpillover = currentCycleData.pods.filter(p => p.spillover > 0);

  const labels = podsWithSpillover.map(p => p.pod);
  const data = podsWithSpillover.map(p => p.spillover);
  const colors = podsWithSpillover.map(p => POD_COLORS[p.pod] || "#64748b");

  return {
    type: "doughnut",
    title: `Spillover Breakdown (${currentCycleData.cycle})`,
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: colors,
        borderColor: colors.map(c => c),
        borderWidth: 2,
      }],
    },
    meta: {
      totalSpillover: currentCycleData.totals.spillover,
      cycle: currentCycleData.cycle,
    },
  };
}

/**
 * Build delivery comparison bar chart
 */
function buildDeliveryComparisonChart(cyclesData, currentCycle) {
  const cycleData = cyclesData[currentCycle];
  if (!cycleData?.success) {
    return { type: "horizontalBar", title: "Delivery Comparison", data: { labels: [], datasets: [] } };
  }

  const POD_COLORS = {
    ML: "#ef4444",
    "Control Center": "#f97316",
    BTS: "#eab308",
    FTS: "#22c55e",
    GTS: "#14b8a6",
    Platform: "#3b82f6",
    FOT: "#6366f1",
    "Talent Studio": "#8b5cf6",
    "Growth & Reuse": "#ec4899",
  };

  // Sort by delivery %
  const sorted = [...cycleData.pods].sort((a, b) => b.deliveryPct - a.deliveryPct);

  const labels = sorted.map(p => p.pod);
  const deliveryData = sorted.map(p => p.deliveryPct);
  const colors = sorted.map(p => POD_COLORS[p.pod] || "#64748b");

  return {
    type: "horizontalBar",
    title: `Delivery % by Pod (${currentCycle})`,
    data: {
      labels,
      datasets: [{
        label: "Delivery %",
        data: deliveryData,
        backgroundColor: colors,
        borderRadius: 8,
      }],
    },
    meta: {
      committed: sorted.map(p => p.committed),
      completed: sorted.map(p => p.completed),
      spillover: sorted.map(p => p.spillover),
    },
  };
}

/**
 * Get spillover summary for a specific pod
 */
async function getPodSpilloverSummary(podName) {
  const allData = await getAllCyclesSpillover();

  if (!allData.success) {
    return { success: false, error: allData.error };
  }

  const cycles = ["C1", "C2", "C3", "C4", "C5", "C6"];
  const podSummary = cycles.map(cycle => {
    const cycleData = allData.cycles[cycle];
    if (!cycleData?.success) return null;
    const podData = cycleData.pods?.find(p => p.pod === podName);
    return podData || null;
  }).filter(Boolean);

  return {
    success: true,
    pod: podName,
    cycleData: podSummary,
    fetchedAt: allData.fetchedAt,
  };
}

module.exports = {
  getSpilloverByCycle,
  getAllCyclesSpillover,
  getCurrentCycleSpillover,
  getPreviousCycleSpillover,
  getSpilloverChartData,
  getPodSpilloverSummary,
};
