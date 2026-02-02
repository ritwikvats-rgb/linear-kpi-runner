/* agent/src/chartDataService.js
 * Aggregates KPI data for chart consumption
 * Returns structured data for all chart types
 */

const {
  computeWeeklyKpi,
  computeCycleKpi,
  computeFeatureMovement,
} = require("./kpiComputer");

// Pod color palette for charts - distinct colors for each pod
const POD_COLORS = {
  ML: { primary: "#ef4444", gradient: ["#ef4444", "#f87171"] },              // Red
  "Control Center": { primary: "#f97316", gradient: ["#f97316", "#fb923c"] }, // Orange
  BTS: { primary: "#eab308", gradient: ["#eab308", "#facc15"] },              // Yellow
  FTS: { primary: "#22c55e", gradient: ["#22c55e", "#4ade80"] },              // Green
  GTS: { primary: "#14b8a6", gradient: ["#14b8a6", "#2dd4bf"] },              // Teal
  Platform: { primary: "#3b82f6", gradient: ["#3b82f6", "#60a5fa"] },         // Blue
  FOT: { primary: "#6366f1", gradient: ["#6366f1", "#818cf8"] },              // Indigo
  "Talent Studio": { primary: "#8b5cf6", gradient: ["#8b5cf6", "#a78bfa"] },  // Purple
  "Growth and Reuse": { primary: "#ec4899", gradient: ["#ec4899", "#f472b6"] }, // Pink
};

// Default color for unknown pods
const DEFAULT_COLOR = { primary: "#64748b", gradient: ["#64748b", "#94a3b8"] };

/**
 * Get color for a pod
 */
function getPodColor(podName) {
  return POD_COLORS[podName] || DEFAULT_COLOR;
}

/**
 * Get all chart data in a single call
 * Returns: { deliveryChart, featureChart, cycleTrendChart, podHealthChart, heroMetrics }
 */
async function getChartData() {
  const kpiResult = await computeWeeklyKpi();

  if (!kpiResult.success) {
    return {
      success: false,
      error: kpiResult.error,
      message: kpiResult.message,
    };
  }

  const currentCycle = kpiResult.fallbackCycle || kpiResult.currentCycle;
  const cycleKpi = kpiResult.cycleKpi || [];
  const featureMovement = kpiResult.featureMovement || [];

  // Build all chart data
  const deliveryChart = buildDeliveryComparisonChart(cycleKpi, currentCycle);
  const featureChart = buildFeatureProgressChart(featureMovement);
  const cycleTrendChart = buildCycleTrendChart(cycleKpi);
  const podHealthChart = buildPodHealthChart(cycleKpi, featureMovement, currentCycle);
  const heroMetrics = buildHeroMetrics(cycleKpi, featureMovement, currentCycle);

  // Build per-pod feature comparison data for Planned vs Completed chart
  const featureByPodChart = buildFeatureByPodChart(featureMovement);

  return {
    success: true,
    currentCycle,
    fetchedAt: kpiResult.fetchedAt,
    deliveryChart,
    featureChart,
    cycleTrendChart,
    podHealthChart,
    heroMetrics,
    featureByPodChart,
  };
}

/**
 * Build Delivery Comparison chart data (Horizontal Bar)
 * Shows delivery % by pod for current cycle
 */
function buildDeliveryComparisonChart(cycleKpi, currentCycle) {
  const filtered = cycleKpi.filter(r => r.cycle === currentCycle && r.status === "OK");

  // Sort by delivery % descending
  const sorted = [...filtered].sort((a, b) => {
    const pctA = parseInt(a.deliveryPct) || 0;
    const pctB = parseInt(b.deliveryPct) || 0;
    return pctB - pctA;
  });

  const labels = sorted.map(r => r.pod);
  const deliveryData = sorted.map(r => parseInt(r.deliveryPct) || 0);
  const colors = sorted.map(r => getPodColor(r.pod).primary);
  const gradients = sorted.map(r => getPodColor(r.pod).gradient);

  // Additional data for tooltips
  const committed = sorted.map(r => r.committed);
  const completed = sorted.map(r => r.completed);

  return {
    type: "horizontalBar",
    title: `Delivery Comparison (${currentCycle})`,
    data: {
      labels,
      datasets: [{
        label: "Delivery %",
        data: deliveryData,
        backgroundColor: colors,
        borderColor: colors,
        borderWidth: 0,
        borderRadius: 8,
        barThickness: 32,
      }],
    },
    meta: {
      committed,
      completed,
      cycle: currentCycle,
    },
  };
}

/**
 * Build Feature Progress chart data (Donut)
 * Shows Done/InFlight/NotStarted totals across all pods
 */
