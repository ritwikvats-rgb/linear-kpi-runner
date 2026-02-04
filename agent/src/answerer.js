/* agent/src/answerer.js
 * Question-answer engine with deterministic-first approach
 * Supports both snapshot-based and live Linear data queries
 */
const { fuelixChat } = require("./fuelixClient");
const { systemPrompt, commentSummaryPrompt, liveDataPrompt } = require("./prompt");
const {
  getLiveProjects,
  getLiveProject,
  getLiveBlockers,
  getLiveComments,
  getLivePodSummary,
  getAdhocIssues,
  listPods,
  normalizeState,
  cacheStats,
  clearCache,
  scoreProjectMatch,
} = require("./liveLinear");
const {
  computeWeeklyKpi,
  computeCombinedKpi,
  fetchPendingDELs,
  fetchDELsByCycle,
  formatPendingDELs,
  formatDELsByCycle,
  formatWeeklyKpiOutput,
  formatCombinedKpiOutput,
  generateInsights,
} = require("./kpiComputer");
const {
  formatTable,
  formatFeatureMovementBox,
  formatDelKpiBox,
  formatProjectsBox,
  formatBlockersBox,
  formatPodsListBox,
  formatSummaryBox,
} = require("./tableFormatter");
const { SlackClient } = require("./slackClient");
const { LinearClient } = require("./linearClient");
const { ProjectChannelMapper } = require("./projectChannelMapper");
const { ProjectAnalyzer } = require("./projectAnalyzer");

// Format timestamp to IST (Indian Standard Time, UTC+5:30)
function formatToIST(isoString) {
  const date = new Date(isoString);
  return date.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }) + " IST";
}

// Initialize Slack/Linear clients (lazy)
let _slackClient = null;
let _linearClientForSlack = null;
let _projectAnalyzer = null;
let _channelMapper = null;

function getSlackClient() {
  if (!_slackClient && process.env.SLACK_BOT_TOKEN) {
    _slackClient = new SlackClient({ botToken: process.env.SLACK_BOT_TOKEN });
  }
  return _slackClient;
}

function getLinearClientForSlack() {
  if (!_linearClientForSlack && process.env.LINEAR_API_KEY) {
    _linearClientForSlack = new LinearClient({ apiKey: process.env.LINEAR_API_KEY });
  }
  return _linearClientForSlack;
}

function getChannelMapper() {
  if (!_channelMapper) {
    const linear = getLinearClientForSlack();
    if (linear) {
      _channelMapper = new ProjectChannelMapper({ linearClient: linear });
    }
  }
  return _channelMapper;
}

function getProjectAnalyzer() {
  if (!_projectAnalyzer) {
    const slack = getSlackClient();
    const linear = getLinearClientForSlack();
    if (slack && linear) {
      _projectAnalyzer = new ProjectAnalyzer({ linearClient: linear, slackClient: slack });
    }
  }
  return _projectAnalyzer;
}

/**
 * Fetch feature readiness (PRD, Design, Dev status) for projects in a pod
 * Includes ALL projects - both in-flight and done - for complete stakeholder overview
 */
async function fetchPodFeatureReadiness(projects) {
  const linear = getLinearClientForSlack();
  if (!linear) return null;

  const readiness = {
    summary: { prd: { done: 0, in_progress: 0, not_started: 0 }, design: { done: 0, in_progress: 0, not_started: 0 } },
    features: []
  };

  // Tech debt project name patterns
  const isTechDebt = (name) => {
    const lower = name.toLowerCase();
    return lower.includes("tech debt") ||
           lower.includes("refactor") ||
           lower.includes("optimization") ||
           lower.includes("sonar") ||
           lower.includes("eslint") ||
           lower.includes("flaky test") ||
           lower.includes("build pipeline") ||
           lower.includes("ci/cd") ||
           lower.includes("circle ci");
  };

  // Clean project name helper
  const cleanName = (name) => name
    .replace(/^Q1 2026\s*:\s*/i, "")
    .replace(/^Q1 26\s*-\s*/i, "")
    .replace(/^\[Q1 2026 Project\]-?/i, "")
    .replace(/^\[Q1 Project 2026\]-?/i, "");

  // Include ALL projects (no filter) - stakeholders need complete view
  const projectsToCheck = projects.slice(0, 30); // Increased limit

  const results = await Promise.all(
    projectsToCheck.map(async (project) => {
      try {
        const projectReadiness = await linear.getFeatureReadiness(project.id);
        return { project, readiness: projectReadiness };
      } catch (e) {
        return { project, readiness: null };
      }
    })
  );

  for (const { project, readiness: projReadiness } of results) {
    const techDebt = isTechDebt(project.name);
    const projectCleanName = cleanName(project.name);
    const projectState = project.normalizedState;

    // If project has feature readiness data, use it
    if (projReadiness && projReadiness.features.length > 0) {
      for (const feature of projReadiness.features) {
        // Check if this specific feature is a tech debt (by feature title)
        const featureTechDebt = techDebt || isTechDebt(feature.title);
        const featureData = {
          project: projectCleanName + (techDebt ? " (Tech Debt)" : ""),
          feature: feature.title + (featureTechDebt && !techDebt ? " (Tech Debt)" : ""),
          prd: featureTechDebt ? "nr" : (feature.phases.PRD?.status || "na"),
          design: featureTechDebt ? "nr" : (feature.phases.Design?.status || "na"),
          beDev: feature.phases["BE Dev"]?.status || "na",
          feDev: feature.phases["FE Dev"]?.status || "na",
          pat: feature.phases.PAT?.status || "na",
          qa: feature.phases.QA?.status || "na",
          projectState: projectState,
          isTechDebt: featureTechDebt // Track for sorting
        };

        readiness.features.push(featureData);

        // Update summary counts
        if (featureData.prd === "done") readiness.summary.prd.done++;
        else if (featureData.prd === "in_progress") readiness.summary.prd.in_progress++;
        else if (featureData.prd !== "na" && featureData.prd !== "nr") readiness.summary.prd.not_started++;

        if (featureData.design === "done") readiness.summary.design.done++;
        else if (featureData.design === "in_progress") readiness.summary.design.in_progress++;
        else if (featureData.design !== "na" && featureData.design !== "nr") readiness.summary.design.not_started++;
      }
    } else {
      // Project has no feature phase data - add as a single row so it still appears
      // This ensures ALL projects show up in the Feature Readiness table
      const featureData = {
        project: projectCleanName + (techDebt ? " (Tech Debt)" : ""),
        feature: "(No sub-features defined)",
        prd: techDebt ? "nr" : "na",
        design: techDebt ? "nr" : "na",
        beDev: "na",
        feDev: "na",
        pat: "na",
        qa: "na",
        projectState: projectState,
        isTechDebt: techDebt // Track for sorting
      };
      readiness.features.push(featureData);
    }
  }

  // Sort features: Regular features FIRST, Tech Debt at the BOTTOM
  readiness.features.sort((a, b) => {
    if (a.isTechDebt === b.isTechDebt) return 0;
    return a.isTechDebt ? 1 : -1; // Tech debt goes to bottom
  });

  return readiness;
}

// ============== SNAPSHOT-BASED FUNCTIONS (existing) ==============

function findPod(snapshot, name) {
  const n = String(name || "").toLowerCase();
  return snapshot.pods.find((p) => p.name.toLowerCase() === n) || null;
}

function renderFeatureMovementTable(rows) {
  const header = `Pod | Planned | Done | In-Flight | Not Started | Projects | Status
---|---:|---:|---:|---:|---:|---
`;
  const body = rows.map(r =>
    `${r.pod} | ${r.plannedFeatures} | ${r.done} | ${r.inFlight} | ${r.notStarted} | ${r.projectsCount} | ${r.data_status}`
  ).join("\n");
  return header + body;
}

function deterministicAnswer(question, snapshot) {
  const q = String(question || "").toLowerCase().trim();

  // 1) show table
  if (q.includes("feature movement") || q.includes("planned features") || q.includes("movement")) {
    const table = renderFeatureMovementTable(snapshot.tables.featureMovement);
    return `Here's the weekly feature movement snapshot across pods:\n\n${table}\n\nSnapshot: ${snapshot.generated_at}`;
  }

  // 2) pods with zero projects
  if (q.includes("zero projects") || q.includes("no projects") || q.includes("pods have 0")) {
    const zp = snapshot.tables.zeroProjects;
    if (!zp.length) return `All pods have >=1 project in this snapshot.\n\nSnapshot: ${snapshot.generated_at}`;
    const lines = zp.map(x => `- ${x.pod}: 0 projects (${x.reason})`).join("\n");
    return `Pods with 0 projects in this snapshot:\n${lines}\n\nSnapshot: ${snapshot.generated_at}`;
  }

  // 3) specific pod query (snapshot-based)
  const podNames = snapshot.pods.map(p => p.name.toLowerCase());
  const match = podNames.find(n => q.includes(n));
  if (match && !q.includes("live") && !q.includes("project ")) {
    const pod = findPod(snapshot, match);
    if (!pod) return null;

    const topProjects = pod.topProjects?.length
      ? pod.topProjects.map(p => `- ${p.title} (${p.state}) owner=${p.owner || "NA"} eta=${p.eta || "NA"}`).join("\n")
      : `- Not available in this snapshot.`;

    const blockers = pod.blockers?.length
      ? pod.blockers.map(b => `- ${b.title} owner=${b.owner || "NA"} priority=${b.priority ?? "NA"}`).join("\n")
      : `- None found (or not labeled) in this snapshot.`;

    return `
${pod.name}: Planned=${pod.plannedFeatures}, Done=${pod.done}, In-Flight=${pod.inFlight}, Not Started=${pod.notStarted}, Projects=${pod.projectsCount} (status=${pod.data_status})

Top projects (latest):
${topProjects}

Blockers:
${blockers}

Snapshot: ${snapshot.generated_at}
`.trim();
  }

  // no deterministic match
  return null;
}

// ============== LIVE DATA FORMATTING ==============

function formatPodSummary(result) {
  if (!result.success) {
    let msg = `Error: ${result.error}\n${result.message}`;
    if (result.suggestion) msg += `\n\nDid you mean: ${result.suggestion}?`;
    if (result.availablePods) msg += `\nAvailable pods: ${result.availablePods.join(", ")}`;
    return msg;
  }

  const { pod, projectCount, projectStats, issueStats, topProjects, fetchedAt } = result;

  let output = `## ${pod} - Live Summary\n\n`;

  // Facts
  output += `**Projects:** ${projectCount} total\n`;
  output += `- Done: ${projectStats.done}\n`;
  output += `- In-Flight: ${projectStats.in_flight}\n`;
  output += `- Not Started: ${projectStats.not_started}\n`;
  if (projectStats.cancelled > 0) output += `- Cancelled: ${projectStats.cancelled}\n`;

  output += `\n**Issues:** ${issueStats.total} total, ${issueStats.active} active\n`;
  if (issueStats.blockers > 0) output += `- Blockers: ${issueStats.blockers}\n`;
  if (issueStats.risks > 0) output += `- Risks: ${issueStats.risks}\n`;

  // Top projects
  if (topProjects?.length > 0) {
    output += `\n**Top Projects (by recent activity):**\n`;
    for (const p of topProjects) {
      output += `- ${p.name} (${p.normalizedState}) - ${p.lead || "no lead"}\n`;
    }
  }

  output += `\n*Source: LIVE from Linear (${formatToIST(fetchedAt)})*`;
  return output;
}

async function formatProjectList(result) {
  if (!result.success) {
    let msg = `Error: ${result.error}\n${result.message}`;
    if (result.suggestion) msg += `\n\nDid you mean: ${result.suggestion}?`;
    return msg;
  }

  const { pod, stats, projects, fetchedAt } = result;

  // Separate roadmap projects from adhoc projects
  const isAdhocProject = (p) => /adhoc/i.test(p.name);
  const roadmapProjects = projects.filter(p => !isAdhocProject(p));

  let output = `## ${pod} - Projects\n\n`;

  // Stats summary (for roadmap only)
  output += `Status breakdown: Done=${stats.done}, In-Flight=${stats.in_flight}, Not Started=${stats.not_started}\n\n`;

  // Roadmap projects
  if (roadmapProjects.length > 0) {
    output += formatProjectsBox(roadmapProjects, pod, {
      title: `Roadmap Projects (${roadmapProjects.length})`
    });
  }

  // Fetch and display adhoc issues table
  try {
    const adhocResult = await getAdhocIssues(pod);
    if (adhocResult.success && adhocResult.total > 0) {
      output += `\n`;
      output += formatAdhocTable(adhocResult);
    }
  } catch (e) {
    // Skip adhoc table if fetch fails
  }

  output += `\n*Source: LIVE from Linear (${formatToIST(fetchedAt)})*`;
  return output;
}

/**
 * Format adhoc issues into a table
 */
function formatAdhocTable(adhocResult) {
  const { pod, total, issues, statusCounts } = adhocResult;

  let output = `### Adhoc in Q1 (${total} total)\n\n`;

  // Status summary
  const inProgress = statusCounts.started || 0;
  const done = statusCounts.completed || 0;
  const notStarted = total - inProgress - done;
  output += `In Progress: ${inProgress} | Done: ${done} | Not Started: ${notStarted}\n\n`;

  if (issues.length === 0) {
    output += `_No adhoc issues found_\n`;
    return output;
  }

  // Table header
  output += `| ID | Title | Cycle | Assignee | Status | Due Date |\n`;
  output += `|-----|-------|-------|----------|--------|----------|\n`;

  // Table rows (limit to 15)
  for (const issue of issues.slice(0, 15)) {
    const title = issue.title.length > 35 ? issue.title.substring(0, 32) + "..." : issue.title;
    const dueDate = issue.dueDate ? new Date(issue.dueDate).toLocaleDateString("en-IN", { day: "2-digit", month: "short" }) : "—";
    output += `| ${issue.identifier} | ${title} | ${issue.cycle} | ${issue.assignee} | ${issue.status} | ${dueDate} |\n`;
  }

  if (issues.length > 15) {
    output += `\n_...and ${issues.length - 15} more_\n`;
  }

  return output;
}

