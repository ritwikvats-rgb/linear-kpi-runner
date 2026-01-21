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
  const { question } = req.body;

  if (!question || typeof question !== "string") {
    return res.status(400).json({
      error: "Missing question",
      message: "Please provide a question in the request body"
    });
  }

  try {
    // Use the existing answerer which returns grounded data
    const response = await answer(question.trim(), null);

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

// Serve the main page
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
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
