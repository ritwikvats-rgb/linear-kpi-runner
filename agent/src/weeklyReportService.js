/* agent/src/weeklyReportService.js
 * Weekly KPI Report Service
 *
 * Generates and posts polished KPI reports to Slack every Friday at 7:30 PM IST
 * Handles cycle transitions intelligently - shows final report for closed cycles
 * and current status for active cycles.
 */

const { SlackClient } = require("./slackClient");
const { computeCycleKpi, computeFeatureMovement, computeWeeklyKpi } = require("./kpiComputer");
const { loadCycleCalendar } = require("./shared/cycleUtils");
const { fuelixChat } = require("./fuelixClient");
const { getLiveProjects, getLiveComments } = require("./liveLinear");
const { ProjectChannelMapper } = require("./projectChannelMapper");
const { LinearClient } = require("./linearClient");

// ============== CONFIGURATION ==============

const REPORT_SCHEDULE = {
  dayOfWeek: 5, // Friday (0=Sunday, 5=Friday)
  hour: 19,     // 7 PM IST
  minute: 30,   // 30 minutes
};

const POD_ORDER = [
  "FTS", "GTS", "Control Center", "Talent Studio", "Platform",
  "Growth & Reuse", "ML", "FOT", "BTS", "DC"
];

// ============== CYCLE DETECTION ==============

/**
 * Determine which cycles to include in the report
 * Returns: { closedCycle: "C2" | null, currentCycle: "C3", scenario: "transition" | "mid_cycle" }
 */
function detectReportCycles(now = new Date()) {
  const calendar = loadCycleCalendar();
  if (!calendar?.pods) {
    return { closedCycle: null, currentCycle: "C3", scenario: "mid_cycle" };
  }

  // Use FTS calendar as reference (most pods follow similar schedule)
  const ftsCalendar = calendar.pods["FTS"] || calendar.pods[Object.keys(calendar.pods)[0]];

  const cycles = ["C1", "C2", "C3", "C4", "C5", "C6"];
  let currentCycle = null;
  let closedCycle = null;

  // Find Friday of this week (the report day)
  const friday = new Date(now);
  friday.setHours(23, 59, 59, 999);

  // Find Saturday of last week (one week back)
  const lastSaturday = new Date(friday);
  lastSaturday.setDate(lastSaturday.getDate() - 6);
  lastSaturday.setHours(0, 0, 0, 0);

  for (const cycle of cycles) {
    const cycleData = ftsCalendar[cycle];
    if (!cycleData) continue;

    const start = new Date(cycleData.start);
    const end = new Date(cycleData.end);

    // Check if this cycle is currently active
    if (now >= start && now <= end) {
      currentCycle = cycle;
    }

    // Check if this cycle ended this week (between last Saturday and this Friday)
    if (end >= lastSaturday && end <= friday && end < now) {
      closedCycle = cycle;
    }
  }

  // If no current cycle found, find the next one
  if (!currentCycle) {
    for (const cycle of cycles) {
      const cycleData = ftsCalendar[cycle];
      if (!cycleData) continue;
      const start = new Date(cycleData.start);
      if (start > now) {
        currentCycle = cycle;
        break;
      }
    }
  }

  // Default to C3 if nothing found
  currentCycle = currentCycle || "C3";

  const scenario = closedCycle ? "transition" : "mid_cycle";

  return { closedCycle, currentCycle, scenario };
}

/**
 * Get cycle date range for display
 */