function buildFeatureProgressChart(featureMovement) {
  const totals = featureMovement.reduce(
    (acc, r) => {
      acc.done += r.done || 0;
      acc.inFlight += r.inFlight || 0;
      acc.notStarted += r.notStarted || 0;
      acc.total += r.plannedFeatures || 0;
      return acc;
    },
    { done: 0, inFlight: 0, notStarted: 0, total: 0 }
  );

  return {
    type: "doughnut",
    title: "Feature Progress",
    data: {
      labels: ["Done", "In Flight", "Not Started"],
      datasets: [{
        data: [totals.done, totals.inFlight, totals.notStarted],
        backgroundColor: ["#22c55e", "#f59e0b", "#64748b"],
        borderColor: ["#16a34a", "#d97706", "#475569"],
        borderWidth: 2,
        hoverOffset: 8,
      }],
    },
    meta: {
      totalFeatures: totals.total,
      donePercentage: totals.total > 0 ? Math.round((totals.done / totals.total) * 100) : 0,
    },
  };
}

/**
 * Build Feature by Pod chart data (Grouped Bar)
 * Shows Planned vs Completed features per pod
 */
function buildFeatureByPodChart(featureMovement) {
  // Sort by planned features descending
  const sorted = [...featureMovement].sort((a, b) =>
    (b.plannedFeatures || 0) - (a.plannedFeatures || 0)
  );

  const labels = sorted.map(r => r.pod);
  const planned = sorted.map(r => r.plannedFeatures || 0);
  const completed = sorted.map(r => r.done || 0);

  return {
    type: "groupedBar",
    title: "Feature + Tech Debt: Planned vs Completed",
    data: {
      labels,
      datasets: [
        {
          label: "Planned",
          data: planned,
          backgroundColor: "#6366f1",
          borderColor: "#4338ca",
          borderWidth: { top: 0, right: 3, bottom: 3, left: 0 },
          borderRadius: 6,
          borderSkipped: false,
        },
        {
          label: "Completed",
          data: completed,
          backgroundColor: "#10b981",
          borderColor: "#059669",
          borderWidth: { top: 0, right: 3, bottom: 3, left: 0 },
          borderRadius: 6,
          borderSkipped: false,
        }
      ],
    },
    meta: {
      inFlight: sorted.map(r => r.inFlight || 0),
      notStarted: sorted.map(r => r.notStarted || 0),
      completionRates: sorted.map(r =>
        r.plannedFeatures > 0 ? Math.round((r.done / r.plannedFeatures) * 100) : 0
      ),
    },
  };
}

/**
 * Build Cycle Trend chart data (Line)
 * Shows delivery % over C1-C6 per pod
 * Always shows all 6 cycles on x-axis
 */
function buildCycleTrendChart(cycleKpi) {
  const cycles = ["C1", "C2", "C3", "C4", "C5", "C6"];

  // Get unique pods
  const pods = [...new Set(cycleKpi.filter(r => r.status === "OK").map(r => r.pod))];

  // Build datasets for each pod
  const datasets = pods.map(pod => {
    const podColor = getPodColor(pod);
    const data = cycles.map(cycle => {
      const row = cycleKpi.find(r => r.pod === pod && r.cycle === cycle);
      if (!row || row.committed === 0) return null; // No data for this cycle
      return parseInt(row.deliveryPct) || 0;
    });

    return {
      label: pod,
      data,
      borderColor: podColor.primary,
      backgroundColor: `${podColor.primary}20`,
      fill: false,
      tension: 0.4,
      pointBackgroundColor: podColor.primary,
      pointBorderColor: "#fff",
      pointBorderWidth: 2,
      pointRadius: 6,
      pointHoverRadius: 8,
      spanGaps: false,
    };
  });

  return {
    type: "line",
    title: "Delivery Trend Across Cycles",
    data: {
      labels: cycles,
      datasets,
    },
  };
}

/**
 * Build Pod Health chart data (Radar)
 * Multi-metric comparison: Delivery %, Completion Rate, Feature Progress
 */
