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
 */
async function fetchPodFeatureReadiness(projects) {
  const linear = getLinearClientForSlack();
  if (!linear) return null;

  const readiness = {
    summary: { prd: { done: 0, in_progress: 0, not_started: 0 }, design: { done: 0, in_progress: 0, not_started: 0 } },
    features: []
  };

  // Fetch readiness for each project (in parallel with limit)
  const projectsToCheck = projects.filter(p => p.normalizedState !== "done").slice(0, 20); // Limit for performance

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

  for (const { project, readiness: projReadiness } of results) {
    if (!projReadiness || projReadiness.features.length === 0) continue;

    const techDebt = isTechDebt(project.name);
    const cleanName = project.name.replace(/^Q1 2026\s*:\s*/i, "").replace(/^Q1 26\s*-\s*/i, "");

    for (const feature of projReadiness.features) {
      // Check if this specific feature is a tech debt (by feature title)
      const featureTechDebt = techDebt || isTechDebt(feature.title);
      const featureData = {
        project: cleanName + (techDebt ? " (Tech Debt)" : ""),
        feature: feature.title + (featureTechDebt ? " (Tech Debt)" : ""),
        prd: featureTechDebt ? "nr" : (feature.phases.PRD?.status || "na"),
        design: featureTechDebt ? "nr" : (feature.phases.Design?.status || "na"),
        beDev: feature.phases["BE Dev"]?.status || "na",
        feDev: feature.phases["FE Dev"]?.status || "na",
        pat: feature.phases.PAT?.status || "na",
        qa: feature.phases.QA?.status || "na"
      };

      readiness.features.push(featureData);

      // Update summary counts
      if (featureData.prd === "done") readiness.summary.prd.done++;
      else if (featureData.prd === "in_progress") readiness.summary.prd.in_progress++;
      else if (featureData.prd !== "na") readiness.summary.prd.not_started++;

      if (featureData.design === "done") readiness.summary.design.done++;
      else if (featureData.design === "in_progress") readiness.summary.design.in_progress++;
      else if (featureData.design !== "na") readiness.summary.design.not_started++;
    }
  }

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

function formatProjectList(result) {
  if (!result.success) {
    let msg = `Error: ${result.error}\n${result.message}`;
    if (result.suggestion) msg += `\n\nDid you mean: ${result.suggestion}?`;
    return msg;
  }

  const { pod, projectCount, stats, projects, fetchedAt } = result;

  let output = `## ${pod} - Projects\n\n`;

  // Stats summary
  output += `Status breakdown: Done=${stats.done}, In-Flight=${stats.in_flight}, Not Started=${stats.not_started}\n\n`;

  // Beautified project list
  output += formatProjectsBox(projects, pod, {
    title: `${pod} Projects (${projectCount} total)`
  });

  output += `\n*Source: LIVE from Linear (${formatToIST(fetchedAt)})*`;
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
const POD_NAMES = ["fts", "gts", "platform", "control center", "talent studio", "growth & reuse", "growth and reuse", "gr"];

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
    /what(?:'s|s| is) (?:going on|happening) (?:in|with|on) (.+?)(?:\?|$)/i,
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
    /what(?:'s|s| is) (?:going on|happening) (?:in|with|on) (fts|gts|platform|control center|talent studio|growth.{1,5}reuse|gr)\??$/i,
    /(?:status|update|summary) (?:of|on|for) (fts|gts|platform|control center|talent studio|growth.{1,5}reuse|gr)\??$/i,
    /(?:tell me about|show me) (fts|gts|platform|control center|talent studio|growth.{1,5}reuse|gr)\??$/i,
    /how(?:'s| is) (fts|gts|platform|control center|talent studio|growth.{1,5}reuse|gr) (?:doing)?\??$/i,
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
 * Generate narrative summary for all pods (the two KPI tables + paragraph)
 * This matches the weekly KPI runner output format with beautified box tables
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

  // ============== TABLE A: Feature Movement (Beautified Box) ==============
  if (fmRows.length > 0) {
    out += formatFeatureMovementBox(fmRows, {
      title: "A) Feature Movement (Weekly Snapshot)"
    });
  } else if (result.featureError) {
    out += `A) Feature Movement: ${result.featureError}\n`;
  } else {
    out += "A) Feature Movement: No data available\n";
  }

  out += "\n";

  // ============== TABLE B: DEL KPI (Beautified Box) ==============
  if (cycleRows.length > 0) {
    out += formatDelKpiBox(cycleRows, cycle, {
      title: `B) DEL KPI (Cycle=${cycle})`
    });
  } else if (result.delError) {
    out += `B) DEL KPI: ${result.delError}\n`;
  } else {
    out += `B) DEL KPI: No data for cycle ${cycle}\n`;
  }

  out += "\n";

  // ============== SUMMARY PARAGRAPH ==============
  out += `--- Summary ---\n`;

  // Build summary based on real data
  const summaryParts = [];

  // Feature movement insights
  const activePods = fmRows.filter(r => r.inFlight > 0);
  if (activePods.length > 0) {
    summaryParts.push(`${activePods.length} pod${activePods.length > 1 ? "s" : ""} have active work in flight`);
  }

  const completedPods = fmRows.filter(r => r.done > 0 && r.done === r.plannedFeatures);
  if (completedPods.length > 0) {
    summaryParts.push(`${completedPods.map(r => r.pod).join(", ")} ${completedPods.length === 1 ? "has" : "have"} completed all planned features`);
  }

  const zeroPods = fmRows.filter(r => r.plannedFeatures === 0);
  if (zeroPods.length > 0) {
    summaryParts.push(`${zeroPods.map(r => r.pod).join(", ")} ${zeroPods.length === 1 ? "has" : "have"} no projects mapped`);
  }

  // DEL insights
  const highDelivery = cycleRows.filter(r => parseInt(r.deliveryPct) >= 80 && r.committed > 0);
  if (highDelivery.length > 0) {
    summaryParts.push(`${highDelivery.map(r => r.pod).join(", ")} ${highDelivery.length === 1 ? "is" : "are"} at 80%+ delivery`);
  }

  const spilloverPods = cycleRows.filter(r => r.spillover > 0);
  if (spilloverPods.length > 0) {
    summaryParts.push(`Spillover: ${spilloverPods.map(r => `${r.pod} (${r.spillover})`).join(", ")}`);
  }

  if (summaryParts.length > 0) {
    out += summaryParts.join(". ") + ".\n";
  } else {
    out += "All pods progressing normally.\n";
  }

  out += `\nSnapshot: ${formatToIST(result.fetchedAt)}`;

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
 * Fetch and summarize comments from all active projects in a pod
 * Includes both Linear comments AND Slack messages for projects with channel IDs
 */
async function fetchPodCommentsSummary(podName, projects) {
  const activeProjects = projects.filter(p => p.normalizedState === "in_flight").slice(0, 5);
  if (activeProjects.length === 0) return null;

  const allComments = [];
  const allSlackMessages = [];
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
          comments: commentsResult.comments.slice(0, 5),
        });
      }
    } catch (e) {
      // Skip failed fetches
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
          maxMessages: 10000,  // Essentially unlimited - fetch all messages
          includeThreads: true
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

  if (allComments.length === 0 && allSlackMessages.length === 0) return null;

  // Build combined text for summarization
  let combinedText = "";
  const sources = [];

  if (allComments.length > 0) {
    sources.push("Linear");
    combinedText += "\n## LINEAR COMMENTS\n";
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
    combinedText += "\n## SLACK DISCUSSIONS\n";
    for (const { project, messages } of allSlackMessages) {
      const shortName = project.replace(/^Q1 2026\s*:\s*/i, "").replace(/^Q1 26\s*-\s*/i, "");
      combinedText += `\n### ${shortName} (Slack)\n`;
      for (const m of messages) {
        combinedText += `- ${m.text}\n`;
      }
    }
  }

  // Summarize with LLM
  try {
    const messages = [
      {
        role: "system",
        content: `You are a project status summarizer. Summarize recent discussions from Linear comments AND Slack messages PROJECT-WISE.

Rules:
- Output each project on its own line with format: "ProjectName: summary of that project"
- NO markdown formatting (no **, ##, etc.)
- Keep each project summary to 1-2 sentences
- Focus on: current work, blockers, and progress
- Be factual and direct
- Combine insights from both Linear and Slack if available

Example output format:
FTS Evals: Multiple engineers working on test cases, one PR in review with pending Sonar fixes.
Data-Driven Cohorts: UI work ongoing with Users page targeted for completion today. Slack discussions indicate alignment on API contracts.
Dynamic Workflows: Tech spec largely complete, initial boilerplate work started.`
      },
      { role: "user", content: `Recent discussions from ${podName} pod:\n${combinedText}` },
    ];
    const summary = await fuelixChat({ messages });

    const totalComments = allComments.reduce((sum, p) => sum + p.comments.length, 0);
    const totalSlackMsgs = allSlackMessages.reduce((sum, p) => sum + p.messages.length, 0);

    return {
      commentCount: totalComments,
      slackMessageCount: totalSlackMsgs,
      projectCount: Math.max(allComments.length, allSlackMessages.length),
      hasSlackData,
      sources: sources.join(" + "),
      summary: summary.trim().replace(/\*\*/g, "").replace(/^#+\s*/gm, ""),
    };
  } catch (e) {
    const totalComments = allComments.reduce((sum, p) => sum + p.comments.length, 0);
    const totalSlackMsgs = allSlackMessages.reduce((sum, p) => sum + p.messages.length, 0);

    return {
      commentCount: totalComments,
      slackMessageCount: totalSlackMsgs,
      projectCount: Math.max(allComments.length, allSlackMessages.length),
      hasSlackData,
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
 */
async function generateMobilePodNarrative(pod, projectCount, stats, projects, podDelData, currentCycle, cycleDels, issueStats, healthScore, healthStatus, fetchedAt) {
  let out = "";

  // Clean up project names
  const cleanName = (name) => name
    .replace(/^Q1 2026\s*:\s*/i, "")
    .replace(/^Q1 26\s*-\s*/i, "")
    .replace(/^\[Q1 2026 Project\]-?/i, "")
    .replace(/^\[Q1 Project 2026\]-?/i, "");

  // ============== HEADER ==============
  out += `## ${healthStatus.emoji} ${pod} - ${healthStatus.text} (${healthScore}%)\n\n`;

  // ============== OVERVIEW TABLE ==============
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

  // ============== PROJECTS ==============
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
      out += jsonTable(`🔄 In-Flight (${inFlight.length})`, [
        { key: "project", header: "Project" },
        { key: "lead", header: "Lead" },
        { key: "status", header: "Status" }
      ], rows);
      out += "\n\n";
    }

    if (done.length > 0) {
      const rows = done.map(p => ({
        project: cleanName(p.name),
        status: "Done"
      }));
      out += jsonTable(`✅ Completed (${done.length})`, [
        { key: "project", header: "Project" },
        { key: "status", header: "Status" }
      ], rows);
      out += "\n\n";
    }

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
  }

  // ============== DEL TRACKING ==============
  // Clean project name - remove "Q1 2026 : " prefix
  const cleanProject = (name) => {
    if (!name) return "-";
    return name.replace(/^Q1 2026\s*:\s*/i, "").replace(/^Q1 26\s*-\s*/i, "");
  };

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
  }

  // ============== FEATURE READINESS (PRD, Design, Dev) ==============
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

      const rows = readiness.features.slice(0, 15).map(f => ({
        feature: f.feature, // Full name
        prd: statusEmoji(f.prd),
        design: statusEmoji(f.design),
        be: statusEmoji(f.beDev),
        fe: statusEmoji(f.feDev),
        pat: statusEmoji(f.pat),
        qa: statusEmoji(f.qa)
      }));

      out += jsonTable("📋 Feature Readiness", [
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

  // ============== COMMENTS & INSIGHTS ==============
  const commentsSummary = await fetchPodCommentsSummary(pod, projects);
  if (commentsSummary && commentsSummary.summary) {
    out += `### 💬 Recent Discussions\n${commentsSummary.summary}\n\n`;
  }

  const insights = await generatePodInsights(pod, stats, podDelData, issueStats, cycleDels, projects);
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
      return formatProjectList(result);
    }

    case "pod_live": {
      const result = await getLivePodSummary(cmd.podName);
      return formatPodSummary(result);
    }

    case "project_detail": {
      // Search ALL pods and find the BEST matching project
      const podsResult = listPods();
      const allPodProjects = [];

      for (const pod of podsResult.pods) {
        const result = await getLiveProjects(pod.name);
        if (result.success) {
          allPodProjects.push({ podName: pod.name, projects: result.projects });
        }
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

      if (bestMatch) {
        const result = await getLiveProject(bestMatch.podName, bestMatch.project.name);
        if (result.success) {
          return formatProjectDetail(result);
        }
      }
      return `Project "${cmd.projectName}" not found in any pod.\n\nTry: "pod <podname> projects" to see available projects.`;
    }

    case "project_blockers": {
      // Search ALL pods and find the BEST matching project
      const podsResult = listPods();
      const allPodProjects = [];

      for (const pod of podsResult.pods) {
        const result = await getLiveProjects(pod.name);
        if (result.success) {
          allPodProjects.push({ podName: pod.name, projects: result.projects });
        }
      }

      let bestMatch = null;
      for (const { podName, projects } of allPodProjects) {
        for (const p of projects) {
          const result = scoreProjectMatch(p, cmd.projectName);
          if (result && (!bestMatch || result.score > bestMatch.score)) {
            bestMatch = { podName, project: result.project, score: result.score };
          }
        }
      }

      if (bestMatch) {
        const result = await getLiveBlockers(bestMatch.podName, bestMatch.project.name);
        if (result.success) {
          return formatBlockers(result);
        }
      }
      return `Project "${cmd.projectName}" not found in any pod.`;
    }

    case "project_comments": {
      // Search ALL pods and find the BEST matching project
      const podsResult = listPods();
      const allPodProjects = [];

      for (const pod of podsResult.pods) {
        const result = await getLiveProjects(pod.name);
        if (result.success) {
          allPodProjects.push({ podName: pod.name, projects: result.projects });
        }
      }

      let bestMatch = null;
      for (const { podName, projects } of allPodProjects) {
        for (const p of projects) {
          const result = scoreProjectMatch(p, cmd.projectName);
          if (result && (!bestMatch || result.score > bestMatch.score)) {
            bestMatch = { podName, project: result.project, score: result.score };
          }
        }
      }

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

      // First, fetch projects from ALL pods and find the BEST match
      const allPodProjects = [];
      for (const pod of podsResult.pods) {
        const result = await getLiveProjects(pod.name);
        if (result.success) {
          allPodProjects.push({ podName: pod.name, projects: result.projects });
        }
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

      // Comments/Discussion summary with Slack
      const discussionSummary = await fetchPodCommentsSummary(matchedPod, [proj]);
      if (discussionSummary && discussionSummary.summary) {
        output += `### 💬 Recent Discussions\n${discussionSummary.summary}\n\n`;
      } else if (commentsResult?.success && commentsResult.commentCount > 0) {
        output += `### 💬 Recent Activity (${commentsResult.commentCount} comments)\n`;
        try {
          const messages = [
            { role: "system", content: commentSummaryPrompt() },
            { role: "user", content: `Project: ${proj.name}\nPod: ${matchedPod}\n\nRecent comments:\n${commentsResult.mergedText}` },
          ];
          const summary = await fuelixChat({ messages });
          output += summary + "\n\n";
        } catch (e) {
          for (const c of commentsResult.comments.slice(0, 5)) {
            output += `- **[${c.issueIdentifier}]** ${c.author}: ${c.body.substring(0, 150)}${c.body.length > 150 ? "..." : ""}\n`;
          }
          output += "\n";
        }
      }

      const hasSlack = discussionSummary && discussionSummary.hasSlackData;
      const sourceStr = hasSlack ? "Linear + Slack" : "Linear";
      output += `---\nSource: ${sourceStr} | ${formatToIST(projectResult.fetchedAt)}`;
      return output;
    }
  }

  // Fall back to snapshot-based deterministic answer
  if (snapshot) {
    const deterministic = deterministicAnswer(question, snapshot);
    if (deterministic) return deterministic;
  }

  // LLM fallback with snapshot
  if (snapshot) {
    const messages = [
      { role: "system", content: systemPrompt() },
      { role: "user", content: `Snapshot JSON:\n${JSON.stringify(snapshot)}\n\nUser question: ${question}` },
    ];
    const out = await fuelixChat({ messages });
    return out.trim();
  }

  return "No snapshot loaded. Use /refresh to load data, or try a live command like 'pod fts' or 'pods'.";
}

module.exports = { answer, parseCommand };