function getCycleDateRange(cycle) {
  const calendar = loadCycleCalendar();
  const ftsCalendar = calendar?.pods?.["FTS"];
  if (!ftsCalendar?.[cycle]) return "";

  const start = new Date(ftsCalendar[cycle].start);
  const end = new Date(ftsCalendar[cycle].end);

  const formatDate = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${formatDate(start)} - ${formatDate(end)}`;
}

/**
 * Calculate days into cycle and total days
 */
function getCycleProgress(cycle) {
  const calendar = loadCycleCalendar();
  const ftsCalendar = calendar?.pods?.["FTS"];
  if (!ftsCalendar?.[cycle]) return { day: 0, total: 14 };

  const start = new Date(ftsCalendar[cycle].start);
  const end = new Date(ftsCalendar[cycle].end);
  const now = new Date();

  const total = Math.ceil((end - start) / (1000 * 60 * 60 * 24));
  const elapsed = Math.ceil((now - start) / (1000 * 60 * 60 * 24));
  const day = Math.max(1, Math.min(elapsed, total));

  return { day, total };
}

// ============== DATA AGGREGATION ==============

/**
 * Aggregate DEL data by pod for a specific cycle
 */
function aggregateDelsByCycle(cycleKpi, cycle) {
  const podData = {};

  for (const row of cycleKpi) {
    if (row.cycle !== cycle) continue;
    if (row.status !== "OK") continue;

    podData[row.pod] = {
      committed: row.committed,
      completed: row.completed,
      deliveryPct: parseInt(row.deliveryPct) || 0,
      spillover: row.spillover,
    };
  }

  // Calculate totals
  let totalCommitted = 0, totalCompleted = 0, totalSpillover = 0;
  for (const pod of Object.values(podData)) {
    totalCommitted += pod.committed;
    totalCompleted += pod.completed;
    totalSpillover += pod.spillover;
  }

  const overallPct = totalCommitted > 0 ? Math.round((totalCompleted / totalCommitted) * 100) : 0;

  return {
    byPod: podData,
    totals: {
      committed: totalCommitted,
      completed: totalCompleted,
      deliveryPct: overallPct,
      spillover: totalSpillover,
    },
  };
}

/**
 * Aggregate feature data
 */
function aggregateFeatures(featureMovement) {
  const podData = {};

  for (const row of featureMovement) {
    podData[row.pod] = {
      planned: row.plannedFeatures || 0,
      done: row.done || 0,
      inFlight: row.inFlight || 0,
      notStarted: row.notStarted || 0,
      progress: row.plannedFeatures > 0 ? Math.round((row.done / row.plannedFeatures) * 100) : 0,
    };
  }

  // Calculate totals
  let totalPlanned = 0, totalDone = 0, totalInFlight = 0, totalNotStarted = 0;
  for (const pod of Object.values(podData)) {
    totalPlanned += pod.planned;
    totalDone += pod.done;
    totalInFlight += pod.inFlight;
    totalNotStarted += pod.notStarted;
  }

  const overallProgress = totalPlanned > 0 ? Math.round((totalDone / totalPlanned) * 100) : 0;

  return {
    byPod: podData,
    totals: {
      planned: totalPlanned,
      done: totalDone,
      inFlight: totalInFlight,
      notStarted: totalNotStarted,
      progress: overallProgress,
    },
  };
}

// ============== POD ACTIVITY FETCHING ==============

/**
 * Fetch activity data for all pods from Linear + Slack
 * Returns per-pod activity summary for LLM to process
 */
async function fetchAllPodActivity() {
  console.log("[WEEKLY-REPORT] Fetching pod activity from Linear + Slack...");

  const podActivity = {};

  // Initialize Slack client and channel mapper
  let slackClient = null;
  let projectChannelMap = {};

  if (process.env.SLACK_BOT_TOKEN) {
    slackClient = new SlackClient({ botToken: process.env.SLACK_BOT_TOKEN });

    // Build mapping of project names to Slack channels
    if (process.env.LINEAR_API_KEY) {
      try {
        const linearClient = new LinearClient({ apiKey: process.env.LINEAR_API_KEY });
        const channelMapper = new ProjectChannelMapper({ linearClient });
        const projectsWithChannels = await channelMapper.getProjectsWithChannels();

        for (const entry of projectsWithChannels) {
          projectChannelMap[entry.project.name.toLowerCase()] = {
            channelId: entry.channelId,
            projectId: entry.project.id,
          };
        }
        console.log(`[WEEKLY-REPORT] Found ${Object.keys(projectChannelMap).length} projects with Slack channels`);
      } catch (e) {
        console.warn("[WEEKLY-REPORT] Failed to load project-channel mapping:", e.message);
      }
    }
  }

  // Fetch projects and comments for each pod in parallel
  const fetchPromises = POD_ORDER.map(async (podName) => {
    try {
      // Get projects for this pod
      const projectsResult = await getLiveProjects(podName);
      if (!projectsResult.success) {
        return { podName, activity: null };
      }

      const projects = projectsResult.projects || [];
      const inFlightProjects = projects.filter(p => p.normalizedState === "in_flight");
      const doneProjects = projects.filter(p => p.normalizedState === "done");

      // Fetch Linear comments from in-flight projects
      const recentComments = [];
      for (const project of inFlightProjects.slice(0, 3)) {
        try {
          const commentsResult = await getLiveComments(podName, project.name, 7);
          if (commentsResult.success && commentsResult.comments?.length > 0) {
            recentComments.push({
              project: project.name.replace(/^Q1 2026\s*:\s*/i, "").replace(/^Q1 26\s*-\s*/i, ""),
              source: "Linear",
              comments: commentsResult.comments.slice(0, 5).map(c => ({
                author: c.author,
                body: c.body?.substring(0, 200) || "",
              })),
            });
          }
        } catch (e) {
          // Skip failed fetches
        }
      }

      // Fetch Slack messages from project channels (14 days, including threads)
      const slackMessages = [];
      if (slackClient) {
        for (const project of inFlightProjects.slice(0, 3)) {
          const projectNameLower = project.name.toLowerCase();
          const channelInfo = projectChannelMap[projectNameLower];

          if (channelInfo) {
            try {
              // Get messages from last 14 days including threads
              const twoWeeksAgo = Math.floor((Date.now() - 14 * 24 * 60 * 60 * 1000) / 1000);
              const messages = await slackClient.getMessagesWithThreads(channelInfo.channelId, {
                oldest: String(twoWeeksAgo),
                maxMessages: 50,
                includeThreads: true,
              });

              if (messages?.length > 0) {
                // Filter human messages (not bots)
                const humanMsgs = messages
                  .filter(m => !m.bot_id && m.type === "message" && m.text)
                  .slice(0, 10);

                // Also get thread replies
                const allText = [];
                for (const m of humanMsgs) {
                  allText.push({ text: m.text?.substring(0, 200) || "" });
                  // Include thread replies
                  if (m.threadReplies?.length > 0) {
                    for (const reply of m.threadReplies.slice(0, 3)) {
                      if (!reply.bot_id && reply.text) {
                        allText.push({ text: `↳ ${reply.text?.substring(0, 150) || ""}` });
                      }
                    }
                  }
                }

                if (allText.length > 0) {
                  slackMessages.push({
                    project: project.name.replace(/^Q1 2026\s*:\s*/i, "").replace(/^Q1 26\s*-\s*/i, ""),
                    source: "Slack",
                    messages: allText.slice(0, 15),  // Limit total messages per project
                  });
                }
              }
            } catch (e) {
              // Skip failed Slack fetches
            }
          }
        }
      }

      return {
        podName,
        activity: {
          totalProjects: projects.length,
          inFlight: inFlightProjects.length,
          done: doneProjects.length,
          inFlightNames: inFlightProjects.slice(0, 5).map(p =>
            p.name.replace(/^Q1 2026\s*:\s*/i, "").replace(/^Q1 26\s*-\s*/i, "")
          ),
          doneNames: doneProjects.slice(0, 3).map(p =>
            p.name.replace(/^Q1 2026\s*:\s*/i, "").replace(/^Q1 26\s*-\s*/i, "")
          ),
          recentComments,
          slackMessages,
        },
      };
    } catch (e) {
      console.warn(`[WEEKLY-REPORT] Failed to fetch activity for ${podName}:`, e.message);
      return { podName, activity: null };
    }
  });

  const results = await Promise.all(fetchPromises);

  for (const { podName, activity } of results) {
    if (activity) {
      podActivity[podName] = activity;
    }
  }

  return podActivity;
}

/**
 * Generate per-pod highlights using LLM
 */
async function generatePodHighlights(podActivity, delData, featureData, currentCycle) {
  // Build context for each pod
  let podContext = "";

  for (const podName of POD_ORDER) {
    const activity = podActivity[podName];
    const delInfo = delData.current?.byPod[podName];
    const featureInfo = featureData.byPod[podName];

    if (!activity && !delInfo && !featureInfo) continue;

    podContext += `\n### ${podName}\n`;

    if (delInfo) {
      podContext += `DELs: ${delInfo.completed}/${delInfo.committed} delivered (${delInfo.deliveryPct}%)\n`;
    }

    if (featureInfo) {
      podContext += `Features: ${featureInfo.done}/${featureInfo.planned} done, ${featureInfo.inFlight} in-flight\n`;
    }

    if (activity) {
      if (activity.inFlightNames?.length > 0) {
        podContext += `Active Projects: ${activity.inFlightNames.join(", ")}\n`;
      }
      if (activity.doneNames?.length > 0) {
        podContext += `Completed: ${activity.doneNames.join(", ")}\n`;
      }
      // Linear comments
      if (activity.recentComments?.length > 0) {
        podContext += "Linear Discussions:\n";
        for (const { project, comments } of activity.recentComments) {
          for (const c of comments.slice(0, 2)) {
            podContext += `  - [${project}] ${c.author}: ${c.body.substring(0, 100)}...\n`;
          }
        }
      }
      // Slack messages
      if (activity.slackMessages?.length > 0) {
        podContext += "Slack Discussions:\n";
        for (const { project, messages } of activity.slackMessages) {
          for (const m of messages.slice(0, 2)) {
            podContext += `  - [${project}] ${m.text.substring(0, 100)}...\n`;
          }
        }
      }
    }
  }

  const prompt = `You are a technical program manager writing a weekly KPI report for engineering leadership.

Based on the following data for each pod, write ONE specific bullet point update for EACH pod that has activity.
Focus on: what they're working on, recent milestones, or notable discussions.

${podContext}

IMPORTANT RULES:
1. Write exactly ONE bullet point per pod (max 15 words per bullet)
2. Be specific - mention project names, features, or milestones
3. Use present tense and active voice
4. If a pod has no meaningful activity, write "No significant updates"
5. Format: "• POD_NAME: [update]"

Example output:
• FTS: AI Interviewer entering final QA, targeting Feb 10 release
• GTS: Grading pipeline optimization complete, 40% latency reduction
• Control Center: Dashboard v2 shipped, working on alert customization`;

  try {
    const response = await fuelixChat({
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      timeout: 45000,
    });
    return response.trim();
  } catch (e) {
    console.error("LLM pod highlights generation failed:", e.message);
    return generateFallbackPodHighlights(podActivity, delData, featureData);
  }
}

