/* agent/src/chartInsights.js
 * AI-powered insight generation for chart data
 * Uses fuelixClient for intelligent analysis
 */

const { fuelixChat } = require("./fuelixClient");

// Insight types with styling metadata
const INSIGHT_TYPES = {
  highlight: { icon: "star", color: "#22c55e", label: "Highlight" },
  warning: { icon: "alert-triangle", color: "#f59e0b", label: "Attention" },
  trend: { icon: "trending-up", color: "#6366f1", label: "Trend" },
  action: { icon: "zap", color: "#ec4899", label: "Action" },
};

/**
 * Generate AI-powered insights from chart data
 * @param {object} chartData - The chart data from chartDataService
 * @returns {object} - { success, insights: [...] }
 */
async function generateChartInsights(chartData) {
  if (!chartData.success) {
    return {
      success: false,
      error: chartData.error,
      message: chartData.message,
    };
  }

  try {
    // Generate rule-based insights first (fast, always available)
    const ruleBasedInsights = generateRuleBasedInsights(chartData);

    // Try to get AI-enhanced insights
    let aiInsights = [];
    try {
      aiInsights = await generateAIInsights(chartData);
    } catch (err) {
      console.error("AI insight generation failed, using rule-based only:", err.message);
    }

    // Combine and deduplicate insights
    const allInsights = [...aiInsights, ...ruleBasedInsights];
    const uniqueInsights = deduplicateInsights(allInsights);

    // Limit to top 6 insights
    const topInsights = uniqueInsights.slice(0, 6);

    return {
      success: true,
      insights: topInsights,
      generatedAt: new Date().toISOString(),
      source: aiInsights.length > 0 ? "ai_enhanced" : "rule_based",
    };
  } catch (err) {
    console.error("Insight generation error:", err);
    return {
      success: false,
      error: "INSIGHT_GENERATION_FAILED",
      message: err.message,
      insights: generateRuleBasedInsights(chartData),
    };
  }
}

/**
 * Generate rule-based insights (always available, no AI needed)
 * Comprehensive analysis across all pods
 */