function buildPodHealthChart(cycleKpi, featureMovement, currentCycle) {
  const pods = [...new Set(cycleKpi.filter(r => r.status === "OK").map(r => r.pod))];

  const datasets = pods.map(pod => {
    const podColor = getPodColor(pod);

    // Get current cycle data
    const cycleData = cycleKpi.find(r => r.pod === pod && r.cycle === currentCycle) || {};
    const featureData = featureMovement.find(r => r.pod === pod) || {};

    // Calculate metrics (normalized to 0-100)
    const deliveryPct = parseInt(cycleData.deliveryPct) || 0;

    // Commitment score: higher if committed > 0
    const commitmentScore = cycleData.committed > 0 ? Math.min(100, cycleData.committed * 20) : 0;

    // Feature completion rate
    const featureTotal = featureData.plannedFeatures || 0;
    const featureCompletionRate = featureTotal > 0
      ? Math.round((featureData.done / featureTotal) * 100)
      : 0;

    // Velocity score (in-flight indicates active work)
    const velocityScore = featureTotal > 0
      ? Math.round(((featureData.done + featureData.inFlight) / featureTotal) * 100)
      : 0;

    // No spillover is good (invert the metric)
    const spilloverScore = cycleData.committed > 0
      ? Math.max(0, 100 - (cycleData.spillover / cycleData.committed) * 100)
      : 100;

    return {
      label: pod,
      data: [deliveryPct, commitmentScore, featureCompletionRate, velocityScore, spilloverScore],
      borderColor: podColor.primary,
      backgroundColor: `${podColor.primary}30`,
      pointBackgroundColor: podColor.primary,
      pointBorderColor: "#fff",
      pointBorderWidth: 2,
    };
  });

  return {
    type: "radar",
    title: "Pod Health Overview",
    data: {
      labels: ["Delivery %", "Commitment", "Features Done", "Velocity", "No Spillover"],
      datasets,
    },
  };
}

/**
 * Build hero metrics for top bar
 */
function buildHeroMetrics(cycleKpi, featureMovement, currentCycle) {
  const currentCycleData = cycleKpi.filter(r => r.cycle === currentCycle && r.status === "OK");

  // Total DELs metrics
  const totalCommitted = currentCycleData.reduce((sum, r) => sum + r.committed, 0);
  const totalCompleted = currentCycleData.reduce((sum, r) => sum + r.completed, 0);
  const overallDeliveryPct = totalCommitted > 0
    ? Math.round((totalCompleted / totalCommitted) * 100)
    : 0;

  // Feature metrics
  const featureTotals = featureMovement.reduce(
    (acc, r) => {
      acc.total += r.plannedFeatures || 0;
      acc.done += r.done || 0;
      acc.inFlight += r.inFlight || 0;
      return acc;
    },
    { total: 0, done: 0, inFlight: 0 }
  );

  // Active pods count
  const activePods = currentCycleData.filter(r => r.committed > 0).length;

  // Top performer
  const topPerformer = [...currentCycleData]
    .filter(r => r.committed > 0)
    .sort((a, b) => (parseInt(b.deliveryPct) || 0) - (parseInt(a.deliveryPct) || 0))[0];

  return {
    overallDeliveryPct,
    totalCommitted,
    totalCompleted,
    totalFeatures: featureTotals.total,
    featuresInFlight: featureTotals.inFlight,
    featuresDone: featureTotals.done,
    activePods,
    totalPods: currentCycleData.length,
    currentCycle,
    topPerformer: topPerformer ? {
      pod: topPerformer.pod,
      deliveryPct: topPerformer.deliveryPct,
    } : null,
  };
}

/**
 * Get per-pod detailed data for drill-down
 */
async function getPodDetailData(podName) {
  const kpiResult = await computeWeeklyKpi();

  if (!kpiResult.success) {
    return {
      success: false,
      error: kpiResult.error,
      message: kpiResult.message,
    };
  }

  const currentCycle = kpiResult.fallbackCycle || kpiResult.currentCycle;
  const cycleKpi = kpiResult.cycleKpi || [];
  const featureMovement = kpiResult.featureMovement || [];

  // Get this pod's data
  const podCycleData = cycleKpi.filter(r => r.pod === podName);
  const podFeatureData = featureMovement.find(r => r.pod === podName);

  if (podCycleData.length === 0) {
    return {
      success: false,
      error: "POD_NOT_FOUND",
      message: `Pod "${podName}" not found in data.`,
    };
  }

  // Build cycle trend for this pod
  const cycles = ["C1", "C2", "C3", "C4", "C5", "C6"];
  const podColor = getPodColor(podName);

  const cycleTrend = {
    labels: cycles,
    datasets: [{
      label: "Delivery %",
      data: cycles.map(c => {
        const row = podCycleData.find(r => r.cycle === c);
        return row && row.committed > 0 ? parseInt(row.deliveryPct) || 0 : null;
      }),
      borderColor: podColor.primary,
      backgroundColor: podColor.gradient[0],
      fill: true,
      tension: 0.4,
    }],
  };

  return {
    success: true,
    podName,
    color: podColor,
    currentCycle,
    currentCycleData: podCycleData.find(r => r.cycle === currentCycle),
    featureData: podFeatureData,
    cycleTrend,
    allCycles: podCycleData,
  };
}

module.exports = {
  getChartData,
  getPodDetailData,
  getPodColor,
  POD_COLORS,
};