/**
 * Fallback pod highlights if LLM fails
 */
function generateFallbackPodHighlights(podActivity, delData, featureData) {
  const highlights = [];

  for (const podName of POD_ORDER) {
    const activity = podActivity[podName];
    const delInfo = delData.current?.byPod[podName];

    if (activity?.inFlightNames?.length > 0) {
      highlights.push(`• ${podName}: Working on ${activity.inFlightNames[0]}`);
    } else if (delInfo?.committed > 0) {
      highlights.push(`• ${podName}: ${delInfo.completed}/${delInfo.committed} DELs delivered`);
    } else {
      highlights.push(`• ${podName}: No significant updates`);
    }
  }

  return highlights.join("\n");
}

// ============== LLM NARRATIVE GENERATION ==============

/**
 * Generate narrative highlights using LLM
 */
async function generateNarrative(delData, featureData, closedCycle, currentCycle, scenario) {
  const prompt = `You are a technical program manager writing a weekly KPI report for engineering leadership.

CONTEXT:
${scenario === "transition" ? `- Cycle ${closedCycle} just closed with ${delData.closed?.totals?.deliveryPct || 0}% delivery (${delData.closed?.totals?.completed || 0}/${delData.closed?.totals?.committed || 0} DELs)` : ""}
- Current cycle: ${currentCycle} with ${delData.current?.totals?.committed || 0} DELs committed
- Feature progress: ${featureData.totals.done}/${featureData.totals.planned} features complete (${featureData.totals.progress}%)

DEL DELIVERY BY POD (${scenario === "transition" ? closedCycle : currentCycle}):
${Object.entries(delData[scenario === "transition" ? "closed" : "current"]?.byPod || {})
  .map(([pod, d]) => `- ${pod}: ${d.completed}/${d.committed} (${d.deliveryPct}%)${d.spillover > 0 ? ` [${d.spillover} spillover]` : ""}`)
  .join("\n")}

FEATURE PROGRESS:
${Object.entries(featureData.byPod)
  .map(([pod, f]) => `- ${pod}: ${f.done}/${f.planned} done, ${f.inFlight} in-flight`)
  .join("\n")}

Write a brief, professional summary with:
1. 3-4 key wins (pods that performed well, milestones hit, notable achievements)

Keep each point to ONE short sentence. Be specific with pod names and numbers.
Format as plain text with bullet points using • symbol.
Do NOT use markdown formatting.
Do NOT include watch items, risks, or learnings sections.`;

  try {
    const response = await fuelixChat({
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      timeout: 30000,
    });
    return response.trim();
  } catch (e) {
    console.error("LLM narrative generation failed:", e.message);
    return generateFallbackNarrative(delData, featureData, closedCycle, currentCycle, scenario);
  }
}