function generateRuleBasedInsights(chartData) {
  const insights = [];
  const { heroMetrics, deliveryChart, featureChart, podHealthChart, cycleTrendChart } = chartData;

  if (!heroMetrics) return insights;

  // ============== DELIVERY INSIGHTS ==============

  // Top performer with context
  if (heroMetrics.topPerformer) {
    const pct = parseInt(heroMetrics.topPerformer.deliveryPct) || 0;
    if (pct > 0) {
      insights.push({
        type: "highlight",
        title: "Top Performer",
        text: `${heroMetrics.topPerformer.pod} leads with ${heroMetrics.topPerformer.deliveryPct} delivery in ${heroMetrics.currentCycle}.`,
        relatedChart: "delivery",
        relatedPod: heroMetrics.topPerformer.pod,
        priority: 1,
      });
    }
  }

  // Overall delivery status
  if (heroMetrics.totalCommitted > 0) {
    if (heroMetrics.overallDeliveryPct >= 80) {
      insights.push({
        type: "highlight",
        title: "Strong Execution",
        text: `Team delivering at ${heroMetrics.overallDeliveryPct}% - ${heroMetrics.totalCompleted}/${heroMetrics.totalCommitted} DELs complete.`,
        relatedChart: "delivery",
        priority: 1,
      });
    } else if (heroMetrics.overallDeliveryPct < 40) {
      insights.push({
        type: "warning",
        title: "Delivery At Risk",
        text: `Only ${heroMetrics.overallDeliveryPct}% delivered. ${heroMetrics.totalCommitted - heroMetrics.totalCompleted} DELs pending.`,
        relatedChart: "delivery",
        priority: 1,
      });
    }
  }

  // ============== PER-POD ANALYSIS ==============

  if (deliveryChart && deliveryChart.data) {
    const labels = deliveryChart.data.labels;
    const data = deliveryChart.data.datasets[0].data;
    const committed = deliveryChart.meta.committed;
    const completed = deliveryChart.meta.completed;

    // Find pods needing attention (committed but low/zero delivery)
    const needsAttention = [];
    const performingWell = [];
    const notStarted = [];

    labels.forEach((pod, i) => {
      const pct = data[i];
      const comm = committed[i];
      const comp = completed[i];

      if (comm > 0 && pct === 0) {
        needsAttention.push({ pod, committed: comm, completed: comp, pct });
      } else if (comm > 0 && pct < 30) {
        needsAttention.push({ pod, committed: comm, completed: comp, pct });
      } else if (comm > 0 && pct >= 50) {
        performingWell.push({ pod, committed: comm, completed: comp, pct });
      } else if (comm === 0) {
        notStarted.push(pod);
      }
    });

    // Warning for struggling pods
    if (needsAttention.length > 0) {
      const podList = needsAttention.map(p => `${p.pod} (${p.pct}%)`).join(", ");
      insights.push({
        type: "warning",
        title: "Needs Attention",
        text: `Low delivery: ${podList}. Review blockers and dependencies.`,
        relatedChart: "delivery",
        relatedPods: needsAttention.map(p => p.pod),
        priority: 1,
      });
    }

    // Highlight performing pods
    if (performingWell.length > 1) {
      const podList = performingWell.map(p => p.pod).join(", ");
      insights.push({
        type: "highlight",
        title: "Pods On Track",
        text: `${podList} showing solid progress with ${performingWell.map(p => p.pct + "%").join(", ")} delivery.`,
        relatedChart: "delivery",
        priority: 2,
      });
    }

    // Info about inactive pods
    if (notStarted.length > 0) {
      insights.push({
        type: "trend",
        title: "No Commitments",
        text: `${notStarted.join(", ")} ${notStarted.length === 1 ? "has" : "have"} no DEL commitments this cycle.`,
        relatedChart: "delivery",
        priority: 4,
      });
    }
  }

  // ============== FEATURE INSIGHTS ==============

  if (featureChart && featureChart.meta) {
    const { totalFeatures, donePercentage } = featureChart.meta;
    const featureData = featureChart.data.datasets[0].data;
    const done = featureData[0] || 0;
    const inFlight = featureData[1] || 0;
    const notStarted = featureData[2] || 0;

    // Feature velocity
    if (totalFeatures > 0) {
      const activeWork = done + inFlight;
      const activePct = Math.round((activeWork / totalFeatures) * 100);

      insights.push({
        type: "trend",
        title: "Feature Velocity",
        text: `${activePct}% features active (${done} done, ${inFlight} in flight). ${notStarted} not started.`,
        relatedChart: "feature",
        priority: 3,
      });

      // Warning if too many not started
      if (notStarted > inFlight + done) {
        insights.push({
          type: "warning",
          title: "Features Backlogged",
          text: `${notStarted} features (${Math.round((notStarted/totalFeatures)*100)}%) not yet started. Consider prioritization.`,
          relatedChart: "feature",
          priority: 2,
        });
      }
    }
  }

  // ============== CYCLE TREND INSIGHTS ==============

  if (cycleTrendChart && cycleTrendChart.data) {
    const datasets = cycleTrendChart.data.datasets;
    const cycles = cycleTrendChart.data.labels;

    // Analyze trends for each pod
    const improving = [];
    const declining = [];

    datasets.forEach(ds => {
      const data = ds.data.filter(d => d !== null);
      if (data.length >= 2) {
        const lastTwo = data.slice(-2);
        const diff = lastTwo[1] - lastTwo[0];
        if (diff > 20) {
          improving.push({ pod: ds.label, diff });
        } else if (diff < -20) {
          declining.push({ pod: ds.label, diff: Math.abs(diff) });
        }
      }
    });

    if (improving.length > 0) {
      insights.push({
        type: "highlight",
        title: "Improving Trend",
        text: `${improving.map(p => p.pod).join(", ")} showing improvement vs previous cycle.`,
        relatedChart: "trend",
        priority: 2,
      });
    }

    if (declining.length > 0) {
      insights.push({
        type: "warning",
        title: "Declining Trend",
        text: `${declining.map(p => p.pod).join(", ")} dropped from previous cycle. Investigate causes.`,
        relatedChart: "trend",
        priority: 1,
      });
    }
  }

  // ============== POD HEALTH INSIGHTS ==============

  if (podHealthChart && podHealthChart.data) {
    const datasets = podHealthChart.data.datasets;
    const healthMetrics = podHealthChart.data.labels; // ["Delivery %", "Commitment", "Features Done", "Velocity", "No Spillover"]

    // Find pods with balanced vs imbalanced metrics
    const healthScores = datasets.map(ds => {
      const avg = ds.data.reduce((a, b) => a + b, 0) / ds.data.length;
      const variance = ds.data.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / ds.data.length;
      return { pod: ds.label, avg: Math.round(avg), variance: Math.round(variance), data: ds.data };
    });

    // Highlight well-rounded pods
    const wellRounded = healthScores.filter(p => p.avg >= 50 && p.variance < 500);
    if (wellRounded.length > 0) {
      insights.push({
        type: "highlight",
        title: "Balanced Teams",
        text: `${wellRounded.map(p => p.pod).join(", ")} showing balanced health across all metrics.`,
        relatedChart: "health",
        priority: 3,
      });
    }
  }

  // ============== ACTION ITEMS ==============

  // Remaining work
  if (heroMetrics.totalCommitted > heroMetrics.totalCompleted) {
    const remaining = heroMetrics.totalCommitted - heroMetrics.totalCompleted;
    const completionRate = heroMetrics.totalCommitted > 0
      ? Math.round((heroMetrics.totalCompleted / heroMetrics.totalCommitted) * 100)
      : 0;

    insights.push({
      type: "action",
      title: "Sprint Focus",
      text: `${remaining} DELs remaining (${100 - completionRate}% of commitment). Focus on completion.`,
      relatedChart: "delivery",
      priority: 2,
    });
  }

  // Sort by priority and return
  return insights.sort((a, b) => a.priority - b.priority);
}

