#!/usr/bin/env node
/* agent/src/testSlackIntegration.js
 * Test script for Slack + Linear integration
 * Run: node agent/src/testSlackIntegration.js
 */

require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

const { SlackClient } = require("./slackClient");
const { LinearClient } = require("./linearClient");
const { ProjectChannelMapper } = require("./projectChannelMapper");
const { ProjectAnalyzer } = require("./projectAnalyzer");

async function main() {
  console.log("=== Slack + Linear Integration Test ===\n");

  // Check environment variables
  const slackToken = process.env.SLACK_BOT_TOKEN;
  const linearApiKey = process.env.LINEAR_API_KEY;

  if (!slackToken) {
    console.error("ERROR: SLACK_BOT_TOKEN not found in .env");
    process.exit(1);
  }

  if (!linearApiKey) {
    console.error("ERROR: LINEAR_API_KEY not found in .env");
    process.exit(1);
  }

  // Initialize clients
  const slackClient = new SlackClient({ botToken: slackToken });
  const linearClient = new LinearClient({ apiKey: linearApiKey });
  const mapper = new ProjectChannelMapper({ linearClient });
  const analyzer = new ProjectAnalyzer({ linearClient, slackClient });

  // Test 1: Verify Slack auth
  console.log("1. Testing Slack authentication...");
  try {
    const authResult = await slackClient.testAuth();
    console.log(`   ✅ Slack auth OK - Bot: ${authResult.user}, Team: ${authResult.team}`);
  } catch (e) {
    console.error(`   ❌ Slack auth failed: ${e.message}`);
    process.exit(1);
  }

  // Test 2: Get projects with Slack channels
  console.log("\n2. Scanning Linear projects for Slack channel labels...");
  try {
    const summary = await mapper.getSummary();
    console.log(`   ✅ Found ${summary.totalProjects} projects with Slack channels:`);
    for (const p of summary.projects) {
      console.log(`      - ${p.name} → ${p.channelId} (${p.state})`);
    }
  } catch (e) {
    console.error(`   ❌ Failed to scan projects: ${e.message}`);
    process.exit(1);
  }

  // Test 3: Join channels
  console.log("\n3. Joining Slack channels...");
  const channelIds = await mapper.getAllChannelIds();
  for (const channelId of channelIds) {
    try {
      await slackClient.joinChannel(channelId);
      console.log(`   ✅ Joined ${channelId}`);
    } catch (e) {
      console.log(`   ⚠️  Could not join ${channelId}: ${e.message}`);
    }
  }

  // Test 4: Analyze first project
  console.log("\n4. Analyzing first project (Slack + Linear)...");
  const projectsWithChannels = await mapper.getProjectsWithChannels();

  if (projectsWithChannels.length === 0) {
    console.log("   No projects with Slack channels found. Add a channel ID label to a project.");
    return;
  }

  const firstProject = projectsWithChannels[0];
  console.log(`   Analyzing: ${firstProject.project.name}`);

  try {
    const analysis = await analyzer.analyzeProject(firstProject.project.id, {
      daysBack: 7,
      includeThreads: true,
    });

    console.log("\n   📊 Analysis Results:");
    console.log(`   - Slack: ${analysis.slack.messageCount} messages, ${analysis.slack.totalReplies} thread replies`);
    console.log(`   - Linear: ${analysis.linear.issueCount} issues, ${analysis.linear.commentCount} comments`);
    console.log(`   - Timeline events: ${analysis.timeline.length}`);

    // Show recent events
    console.log("\n   📅 Recent Timeline (last 5 events):");
    for (const event of analysis.timeline.slice(0, 5)) {
      const time = event.timestamp.split("T")[0];
      if (event.type === "slack_message") {
        console.log(`      [${time}] Slack: ${event.text?.substring(0, 60)}...`);
      } else if (event.type === "linear_comment") {
        console.log(`      [${time}] Linear (${event.issueId}): ${event.text?.substring(0, 60)}...`);
      } else if (event.type === "linear_issue_update") {
        console.log(`      [${time}] Linear: ${event.issueId} - ${event.state}`);
      }
    }

    // Generate KPI data
    const kpiData = analyzer.generateKPIData(analysis);
    console.log("\n   📈 KPI Summary:");
    console.log(`   - Total events: ${kpiData.summary.totalEvents}`);
    console.log(`   - Slack participants: ${kpiData.slackParticipants}`);
    console.log(`   - Linear participants: ${kpiData.linearParticipants}`);

  } catch (e) {
    console.error(`   ❌ Analysis failed: ${e.message}`);
  }

  console.log("\n=== Test Complete ===");
}

main().catch(console.error);