/**
 * Fallback narrative if LLM fails
 */
function generateFallbackNarrative(delData, featureData, closedCycle, currentCycle, scenario) {
  const data = scenario === "transition" ? delData.closed : delData.current;
  const byPod = data?.byPod || {};

  // Find top performers (100% or highest)
  const sorted = Object.entries(byPod).sort((a, b) => b[1].deliveryPct - a[1].deliveryPct);
  const topPerformers = sorted.filter(([, d]) => d.deliveryPct >= 100).map(([p]) => p);
  const needsAttention = sorted.filter(([, d]) => d.deliveryPct < 75 && d.committed > 0).map(([p]) => p);

  let narrative = "KEY WINS\n\n";

  if (topPerformers.length > 0) {
    narrative += `• ${topPerformers.slice(0, 3).join(", ")} achieved 100% delivery\n`;
  }

  if (featureData.totals.done > 0) {
    narrative += `• ${featureData.totals.done} features completed across all pods\n`;
  }

  if (featureData.totals.inFlight > 0) {
    narrative += `• ${featureData.totals.inFlight} features currently in-flight across all pods\n`;
  }

  return narrative;
}

// ============== SLACK MESSAGE FORMATTING ==============

/**
 * Format the complete Slack message
 */
function formatSlackMessage(delData, featureData, narrative, podHighlights, closedCycle, currentCycle, scenario) {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", year: "numeric" });

  let message = "";

  // Header
  message += "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n";
  message += `📊  *ENGINEERING KPI REPORT*  |  ${dateStr}\n`;
  message += "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n";

  // If cycle transition, show closed cycle report first
  if (scenario === "transition" && closedCycle && delData.closed) {
    message += formatClosedCycleSection(delData.closed, closedCycle);
    message += "\n";
  }

  // Current cycle status
  message += formatCurrentCycleSection(delData.current, currentCycle, scenario);
  message += "\n";

  // Feature progress
  message += formatFeatureSection(featureData);
  message += "\n";

  // Pod-by-pod updates (from Linear + Slack)
  if (podHighlights) {
    message += "┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓\n";
    message += "┃  📝 *POD UPDATES*  (from Linear + Slack)             ┃\n";
    message += "┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\n\n";
    message += "```\n";
    message += podHighlights;
    message += "\n```\n\n";
  }

  // Narrative (key highlights, watch items, learnings)
  message += "💬 *KEY HIGHLIGHTS & ANALYSIS*\n";
  message += "```\n";
  message += narrative;
  message += "\n```\n\n";

  // Footer
  const nextFriday = getNextFriday();
  message += "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n";
  message += `📅 Next Report: ${nextFriday.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })} @ 7:30 PM IST\n`;

  const dashboardUrl = process.env.DASHBOARD_URL || "https://kpi-dashboard.render.com/dashboard";
  message += `🔗 Dashboard: ${dashboardUrl}\n`;
  message += "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━";

  return message;
}

