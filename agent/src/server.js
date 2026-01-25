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
const { SlackClient } = require("./slackClient");
const { LinearClient } = require("./linearClient");
const { ProjectChannelMapper } = require("./projectChannelMapper");
const { ProjectAnalyzer } = require("./projectAnalyzer");

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Main question endpoint
app.post("/api/ask", async (req, res) => {
  const { question, mobile } = req.body;

  if (!question || typeof question !== "string") {
    return res.status(400).json({
      error: "Missing question",
      message: "Please provide a question in the request body"
    });
  }

  try {
    // Use the existing answerer which returns grounded data
    // Pass mobile flag for simplified output format
    const response = await answer(question.trim(), null, { mobile: !!mobile });

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

// Start server
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║                                                            ║
║   KPI Assistant is running!                                ║
║                                                            ║
║   Open in your browser:  http://localhost:${PORT}            ║
║                                                            ║
║   Try asking:                                              ║
║   • "What's going on across all pods?"                     ║
║   • "What's the status of FTS?"                            ║
║   • "Show me DELs in cycle C1"                             ║
║                                                            ║
║   Press Ctrl+C to stop                                     ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
`);
});
