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
 */
function generateRuleBasedInsights(chartData) {
  const insights = [];
  const { heroMetrics, deliveryChart } = chartData;

  if (!heroMetrics) return insights;

  // Highlight: Top performer
  if (heroMetrics.topPerformer && parseInt(heroMetrics.topPerformer.deliveryPct) >= 80) {
    insights.push({
      type: "highlight",
      title: "Top Performer",
      text: `${heroMetrics.topPerformer.pod} leads with ${heroMetrics.topPerformer.deliveryPct} delivery rate in ${heroMetrics.currentCycle}.`,
      relatedChart: "delivery",
      relatedPod: heroMetrics.topPerformer.pod,
      priority: 1,
    });
  }

  // Warning: Low overall delivery
  if (heroMetrics.overallDeliveryPct < 50 && heroMetrics.totalCommitted > 0) {
    insights.push({
      type: "warning",
      title: "Delivery At Risk",
      text: `Overall delivery at ${heroMetrics.overallDeliveryPct}%. Consider reviewing blockers across pods.`,
      relatedChart: "delivery",
      priority: 2,
    });
  }

  // Highlight: High overall delivery
  if (heroMetrics.overallDeliveryPct >= 80 && heroMetrics.totalCommitted > 0) {
    insights.push({
      type: "highlight",
      title: "Strong Delivery",
      text: `Excellent overall delivery at ${heroMetrics.overallDeliveryPct}% - team is executing well!`,
      relatedChart: "delivery",
      priority: 1,
    });
  }

  // Trend: Features in flight
  if (heroMetrics.featuresInFlight > 0) {
    const inFlightPct = heroMetrics.totalFeatures > 0
      ? Math.round((heroMetrics.featuresInFlight / heroMetrics.totalFeatures) * 100)
      : 0;
    insights.push({
      type: "trend",
      title: "Active Development",
      text: `${heroMetrics.featuresInFlight} features (${inFlightPct}%) currently in flight across ${heroMetrics.activePods} pods.`,
      relatedChart: "feature",
      priority: 3,
    });
  }

  // Warning: Pods with 0% delivery
  if (deliveryChart && deliveryChart.data) {
    const zeroDeliveryPods = deliveryChart.data.labels.filter((pod, i) =>
      deliveryChart.data.datasets[0].data[i] === 0 && deliveryChart.meta.committed[i] > 0
    );

    if (zeroDeliveryPods.length > 0) {
      insights.push({
        type: "warning",
        title: "No Completions",
        text: `${zeroDeliveryPods.join(", ")} ${zeroDeliveryPods.length === 1 ? "has" : "have"} committed DELs but 0% completion.`,
        relatedChart: "delivery",
        relatedPods: zeroDeliveryPods,
        priority: 1,
      });
    }
  }

  // Action: Suggest focus areas
  if (heroMetrics.totalCommitted > heroMetrics.totalCompleted) {
    const remaining = heroMetrics.totalCommitted - heroMetrics.totalCompleted;
    insights.push({
      type: "action",
      title: "Focus Area",
      text: `${remaining} DELs remaining in ${heroMetrics.currentCycle}. Prioritize completion before cycle ends.`,
      relatedChart: "delivery",
      priority: 2,
    });
  }

  // Sort by priority
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