function formatClosedCycleSection(delData, cycle) {
  const dateRange = getCycleDateRange(cycle);

  let section = "┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓\n";
  section += `┃  📦 *CYCLE ${cycle} FINAL REPORT*  (${dateRange})  ✅ CLOSED  ┃\n`;
  section += "┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\n\n";

  section += `🎯 Overall Delivery: *${delData.totals.deliveryPct}%* (${delData.totals.completed}/${delData.totals.committed} DELs)\n\n`;

  // Add DEL analysis summary before the table
  section += generateDelSummary(delData, cycle);

  section += "```\n";
  section += formatDelTable(delData, true);
  section += "```\n";

  return section;
}

/**
 * Generate a brief DEL summary analysis
 */
function generateDelSummary(delData, cycle) {
  const byPod = delData.byPod;
  const totals = delData.totals;

  // Find top performers (100% delivery)
  const topPerformers = Object.entries(byPod)
    .filter(([, d]) => d.deliveryPct === 100 && d.committed > 0)
    .map(([pod]) => pod);

  // Find pods with most spillover
  const highSpillover = Object.entries(byPod)
    .filter(([, d]) => d.spillover > 0)
    .sort((a, b) => b[1].spillover - a[1].spillover)
    .slice(0, 2)
    .map(([pod, d]) => `${pod} (${d.spillover})`);

  let summary = "📊 *Summary:* ";

  if (topPerformers.length > 0) {
    summary += `${topPerformers.join(", ")} achieved 100% delivery. `;
  }

  if (totals.spillover > 0) {
    summary += `${totals.spillover} DELs spilled to next cycle`;
    if (highSpillover.length > 0) {
      summary += ` (${highSpillover.join(", ")})`;
    }
    summary += ".";
  }

  return summary + "\n\n";
}