function formatProjectDetail(result) {
  if (!result.success) {
    let msg = `Error: ${result.error}\n${result.message}`;
    if (result.availableProjects) {
      msg += `\n\nAvailable projects:\n${result.availableProjects.map(p => `- ${p}`).join("\n")}`;
    }
    return msg;
  }

  const { pod, project, issueStats, activeIssues, blockerIssues, fetchedAt } = result;

  let output = `## ${project.name}\n\n`;

  // Project facts
  output += `**Pod:** ${pod}\n`;
  output += `**State:** ${project.normalizedState}\n`;
  output += `**Lead:** ${project.lead || "Not assigned"}\n`;
  if (project.targetDate) output += `**Target Date:** ${project.targetDate}\n`;
  if (project.url) output += `**URL:** ${project.url}\n`;

  // Issue stats
  output += `\n**Issues:** ${issueStats.total} total\n`;
  output += `- Active: ${issueStats.active}\n`;
  output += `- Done: ${issueStats.done}\n`;
  if (issueStats.blockers > 0) output += `- **Blockers: ${issueStats.blockers}**\n`;
  if (issueStats.highPriority > 0) output += `- High Priority: ${issueStats.highPriority}\n`;

  // Blockers
  if (blockerIssues?.length > 0) {
    output += `\n**Blockers:**\n`;
    for (const issue of blockerIssues) {
      output += `- [${issue.identifier}] ${issue.title} (${issue.assignee || "unassigned"})\n`;
    }
  }

  // Active issues
  if (activeIssues?.length > 0) {
    output += `\n**Active Issues (recent):**\n`;
    for (const issue of activeIssues.slice(0, 10)) {
      const marker = issue.isBlocker ? " [BLOCKER]" : "";
      output += `- [${issue.identifier}] ${issue.title}${marker}\n`;
    }
  }

  output += `\n*Source: LIVE from Linear (${formatToIST(fetchedAt)})*`;
  return output;
}

function formatBlockers(result) {
  if (!result.success) {
    return `Error: ${result.error}\n${result.message}`;
  }

  const { pod, project, projectUrl, blockerCount, blockers, fetchedAt } = result;

  let output = `## Blockers for ${project}\n\n`;
  output += `Pod: ${pod}\n`;
  output += `Total Blockers: ${blockerCount}\n`;
  if (projectUrl) output += `Project URL: ${projectUrl}\n`;

  if (blockers.length === 0) {
    output += `\nNo blockers found for this project.\n`;
  } else {
    output += `\n`;
    output += formatBlockersBox(blockers, project, {
      title: `Blockers (${blockerCount} total)`
    });
  }

  output += `\n*Source: LIVE from Linear (${formatToIST(fetchedAt)})*`;
  return output;
}

function formatPodsList(result) {
  let output = `## Available Pods\n\n`;
  output += `Source: ${result.source}\n`;
  if (result.org) output += `Organization: ${result.org}\n`;
  output += `\n`;

  output += formatPodsListBox(result.pods, {
    title: `Pods (${result.podCount} total)`
  });

  return output;
}

// ============== COMMAND PARSING ==============

// Known pod names for detection
const POD_NAMES = ["fts", "gts", "platform", "control center", "talent studio", "growth & reuse", "growth and reuse", "gr", "ml", "fot", "bts"];

/**
 * Check if a string is EXACTLY a pod name (not a project name within a pod)
 */
function isPodName(str) {
  const s = String(str || "").toLowerCase().trim();
  // Only match exact pod names, not "fts evals" or "platform roadmap"
  return POD_NAMES.some(p => p === s || s === p.replace("&", "and"));
}

/**
 * Extract pod name if the query is asking about a specific pod
 */
function extractPodFromQuery(input) {
  const lower = input.toLowerCase();

  // Check each known pod name
  for (const pod of POD_NAMES) {
    if (lower.includes(pod)) {
      // Map aliases to canonical pod names
      if (pod === "growth & reuse" || pod === "growth and reuse" || pod === "gr") return "Growth & Reuse";
      if (pod === "fts") return "FTS";
      if (pod === "gts") return "GTS";
      if (pod === "platform") return "Platform";
      if (pod === "control center") return "Control Center";
      if (pod === "talent studio") return "Talent Studio";
      if (pod === "ml") return "ML";
      if (pod === "fot") return "FOT";
      if (pod === "bts") return "BTS";
      return pod;
    }
  }
  return null;
}

/**
 * Extract project name from natural language queries like:
 * - "what's going on in FTS Evals manual actions replacements"
 * - "status of Data-Driven Cohorts"
 * - "update on tagging project"
 *
 * Returns null if the query is about a pod (not a project)
 */
function extractProjectFromNaturalLanguage(input) {
  // First check if this is an "all pods" or general KPI query
  const lower = input.toLowerCase();
  if (lower.includes("all pods") || lower.includes("across pods") ||
      lower.includes("all teams") || lower.includes("this week") ||
      lower.includes("kpi")) {
    return null; // Not a project query
  }

  // Patterns that indicate a project-specific query
  const patterns = [
    /deep ?dive (?:into|on|for|in)? ?(.+?)(?:\?|$)/i,  // "deep dive into X", "deep dive X"
    /what(?:'s|s| is) (?:going on|happening) (?:in|with|on)? ?(.+?)(?:\?|$)/i,  // "whats going on X" or "whats going on in X"
    /(?:status|update|progress|details?) (?:of|on|for) (.+?)(?:\?|$)/i,
    /(?:tell me about|show me|give me) (.+?)(?:\?|$)/i,
    /how(?:'s| is) (.+?) (?:doing|going|progressing)(?:\?|$)/i,
    /(.+?) (?:status|update|progress)(?:\?|$)/i,
  ];

  for (const pattern of patterns) {
    const match = input.match(pattern);
    if (match && match[1]) {
      let projectName = match[1].trim();
      // Remove common suffixes like "project"
      projectName = projectName.replace(/\s+project$/i, "").trim();

      // Check if it's just a pod name - if so, return null (it's a pod query)
      if (isPodName(projectName)) {
        return null;
      }

      // Must have meaningful length to be a project name
      if (projectName.length > 3) {
        return projectName;
      }
    }
  }

  return null;
}

/**
 * LLM-based query interpreter for natural language understanding
 * Handles typos, variations, and extracts intent
 */
async function interpretQueryWithLLM(input, availablePods, availableProjects) {
  const podList = availablePods.join(", ");
  const projectList = availableProjects.slice(0, 30).join(", ");

  const messages = [
    {
      role: "system",
      content: `You are a query interpreter for a project management dashboard. Your job is to understand what the user wants and extract structured intent.

## AVAILABLE PODS
${podList}

## SAMPLE PROJECTS (there are more)
${projectList}

## YOUR TASK
1. Understand what the user is asking about
2. Correct any typos in pod/project names
3. Return a JSON object with the intent

## INTENT TYPES
- "pod_info" - User wants GENERAL overview/status of a pod (e.g., "whats up with fts", "how is talent studio doing", "fts status")
- "project_info" - User wants GENERAL overview of a project (e.g., "AI interviewer status", "deep dive data cohorts", "show me AI interviewer")
- "project_question" - User is asking a SPECIFIC QUESTION about a project (e.g., "any blockers in AI interviewer?", "what are the risks for Data Cohorts?", "tell me blockers in AI interviewer for tomorrow demo"). Use this when the user asks about blockers, risks, issues, concerns, deadlines, or specific aspects of a project.
- "all_pods" - User wants overview of all pods (e.g., "how are all teams doing", "overall status")
- "conversation" - User is making general conversation, greetings, or asking questions NOT about a specific pod/project (e.g., "hello", "thanks", "anything to highlight across all teams?", "what should I know?")
- "unknown" - ONLY use this if the input is completely gibberish or unintelligible

IMPORTANT: If the user asks a QUESTION (blockers? risks? issues? concerns? what about...? tell me about...? can you tell me...?) about a specific project, use "project_question" NOT "project_info".

## OUTPUT FORMAT (JSON only, no explanation)
{
  "intent": "pod_info" | "project_info" | "project_question" | "all_pods" | "conversation" | "unknown",
  "entity": "corrected pod or project name" | null,
  "question_focus": "blockers" | "risks" | "timeline" | "issues" | "general" | null,
  "confidence": "high" | "medium" | "low",
  "corrected_query": "what user probably meant"
}

## EXAMPLES
Input: "whats going on AI Interviwer"
Output: {"intent": "project_info", "entity": "AI Interviewer", "question_focus": null, "confidence": "high", "corrected_query": "What's going on with AI Interviewer project?"}

Input: "fts stauts"
Output: {"intent": "pod_info", "entity": "FTS", "question_focus": null, "confidence": "high", "corrected_query": "FTS status"}

Input: "deep dive into data driven cohorts"
Output: {"intent": "project_info", "entity": "Data-Driven Cohorts", "question_focus": null, "confidence": "high", "corrected_query": "Deep dive into Data-Driven Cohorts project"}

Input: "can you tell me any blocker in tomorrow demo in AI interviewer project"
Output: {"intent": "project_question", "entity": "AI Interviewer", "question_focus": "blockers", "confidence": "high", "corrected_query": "What are the blockers for AI Interviewer's tomorrow demo?"}

Input: "any risks in data cohorts project?"
Output: {"intent": "project_question", "entity": "Data-Driven Cohorts", "question_focus": "risks", "confidence": "high", "corrected_query": "What are the risks in Data-Driven Cohorts project?"}

Input: "what issues does AI interviewer have?"
Output: {"intent": "project_question", "entity": "AI Interviewer", "question_focus": "issues", "confidence": "high", "corrected_query": "What issues does AI Interviewer have?"}

Input: "tell me about blockers for onboarding project"
Output: {"intent": "project_question", "entity": "Onboarding", "question_focus": "blockers", "confidence": "high", "corrected_query": "What are the blockers for Onboarding project?"}

Input: "anything else you want to highlight?"
Output: {"intent": "conversation", "entity": null, "question_focus": null, "confidence": "high", "corrected_query": "What are the key highlights?"}

Input: "hello"
Output: {"intent": "conversation", "entity": null, "question_focus": null, "confidence": "high", "corrected_query": "User greeting"}

Input: "thanks"
Output: {"intent": "conversation", "entity": null, "question_focus": null, "confidence": "high", "corrected_query": "User expressing thanks"}`
    },
    { role: "user", content: input }
  ];

  try {
    const response = await fuelixChat({ messages, temperature: 0 });
    // Extract JSON from response
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        success: true,
        intent: parsed.intent,
        entity: parsed.entity,
        confidence: parsed.confidence,
        correctedQuery: parsed.corrected_query,
      };
    }
  } catch (e) {
    // LLM failed, return unknown
  }

  return { success: false, intent: "unknown", entity: null };
}

// Cache for conversation context (TTL: 2 minutes)
let _conversationContextCache = { data: null, timestamp: 0 };
const CONTEXT_CACHE_TTL = 2 * 60 * 1000; // 2 minutes

// Quick responses for simple greetings (no data fetch needed)
const QUICK_RESPONSES = {
  greetings: ["hello", "hi", "hey", "good morning", "good afternoon", "good evening"],
  thanks: ["thanks", "thank you", "thx", "ty", "cheers"],
};

function isSimpleGreeting(question) {
  const q = question.toLowerCase().trim();
  return QUICK_RESPONSES.greetings.some(g => q === g || q === g + "!");
}

function isSimpleThanks(question) {
  const q = question.toLowerCase().trim();
  return QUICK_RESPONSES.thanks.some(t => q.includes(t));
}

/**
 * Handle conversational/open-ended queries using LLM
 * This allows natural language questions like "anything to highlight?", "what should I know?", etc.
 * Optimized for speed with parallel fetching and caching.
 * Supports conversation history for follow-up answers.
 */
