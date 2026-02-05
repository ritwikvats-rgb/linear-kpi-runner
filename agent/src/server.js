/* agent/src/server.js
 * Simple Express server for VP-friendly KPI interface
 *
 * Run: node agent/src/server.js
 * Open: http://localhost:3000
 */
const express = require("express");
const path = require("path");
const { answer } = require("./answerer");
const { getChartData, getPodDetailData } = require("./chartDataService");
const { generateChartInsights } = require("./chartInsights");
const { generateChartNarration } = require("./chartNarration");
const {
  getSpilloverByCycle,
  getCurrentCycleSpillover,
  getAllCyclesSpillover,
  getSpilloverChartData,
  getPodSpilloverSummary,
} = require("./spilloverService");
const { SlackClient } = require("./slackClient");
const { LinearClient } = require("./linearClient");
const { ProjectChannelMapper } = require("./projectChannelMapper");
const { ProjectAnalyzer } = require("./projectAnalyzer");
const {
  generateWeeklyReport,
  postWeeklyReport,
  startScheduler,
  detectReportCycles,
} = require("./weeklyReportService");

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Main question endpoint - supports conversation history
app.post("/api/ask", async (req, res) => {
  const { question, mobile, history } = req.body;

  if (!question || typeof question !== "string") {
    return res.status(400).json({
      error: "Missing question",
      message: "Please provide a question in the request body"
    });
  }

  try {
    // Use the existing answerer which returns grounded data
    // Pass mobile flag for simplified output format
    // Pass conversation history for context
    const response = await answer(question.trim(), null, {
      mobile: !!mobile,
      history: Array.isArray(history) ? history.slice(-6) : [] // Keep last 6 messages (3 exchanges)
    });

    res.json({
      success: true,
      question: question.trim(),
      answer: response,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error("Error processing question:", err);
    res.status(500).json({
      success: false,
      error: "Failed to process question",
      message: err.message || "An unexpected error occurred"
    });
  }
});

// ============== CHART ENDPOINTS ==============

// Get all chart data
app.get("/api/charts/data", async (req, res) => {
  try {
    const data = await getChartData();
    res.json(data);
  } catch (err) {
    console.error("Error fetching chart data:", err);
    res.status(500).json({
      success: false,
      error: "CHART_DATA_ERROR",
      message: err.message || "Failed to fetch chart data"
    });
  }
});

// Get AI-powered chart insights
app.get("/api/charts/insights", async (req, res) => {
  try {
    const chartData = await getChartData();
    const insights = await generateChartInsights(chartData);
    res.json(insights);
  } catch (err) {
    console.error("Error generating insights:", err);
    res.status(500).json({
      success: false,
      error: "INSIGHT_ERROR",
      message: err.message || "Failed to generate insights"
    });
  }
});

// Get LLM-powered chart narration
app.get("/api/charts/narration", async (req, res) => {
  try {
    const focus = typeof req.query.focus === "string" ? req.query.focus : "executive";
    const chartData = await getChartData();
    const narration = await generateChartNarration(chartData, { focus });
    res.json(narration);
  } catch (err) {
    console.error("Error generating narration:", err);
    res.status(500).json({
      success: false,
      error: "NARRATION_ERROR",
      message: err.message || "Failed to generate narration"
    });
  }
});

// Get pod detail data for drill-down
app.get("/api/charts/pod/:podName", async (req, res) => {
  try {
    const data = await getPodDetailData(req.params.podName);
    res.json(data);
  } catch (err) {
    console.error("Error fetching pod detail:", err);
    res.status(500).json({
      success: false,
      error: "POD_DETAIL_ERROR",
      message: err.message || "Failed to fetch pod detail"
    });
  }
});

// ============== SPILLOVER ENDPOINTS ==============

// Get spillover data for current cycle
app.get("/api/spillover/current", async (req, res) => {
  try {
    const data = await getCurrentCycleSpillover();
    res.json(data);
  } catch (err) {
    console.error("Error fetching current spillover:", err);
    res.status(500).json({
      success: false,
      error: "SPILLOVER_ERROR",
      message: err.message || "Failed to fetch spillover data"
    });
  }
});

// Get spillover data for a specific cycle
app.get("/api/spillover/cycle/:cycleKey", async (req, res) => {
  try {
    const data = await getSpilloverByCycle(req.params.cycleKey);
    res.json(data);
  } catch (err) {
    console.error("Error fetching cycle spillover:", err);
    res.status(500).json({
      success: false,
      error: "SPILLOVER_ERROR",
      message: err.message || "Failed to fetch spillover data"
    });
  }
});

// Get spillover data for all cycles (for charts)
app.get("/api/spillover/all", async (req, res) => {
  try {
    const data = await getAllCyclesSpillover();
    res.json(data);
  } catch (err) {
    console.error("Error fetching all spillover:", err);
    res.status(500).json({
      success: false,
      error: "SPILLOVER_ERROR",
      message: err.message || "Failed to fetch spillover data"
    });
  }
});

// Get spillover chart data (formatted for charts)
app.get("/api/spillover/charts", async (req, res) => {
  try {
    const data = await getSpilloverChartData();
    res.json(data);
  } catch (err) {
    console.error("Error fetching spillover charts:", err);
    res.status(500).json({
      success: false,
      error: "SPILLOVER_CHART_ERROR",
      message: err.message || "Failed to fetch spillover charts"
    });
  }
});

// Get spillover summary for a specific pod
app.get("/api/spillover/pod/:podName", async (req, res) => {
  try {
    const data = await getPodSpilloverSummary(req.params.podName);
    res.json(data);
  } catch (err) {
    console.error("Error fetching pod spillover:", err);
    res.status(500).json({
      success: false,
      error: "POD_SPILLOVER_ERROR",
      message: err.message || "Failed to fetch pod spillover"
    });
  }
});

// ============== SLACK INTEGRATION ENDPOINTS ==============

// Initialize Slack/Linear clients (lazy)
let slackClient = null;
let linearClient = null;
let projectAnalyzer = null;

function getSlackClient() {
  if (!slackClient && process.env.SLACK_BOT_TOKEN) {
    slackClient = new SlackClient({ botToken: process.env.SLACK_BOT_TOKEN });
  }
  return slackClient;
}

function getLinearClient() {
  if (!linearClient && process.env.LINEAR_API_KEY) {
    linearClient = new LinearClient({ apiKey: process.env.LINEAR_API_KEY });
  }
  return linearClient;
}

function getProjectAnalyzer() {
  if (!projectAnalyzer) {
    const slack = getSlackClient();
    const linear = getLinearClient();
    if (slack && linear) {
      projectAnalyzer = new ProjectAnalyzer({ linearClient: linear, slackClient: slack });
    }
  }
  return projectAnalyzer;
}

// Check Slack connection status
app.get("/api/slack/status", async (req, res) => {
  try {
    const slack = getSlackClient();
    if (!slack) {
      return res.json({ ok: false, error: "SLACK_BOT_TOKEN not configured" });
    }
    const auth = await slack.testAuth();
    res.json({ ok: true, bot: auth.user, team: auth.team });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// Get projects with Slack channels
app.get("/api/slack/projects", async (req, res) => {
  try {
    const linear = getLinearClient();
    if (!linear) {
      return res.status(500).json({ error: "LINEAR_API_KEY not configured" });
    }
    const mapper = new ProjectChannelMapper({ linearClient: linear });
    const summary = await mapper.getSummary();
    res.json(summary);
  } catch (err) {
    console.error("Error fetching Slack projects:", err);
    res.status(500).json({ error: err.message });
  }
});

// Analyze a project (Slack + Linear combined)
app.get("/api/slack/analyze/:projectId", async (req, res) => {
  try {
    const analyzer = getProjectAnalyzer();
    if (!analyzer) {
      return res.status(500).json({ error: "Slack or Linear not configured" });
    }
    const daysBack = parseInt(req.query.days) || 14;
    const analysis = await analyzer.analyzeProject(req.params.projectId, {
      daysBack,
      includeThreads: true,
    });
    res.json({
      success: true,
      ...analysis,
      summaryText: analyzer.generateSummaryText(analysis),
      kpiData: analyzer.generateKPIData(analysis),
    });
  } catch (err) {
    console.error("Error analyzing project:", err);
    res.status(500).json({ error: err.message });
  }
});

// Post KPI summary to configured Slack channel
app.post("/api/slack/post-kpi", async (req, res) => {
  try {
    const slack = getSlackClient();
    if (!slack) {
      return res.status(500).json({ error: "SLACK_BOT_TOKEN not configured" });
    }

    const channelId = process.env.SLACK_KPI_CHANNEL;
    if (!channelId) {
      return res.status(500).json({ error: "SLACK_KPI_CHANNEL not configured" });
    }

    const { pod, message } = req.body;

    // If a specific message is provided, post it
    if (message) {
      const result = await slack.postMessage(channelId, message);
      return res.json({ success: true, ts: result.ts, channel: channelId });
    }

    // Otherwise, generate a KPI summary for the pod
    if (pod) {
      const response = await answer(`status of ${pod}`, null, { mobile: true });
      const summary = `📊 *KPI Update: ${pod}*\n\n${response}`;
      const result = await slack.postMessage(channelId, summary);
      return res.json({ success: true, ts: result.ts, channel: channelId, pod });
    }

    return res.status(400).json({ error: "Provide 'pod' or 'message' in request body" });
  } catch (err) {
    console.error("Error posting to Slack:", err);
    res.status(500).json({ error: err.message });
  }
});

// Join the KPI channel (for public channels)
app.post("/api/slack/join-channel", async (req, res) => {
  try {
    const slack = getSlackClient();
    if (!slack) {
      return res.status(500).json({ error: "SLACK_BOT_TOKEN not configured" });
    }

    const channelId = req.body.channel || process.env.SLACK_KPI_CHANNEL;
    if (!channelId) {
      return res.status(400).json({ error: "No channel specified" });
    }

    const result = await slack.joinChannel(channelId);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error("Error joining channel:", err);
    res.status(500).json({ error: err.message });
  }
});

// ============== WEEKLY REPORT ENDPOINTS ==============

// Preview the weekly report (without posting)
app.get("/api/weekly-report/preview", async (req, res) => {
  try {
    console.log("[API] Generating weekly report preview...");
    const report = await generateWeeklyReport();
    res.json({
      success: true,
      preview: report.message,
      metadata: report.metadata,
    });
  } catch (err) {
    console.error("Error generating report preview:", err);
    res.status(500).json({ error: err.message });
  }
});

// Post the weekly report to Slack immediately
app.post("/api/weekly-report/post", async (req, res) => {
  try {
    console.log("[API] Posting weekly report to Slack...");
    const result = await postWeeklyReport();
    res.json({
      success: true,
      message: "Weekly report posted successfully!",
      ...result,
    });
  } catch (err) {
    console.error("Error posting weekly report:", err);
    res.status(500).json({ error: err.message });
  }
});

// Get current cycle detection info
app.get("/api/weekly-report/cycles", async (req, res) => {
  try {
    const cycles = detectReportCycles();
    res.json({
      success: true,
      ...cycles,
      nextReportDay: "Friday 7:30 PM IST",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve the main page
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

// Serve the HUD Command Center (main dashboard)
app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/hud-dashboard.html"));
});

// Alias for HUD dashboard
app.get("/hud", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/hud-dashboard.html"));
});

// Alias for KPI dashboard URL
app.get("/kpi-dashboard.html", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/hud-dashboard.html"));
});

app.get("/kpi-dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/hud-dashboard.html"));
});

// Spillover dashboard
app.get("/spillover", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/spillover-dashboard.html"));
});

app.get("/spillover-dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/spillover-dashboard.html"));
});