function formatCurrentCycleSection(delData, cycle, scenario) {
  const dateRange = getCycleDateRange(cycle);
  const { day, total } = getCycleProgress(cycle);
  const progressPct = Math.round((day / total) * 100);

  const statusEmoji = scenario === "transition" ? "🚀" : "🔄";
  const statusText = scenario === "transition" ? "JUST STARTED" : "IN PROGRESS";

  let section = "┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓\n";
  section += `┃  ${statusEmoji} *CYCLE ${cycle} STATUS*  (${dateRange})  ${statusText}  ┃\n`;
  section += "┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\n\n";

  section += `📅 Day ${day} of ${total}  |  Progress: ${progressPct}%\n\n`;

  section += "```\n";
  section += formatDelTable(delData, false);
  section += "```\n";

  return section;
}

function formatDelTable(delData, isClosed) {
  const header = isClosed
    ? "POD              │ Planned │ Delivered │ Delivery │ Spillover"
    : "POD              │ Committed │ Completed │ In-Flight │ Progress";

  const separator = isClosed
    ? "─────────────────┼─────────┼───────────┼──────────┼──────────"
    : "─────────────────┼───────────┼───────────┼───────────┼──────────";

  let table = header + "\n" + separator + "\n";

  // Sort pods by delivery % descending
  const sortedPods = POD_ORDER.filter(p => delData.byPod[p]);
  sortedPods.sort((a, b) => (delData.byPod[b]?.deliveryPct || 0) - (delData.byPod[a]?.deliveryPct || 0));

  for (const pod of sortedPods) {
    const d = delData.byPod[pod];
    if (!d) continue;

    const podStr = pod.padEnd(16);
    if (isClosed) {
      const committed = String(d.committed).padStart(7);
      const completed = String(d.completed).padStart(9);
      const pct = `${d.deliveryPct}%`.padStart(8);
      const spill = String(d.spillover).padStart(9);
      table += `${podStr} │${committed} │${completed} │${pct} │${spill}\n`;
    } else {
      const committed = String(d.committed).padStart(9);
      const completed = String(d.completed).padStart(9);
      const inFlight = String(d.committed - d.completed).padStart(9);
      const pct = `${d.deliveryPct}%`.padStart(8);
      table += `${podStr} │${committed} │${completed} │${inFlight} │${pct}\n`;
    }
  }

  // Totals row
  table += separator + "\n";
  const totals = delData.totals;
  if (isClosed) {
    table += `${"TOTAL".padEnd(16)} │${String(totals.committed).padStart(7)} │${String(totals.completed).padStart(9)} │${`${totals.deliveryPct}%`.padStart(8)} │${String(totals.spillover).padStart(9)}\n`;
  } else {
    const inFlight = totals.committed - totals.completed;
    table += `${"TOTAL".padEnd(16)} │${String(totals.committed).padStart(9)} │${String(totals.completed).padStart(9)} │${String(inFlight).padStart(9)} │${`${totals.deliveryPct}%`.padStart(8)}\n`;
  }

  return table;
}