async function handleConversationalQuery(question, availablePods, snapshot, options = {}) {
  const history = options.history || [];
  // Fast path for simple greetings - no data fetch needed
  if (isSimpleGreeting(question)) {
    return "Hello! I'm your KPI Assistant. I can help you with:\n- **Pod status**: \"pod FTS\" or \"how is Platform doing?\"\n- **Project details**: \"deep dive AI Interviewer\"\n- **All pods**: \"pods\"\n- **Highlights & risks**: \"anything to highlight?\"\n\nWhat would you like to know?";
  }

  if (isSimpleThanks(question)) {
    return "You're welcome! Let me know if you need anything else.";
  }

  // Check cache for context data
  const now = Date.now();
  let contextData = "";

  if (_conversationContextCache.data && (now - _conversationContextCache.timestamp) < CONTEXT_CACHE_TTL) {
    contextData = _conversationContextCache.data;
  } else {
    // Build fresh context
    try {
      // Get high-level overview of all pods
      const podsResult = listPods();
      if (podsResult.pods && podsResult.pods.length > 0) {
        contextData += "## Available Pods\n";
        for (const pod of podsResult.pods) {
          contextData += `- ${pod.name}\n`;
        }
        contextData += "\n";
      }

      // Fetch pod summaries IN PARALLEL for speed
      const podsToFetch = availablePods.slice(0, 5);
      if (podsToFetch.length > 0) {
        const summaryPromises = podsToFetch.map(podName =>
          getLivePodSummary(podName)
            .then(summary => ({ podName, summary, success: true }))
            .catch(() => ({ podName, success: false }))
        );

        // Wait for all with a timeout
        const results = await Promise.race([
          Promise.all(summaryPromises),
          new Promise(resolve => setTimeout(() => resolve([]), 10000)) // 10s timeout
        ]);

        const podSummaries = results
          .filter(r => r.success && r.summary?.success)
          .map(r => ({
            pod: r.podName,
            projects: r.summary.projectCount,
            done: r.summary.projectStats.done,
            inFlight: r.summary.projectStats.in_flight,
            notStarted: r.summary.projectStats.not_started,
            blockers: r.summary.issueStats?.blockers || 0,
            risks: r.summary.issueStats?.risks || 0,
            topProjects: r.summary.topProjects?.slice(0, 3) || []
          }));

        if (podSummaries.length > 0) {
          contextData += "## Pod Summaries (Live Data)\n";
          for (const ps of podSummaries) {
            contextData += `### ${ps.pod}\n`;
            contextData += `- Projects: ${ps.projects} total (Done: ${ps.done}, In-Flight: ${ps.inFlight}, Not Started: ${ps.notStarted})\n`;
            if (ps.blockers > 0) contextData += `- **Blockers: ${ps.blockers}**\n`;
            if (ps.risks > 0) contextData += `- Risks: ${ps.risks}\n`;
            if (ps.topProjects.length > 0) {
              contextData += `- Top Projects: ${ps.topProjects.map(p => p.name).join(", ")}\n`;
            }
            contextData += "\n";
          }
        }
      }

      // Cache the context
      _conversationContextCache = { data: contextData, timestamp: now };
    } catch (e) {
      // Continue with whatever context we have
    }
  }

  // Add snapshot data if available (compact version)
  if (snapshot && !contextData) {
    contextData += "## Snapshot Data\n";
    // Only include essential fields to reduce token count
    const compactSnapshot = {
      pods: snapshot.pods?.map(p => ({
        name: p.name,
        done: p.done,
        inFlight: p.inFlight,
        blockers: p.blockers?.length || 0
      })),
      generated_at: snapshot.generated_at
    };
    contextData += JSON.stringify(compactSnapshot, null, 2);
    contextData += "\n";
  }

  // Build conversational prompt - intelligent assistant that can reason
  const conversationalSystemPrompt = `You are an intelligent KPI Assistant that can THINK, REASON, and have natural conversations about engineering projects and pods.

## YOUR CAPABILITIES
- You UNDERSTAND context and can make connections between data points
- You can ANALYZE patterns (e.g., if multiple pods have blockers, that's a trend worth mentioning)
- You can INFER concerns even if not explicitly stated
- You REMEMBER the conversation context and can answer follow-up questions naturally
- You can be PROACTIVE and highlight important things the user should know

## HOW TO RESPOND
- Be conversational like ChatGPT or Claude - natural, friendly, helpful
- THINK about what the user really wants to know
- Provide INSIGHTS, not just data dumps
- If asked "anything to highlight?" - identify the MOST IMPORTANT things across all data
- If asked about risks/blockers - reason about what could go wrong
- Be concise but informative
- Offer to go deeper if the user wants more details

## AVAILABLE DATA
${contextData || "No live data currently loaded. You can ask about specific pods (e.g., 'pod FTS') or projects to get detailed information."}`;

  // Build messages with conversation history
  const messages = [
    { role: "system", content: conversationalSystemPrompt },
  ];

  // Add conversation history for context (so LLM understands follow-ups)
  if (history.length > 0) {
    for (const msg of history) {
      messages.push({ role: msg.role, content: msg.content });
    }
  }

  // Add current question
  messages.push({ role: "user", content: question });

  try {
    const response = await fuelixChat({ messages, temperature: 0.7, timeout: 20000 });
    return response.trim();
  } catch (e) {
    return `I'm here to help! You can ask me about:\n- **Pod status**: "pod FTS" or "how is Talent Studio doing?"\n- **Project details**: "deep dive AI Interviewer"\n- **All pods overview**: "pods" or "show all teams"\n\nWhat would you like to know?`;
  }
}

/**
 * Handle specific questions about a project (blockers, risks, issues, etc.)
 * OPTIMIZED: Parallel fetching - no delays.
 * Supports conversation history for follow-up questions.
 */