/**
 * Generate AI-enhanced insights using fuelixChat
 */
async function generateAIInsights(chartData) {
  const { heroMetrics, deliveryChart, featureChart, cycleTrendChart } = chartData;

  // Build context for AI
  const context = buildAIContext(chartData);

  const systemPrompt = `You are a data analyst assistant that provides concise, actionable insights about engineering team KPIs.
Given the following KPI data, generate 3-4 brief insights. Each insight should be:
- One sentence (max 100 characters)
- Actionable or informative
- Focused on what matters to engineering leadership

Return JSON array with objects containing: type (highlight|warning|trend|action), title (2-3 words), text (the insight)`;

  const userPrompt = `Analyze this engineering KPI data and provide insights:

${context}

Return only valid JSON array. Example format:
[{"type":"highlight","title":"Top Performer","text":"FTS leads with 95% delivery."}]`;

  try {
    const response = await fuelixChat({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    // Parse AI response
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.error("AI response not valid JSON array");
      return [];
    }

    const aiInsights = JSON.parse(jsonMatch[0]);

    // Validate and format insights
    return aiInsights
      .filter(i => i.type && i.title && i.text)
      .map(i => ({
        type: INSIGHT_TYPES[i.type] ? i.type : "trend",
        title: i.title.substring(0, 30),
        text: i.text.substring(0, 150),
        relatedChart: inferRelatedChart(i.text),
        priority: i.type === "warning" ? 1 : i.type === "action" ? 2 : 3,
        source: "ai",
      }));
  } catch (err) {
    console.error("AI insight parsing error:", err.message);
    return [];
  }
}

/**
 * Build context string for AI analysis
 */
function buildAIContext(chartData) {
  const { heroMetrics, deliveryChart } = chartData;
  let context = "";

  context += `Current Cycle: ${heroMetrics.currentCycle}\n`;
  context += `Overall Delivery: ${heroMetrics.overallDeliveryPct}% (${heroMetrics.totalCompleted}/${heroMetrics.totalCommitted} DELs)\n`;
  context += `Total Features: ${heroMetrics.totalFeatures} (Done: ${heroMetrics.featuresDone}, In Flight: ${heroMetrics.featuresInFlight})\n`;
  context += `Active Pods: ${heroMetrics.activePods}/${heroMetrics.totalPods}\n\n`;

  if (deliveryChart && deliveryChart.data) {
    context += "Delivery by Pod:\n";
    deliveryChart.data.labels.forEach((pod, i) => {
      const pct = deliveryChart.data.datasets[0].data[i];
      const committed = deliveryChart.meta.committed[i];
      context += `- ${pod}: ${pct}% (${committed} committed)\n`;
    });
  }

  return context;
}

/**
 * Infer which chart an insight relates to based on text content
 */
function inferRelatedChart(text) {
  const lower = text.toLowerCase();
  if (lower.includes("delivery") || lower.includes("del") || lower.includes("completed")) {
    return "delivery";
  }
  if (lower.includes("feature") || lower.includes("flight") || lower.includes("done")) {
    return "feature";
  }
  if (lower.includes("trend") || lower.includes("cycle") || lower.includes("c1") || lower.includes("c2")) {
    return "trend";
  }
  if (lower.includes("health") || lower.includes("velocity") || lower.includes("commitment")) {
    return "health";
  }
  return "delivery";
}

/**
 * Deduplicate insights by title similarity
 */
function deduplicateInsights(insights) {
  const seen = new Set();
  return insights.filter(insight => {
    const key = insight.title.toLowerCase().replace(/\s+/g, "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Get insight type metadata
 */
function getInsightTypeMeta(type) {
  return INSIGHT_TYPES[type] || INSIGHT_TYPES.trend;
}

module.exports = {
  generateChartInsights,
  generateRuleBasedInsights,
  getInsightTypeMeta,
  INSIGHT_TYPES,
};