function formatFeatureSection(featureData) {
  let section = "┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓\n";
  section += "┃  🎯 *FEATURE PROGRESS*  (Q1 2026 Roadmap)              ┃\n";
  section += "┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\n\n";

  section += "```\n";
  section += "POD              │ Planned │ Done │ In-Flight │ Progress\n";
  section += "─────────────────┼─────────┼──────┼───────────┼──────────\n";

  // Sort by progress descending
  const sortedPods = POD_ORDER.filter(p => featureData.byPod[p]);
  sortedPods.sort((a, b) => (featureData.byPod[b]?.progress || 0) - (featureData.byPod[a]?.progress || 0));

  for (const pod of sortedPods) {
    const f = featureData.byPod[pod];
    if (!f) continue;

    const podStr = pod.padEnd(16);
    const planned = String(f.planned).padStart(7);
    const done = String(f.done).padStart(4);
    const inFlight = String(f.inFlight).padStart(9);
    const progress = `${f.progress}%`.padStart(8);
    section += `${podStr} │${planned} │${done} │${inFlight} │${progress}\n`;
  }

  // Totals
  section += "─────────────────┼─────────┼──────┼───────────┼──────────\n";
  const t = featureData.totals;
  section += `${"TOTAL".padEnd(16)} │${String(t.planned).padStart(7)} │${String(t.done).padStart(4)} │${String(t.inFlight).padStart(9)} │${`${t.progress}%`.padStart(8)}\n`;
  section += "```\n";

  return section;
}

function getNextFriday() {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const daysUntilFriday = (5 - dayOfWeek + 7) % 7 || 7;
  const nextFriday = new Date(now);
  nextFriday.setDate(now.getDate() + daysUntilFriday);
  return nextFriday;
}

// ============== MAIN REPORT GENERATION ==============

/**
 * Generate the complete weekly report
 */
async function generateWeeklyReport() {
  console.log("[WEEKLY-REPORT] Starting report generation...");

  // Step 1: Detect which cycles to report on
  const { closedCycle, currentCycle, scenario } = detectReportCycles();
  console.log(`[WEEKLY-REPORT] Scenario: ${scenario}, Closed: ${closedCycle}, Current: ${currentCycle}`);

  // Step 2: Fetch KPI data
  console.log("[WEEKLY-REPORT] Fetching KPI data...");
  const kpiResult = await computeWeeklyKpi();

  if (!kpiResult.success) {
    throw new Error(`Failed to fetch KPI data: ${kpiResult.message}`);
  }

  const { cycleKpi, featureMovement } = kpiResult;

  // Step 3: Aggregate data
  console.log("[WEEKLY-REPORT] Aggregating data...");
  const delData = {
    current: aggregateDelsByCycle(cycleKpi, currentCycle),
  };

  if (closedCycle) {
    delData.closed = aggregateDelsByCycle(cycleKpi, closedCycle);
  }

  const featureData = aggregateFeatures(featureMovement);

  // Step 4: Fetch pod activity from Linear (projects, comments)
  console.log("[WEEKLY-REPORT] Fetching pod activity...");
  const podActivity = await fetchAllPodActivity();

  // Step 5: Generate pod-specific highlights using LLM
  console.log("[WEEKLY-REPORT] Generating pod highlights...");
  const podHighlights = await generatePodHighlights(podActivity, delData, featureData, currentCycle);

  // Step 6: Generate overall narrative using LLM
  console.log("[WEEKLY-REPORT] Generating narrative...");
  const narrative = await generateNarrative(delData, featureData, closedCycle, currentCycle, scenario);

  // Step 7: Format Slack message
  console.log("[WEEKLY-REPORT] Formatting message...");
  const message = formatSlackMessage(delData, featureData, narrative, podHighlights, closedCycle, currentCycle, scenario);

  return {
    success: true,
    message,
    metadata: {
      scenario,
      closedCycle,
      currentCycle,
      generatedAt: new Date().toISOString(),
    },
  };
}

/**
 * Post the weekly report to Slack
 */
async function postWeeklyReport() {
  const channelId = process.env.SLACK_KPI_CHANNEL;

  if (!channelId) {
    throw new Error("SLACK_KPI_CHANNEL not configured");
  }

  if (!process.env.SLACK_BOT_TOKEN) {
    throw new Error("SLACK_BOT_TOKEN not configured");
  }

  const slack = new SlackClient({ botToken: process.env.SLACK_BOT_TOKEN });

  // Generate report
  const report = await generateWeeklyReport();

  if (!report.success) {
    throw new Error("Failed to generate report");
  }

  // Post to Slack
  console.log(`[WEEKLY-REPORT] Posting to channel ${channelId}...`);
  const result = await slack.postMessage(channelId, report.message);

  console.log(`[WEEKLY-REPORT] Posted successfully! ts: ${result.ts}`);

  return {
    success: true,
    messageTs: result.ts,
    channel: channelId,
    metadata: report.metadata,
  };
}