async function handleProjectQuestion(question, projectName, questionFocus, snapshot, options = {}) {
  const history = options.history || [];
  const podsResult = listPods();
  let projectData = null;
  let podName = null;
  let blockers = [];
  let activeIssues = [];
  let slackContext = "";

  // PARALLEL: Search all pods at once
  const searchResults = await Promise.all(
    podsResult.pods.map(async (pod) => {
      try {
        const result = await getLiveProjects(pod.name);
        if (result.success) {
          const match = result.projects.find(p =>
            p.name.toLowerCase().includes(projectName.toLowerCase()) ||
            projectName.toLowerCase().includes(p.name.toLowerCase().replace(/^.*?-\s*/, ''))
          );
          if (match) return { pod: pod.name, project: match };
        }
      } catch (e) {}
      return null;
    })
  );

  const found = searchResults.find(r => r !== null);
  if (found) {
    projectData = found.project;
    podName = found.pod;

    // PARALLEL: Fetch Linear details + Slack at same time
    const [detailResult, slackResult] = await Promise.all([
      getLiveProject(podName, projectData.name).catch(() => null),
      generateDeepDiveDiscussions(projectData).catch(() => null)
    ]);

    if (detailResult?.success) {
      blockers = detailResult.blockerIssues || [];
      activeIssues = detailResult.activeIssues || [];
    }

    if (slackResult?.keyDiscussions) {
      slackContext = slackResult.keyDiscussions;
      if (slackResult.slackMessageCount > 0) {
        slackContext += `\n(Based on ${slackResult.slackMessageCount} Slack messages)`;
      }
    }
  }

  // Build context for LLM
  let projectContext = "";
  if (projectData) {
    projectContext = `## Project: ${projectData.name}
- Pod: ${podName}
- State: ${projectData.normalizedState || projectData.state}
- Lead: ${projectData.lead || "Not assigned"}
- Target Date: ${projectData.targetDate || "Not set"}

`;
    if (blockers.length > 0) {
      projectContext += `## Blockers (${blockers.length})\n`;
      for (const b of blockers) {
        projectContext += `- [${b.identifier}] ${b.title} (Assignee: ${b.assignee || "unassigned"}, Priority: ${b.priority || "none"})\n`;
      }
      projectContext += "\n";
    } else {
      projectContext += "## Blockers\nNo formal blockers logged in Linear.\n\n";
    }

    if (activeIssues.length > 0) {
      projectContext += `## Active Issues (${activeIssues.length})\n`;
      for (const issue of activeIssues.slice(0, 15)) {
        const blockerTag = issue.isBlocker ? " [BLOCKER]" : "";
        const stateInfo = issue.state || "unknown state";
        projectContext += `- [${issue.identifier}] ${issue.title}${blockerTag} (${stateInfo})\n`;
      }
      projectContext += "\n";
    }

    // Add Slack/Linear discussions context
    if (slackContext) {
      projectContext += `## Recent Discussions (from Slack + Linear)\n${slackContext}\n`;
    }
  } else {
    projectContext = `Could not find project "${projectName}" in any pod. Available pods: ${podsResult.pods.map(p => p.name).join(", ")}`;
  }

  // Build LLM prompt - instruct to THINK and REASON, not just summarize
  const today = new Date();
  const todayStr = today.toLocaleDateString("en-IN", { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Kolkata' });
  const tomorrowDate = new Date(today);
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrowStr = tomorrowDate.toLocaleDateString("en-IN", { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'Asia/Kolkata' });

  const systemPromptText = `You are an intelligent KPI Assistant with deep understanding of software projects. You can THINK, REASON, and provide INSIGHTS - not just summarize data.

## CURRENT DATE & TIME
- **Today is: ${todayStr}**
- **Tomorrow is: ${tomorrowStr}**
- Use this to understand time-based questions like "tomorrow's demo", "this week", "upcoming deadline"

## YOUR CAPABILITIES
- You can ANALYZE data to find patterns and connections
- You can INFER risks even if not explicitly labeled as "blocker"
- You can UNDERSTAND context from Slack discussions to identify concerns
- You can REASON about what issues might impact a demo, deadline, or release
- You can COMPARE target dates with today to identify urgent issues
- You can PREDICT potential problems based on the state of tickets

## HOW TO ANSWER
1. THINK about what the user is really asking (e.g., "blockers for tomorrow's demo" = what could go wrong on ${tomorrowStr}?)
2. ANALYZE all the data - tickets, states, discussions, patterns
3. REASON about connections (e.g., if 3 tickets are "Deployed to Staging" but user asks about demo, those might be relevant)
4. CHECK target dates against today's date for urgency
5. PROVIDE INSIGHTS - don't just list data, explain what it means
6. BE PROACTIVE - if you see something concerning, mention it even if not directly asked

## RESPONSE STYLE
- Be conversational and helpful like ChatGPT or Claude
- Reference specific ticket IDs (TS-1234) when relevant
- Explain WHY something is a concern, not just WHAT it is
- If no formal blockers exist but issues could cause problems, say so
- Mention if target dates are approaching or overdue
- Offer to help further (e.g., "If you tell me which environment you're demoing on, I can be more specific")

## PROJECT DATA
${projectContext}`;

  // Build messages with conversation history for follow-ups
  const messages = [
    { role: "system", content: systemPromptText },
  ];

  // Add conversation history (previous Q&A pairs)
  if (history.length > 0) {
    for (const msg of history) {
      messages.push({ role: msg.role, content: msg.content });
    }
  }

  // Add current question
  messages.push({ role: "user", content: question });

  try {
    const response = await fuelixChat({ messages, temperature: 0.7, timeout: 25000 });
    return response.trim();
  } catch (e) {
    // Fallback to basic response
    if (blockers.length > 0) {
      return `**Blockers for ${projectData?.name || projectName}:**\n${blockers.map(b => `- ${b.title} (${b.assignee || "unassigned"})`).join("\n")}`;
    }
    if (activeIssues.length > 0) {
      return `No formal blockers, but there are ${activeIssues.length} active issues for ${projectData?.name || projectName}:\n${activeIssues.slice(0, 5).map(i => `- [${i.identifier}] ${i.title}`).join("\n")}`;
    }
    return `No blockers or active issues found for ${projectData?.name || projectName}.`;
  }
}

/**
 * Parse user input into a command structure
 */
function parseCommand(input) {
  const trimmed = String(input || "").trim();
  const lower = trimmed.toLowerCase();
  const words = lower.split(/\s+/);

  // "pods" or "list pods"
  if (lower === "pods" || lower === "list pods") {
    return { type: "list_pods" };
  }

  // "cache" or "cache stats"
  if (lower === "cache" || lower === "cache stats") {
    return { type: "cache_stats" };
  }

  // "clear cache"
  if (lower === "clear cache") {
    return { type: "clear_cache" };
  }

  // "debug" mode toggle
  if (lower === "debug" || lower === "debug mode" || lower === "debug on") {
    return { type: "debug_mode" };
  }

  // ALL PODS / CROSS-POD queries - these should return combined KPI tables
  const allPodsPatterns = [
    /what(?:'s|s| is) (?:going on|happening) (?:across|in|with) (?:all )?pods/i,
    /what(?:'s|s| is) (?:going on|happening) (?:this week|today)/i,
    /(?:show|get|give me) (?:the )?(?:all |cross.?)?pod(?:s)? (?:status|summary|kpi)/i,
    /(?:status|summary) (?:of |for )?(?:all )?pods/i,
    /(?:across|all) pods/i,
    /(?:our )?kpis? this week/i,
    /what are (?:the |our )?kpis?/i,
    /how are (?:all )?(?:the )?pods (?:doing)?/i,
    /team(?:s)? (?:status|summary)/i,
  ];

  for (const pattern of allPodsPatterns) {
    if (pattern.test(lower)) {
      return { type: "all_pods_summary" };
    }
  }

  // POD-SPECIFIC natural language queries - "what's going on in FTS?"
  const podQueryPatterns = [
    /what(?:'s|s| is) (?:going on|happening) (?:in|with|on) (fts|gts|platform|control center|talent studio|growth.{1,5}reuse|gr|ml|fot|bts)\??$/i,
    /(?:status|update|summary) (?:of|on|for) (fts|gts|platform|control center|talent studio|growth.{1,5}reuse|gr|ml|fot|bts)\??$/i,
    /(?:tell me about|show me) (fts|gts|platform|control center|talent studio|growth.{1,5}reuse|gr|ml|fot|bts)\??$/i,
    /how(?:'s| is) (fts|gts|platform|control center|talent studio|growth.{1,5}reuse|gr|ml|fot|bts) (?:doing)?\??$/i,
  ];

  for (const pattern of podQueryPatterns) {
    const match = lower.match(pattern);
    if (match && match[1]) {
      const podName = extractPodFromQuery(match[1]);
      if (podName) {
        return { type: "pod_narrative", podName };
      }
    }
  }

  // Combined/Full KPI queries - both DEL and Weekly with project summaries
  const combinedKpiPatterns = [
    /^(?:full|combined|complete|all|both) (?:kpi|kpis)/i,
    /^kpi (?:full|combined|complete|all|both)/i,
    /^(?:show|get|display) (?:both|all|full) (?:kpi|kpis)/i,
    /^del.*(?:and|with|&).*(?:weekly|feature)/i,
    /^(?:weekly|feature).*(?:and|with|&).*del/i,
  ];

  for (const pattern of combinedKpiPatterns) {
    if (pattern.test(lower)) {
      return { type: "all_pods_summary" };
    }
  }

  // DEL-specific queries - DELs planned/committed in a specific cycle
  // Match queries like: "what DELs are planned in cycle C1", "DELs in C1 for FTS", "what and DELs planned in cycle C1"
  const delCyclePatterns = [
    /(?:what(?:'s|s| is| are| and)?|whats?|and) (?:the )?dels? (?:are )?(?:planned|committed|scheduled|in) (?:for |in )?(?:cycle )?c([1-6])/i,
    /dels? (?:planned|committed|scheduled|in) (?:for |in )?(?:cycle )?c([1-6])/i,
    /(?:show|list|get|display) (?:the )?dels? (?:for |in )?(?:cycle )?c([1-6])/i,
    /(?:cycle )?c([1-6]) dels?/i,
    /dels? (?:for |in )?c([1-6])/i,
  ];

  for (const pattern of delCyclePatterns) {
    const match = lower.match(pattern);
    if (match && match[1]) {
      const cycle = `C${match[1]}`;
      const podName = extractPodFromQuery(lower);
      return { type: "dels_by_cycle", cycle, podName };
    }
  }

  // DEL-specific queries - pending/incomplete DELs
  // Match queries like: "in fts whats DELs are pending", "what are the pending dels", "show pending dels for fts"
  const delQueryPatterns = [
    /(?:what(?:'s|s| is| are)?|whats) (?:the )?(?:pending|incomplete|uncommitted|not completed|outstanding) dels?/i,
    /(?:what(?:'s|s| is| are)?|whats) dels? (?:are )?(?:pending|incomplete|not done|not completed|outstanding)/i,
    /dels? (?:that are |which are )?(?:pending|incomplete|not completed|outstanding)/i,
    /(?:show|list|get|display) (?:the )?(?:pending|incomplete|outstanding) dels?/i,
    /(?:which|what) dels? (?:are )?(?:pending|incomplete|not done|not completed)/i,
    /pending dels?/i,
    /(?:in |for )?\w+ (?:pending|incomplete) dels?/i,
  ];

  for (const pattern of delQueryPatterns) {
    const match = lower.match(pattern);
    if (match) {
      // Check if pod name is specified
      const podName = extractPodFromQuery(lower);
      return { type: "pending_dels", podName };
    }
  }

  // DEL-only KPI queries - show just the DEL metrics table
  const delOnlyKpiPatterns = [
    /^(?:show\s+(?:me\s+)?)?dels?\s+kpi/i,
    /^dels?\s+kpi/i,
    /^(?:show\s+(?:me\s+)?)?(?:the\s+)?del\s+(?:kpi|metrics|report|table)/i,
    /^(?:what(?:'s|s| is| are)\s+)?(?:the\s+)?dels?\s+(?:kpi|metrics|status)/i,
    /^cycle\s+kpi/i,
    /^(?:get|display)\s+(?:the\s+)?dels?\s+(?:kpi|metrics)/i,
  ];

  for (const pattern of delOnlyKpiPatterns) {
    if (pattern.test(lower)) {
      return { type: "del_kpi" };
    }
  }

  // KPI queries - detect various ways users ask for KPI (shows both tables)
  const kpiPatterns = [
    /^(?:what(?:'s|s| is) )?(?:the )?(?:weekly )?kpi/i,
    /^(?:what(?:'s|s| is) )?(?:this week(?:'s)? )?kpi/i,
    /^(?:show\s+(?:me\s+)?)?kpi\s+(?:tables?|report|snapshot)/i,
    /^pod kpi/i,
    /^weekly (?:kpi|report|snapshot)/i,
    /^kpi (?:for )?(?:this )?week/i,
    /^(?:this )?week(?:'s)? kpi/i,
    /^(?:show|get|display)\s+(?:me\s+)?(?:the )?(?:weekly )?kpi/i,
    /^(?:how are we doing|team status|sprint status)/i,
  ];

  for (const pattern of kpiPatterns) {
    if (pattern.test(lower)) {
      // Default to all pods summary for better user experience
      return { type: "all_pods_summary" };
    }
  }

  // "pod <name>" or "pod <name> projects" or "pod <name> live"
  if (words[0] === "pod" && words.length >= 2) {
    // Check for subcommand at end
    const lastWord = words[words.length - 1];
    if (lastWord === "projects" && words.length >= 3) {
      const podName = words.slice(1, -1).join(" ");
      return { type: "pod_projects", podName };
    }
    if (lastWord === "live" && words.length >= 3) {
      const podName = words.slice(1, -1).join(" ");
      return { type: "pod_live", podName };
    }
    const podName = words.slice(1).join(" ");
    return { type: "pod_summary", podName };
  }

  // "project <name>" or "project <name> blockers" or "project <name> comments"
  if (words[0] === "project" && words.length >= 2) {
    const lastWord = words[words.length - 1];

    if (lastWord === "blockers" && words.length >= 3) {
      const projectName = words.slice(1, -1).join(" ");
      return { type: "project_blockers", projectName };
    }
    if (lastWord === "comments" && words.length >= 3) {
      const projectName = words.slice(1, -1).join(" ");
      return { type: "project_comments", projectName };
    }

    const projectName = words.slice(1).join(" ");
    return { type: "project_detail", projectName };
  }

  // Check for natural language project queries
  // e.g., "what's going on in FTS Evals manual actions replacements"
  const projectFromNL = extractProjectFromNaturalLanguage(trimmed);
  if (projectFromNL) {
    return { type: "project_deep_dive", projectName: projectFromNL };
  }

  // Check for pod name mentions (e.g., "fts status", "gts blockers")
  // This is handled separately in the main answer function

  return { type: "unknown", input: trimmed };
}

// ============== DEBUG & NARRATIVE FUNCTIONS ==============

/**
 * Format debug info for troubleshooting
 */
function formatDebugInfo() {
  const { loadCycleCalendar, loadLabelIds } = require("./kpiComputer");
  const config = require("./configLoader").loadConfig();

  let out = "## Debug Information\n\n";

  // Config source
  out += `**Config Source:** ${config.source}\n`;
  out += `**Organization:** ${config.org?.name || "N/A"}\n\n`;

  // Pods
  out += `### Configured Pods (${Object.keys(config.pods).length})\n\n`;
  out += `| Pod | Team ID | Initiative ID | Projects |\n`;
  out += `|-----|---------|---------------|----------|\n`;

  for (const [name, data] of Object.entries(config.pods)) {
    const teamId = data.teamId ? data.teamId.substring(0, 8) + "..." : "MISSING";
    const initId = data.initiativeId ? data.initiativeId.substring(0, 8) + "..." : "MISSING";
    const projects = data.projects?.length ?? "N/A";
    out += `| ${name} | ${teamId} | ${initId} | ${projects} |\n`;
  }

  // Labels
  const labelIds = loadLabelIds();
  out += `\n### Label IDs\n`;
  if (labelIds) {
    out += `- DEL: ${labelIds.DEL ? "configured" : "MISSING"}\n`;
    out += `- DEL-CANCELLED: ${labelIds["DEL-CANCELLED"] ? "configured" : "MISSING"}\n`;
    for (let i = 1; i <= 6; i++) {
      const key = `2026Q1-C${i}`;
      out += `- ${key}: ${labelIds[key] ? "configured" : "MISSING"}\n`;
    }
  } else {
    out += `Labels config not found. Run: node scripts/runWeeklyKpi.js\n`;
  }

  // Cycle calendar
  const calendar = loadCycleCalendar();
  out += `\n### Cycle Calendar\n`;
  if (calendar) {
    out += `Pods with calendar: ${Object.keys(calendar.pods || {}).join(", ")}\n`;
  } else {
    out += `Calendar not found.\n`;
  }

  return out;
}

/**
 * Generate leadership dashboard for all pods
 * Shows: Executive Summary table, Needs Attention, Pending DELs, Insights
 */
async function generateAllPodsSummary() {
  const result = await computeCombinedKpi();

  if (!result.success) {
    return `Error: ${result.error}\n${result.message}`;
  }

  const cycle = result.fallbackCycle || result.currentCycle;
  const cycleRows = result.cycleKpi.filter(r => r.cycle === cycle);
  const fmRows = result.featureMovement || [];

  let out = "";

  // ============== 1. EXECUTIVE SUMMARY (Pod-wise Breakdown) ==============
  // Combine feature movement and DEL data into one comprehensive table
  const podData = [];
  let totals = { projects: 0, done: 0, inFlight: 0, notStarted: 0, delsCommitted: 0, delsCompleted: 0 };

  for (const fm of fmRows) {
    const delRow = cycleRows.find(d => d.pod === fm.pod);
    const projects = fm.plannedFeatures || 0;
    const done = fm.done || 0;
    const inFlight = fm.inFlight || 0;
    const notStarted = fm.notStarted || 0;
    const delsCommitted = delRow?.committed || 0;
    const delsCompleted = delRow?.completed || 0;
    const deliveryPct = delRow?.deliveryPct || "0%";

    // Calculate health based on delivery %
    const pctNum = parseInt(deliveryPct) || 0;
    let health = "🔴";
    if (pctNum >= 70) health = "🟢";
    else if (pctNum >= 40) health = "🟡";
    else if (pctNum > 0) health = "🟠";

    podData.push({
      pod: fm.pod,
      projects,
      done,
      inFlight,
      notStarted,
      delsCommitted,
      delsCompleted,
      deliveryPct,
      health
    });

    // Accumulate totals
    totals.projects += projects;
    totals.done += done;
    totals.inFlight += inFlight;
    totals.notStarted += notStarted;
    totals.delsCommitted += delsCommitted;
    totals.delsCompleted += delsCompleted;
  }

  // Calculate overall delivery %
  const overallDeliveryPct = totals.delsCommitted > 0
    ? Math.round((totals.delsCompleted / totals.delsCommitted) * 100) + "%"
    : "0%";

  // Build executive summary table
  out += jsonTable(`📊 Executive Summary (${cycle})`, [
    { key: "pod", header: "Pod" },
    { key: "projects", header: "Projects" },
    { key: "done", header: "Done" },
    { key: "inFlight", header: "In-Flight" },
    { key: "notStarted", header: "Not Started" },
    { key: "delsCommitted", header: `DELs (${cycle})` },
    { key: "delsCompleted", header: "Completed" },
    { key: "deliveryPct", header: "Delivery %" },
    { key: "health", header: "Health" }
  ], [
    ...podData,
    // TOTAL row
    {
      pod: "TOTAL",
      projects: totals.projects,
      done: totals.done,
      inFlight: totals.inFlight,
      notStarted: totals.notStarted,
      delsCommitted: totals.delsCommitted,
      delsCompleted: totals.delsCompleted,
      deliveryPct: overallDeliveryPct,
      health: ""
    }
  ]);
  out += "\n\n";

  // ============== 2. NEEDS ATTENTION ==============
  const atRiskPods = podData.filter(p => {
    const pct = parseInt(p.deliveryPct) || 0;
    return pct < 50 && p.delsCommitted > 0;
  });

  if (atRiskPods.length > 0) {
    out += `### ⚠️ Needs Attention\n\n`;
    out += `**Low Delivery (<50%):**\n`;
    for (const p of atRiskPods) {
      const pending = p.delsCommitted - p.delsCompleted;
      out += `- ${p.pod}: ${p.deliveryPct} delivery (${pending} DELs pending)\n`;
    }
    out += "\n";
  }

  // ============== 3. PENDING DELs BY POD ==============
  // Fetch pending DELs for all pods
  try {
    const pendingDelsResult = await fetchPendingDELs(null); // null = all pods
    const dels = pendingDelsResult?.dels || [];
    if (pendingDelsResult?.success && dels.length > 0) {
      const rows = dels.slice(0, 15).map(d => ({
        pod: d.pod || "-",
        del: (d.title || "").length > 35 ? d.title.substring(0, 35) + "..." : (d.title || "-"),
        assignee: d.assignee || "Unassigned",
        state: d.state || "-"
      }));

      out += jsonTable(`📅 Pending DELs (${dels.length} total)`, [
        { key: "pod", header: "Pod" },
        { key: "del", header: "DEL" },
        { key: "assignee", header: "Assignee" },
        { key: "state", header: "State" }
      ], rows);
      out += "\n\n";
    }
  } catch (e) {
    // Skip pending DELs section if fetch fails
    console.error("Failed to fetch pending DELs:", e.message);
  }

  // ============== 4. INSIGHTS ==============
  const insights = [];

  // Pods with 0% delivery
  const zeroDeliveryPods = podData.filter(p => parseInt(p.deliveryPct) === 0 && p.delsCommitted > 0);
  if (zeroDeliveryPods.length > 0) {
    insights.push(`${zeroDeliveryPods.length} pod${zeroDeliveryPods.length > 1 ? "s" : ""} at 0% delivery: ${zeroDeliveryPods.map(p => p.pod).join(", ")}`);
  }

  // High performers
  const highPerformers = podData.filter(p => parseInt(p.deliveryPct) >= 70 && p.delsCommitted > 0);
  if (highPerformers.length > 0) {
    insights.push(`${highPerformers.map(p => p.pod).join(", ")} leading with 70%+ delivery`);
  }

  // Not started percentage
  const notStartedPct = totals.projects > 0 ? Math.round((totals.notStarted / totals.projects) * 100) : 0;
  if (notStartedPct > 50) {
    insights.push(`${notStartedPct}% of projects not started - consider prioritization review`);
  }

  // At risk count
  if (atRiskPods.length > 0) {
    insights.push(`${atRiskPods.length} pod${atRiskPods.length > 1 ? "s" : ""} below 50% delivery need focus`);
  }

  if (insights.length > 0) {
    out += `### 💡 Insights\n\n`;
    insights.forEach((insight, i) => {
      out += `${i + 1}. ${insight}\n`;
    });
    out += "\n";
  }

  // ============== FOOTER ==============
  out += `---\nSource: Linear | ${formatToIST(result.fetchedAt)}`;

  return out;
}

/**
 * Calculate pod health score (0-100)
 * Based on: delivery %, blockers, activity, progress
 */
function calculateHealthScore(stats, podDelData, issueStats, projects) {
  const totalProjects = (stats.done || 0) + (stats.in_flight || 0) + (stats.not_started || 0);

  // Health score = Completion percentage (completed / total * 100)
  // Simple, honest, and immediately understandable
  if (totalProjects === 0) {
    return 0;
  }

  const completionPct = Math.round((stats.done / totalProjects) * 100);
  return completionPct;
}

/**
 * Get health status emoji and text based on completion %
 */
function getHealthStatus(score) {
  if (score >= 80) return { emoji: "🟢", text: "Excellent", color: "green" };
  if (score >= 50) return { emoji: "🟡", text: "Good Progress", color: "yellow" };
  if (score >= 25) return { emoji: "🟠", text: "In Progress", color: "orange" };
  if (score > 0) return { emoji: "🟠", text: "Getting Started", color: "orange" };
  return { emoji: "🔴", text: "Not Started", color: "red" };
}

/**
 * Generate structured deep dive discussions for a single project
 * OPTIMIZED: Linear + Slack fetch in parallel
 */
async function generateDeepDiveDiscussions(project) {
  const linearClient = getLinearClientForSlack();
  const slackClient = getSlackClient();
  const channelMapper = getChannelMapper();

  // PARALLEL: Fetch Linear and Slack at the same time
  const [linearData, slackData] = await Promise.all([
    // Linear fetch
    (async () => {
      let issues = [];
      let linearComments = [];
      if (linearClient && project.id) {
        try {
          const allIssues = await linearClient.getIssuesByProject(project.id);
          issues = allIssues
            .filter(i => i.state && i.state.type !== "completed" && i.state.type !== "canceled")
            .map(i => ({
              identifier: i.identifier,
              title: i.title,
              status: i.state ? i.state.name : "Unknown",
              assignee: i.assignee ? i.assignee.name : "Unassigned",
            }));

          // Fetch comments in parallel
          const cutoff = new Date();
          cutoff.setDate(cutoff.getDate() - 14);
          const commentResults = await Promise.all(
            allIssues.slice(0, 10).map(async (issue) => {
              try {
                const comments = await linearClient.getIssueComments(issue.id, 10);
                return comments
                  .filter(c => new Date(c.createdAt) >= cutoff)
                  .map(c => ({
                    issueId: issue.identifier,
                    author: c.user ? c.user.name : "Unknown",
                    body: c.body,
                    createdAt: c.createdAt,
                  }));
              } catch (e) { return []; }
            })
          );
          linearComments = commentResults.flat();
        } catch (e) {}
      }
      return { issues, linearComments };
    })(),

    // Slack fetch
    (async () => {
      let slackMessages = [];
      if (slackClient && channelMapper) {
        try {
          const projectsWithChannels = await channelMapper.getProjectsWithChannels();
          const channelEntry = projectsWithChannels.find(e => e.project.id === project.id);

          if (channelEntry) {
            // Join and fetch messages in parallel
            const [, messages] = await Promise.all([
              slackClient.joinChannel(channelEntry.channelId).catch(() => {}),
              slackClient.getMessagesWithThreads(channelEntry.channelId, {
                oldest: "0",
                includeThreads: true,
              })
            ]);

            const humanMessages = messages.filter(m => !m.bot_id && m.type === "message" && m.text);

            // Collect user IDs
            const allUserIds = new Set();
            for (const m of humanMessages) {
              if (m.user) allUserIds.add(m.user);
              const mentions = m.text.match(/<@([A-Z0-9]+)>/g) || [];
              for (const mention of mentions) {
                allUserIds.add(mention.replace(/<@|>/g, ""));
              }
              if (m.threadReplies) {
                for (const r of m.threadReplies) {
                  if (r.user) allUserIds.add(r.user);
                  const rMentions = (r.text || "").match(/<@([A-Z0-9]+)>/g) || [];
                  for (const mention of rMentions) {
                    allUserIds.add(mention.replace(/<@|>/g, ""));
                  }
                }
              }
            }

            // Resolve user names
            let userMap = {};
            if (allUserIds.size > 0) {
              try {
                userMap = await slackClient.resolveUserNames([...allUserIds]);
              } catch (e) {}
            }

            const cleanText = (text) => {
              if (!text) return text;
              return text.replace(/<@([A-Z0-9]+)>/g, (match, userId) => {
                const name = userMap[userId];
                if (name && !name.match(/^U[A-Z0-9]+$/)) return name;
                return "someone";
              });
            };

            // Helper to format Slack timestamp to readable date
            const formatSlackTs = (ts) => {
              if (!ts) return null;
              const date = new Date(parseFloat(ts) * 1000);
              return date.toLocaleDateString("en-IN", { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
            };

            for (const m of humanMessages) {
              let userName = userMap[m.user] || "Someone";
              if (userName.match(/^U[A-Z0-9]+$/)) userName = "Someone";
              slackMessages.push({ author: userName, text: cleanText(m.text), timestamp: formatSlackTs(m.ts) });

              if (m.threadReplies) {
                for (const r of m.threadReplies) {
                  if (!r.bot_id && r.text) {
                    let rName = userMap[r.user] || "Someone";
                    if (rName.match(/^U[A-Z0-9]+$/)) rName = "Someone";
                    slackMessages.push({ author: rName, text: cleanText(r.text), isReply: true, timestamp: formatSlackTs(r.ts) });
                  }
                }
              }
            }
          }
        } catch (e) {}
      }
      return slackMessages;
    })()
  ]);

  const { issues, linearComments } = linearData;
  const slackMessages = slackData;

  // Build context for LLM with timestamps
  let context = "";

  if (slackMessages.length > 0) {
    context += "## SLACK DISCUSSIONS (with timestamps)\n";
    for (const m of slackMessages.slice(0, 100)) {
      const prefix = m.isReply ? "  ↳ " : "- ";
      const timeStr = m.timestamp ? `[${m.timestamp}] ` : "";
      context += `${prefix}${timeStr}${m.author}: ${m.text.substring(0, 300)}\n`;
    }
  }

  if (linearComments.length > 0) {
    context += "\n## LINEAR COMMENTS (with timestamps)\n";
    for (const c of linearComments.slice(0, 30)) {
      const timeStr = c.createdAt ? `[${new Date(c.createdAt).toLocaleDateString("en-IN", { month: 'short', day: 'numeric' })}] ` : "";
      context += `- [${c.issueId}] ${timeStr}${c.author}: ${c.body.substring(0, 300)}\n`;
    }
  }

  if (!context) {
    return { issues, keyDiscussions: null };
  }

  // Use LLM to extract key discussion points
  try {
    const messages = [
      {
        role: "system",
        content: `You are an expert at extracting key discussion points from Slack and Linear conversations.

Your job is to identify the MOST IMPORTANT discussion topics and summarize each as a numbered insight.

## OUTPUT FORMAT
Return 5-10 numbered insights. Each insight should:
1. Start with a **bold topic** (2-4 words)
2. Follow with a brief explanation (1-2 sentences)
3. Include specific names, decisions, deadlines mentioned

## WHAT TO EXTRACT
- Delays or timeline changes
- Key decisions made
- Blockers or dependencies
- Design/API/Architecture discussions
- New requirements or scope changes
- Action items with owners
- QA/Testing concerns
- Deployment or launch discussions

## FORMAT EXAMPLE
1. **Delivery Delayed 1-2 weeks** - Deployment pipeline setup delayed the project. QA activities deadline was Jan 26.
2. **Domain Decision Pending** - Discussions on launching under TIAI brand vs Gradien. Options for telusinternational.ai subdomain.
3. **BE Ad-hoc Requests** - Profile API modifications needed, Job preview enhancements for job type and domain icon.

## RULES
- NO markdown except **bold** for topic headers
- Keep each insight to 1-2 sentences
- Focus on DISCUSSIONS, not ticket statuses
- Include WHO is doing WHAT when mentioned
- Skip generic/trivial messages
- NEVER include raw user IDs like U06H90RUXPT or U07B0CNGJR0 - use "someone" if name unknown
- NEVER include <@U123ABC> format - always use actual names or "someone"`
      },
      { role: "user", content: `Extract key discussion points from this project:\n\n${context}` },
    ];

    const summary = await fuelixChat({ messages });
    return {
      issues,
      keyDiscussions: summary.trim(),
      slackMessageCount: slackMessages.length,
      linearCommentCount: linearComments.length,
    };
  } catch (e) {
    return { issues, keyDiscussions: null };
  }
}

/**
 * Fetch and summarize comments from all active projects in a pod
 * Includes both Linear comments AND Slack messages for projects with channel IDs
 */
async function fetchPodCommentsSummary(podName, projects) {
  const activeProjects = projects.filter(p => p.normalizedState === "in_flight"); // No limit - fetch all active projects
  if (activeProjects.length === 0) return null;

  const allComments = [];
  const allSlackMessages = [];
  const allIssueData = []; // NEW: Store Linear issue metadata (assignees, status, descriptions)
  let hasSlackData = false;

  // Get channel mapper for Slack data
  const channelMapper = getChannelMapper();
  const slackClient = getSlackClient();
  let projectChannelMap = {};

  // Build mapping of project names to channel IDs if Slack is configured
  if (channelMapper && slackClient) {
    try {
      const projectsWithChannels = await channelMapper.getProjectsWithChannels();
      for (const entry of projectsWithChannels) {
        projectChannelMap[entry.project.name.toLowerCase()] = {
          channelId: entry.channelId,
          projectId: entry.project.id,
        };
      }
    } catch (e) {
      console.warn("Failed to load project-channel mapping:", e.message);
    }
  }

  // Fetch Linear comments and Slack messages in parallel for each project
  for (const project of activeProjects) {
    const projectNameLower = project.name.toLowerCase();

    // Fetch Linear comments
    try {
      const commentsResult = await getLiveComments(podName, project.name, 7);
      if (commentsResult.success && commentsResult.comments.length > 0) {
        allComments.push({
          project: project.name,
          comments: commentsResult.comments, // No limit - fetch all comments
        });
      }
    } catch (e) {
      // Skip failed fetches
    }

    // Fetch Linear issue metadata (assignees, status, descriptions) - SOURCE OF TRUTH
    const linearClient = getLinearClientForSlack();
    if (linearClient && project.id) {
      try {
        const issues = await linearClient.getIssuesByProject(project.id);
        if (issues && issues.length > 0) {
          // Get active issues with relevant metadata (exclude completed/canceled)
          const relevantIssues = issues
            .filter(i => i.state?.type !== "completed" && i.state?.type !== "canceled")
            .map(i => ({
              identifier: i.identifier,
              title: i.title,
              status: i.state?.name || "Unknown",
              statusType: i.state?.type || "unknown",
              assignee: i.assignee?.name || "Unassigned",
              description: i.description ? i.description.substring(0, 500) : null,
              labels: i.labels?.nodes?.map(l => l.name) || [],
            }));

          if (relevantIssues.length > 0) {
            allIssueData.push({
              project: project.name,
              issues: relevantIssues,
            });
          }
        }
      } catch (e) {
        // Skip failed fetches
      }
    }

    // Fetch Slack messages AND threads if project has a channel
    if (slackClient && projectChannelMap[projectNameLower]) {
      const { channelId } = projectChannelMap[projectNameLower];
      try {
        // Determine oldest date based on project
        // For "Data-Driven Cohorts": start from Dec 24, 2025
        // For all other projects: fetch from channel creation (no limit)
        let oldest;
        if (projectNameLower.includes("data-driven cohorts")) {
          // December 24, 2025 00:00:00 UTC
          oldest = String(new Date("2025-12-24T00:00:00Z").getTime() / 1000);
        } else {
          // Fetch all messages from the beginning (use a very old date)
          oldest = "0";
        }

        const messages = await slackClient.getMessagesWithThreads(channelId, {
          oldest,
          includeThreads: true
          // No maxMessages limit - fetch ALL messages and threads
        });

        if (messages && messages.length > 0) {
          hasSlackData = true;
          // Filter out bot messages and system messages
          const humanMessages = messages.filter(m =>
            !m.bot_id && m.type === "message" && m.text && m.text.length > 0
          );

          if (humanMessages.length > 0) {
            // Flatten messages and ALL their thread replies - FULL TEXT, no truncation
            const flattenedMessages = [];
            for (const m of humanMessages) {
              flattenedMessages.push({
                text: m.text,
                user: m.user || "Unknown",
                ts: m.ts,
                isThread: false,
              });
              // Include ALL thread replies with FULL TEXT
              if (m.threadReplies && m.threadReplies.length > 0) {
                for (const reply of m.threadReplies) {
                  if (!reply.bot_id && reply.text) {
                    flattenedMessages.push({
                      text: `↳ ${reply.text}`,
                      user: reply.user || "Unknown",
                      ts: reply.ts,
                      isThread: true,
                    });
                  }
                }
              }
            }

            allSlackMessages.push({
              project: project.name,
              messages: flattenedMessages,
            });
          }
        }
      } catch (e) {
        console.warn(`Failed to fetch Slack messages for ${project.name}:`, e.message);
      }
    }
  }

  if (allComments.length === 0 && allSlackMessages.length === 0 && allIssueData.length === 0) return null;

  // Helper function to clean Slack message text
  // Replaces <@USER_ID> mentions with resolved names or "someone"
  function cleanSlackText(text, userMap) {
    if (!text) return text;
    // Replace <@USER_ID> patterns
    return text.replace(/<@([A-Z0-9]+)>/g, (match, userId) => {
      const name = userMap[userId];
      if (name && name !== userId) {
        return name;
      }
      // If unresolved, use generic term instead of raw ID
      return "someone";
    });
  }

  // Resolve Slack user IDs to real names if we have Slack data
  let slackUserMap = {};
  if (allSlackMessages.length > 0 && slackClient) {
    try {
      // Collect all unique user IDs from Slack messages (both authors and @mentions)
      const allUserIds = new Set();
      for (const { messages } of allSlackMessages) {
        for (const m of messages) {
          // Add message author
          if (m.user && m.user !== "Unknown") {
            allUserIds.add(m.user);
          }
          // Extract @mentions from message text
          const mentions = m.text?.match(/<@([A-Z0-9]+)>/g) || [];
          for (const mention of mentions) {
            const userId = mention.replace(/<@|>/g, "");
            allUserIds.add(userId);
          }
        }
      }
      // Resolve user IDs to names (with rate limiting)
      if (allUserIds.size > 0) {
        slackUserMap = await slackClient.resolveUserNames([...allUserIds]);
      }
    } catch (e) {
      console.warn("Failed to resolve Slack user names:", e.message);
    }
  }

  // Build combined text for summarization
  let combinedText = "";
  const sources = [];

  // FIRST: Add the actual discussions (this is what we want to summarize)
  if (allComments.length > 0) {
    sources.push("Linear");
    combinedText += "\n## LINEAR COMMENTS (Main discussion content)\n";
    for (const { project, comments } of allComments) {
      const shortName = project.replace(/^Q1 2026\s*:\s*/i, "").replace(/^Q1 26\s*-\s*/i, "");
      combinedText += `\n### ${shortName}\n`;
      for (const c of comments) {
        combinedText += `- ${c.author}: ${c.body}\n`;
      }
    }
  }

  if (allSlackMessages.length > 0) {
    sources.push("Slack");
    combinedText += "\n## SLACK DISCUSSIONS (Main discussion content)\n";
    for (const { project, messages } of allSlackMessages) {
      const shortName = project.replace(/^Q1 2026\s*:\s*/i, "").replace(/^Q1 26\s*-\s*/i, "");
      combinedText += `\n### ${shortName} (Slack)\n`;
      for (const m of messages) {
        // Use resolved name if available, otherwise use generic term
        let userName = slackUserMap[m.user] || "Someone";
        // If still looks like a user ID (starts with U and is alphanumeric), use generic
        if (userName.match(/^U[A-Z0-9]+$/)) {
          userName = "Someone";
        }
        // Clean message text - replace <@USER_ID> mentions with resolved names
        const cleanedText = cleanSlackText(m.text, slackUserMap);
        combinedText += `- ${userName}: ${cleanedText}\n`;
      }
    }
  }

  // Add issue data as REFERENCE ONLY (for fact-checking, not main content)
  if (allIssueData.length > 0) {
    combinedText += "\n## REFERENCE: LINEAR ISSUE ASSIGNMENTS (Use only to verify facts, NOT as main content)\n";
    for (const { project, issues } of allIssueData) {
      const shortName = project.replace(/^Q1 2026\s*:\s*/i, "").replace(/^Q1 26\s*-\s*/i, "");
      // Only include key issues (QA, Design, PRD, Dev related) as quick reference
      const keyIssues = issues.filter(i => {
        const t = i.title.toLowerCase();
        return t.includes("qa") || t.includes("design") || t.includes("prd") ||
               t.includes("dev") || t.includes("spec") || t.includes("review") ||
               t.includes("implementation") || t.includes("pat");
      }); // No limit - include all key issues

      if (keyIssues.length > 0) {
        combinedText += `\n### ${shortName} - Key Assignments\n`;
        for (const issue of keyIssues) {
          combinedText += `- ${issue.title}: ${issue.status} (${issue.assignee})\n`;
        }
      }
    }
  }

  // Summarize with LLM
  try {
    const messages = [
      {
        role: "system",
        content: `You are a discussion summarizer for engineering leadership. Your job is to summarize WHAT PEOPLE ARE TALKING ABOUT in Slack and Linear comments.

## YOUR PRIMARY FOCUS: CONVERSATIONS & DISCUSSIONS
Summarize the actual discussions:
- What decisions are being made?
- What blockers or issues are people discussing?
- What progress updates are people sharing?
- What questions or concerns are raised?
- What dependencies are being coordinated?

## DO NOT just list ticket statuses!
BAD output: "FE Dev is In Progress with Sagnik, BE Dev is In Progress with Prachi, QA is Todo with Chinmaya"
This is useless - they can see ticket statuses in Linear already.

GOOD output: "Team discussing rubric parameter changes to avoid duplicate follow-ups; Harshada observing over more test rounds before closing; Vaibhav investigating the save button issue reported by Sunny."
This tells them what's actually happening in conversations.

## USE LINEAR ISSUE DATA ONLY TO VERIFY
- If Slack asks "who owns QA?" but Linear shows QA assigned to Chinmaya → Don't repeat the question, just know QA is covered
- Use issue data to fact-check discussions, NOT as the main content
- Only mention assignments if they're RELEVANT to the discussion

## Understanding Comments:
- "AuthorName: text" - name BEFORE colon is the speaker
- @mentions are people being referenced, not the speaker

## OUTPUT RULES:
1. One line per project: "ProjectName: discussion summary"
2. NO markdown (no **, ##, etc.)
3. 1-2 sentences focusing on WHAT PEOPLE ARE DISCUSSING
4. Include: decisions, blockers, progress updates, concerns, action items
5. Skip projects with no meaningful discussion
6. NEVER include raw IDs like U08CTADBLTX

## Example:
Input:
- Slack: "Harshith proposes making rubric parameters mutually exclusive; Atul tested passing prior questions but notes non-exclusive parameters still cause duplicate follow-ups"
- Linear Issue: QA assigned to Chinmaya (Todo)

Output: "AI Interviewer: Harshith proposes making rubric parameters mutually exclusive while tracking previously discussed topics to avoid repeated follow-ups; Atul tested passing prior questions but notes non-exclusive parameters still cause duplicate follow-ups."

NOT: "AI Interviewer: QA is Todo with Chinmaya, FE Dev is In Progress with Atul..." (WRONG - this is just ticket status)`
      },
      { role: "user", content: `Recent discussions from ${podName} pod:\n${combinedText}` },
    ];
    const summary = await fuelixChat({ messages });

    const totalComments = allComments.reduce((sum, p) => sum + p.comments.length, 0);
    const totalSlackMsgs = allSlackMessages.reduce((sum, p) => sum + p.messages.length, 0);
    const totalIssues = allIssueData.reduce((sum, p) => sum + p.issues.length, 0);

    return {
      commentCount: totalComments,
      slackMessageCount: totalSlackMsgs,
      issueCount: totalIssues,
      projectCount: Math.max(allComments.length, allSlackMessages.length, allIssueData.length),
      hasSlackData,
      hasIssueData: allIssueData.length > 0,
      sources: sources.join(" + "),
      summary: summary.trim().replace(/\*\*/g, "").replace(/^#+\s*/gm, ""),
    };
  } catch (e) {
    const totalComments = allComments.reduce((sum, p) => sum + p.comments.length, 0);
    const totalSlackMsgs = allSlackMessages.reduce((sum, p) => sum + p.messages.length, 0);
    const totalIssues = allIssueData.reduce((sum, p) => sum + p.issues.length, 0);

    return {
      commentCount: totalComments,
      slackMessageCount: totalSlackMsgs,
      issueCount: totalIssues,
      projectCount: Math.max(allComments.length, allSlackMessages.length, allIssueData.length),
      hasSlackData,
      hasIssueData: allIssueData.length > 0,
      sources: sources.join(" + "),
      summary: null,
    };
  }
}

/**
 * Generate LLM-powered insights for a pod
 */
async function generatePodInsights(pod, stats, podDelData, issueStats, cycleDels, projects) {
  const dataContext = {
    podName: pod,
    totalProjects: stats.done + stats.in_flight + stats.not_started,
    completed: stats.done,
    inFlight: stats.in_flight,
    notStarted: stats.not_started,
    delCommitted: podDelData?.committed || 0,
    delCompleted: podDelData?.completed || 0,
    deliveryPct: podDelData?.deliveryPct || "N/A",
    spillover: podDelData?.spillover || 0,
    blockers: issueStats.blockers,
    risks: issueStats.risks,
    pendingDels: cycleDels.filter(d => !d.isCompleted).length,
  };

  try {
    const messages = [
      {
        role: "system",
        content: `You are a KPI analyst. Provide 2-3 actionable insights based on pod metrics.

Rules:
- NO markdown (no **, ##, etc.)
- Start each insight with a number: 1. 2. 3.
- Keep each insight to one sentence
- Be specific with numbers from the data
- Focus on actions, not observations`
      },
      { role: "user", content: `Pod metrics for ${pod}:\n${JSON.stringify(dataContext, null, 2)}` },
    ];
    const insights = await fuelixChat({ messages });
    // Strip any markdown that might have been added
    return insights.trim().replace(/\*\*/g, "").replace(/^#+\s*/gm, "").replace(/^-\s+/gm, "");
  } catch (e) {
    return null;
  }
}

/**
 * Create a JSON table marker for frontend rendering
 */
function jsonTable(title, columns, rows) {
  const tableData = { title, columns, rows };
  return `{{TABLE:${JSON.stringify(tableData)}:TABLE}}`;
}

/**
 * Generate dynamic narrative for a pod
 * Returns structured data that frontend renders as HTML tables
 *
 * Section order:
 * 1. Overview
 * 2. Feature Readiness (all features and tech debts)
 * 3. In-Flight Features
 * 4. Not Started Features
 * 5. Pending DELs
 * 6. Completed (projects + DELs)
 * 7. Adhoc in Q1
 * 8. Recent Discussions
 * 9. Insights
 */
async function generateMobilePodNarrative(pod, projectCount, stats, projects, podDelData, currentCycle, cycleDels, issueStats, healthScore, healthStatus, fetchedAt) {
  let out = "";

  // Clean up project names
  const cleanName = (name) => name
    .replace(/^Q1 2026\s*:\s*/i, "")
    .replace(/^Q1 26\s*-\s*/i, "")
    .replace(/^\[Q1 2026 Project\]-?/i, "")
    .replace(/^\[Q1 Project 2026\]-?/i, "");

  // Clean project name - remove "Q1 2026 : " prefix
  const cleanProject = (name) => {
    if (!name) return "-";
    return name.replace(/^Q1 2026\s*:\s*/i, "").replace(/^Q1 26\s*-\s*/i, "");
  };

  // ============== 1. HEADER ==============
  out += `## ${healthStatus.emoji} ${pod} - ${healthStatus.text} (${healthScore}%)\n\n`;

  // ============== 2. OVERVIEW TABLE ==============
  const overviewRows = [
    { metric: "Total Projects", value: projectCount },
    { metric: "Done", value: stats.done },
    { metric: "In-Flight", value: stats.in_flight },
    { metric: "Not Started", value: stats.not_started },
  ];

  if (podDelData) {
    overviewRows.push({ metric: `DELs Committed (${currentCycle})`, value: podDelData.committed });
    overviewRows.push({ metric: "DELs Completed", value: podDelData.completed });
    overviewRows.push({ metric: "Delivery Rate", value: podDelData.deliveryPct });
  }

  if (issueStats.blockers > 0) overviewRows.push({ metric: "⚠️ Blockers", value: issueStats.blockers });
  if (issueStats.risks > 0) overviewRows.push({ metric: "⚠️ Risks", value: issueStats.risks });

  out += jsonTable("📊 Overview", [
    { key: "metric", header: "Metric" },
    { key: "value", header: "Value" }
  ], overviewRows);
  out += "\n\n";

  // ============== 3. FEATURE READINESS (PRD, Design, Dev) ==============
  // Moved up right after Overview per user request - shows ALL features for stakeholder visibility
  try {
    const readiness = await fetchPodFeatureReadiness(projects);
    if (readiness && readiness.features.length > 0) {
      // Status emoji mapper
      const statusEmoji = (s) => {
        if (s === "done") return "✅";
        if (s === "in_progress") return "🔄";
        if (s === "not_started") return "⏳";
        if (s === "nr") return "N/R";
        return "—";
      };

      // Show ALL features (increased from 15 to 50 for complete stakeholder overview)
      const rows = readiness.features.slice(0, 50).map(f => ({
        project: f.project, // Include project name for context
        feature: f.feature, // Full name includes (Tech Debt) label
        prd: statusEmoji(f.prd),
        design: statusEmoji(f.design),
        be: statusEmoji(f.beDev),
        fe: statusEmoji(f.feDev),
        pat: statusEmoji(f.pat),
        qa: statusEmoji(f.qa)
      }));

      out += jsonTable("📋 Feature Readiness", [
        { key: "project", header: "Project" },
        { key: "feature", header: "Feature" },
        { key: "prd", header: "PRD" },
        { key: "design", header: "Design" },
        { key: "be", header: "BE" },
        { key: "fe", header: "FE" },
        { key: "pat", header: "PAT" },
        { key: "qa", header: "QA" }
      ], rows);
      out += "\n**Legend:** ✅ Done | 🔄 In Progress | ⏳ Not Started | N/R Not Required | — N/A\n\n";
    }
  } catch (e) {
    console.error("Feature readiness fetch error:", e.message);
  }

  // ============== 4. IN-FLIGHT FEATURES ==============
  if (projectCount > 0) {
    const inFlight = projects.filter(p => p.normalizedState === "in_flight");
    const done = projects.filter(p => p.normalizedState === "done");
    const notStarted = projects.filter(p => p.normalizedState === "not_started");

    if (inFlight.length > 0) {
      const rows = inFlight.map(p => ({
        project: cleanName(p.name),
        lead: p.lead || "-",
        status: "In Progress"
      }));
      out += jsonTable(`🔄 In-Flight Features (${inFlight.length})`, [
        { key: "project", header: "Project" },
        { key: "lead", header: "Lead" },
        { key: "status", header: "Status" }
      ], rows);
      out += "\n\n";
    }

    // ============== 5. NOT STARTED FEATURES ==============
    if (notStarted.length > 0) {
      const rows = notStarted.map(p => ({
        project: cleanName(p.name),
        lead: p.lead || "-"
      }));
      out += jsonTable(`⏳ Not Started (${notStarted.length})`, [
        { key: "project", header: "Project" },
        { key: "lead", header: "Lead" }
      ], rows);
      out += "\n\n";
    }

    // ============== 6. PENDING DELs ==============
    if (cycleDels.length > 0) {
      const pendingDels = cycleDels.filter(d => !d.isCompleted);
      const completedDels = cycleDels.filter(d => d.isCompleted);

      if (pendingDels.length > 0) {
        const rows = pendingDels.map(d => ({
          id: d.identifier,
          title: d.title.length > 30 ? d.title.substring(0, 30) + "..." : d.title,
          project: cleanProject(d.project),
          assignee: d.assignee || "Unassigned",
          state: d.state
        }));
        out += jsonTable(`⚠️ Pending DELs (${pendingDels.length})`, [
          { key: "id", header: "ID" },
          { key: "title", header: "Title" },
          { key: "project", header: "Project" },
          { key: "assignee", header: "Assignee" },
          { key: "state", header: "State" }
        ], rows);
        out += "\n\n";
      }

      // ============== 7. COMPLETED (Projects + DELs) ==============
      if (done.length > 0) {
        const rows = done.map(p => ({
          project: cleanName(p.name),
          status: "Done"
        }));
        out += jsonTable(`✅ Completed Projects (${done.length})`, [
          { key: "project", header: "Project" },
          { key: "status", header: "Status" }
        ], rows);
        out += "\n\n";
      }

      if (completedDels.length > 0) {
        const rows = completedDels.map(d => ({
          id: d.identifier,
          title: d.title.length > 35 ? d.title.substring(0, 35) + "..." : d.title,
          project: cleanProject(d.project),
          status: "Done"
        }));
        out += jsonTable(`✅ Completed DELs (${completedDels.length})`, [
          { key: "id", header: "ID" },
          { key: "title", header: "Title" },
          { key: "project", header: "Project" },
          { key: "status", header: "Status" }
        ], rows);
        out += "\n\n";
      }
    } else {
      // No DELs - just show completed projects if any
      if (done.length > 0) {
        const rows = done.map(p => ({
          project: cleanName(p.name),
          status: "Done"
        }));
        out += jsonTable(`✅ Completed Projects (${done.length})`, [
          { key: "project", header: "Project" },
          { key: "status", header: "Status" }
        ], rows);
        out += "\n\n";
      }
    }
  }

  // ============== 8, 9, 10: PARALLEL FETCH (Adhoc, Comments, Insights) ==============
  // These are independent - run them in parallel for 2-3x speedup
  const [adhocResult, commentsSummary, insights] = await Promise.all([
    getAdhocIssues(pod).catch(() => ({ success: false, total: 0 })),
    fetchPodCommentsSummary(pod, projects).catch(() => null),
    generatePodInsights(pod, stats, podDelData, issueStats, cycleDels, projects).catch(() => null)
  ]);

  // 8. ADHOC IN Q1
  if (adhocResult?.success && adhocResult.total > 0) {
    const adhocRows = adhocResult.issues.slice(0, 15).map(issue => ({
      id: issue.identifier,
      title: issue.title.length > 30 ? issue.title.substring(0, 27) + "..." : issue.title,
      cycle: issue.cycle,
      assignee: issue.assignee,
      status: issue.status,
      dueDate: issue.dueDate ? new Date(issue.dueDate).toLocaleDateString("en-IN", { day: "2-digit", month: "short" }) : "—"
    }));
    out += jsonTable(`📋 Adhoc in Q1 (${adhocResult.total})`, [
      { key: "id", header: "ID" },
      { key: "title", header: "Title" },
      { key: "cycle", header: "Cycle" },
      { key: "assignee", header: "Assignee" },
      { key: "status", header: "Status" },
      { key: "dueDate", header: "Due" }
    ], adhocRows);
    out += "\n\n";
  }

  // 9. RECENT DISCUSSIONS
  if (commentsSummary && commentsSummary.summary) {
    out += `### 💬 Recent Discussions\n${commentsSummary.summary}\n\n`;
  }

  // 10. INSIGHTS
  if (insights) {
    out += `### 💡 Insights\n${insights}\n\n`;
  }

  // ============== FOOTER ==============
  const hasSlack = commentsSummary && commentsSummary.hasSlackData;
  const sourceStr = hasSlack ? "Linear + Slack" : "Linear";
  out += `---\nSource: ${sourceStr} | ${formatToIST(fetchedAt)}`;

  return out;
}

/**
 * Generate comprehensive narrative summary for a single pod
 * Returns structured data for frontend HTML rendering
 */
async function generatePodNarrative(podName, isMobile = false) {
  // Get live pod data
  const projectsResult = await getLiveProjects(podName);

  if (!projectsResult.success) {
    let msg = `Could not fetch data for "${podName}": ${projectsResult.error}\n${projectsResult.message}`;
    if (projectsResult.suggestion) {
      msg += `\n\nDid you mean: ${projectsResult.suggestion}?`;
    }
    if (projectsResult.availablePods) {
      msg += `\nAvailable pods: ${projectsResult.availablePods.join(", ")}`;
    }
    return msg;
  }

  const { pod, projectCount, stats, projects } = projectsResult;

  // Get team issues for blockers
  const summaryResult = await getLivePodSummary(podName);
  const issueStats = summaryResult.success ? summaryResult.issueStats : { total: 0, active: 0, blockers: 0, risks: 0 };

  // Get DEL metrics for this pod
  const delResult = await computeCombinedKpi();
  let podDelData = null;
  let currentCycle = "C1";
  if (delResult.success) {
    currentCycle = delResult.fallbackCycle || delResult.currentCycle || "C1";
    const cycleRows = delResult.cycleKpi?.filter(r => r.pod === pod && r.cycle === currentCycle) || [];
    if (cycleRows.length > 0) {
      podDelData = cycleRows[0];
    }
  }

  // Fetch DELs for current cycle
  const cycleDelsResult = await fetchDELsByCycle(currentCycle, pod);
  const cycleDels = cycleDelsResult.success ? cycleDelsResult.dels : [];

  // Calculate health score
  const healthScore = calculateHealthScore(stats, podDelData, issueStats, projects);
  const healthStatus = getHealthStatus(healthScore);

  // Use the same dynamic table format for both mobile and desktop
  return await generateMobilePodNarrative(pod, projectCount, stats, projects, podDelData, currentCycle, cycleDels, issueStats, healthScore, healthStatus, projectsResult.fetchedAt);
}

// ============== HELPER: PARALLEL PROJECT FETCH ==============

/**
 * Fetch projects from all pods in parallel with retry
 * Returns array of { podName, projects } for successful fetches
 */
async function fetchAllPodsProjectsParallel() {
  const podsResult = listPods();

  // STEP 1: Parallel fetch all pods
  const fetchResults = await Promise.all(
    podsResult.pods.map(async (pod) => {
      try {
        const result = await getLiveProjects(pod.name);
        return { podName: pod.name, result };
      } catch (e) {
        return { podName: pod.name, result: { success: false, error: e.message } };
      }
    })
  );

  // Separate successes and failures
  const allPodProjects = [];
  let failedPods = [];

  for (const { podName, result } of fetchResults) {
    if (result.success) {
      allPodProjects.push({ podName, projects: result.projects });
    } else {
      failedPods.push(podName);
    }
  }

  // STEP 2: Retry failed pods once
  if (failedPods.length > 0) {
    console.log(`[INFO] Retrying ${failedPods.length} failed pods: ${failedPods.join(", ")}`);
    const retryResults = await Promise.all(
      failedPods.map(async (podName) => {
        try {
          await new Promise(resolve => setTimeout(resolve, 500));
          const result = await getLiveProjects(podName);
          return { podName, result };
        } catch (e) {
          return { podName, result: { success: false, error: e.message } };
        }
      })
    );

    for (const { podName, result } of retryResults) {
      if (result.success) {
        allPodProjects.push({ podName, projects: result.projects });
        failedPods = failedPods.filter(p => p !== podName);
      } else {
        console.log(`[WARN] Failed to fetch projects for ${podName} after retry`);
      }
    }
  }

  return { allPodProjects, failedPods };
}

/**
 * Find best matching project across all pods
 */
function findBestProjectMatchAcrossPods(allPodProjects, projectQuery) {
  let bestMatch = null;
  for (const { podName, projects } of allPodProjects) {
    for (const p of projects) {
      const result = scoreProjectMatch(p, projectQuery);
      if (result && (!bestMatch || result.score > bestMatch.score)) {
        bestMatch = { podName, project: result.project, score: result.score };
      }
    }
  }
  return bestMatch;
}

// ============== MAIN ANSWER FUNCTION ==============

/**
 * Answer a question using live data or snapshot
 * @param {string} question - User question
 * @param {object} snapshot - Snapshot data (optional, for fallback)
 * @param {object} options - Options { mobile: boolean }
 */
async function answer(question, snapshot, options = {}) {
  const cmd = parseCommand(question);
  const isMobile = options.mobile || false;

  // Handle explicit commands first
  switch (cmd.type) {
    case "list_pods": {
      const result = listPods();
      return formatPodsList(result);
    }

    case "cache_stats": {
      const stats = cacheStats();
      return `Cache: ${stats.entries} entries, ${stats.totalSizeKb} KB`;
    }

    case "clear_cache": {
      clearCache();
      return "Cache cleared.";
    }

    case "debug_mode": {
      return formatDebugInfo();
    }

    case "all_pods_summary": {
      // Generate the two clean KPI tables + summary paragraph
      return await generateAllPodsSummary();
    }

    case "pending_dels": {
      // Fetch and display pending (committed but not completed) DELs
      const result = await fetchPendingDELs(cmd.podName);
      return formatPendingDELs(result, isMobile);
    }

    case "dels_by_cycle": {
      // Fetch and display DELs committed to a specific cycle
      const result = await fetchDELsByCycle(cmd.cycle, cmd.podName);
      return formatDELsByCycle(result, isMobile);
    }

    case "pod_narrative": {
      // Generate narrative summary for a single pod
      return await generatePodNarrative(cmd.podName, isMobile);
    }

    case "del_kpi": {
      // Show ONLY the DEL KPI table (Committed vs Completed vs Delivery %)
      const result = await computeWeeklyKpi();
      if (!result.success) {
        return `Error: ${result.error}\n${result.message}`;
      }

      const cycle = result.fallbackCycle || result.currentCycle;
      const cycleRows = result.cycleKpi.filter(r => r.cycle === cycle);

      let output = `## DEL KPI (Cycle ${cycle})\n\n`;
      output += `DEL = Delivery Excellence Level - tracks committed vs completed deliverables\n\n`;
      output += formatDelKpiBox(cycleRows, cycle, {
        title: `DEL Metrics (Cycle=${cycle})`
      });

      // Add fallback note if applicable
      if (result.fallbackCycle) {
        output += `\n[Note: ${result.currentCycle} has 0 committed. Showing ${result.fallbackCycle} which has data.]\n`;
      }

      output += `\nSnapshot: ${result.fetchedAt}`;
      return output;
    }

    case "weekly_kpi": {
      // Compute both KPI tables (DEL + Feature Movement) like runWeeklyKpi.js
      const result = await computeWeeklyKpi();
      let output = formatWeeklyKpiOutput(result);

      // Add insights
      if (result.success) {
        const insights = generateInsights(result);
        if (insights) {
          output += insights;
        }
      }

      return output;
    }

    case "combined_kpi": {
      // Compute combined KPI with both DEL and Feature Movement + project summaries
      const result = await computeCombinedKpi();
      let output = formatCombinedKpiOutput(result, result.projectsByPod);

      // Add insights
      if (result.success) {
        const insights = generateInsights(result);
        if (insights) {
          output += insights;
        }
      }

      return output;
    }

    case "pod_summary": {
      const result = await getLivePodSummary(cmd.podName);
      return formatPodSummary(result);
    }

    case "pod_projects": {
      const result = await getLiveProjects(cmd.podName);
      return await formatProjectList(result);
    }

    case "pod_live": {
      const result = await getLivePodSummary(cmd.podName);
      return formatPodSummary(result);
    }

    case "project_detail": {
      // Redirect to project_deep_dive for the beautiful format with Key Discussions
      // This ensures all project queries get the same rich output
      return answer(`deep dive ${cmd.projectName}`, snapshot, options);
    }

    case "project_blockers": {
      // Search ALL pods in parallel and find the BEST matching project
      const { allPodProjects } = await fetchAllPodsProjectsParallel();
      const bestMatch = findBestProjectMatchAcrossPods(allPodProjects, cmd.projectName);

      if (bestMatch) {
        const result = await getLiveBlockers(bestMatch.podName, bestMatch.project.name);
        if (result.success) {
          return formatBlockers(result);
        }
      }
      return `Project "${cmd.projectName}" not found in any pod.`;
    }

    case "project_comments": {
      // Search ALL pods in parallel and find the BEST matching project
      const { allPodProjects } = await fetchAllPodsProjectsParallel();
      const bestMatch = findBestProjectMatchAcrossPods(allPodProjects, cmd.projectName);

      if (bestMatch) {
        const result = await getLiveComments(bestMatch.podName, bestMatch.project.name, 7);
        if (result.success) {
          if (result.commentCount === 0) {
            return `No comments found in the last 7 days for project "${result.project}".`;
          }

          // Summarize with LLM
          try {
            const messages = [
              { role: "system", content: commentSummaryPrompt() },
              { role: "user", content: `Project: ${result.project}\nPod: ${result.pod}\n\nRecent comments:\n${result.mergedText}` },
            ];
            const summary = await fuelixChat({ messages });

            let output = `## Comments Summary: ${result.project}\n\n`;
            output += `**Pod:** ${bestMatch.podName}\n`;
            output += `**Period:** Last 7 days\n`;
            output += `**Total comments:** ${result.commentCount}\n\n`;
            output += `### Summary\n${summary}\n\n`;
            output += `*Source: LIVE from Linear (${result.fetchedAt})*`;
            return output;
          } catch (e) {
            // LLM failed, return raw comments
            let output = `## Recent Comments: ${result.project}\n\n`;
            for (const c of result.comments.slice(0, 10)) {
              output += `**[${c.issueIdentifier}]** ${c.author} (${new Date(c.createdAt).toLocaleDateString()}):\n${c.body.substring(0, 200)}${c.body.length > 200 ? "..." : ""}\n\n`;
            }
            return output;
          }
        }
      }
      return `Project "${cmd.projectName}" not found in any pod.`;
    }

    case "project_deep_dive": {
      // Deep dive: project details + issues + comments
      const podsResult = listPods();
      let projectResult = null;
      let commentsResult = null;
      let matchedPod = null;

      // STEP 1: Parallel fetch all pods (faster than sequential)
      const fetchResults = await Promise.all(
        podsResult.pods.map(async (pod) => {
          try {
            const result = await getLiveProjects(pod.name);
            return { podName: pod.name, result };
          } catch (e) {
            return { podName: pod.name, result: { success: false, error: e.message } };
          }
        })
      );

      // Separate successes and failures
      const allPodProjects = [];
      let failedPods = [];

      for (const { podName, result } of fetchResults) {
        if (result.success) {
          allPodProjects.push({ podName, projects: result.projects });
        } else {
          failedPods.push(podName);
        }
      }

      // STEP 2: Retry failed pods once (handles temporary glitches)
      if (failedPods.length > 0) {
        console.log(`[INFO] Retrying ${failedPods.length} failed pods: ${failedPods.join(", ")}`);
        const retryResults = await Promise.all(
          failedPods.map(async (podName) => {
            try {
              // Small delay before retry
              await new Promise(resolve => setTimeout(resolve, 500));
              const result = await getLiveProjects(podName);
              return { podName, result };
            } catch (e) {
              return { podName, result: { success: false, error: e.message } };
            }
          })
        );

        const stillFailed = [];
        for (const { podName, result } of retryResults) {
          if (result.success) {
            allPodProjects.push({ podName, projects: result.projects });
          } else {
            stillFailed.push(podName);
            console.log(`[WARN] Failed to fetch projects for ${podName} after retry`);
          }
        }
        failedPods = stillFailed;
      }

      // Score all projects and find best match
      let bestMatch = null;
      for (const { podName, projects } of allPodProjects) {
        for (const p of projects) {
          const result = scoreProjectMatch(p, cmd.projectName);
          if (result && (!bestMatch || result.score > bestMatch.score)) {
            bestMatch = { podName, project: result.project, score: result.score };
          }
        }
      }

      // Now get full details for the best match
      if (bestMatch) {
        projectResult = await getLiveProject(bestMatch.podName, bestMatch.project.name);
        if (projectResult.success) {
          matchedPod = bestMatch.podName;
          commentsResult = await getLiveComments(bestMatch.podName, bestMatch.project.name, 14);
        }
      }

      if (!projectResult || !projectResult.success) {
        return `Project "${cmd.projectName}" not found in any pod.\n\nTry: "pods" to see available pods, then "pod <name> projects" to list projects.`;
      }

      const cleanProjectName = (name) => name
        .replace(/^Q1 2026\s*:\s*/i, "")
        .replace(/^Q1 26\s*-\s*/i, "");

      // Build comprehensive output
      const proj = projectResult.project;
      const stateEmoji = proj.normalizedState === "done" ? "✅" : proj.normalizedState === "in_flight" ? "🔄" : "⏳";
      let output = `## ${stateEmoji} ${cleanProjectName(proj.name)}\n\n`;

      // Overview table
      const overviewRows = [
        { metric: "Pod", value: matchedPod },
        { metric: "State", value: proj.normalizedState === "in_flight" ? "In Progress" : proj.normalizedState === "done" ? "Done" : "Not Started" },
        { metric: "Lead", value: proj.lead || "Not assigned" },
        { metric: "Total Issues", value: projectResult.issueStats.total },
        { metric: "Active", value: projectResult.issueStats.active },
        { metric: "Completed", value: projectResult.issueStats.done },
      ];
      if (projectResult.issueStats.blockers > 0) overviewRows.push({ metric: "⚠️ Blockers", value: projectResult.issueStats.blockers });
      if (proj.targetDate) overviewRows.push({ metric: "Target Date", value: proj.targetDate });

      output += jsonTable("📊 Overview", [
        { key: "metric", header: "Metric" },
        { key: "value", header: "Value" }
      ], overviewRows);
      output += "\n\n";

      // Feature readiness (PRD, Design, Dev phases)
      try {
        const linear = getLinearClientForSlack();
        if (linear && proj.id) {
          const readiness = await linear.getFeatureReadiness(proj.id);
          if (readiness && readiness.features.length > 0) {
            // Check if this is a tech debt project
            const isTechDebt = (name) => {
              const lower = name.toLowerCase();
              return lower.includes("tech debt") || lower.includes("refactor") ||
                     lower.includes("optimization") || lower.includes("sonar") ||
                     lower.includes("eslint") || lower.includes("flaky test") ||
                     lower.includes("build pipeline") || lower.includes("circle ci");
            };
            const techDebt = isTechDebt(proj.name);

            const statusEmoji = (s) => {
              if (s === "done") return "✅";
              if (s === "in_progress") return "🔄";
              if (s === "not_started") return "⏳";
              if (s === "nr") return "N/R";
              return "—";
            };

            const rows = readiness.features.map(f => ({
              feature: f.title, // Full name
              prd: techDebt ? "N/R" : statusEmoji(f.phases.PRD?.status || "na"),
              design: techDebt ? "N/R" : statusEmoji(f.phases.Design?.status || "na"),
              be: statusEmoji(f.phases["BE Dev"]?.status || "na"),
              fe: statusEmoji(f.phases["FE Dev"]?.status || "na"),
              pat: statusEmoji(f.phases.PAT?.status || "na"),
              qa: statusEmoji(f.phases.QA?.status || "na")
            }));

            const tableTitle = techDebt ? "📋 Feature Phases (Tech Debt)" : "📋 Feature Phases";
            output += jsonTable(tableTitle, [
              { key: "feature", header: "Feature" },
              { key: "prd", header: "PRD" },
              { key: "design", header: "Design" },
              { key: "be", header: "BE" },
              { key: "fe", header: "FE" },
              { key: "pat", header: "PAT" },
              { key: "qa", header: "QA" }
            ], rows);
            output += "**Legend:** ✅ Done | 🔄 In Progress | ⏳ Not Started | N/R Not Required | — N/A\n\n";
          }
        }
      } catch (e) {
        // Skip feature readiness if fetch fails
      }

      // Active issues table
      if (projectResult.activeIssues?.length > 0) {
        const rows = projectResult.activeIssues.slice(0, 10).map(issue => ({
          id: issue.identifier,
          title: issue.title.length > 35 ? issue.title.substring(0, 35) + "..." : issue.title,
          assignee: issue.assignee || "Unassigned",
          state: issue.state || "Unknown",
          blocker: issue.isBlocker ? "⚠️" : ""
        }));

        output += jsonTable(`🔄 Active Issues (${projectResult.activeIssues.length})`, [
          { key: "id", header: "ID" },
          { key: "title", header: "Title" },
          { key: "assignee", header: "Assignee" },
          { key: "state", header: "State" },
          { key: "blocker", header: "" }
        ], rows);
        output += "\n\n";
      }

      // Blockers table
      if (projectResult.blockerIssues?.length > 0) {
        const rows = projectResult.blockerIssues.map(issue => ({
          id: issue.identifier,
          title: issue.title.length > 40 ? issue.title.substring(0, 40) + "..." : issue.title,
          assignee: issue.assignee || "Unassigned"
        }));

        output += jsonTable(`⚠️ Blockers (${projectResult.blockerIssues.length})`, [
          { key: "id", header: "ID" },
          { key: "title", header: "Title" },
          { key: "assignee", header: "Assignee" }
        ], rows);
        output += "\n\n";
      }

      // Generate structured deep dive discussions (Key Discussions from Slack + Linear)
      const deepDive = await generateDeepDiveDiscussions(proj);

      // Show Linear Issues table if we have issue data
      if (deepDive.issues && deepDive.issues.length > 0) {
        const issueRows = deepDive.issues.slice(0, 15).map(i => ({
          issue: `${i.identifier} - ${i.title.length > 45 ? i.title.substring(0, 45) + "..." : i.title}`,
          status: i.status,
          assignee: i.assignee,
        }));

        output += jsonTable("📋 Linear Issues", [
          { key: "issue", header: "Issue" },
          { key: "status", header: "Status" },
          { key: "assignee", header: "Assignee" },
        ], issueRows);
        output += "\n\n";
      }

      // Show Key Discussions (numbered insights)
      if (deepDive.keyDiscussions) {
        output += `### 💬 Key Discussions\n\n${deepDive.keyDiscussions}\n\n`;
      } else if (commentsResult?.success && commentsResult.commentCount > 0) {
        // Fallback to basic comments if no discussions generated
        output += `### 💬 Recent Activity (${commentsResult.commentCount} comments)\n`;
        for (const c of commentsResult.comments.slice(0, 5)) {
          output += `- **[${c.issueIdentifier}]** ${c.author}: ${c.body.substring(0, 150)}${c.body.length > 150 ? "..." : ""}\n`;
        }
        output += "\n";
      }

      const hasSlack = deepDive.slackMessageCount > 0;
      const sourceStr = hasSlack ? `Linear + Slack (${deepDive.slackMessageCount} messages)` : "Linear";
      output += `---\nSource: ${sourceStr} | ${formatToIST(projectResult.fetchedAt)}`;
      return output;
    }
  }

  // Fall back to snapshot-based deterministic answer
  if (snapshot) {
    const deterministic = deterministicAnswer(question, snapshot);
    if (deterministic) return deterministic;
  }

  // LLM-based query interpretation for unknown commands
  // This handles typos, natural language variations, etc.
  if (cmd.type === "unknown") {
    const history = options.history || [];

    // IMPORTANT: Detect short follow-up answers (1-3 words) when there's conversation history
    // Examples: "staging", "yes", "prelive", "the first one", "AI interviewer"
    // These should be handled conversationally, not re-interpreted as new queries
    const wordCount = question.trim().split(/\s+/).length;
    const isLikelyFollowUp = history.length > 0 && wordCount <= 4;

    if (isLikelyFollowUp) {
      // This is probably an answer to a previous question - handle conversationally
      const podsResult = listPods();
      const availablePods = podsResult.pods.map(p => p.name);
      return await handleConversationalQuery(question, availablePods, snapshot, options);
    }

    try {
      // Get available pods and projects for context
      const podsResult = listPods();
      const availablePods = podsResult.pods.map(p => p.name);

      // Get sample projects from all pods
      const availableProjects = [];
      for (const pod of podsResult.pods.slice(0, 3)) {
        try {
          const result = await getLiveProjects(pod.name);
          if (result.success) {
            availableProjects.push(...result.projects.map(p => p.name));
          }
        } catch (e) {}
      }

      // Interpret query with LLM
      const interpretation = await interpretQueryWithLLM(question, availablePods, availableProjects);

      if (interpretation.success && interpretation.intent !== "unknown") {
        // Re-route based on LLM interpretation
        if (interpretation.intent === "pod_info" && interpretation.entity) {
          // Find matching pod
          const podName = interpretation.entity.toLowerCase();
          const matchedPod = availablePods.find(p =>
            p.toLowerCase() === podName ||
            p.toLowerCase().includes(podName) ||
            podName.includes(p.toLowerCase())
          );

          if (matchedPod) {
            // Recursively call answer with corrected query
            return answer(`pod ${matchedPod}`, snapshot, options);
          }
        }

        if (interpretation.intent === "project_info" && interpretation.entity) {
          // Route to project deep dive
          return answer(`project ${interpretation.entity}`, snapshot, options);
        }

        // Handle specific questions about a project (blockers, risks, etc.)
        if (interpretation.intent === "project_question" && interpretation.entity) {
          return await handleProjectQuestion(
            question,
            interpretation.entity,
            interpretation.questionFocus || interpretation.question_focus,
            snapshot,
            options
          );
        }

        if (interpretation.intent === "all_pods") {
          return answer("pods", snapshot, options);
        }

        // Handle conversational/open-ended queries with LLM
        if (interpretation.intent === "conversation") {
          return await handleConversationalQuery(question, availablePods, snapshot, options);
        }
      }
    } catch (e) {
      // LLM interpretation failed, continue to fallback
    }
  }

  // LLM fallback - use conversational handler for any unmatched query
  return await handleConversationalQuery(question, [], snapshot, options);
}

module.exports = { answer, parseCommand };