// Background prefetch - warm cache on server start
async function prefetchPodData() {
  const pods = ["FTS", "GTS", "Control Center", "Talent Studio", "Platform", "Growth & Reuse", "ML", "FOT", "BTS", "DC"];
  console.log("[PREFETCH] Warming cache for all pods in background...");

  // Prefetch in parallel batches of 3 to avoid rate limiting
  for (let i = 0; i < pods.length; i += 3) {
    const batch = pods.slice(i, i + 3);
    await Promise.all(batch.map(async (podName) => {
      try {
        // This triggers the answer function which populates cache
        await answer(`status of ${podName}`, null, { mobile: true });
        console.log(`[PREFETCH] ✓ ${podName} cached`);
      } catch (e) {
        console.log(`[PREFETCH] ✗ ${podName} failed: ${e.message}`);
      }
    }));
    // Small delay between batches
    if (i + 3 < pods.length) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  console.log("[PREFETCH] Cache warming complete!");
}

// Start server
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║                                                            ║
║   KPI Assistant is running!                                ║
║                                                            ║
║   Open in your browser:  http://localhost:${PORT}            ║
║                                                            ║
║   Dashboards:                                              ║
║   • http://localhost:${PORT}/dashboard    - HUD Dashboard    ║
║   • http://localhost:${PORT}/spillover    - Spillover Tracker║
║                                                            ║
║   APIs:                                                    ║
║   • /api/spillover/current  - Current cycle spillover      ║
║   • /api/spillover/cycle/C2 - Specific cycle spillover     ║
║   • /api/spillover/charts   - Chart data                   ║
║                                                            ║
║   Weekly Report:                                           ║
║   • /api/weekly-report/preview - Preview report            ║
║   • /api/weekly-report/post    - Post to Slack now         ║
║   • Auto-posts every Friday @ 7:30 PM IST                  ║
║                                                            ║
║   Press Ctrl+C to stop                                     ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
`);

  // Start background prefetch (don't await - let server start immediately)
  prefetchPodData().catch(e => console.log("[PREFETCH] Error:", e.message));

  // Start weekly report scheduler (posts every Friday 7:30 PM IST)
  if (process.env.SLACK_KPI_CHANNEL && process.env.SLACK_BOT_TOKEN) {
    startScheduler();
  } else {
    console.log("[SCHEDULER] Weekly report scheduler not started - SLACK_KPI_CHANNEL or SLACK_BOT_TOKEN not configured");
  }
});
