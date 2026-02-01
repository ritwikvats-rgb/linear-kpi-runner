/* agent/src/chartNarration.js
 * LLM-powered narration for chart data.
 */

const { fuelixChat } = require("./fuelixClient");

function safeJsonStringify(value, maxChars = 12000) {
  const json = JSON.stringify(value);
  if (json.length <= maxChars) return json;
  // Truncate at a safe boundary and note truncation in a valid way
  const truncated = json.slice(0, maxChars);
  // Find last complete key-value boundary (comma or opening brace)
  const lastSafe = Math.max(truncated.lastIndexOf(","), truncated.lastIndexOf("{"));
  if (lastSafe > maxChars * 0.5) {
    return truncated.slice(0, lastSafe) + ',"_truncated":true}';
  }
  return truncated + '"}';  // Close with minimal valid ending
}

function buildNarrationContext(chartData) {
  const { heroMetrics, deliveryChart, featureChart, cycleTrendChart, podHealthChart } = chartData;

  return {
    currentCycle: heroMetrics?.currentCycle,
    hero: heroMetrics
      ? {
          overallDeliveryPct: heroMetrics.overallDeliveryPct,
          totalCommitted: heroMetrics.totalCommitted,
          totalCompleted: heroMetrics.totalCompleted,
          totalFeatures: heroMetrics.totalFeatures,
          featuresDone: heroMetrics.featuresDone,
          featuresInFlight: heroMetrics.featuresInFlight,
          activePods: heroMetrics.activePods,
          totalPods: heroMetrics.totalPods,
          topPerformer: heroMetrics.topPerformer,
        }
      : null,
    delivery: deliveryChart?.meta
      ? {
          labels: deliveryChart.data?.labels,
          deliveryPct: deliveryChart.data?.datasets?.[0]?.data,
          committed: deliveryChart.meta.committed,
          completed: deliveryChart.meta.completed,
        }
      : null,
    features: featureChart?.meta
      ? {
          labels: featureChart.data?.labels,
          featureBreakdown: featureChart.data?.datasets?.[0]?.data,
          totalFeatures: featureChart.meta.totalFeatures,
          donePercentage: featureChart.meta.donePercentage,
        }
      : null,
    trend: cycleTrendChart?.data
      ? {
          cycles: cycleTrendChart.data.labels,
          datasets: (cycleTrendChart.data.datasets || []).map(ds => ({
            label: ds.label,
            data: ds.data,
          })),
        }
      : null,
    health: podHealthChart?.data
      ? {
          metrics: podHealthChart.data.labels,
          pods: (podHealthChart.data.datasets || []).map(ds => ({
            pod: ds.label,
            data: ds.data,
          })),
        }
      : null,
  };
}

async function generateChartNarration(chartData, { focus = "executive", maxBullets = 6 } = {}) {
  if (!chartData?.success) {
    return {
      success: false,
      error: chartData?.error || "CHART_DATA_ERROR",
      message: chartData?.message || "Chart data not available",
    };
  }

  const contextObj = buildNarrationContext(chartData);

  const systemPrompt = `You are an analytics narrator for an engineering KPI dashboard.
Write a concise summary that is grounded only in the provided JSON data.
Rules:
- Output must be valid JSON with keys: summary (string), bullets (string[]), risks (string[]), questions (string[]).
- Keep summary <= 280 characters.
- bullets: ${maxBullets} items max.
- Prefer concrete numbers over vague language.
- If data is missing, say so briefly rather than guessing.`;

  const userPrompt = `Focus: ${focus}

KPI JSON:
${safeJsonStringify(contextObj)}

Return only valid JSON.`;

  let response;
  try {
    response = await fuelixChat({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.2,
    });
  } catch (err) {
    return {
      success: false,
      error: "LLM_ERROR",
      message: err.message || "Failed to generate narration",
    };
  }

  // Extract JSON object - trim response first to avoid trailing content issues
  const trimmed = response.trim();
  const jsonMatch = trimmed.match(/^\{[\s\S]*\}$/) || trimmed.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return {
      success: false,
      error: "NARRATION_PARSE_ERROR",
      message: "LLM did not return JSON",
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch (e) {
    return {
      success: false,
      error: "NARRATION_PARSE_ERROR",
      message: e.message,
    };
  }

  return {
    success: true,
    narration: {
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      bullets: Array.isArray(parsed.bullets) ? parsed.bullets.slice(0, maxBullets) : [],
      risks: Array.isArray(parsed.risks) ? parsed.risks.slice(0, maxBullets) : [],
      questions: Array.isArray(parsed.questions) ? parsed.questions.slice(0, maxBullets) : [],
    },
    generatedAt: new Date().toISOString(),
    source: "llm",
  };
}

module.exports = { generateChartNarration };