// ============== SCHEDULER ==============

let schedulerInterval = null;
let cachedReport = null;  // Cache for pre-generated report

/**
 * Get current IST time
 */
function getISTTime() {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  return new Date(now.getTime() + istOffset + now.getTimezoneOffset() * 60 * 1000);
}

/**
 * Check if it's time to START generating the report (7:00 PM IST)
 */
function isGenerationTime() {
  const istTime = getISTTime();
  const dayOfWeek = istTime.getDay();
  const hour = istTime.getHours();
  const minute = istTime.getMinutes();

  // Friday at 7:00 PM IST (±2 minutes)
  return dayOfWeek === 5 && hour === 19 && minute >= 0 && minute <= 2;
}

/**
 * Check if it's time to PUBLISH the report (7:30 PM IST)
 */
function isPublishTime() {
  const istTime = getISTTime();
  const dayOfWeek = istTime.getDay();
  const hour = istTime.getHours();
  const minute = istTime.getMinutes();

  // Friday at 7:30 PM IST (±2 minutes)
  return dayOfWeek === 5 && hour === 19 && minute >= 30 && minute <= 32;
}

/**
 * Legacy function for backwards compatibility
 */
function isReportTime() {
  return isPublishTime();
}

/**
 * Start the weekly report scheduler
 * Two-phase approach:
 *   7:00 PM IST - Fetch data, run LLM analysis, cache report
 *   7:30 PM IST - Publish cached report to Slack
 */
function startScheduler() {
  if (schedulerInterval) {
    console.log("[SCHEDULER] Already running");
    return;
  }

  console.log("[SCHEDULER] Starting weekly report scheduler...");
  console.log("[SCHEDULER] Schedule:");
  console.log("  • 7:00 PM IST - Fetch data & generate report");
  console.log("  • 7:30 PM IST - Publish to Slack");

  let lastGenerateDate = null;
  let lastPublishDate = null;

  schedulerInterval = setInterval(async () => {
    const today = new Date().toDateString();

    // PHASE 1: Generate report at 7:00 PM
    if (isGenerationTime() && lastGenerateDate !== today) {
      lastGenerateDate = today;
      console.log("[SCHEDULER] 7:00 PM - Starting report generation...");

      try {
        console.log("[SCHEDULER] Fetching data from Linear...");
        const report = await generateWeeklyReport();

        if (report.success) {
          cachedReport = report;
          console.log("[SCHEDULER] ✓ Report generated and cached!");
          console.log("[SCHEDULER] Waiting until 7:30 PM to publish...");
        } else {
          console.error("[SCHEDULER] ✗ Report generation failed");
        }
      } catch (e) {
        console.error("[SCHEDULER] ✗ Error generating report:", e.message);
      }
    }

    // PHASE 2: Publish report at 7:30 PM
    if (isPublishTime() && lastPublishDate !== today) {
      lastPublishDate = today;
      console.log("[SCHEDULER] 7:30 PM - Publishing report to Slack...");

      try {
        if (cachedReport && cachedReport.success) {
          // Use cached report
          const channelId = process.env.SLACK_KPI_CHANNEL;
          const slack = new SlackClient({ botToken: process.env.SLACK_BOT_TOKEN });

          const result = await slack.postMessage(channelId, cachedReport.message);
          console.log("[SCHEDULER] ✓ Weekly report published! ts:", result.ts);

          // Clear cache
          cachedReport = null;
        } else {
          // Fallback: generate and post immediately if no cache
          console.log("[SCHEDULER] No cached report, generating now...");
          await postWeeklyReport();
          console.log("[SCHEDULER] ✓ Weekly report published!");
        }
      } catch (e) {
        console.error("[SCHEDULER] ✗ Failed to publish report:", e.message);
      }
    }
  }, 60 * 1000); // Check every minute

  console.log("[SCHEDULER] Scheduler started");
}

/**
 * Stop the scheduler
 */
function stopScheduler() {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    cachedReport = null;
    console.log("[SCHEDULER] Stopped");
  }
}

// ============== EXPORTS ==============

module.exports = {
  generateWeeklyReport,
  postWeeklyReport,
  startScheduler,
  stopScheduler,
  detectReportCycles,
  isReportTime,
  // For testing
  aggregateDelsByCycle,
  aggregateFeatures,
  formatSlackMessage,
};
