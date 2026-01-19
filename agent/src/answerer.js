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
  formatPendingDELs,
  formatWeeklyKpiOutput,
  formatCombinedKpiOutput,
  generateInsights,
} = require("./kpiComputer");
const {
  formatFeatureMovementBox,
  formatDelKpiBox,
  formatProjectsBox,
  formatBlockersBox,
  formatPodsListBox,
  formatSummaryBox,
} = require("./tableFormatter");

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

  output += `\n*Source: LIVE from Linear (${fetchedAt})*`;
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

  output += `\n*Source: LIVE from Linear (${fetchedAt})*`;
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

  output += `\n*Source: LIVE from Linear (${fetchedAt})*`;
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

  output += `\n*Source: LIVE from Linear (${fetchedAt})*`;
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
      // Map aliases
      if (pod === "growth and reuse" || pod === "gr") return "Growth & Reuse";
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
    /^(?:show\s+(?:me\s+)?)?kpi\s+(?:tables?|report|snapshot)/i,
    /^pod kpi/i,
    /^weekly (?:kpi|report|snapshot)/i,
    /^kpi (?:for )?(?:this )?week/i,
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
  out += formatFeatureMovementBox(fmRows, {
    title: "A) How are our planned features moving? (Weekly Snapshot)"
  });

  out += "\n";

  // ============== TABLE B: DEL KPI (Beautified Box) ==============
  out += formatDelKpiBox(cycleRows, cycle, {
    title: `B) Pod-wise Cycle KPI (Cycle=${cycle})`
  });

  out += "\n";

  // ============== SUMMARY PARAGRAPH ==============
  out += `--- Summary ---\n`;

  // Build summary based on real data
  const summaryParts = [];

  // Feature movement insights
  const activePods = fmRows.filter(r => r.inFlight > 0);
  if (activePods.length > 0) {
    summaryParts.push(`${activePods.length} pods have active work in flight`);
  }

  const completedPods = fmRows.filter(r => r.done > 0 && r.done === r.plannedFeatures);
  if (completedPods.length > 0) {
    summaryParts.push(`${completedPods.map(r => r.pod).join(", ")} ${completedPods.length === 1 ? "has" : "have"} completed all planned features`);
  }

  const zeroPods = fmRows.filter(r => r.plannedFeatures === 0);
  if (zeroPods.length > 0) {
    summaryParts.push(`${zeroPods.map(r => r.pod).join(", ")} ${zeroPods.length === 1 ? "has" : "have"} no projects mapped to their initiative yet`);
  }

  // DEL insights
  const highDelivery = cycleRows.filter(r => parseInt(r.deliveryPct) >= 80 && r.committed > 0);
  if (highDelivery.length > 0) {
    summaryParts.push(`${highDelivery.map(r => r.pod).join(", ")} ${highDelivery.length === 1 ? "is" : "are"} at 80%+ delivery`);
  }

  const spilloverPods = cycleRows.filter(r => r.spillover > 0);
  if (spilloverPods.length > 0) {
    summaryParts.push(`spillover in ${spilloverPods.map(r => `${r.pod} (${r.spillover})`).join(", ")}`);
  }

  if (summaryParts.length > 0) {
    out += summaryParts.join(". ") + ".\n";
  } else {
    out += "All pods are progressing on their planned work. No blockers detected at the pod level.\n";
  }

  out += `\nSnapshot: ${result.fetchedAt}`;

  return out;
}

/**
 * Generate narrative summary for a single pod
 * Output format:
 * a) One paragraph summary of what's happening NOW
 * b) Short "What changed recently" bullet list (max 5)
 * c) Blockers/Risks only if they exist
 * d) Suggestions only if blockers/risks exist
 */
async function generatePodNarrative(podName) {
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

  let out = "";

  // ============== (a) ONE PARAGRAPH SUMMARY ==============
  out += `${pod} Summary\n`;
  out += `${"=".repeat(pod.length + 8)}\n\n`;

  // Build narrative paragraph
  const narrativeParts = [];

  // Project status
  if (projectCount === 0) {
    narrativeParts.push(`${pod} currently has no projects mapped to its Q1 2026 initiative`);
  } else {
    const statusParts = [];
    if (stats.in_flight > 0) statusParts.push(`${stats.in_flight} in-flight`);
    if (stats.done > 0) statusParts.push(`${stats.done} completed`);
    if (stats.not_started > 0) statusParts.push(`${stats.not_started} not yet started`);

    narrativeParts.push(`${pod} has ${projectCount} planned features for Q1 2026: ${statusParts.join(", ")}`);

    // Highlight active projects
    const inFlightProjects = projects.filter(p => p.normalizedState === "in_flight");
    if (inFlightProjects.length > 0 && inFlightProjects.length <= 3) {
      narrativeParts.push(`Currently active: ${inFlightProjects.map(p => p.name.replace(/^Q1 2026\s*:\s*/i, "")).join(", ")}`);
    }
  }

  // Blocker status
  if (issueStats.blockers > 0) {
    narrativeParts.push(`There ${issueStats.blockers === 1 ? "is" : "are"} ${issueStats.blockers} blocker${issueStats.blockers === 1 ? "" : "s"} requiring attention`);
  }

  out += narrativeParts.join(". ") + ".\n\n";

  // ============== (b) WHAT CHANGED RECENTLY ==============
  out += `What changed recently:\n`;

  // Get recently updated projects (sorted by updatedAt)
  const recentProjects = [...projects]
    .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))
    .slice(0, 5);

  if (recentProjects.length === 0) {
    out += `- No recent project activity detected\n`;
  } else {
    for (const p of recentProjects) {
      const shortName = p.name.replace(/^Q1 2026\s*:\s*/i, "").replace(/^Q1 26\s*-\s*/i, "");
      const updatedDate = p.updatedAt ? new Date(p.updatedAt).toLocaleDateString() : "unknown";
      const stateText = p.normalizedState === "in_flight" ? "in progress" : p.normalizedState === "done" ? "completed" : "planned";
      out += `- ${shortName} (${stateText}, updated ${updatedDate})\n`;
    }
  }

  out += `\n`;

  // ============== (c) BLOCKERS/RISKS ==============
  if (issueStats.blockers > 0 || issueStats.risks > 0) {
    out += `Blockers/Risks:\n`;
    if (issueStats.blockers > 0) {
      out += `- ${issueStats.blockers} blocker issue${issueStats.blockers === 1 ? "" : "s"} labeled in Linear\n`;
    }
    if (issueStats.risks > 0) {
      out += `- ${issueStats.risks} risk item${issueStats.risks === 1 ? "" : "s"} flagged\n`;
    }

    // ============== (d) SUGGESTIONS ==============
    out += `\nSuggestions:\n`;
    if (issueStats.blockers > 0) {
      out += `- Review blocker issues and assign owners if not already done\n`;
      out += `- Consider escalating if blockers have been open for more than 2 days\n`;
    }
    if (issueStats.risks > 0) {
      out += `- Evaluate risk items and determine mitigation strategies\n`;
    }
  } else {
    out += `No actionable blockers detected.\n`;
  }

  out += `\n*Source: LIVE from Linear (${projectsResult.fetchedAt})*`;

  return out;
}

// ============== MAIN ANSWER FUNCTION ==============

/**
 * Answer a question using live data or snapshot
 * @param {string} question - User question
 * @param {object} snapshot - Snapshot data (optional, for fallback)
 */
async function answer(question, snapshot) {
  const cmd = parseCommand(question);

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
      return formatPendingDELs(result);
    }

    case "pod_narrative": {
      // Generate narrative summary for a single pod
      return await generatePodNarrative(cmd.podName);
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

      // Build comprehensive output
      let output = `## ${projectResult.project.name}\n\n`;

      // Project facts
      output += `**Pod:** ${matchedPod}\n`;
      output += `**State:** ${projectResult.project.normalizedState}\n`;
      output += `**Lead:** ${projectResult.project.lead || "Not assigned"}\n`;
      if (projectResult.project.targetDate) output += `**Target Date:** ${projectResult.project.targetDate}\n`;
      if (projectResult.project.url) output += `**URL:** ${projectResult.project.url}\n`;

      // Issue stats
      output += `\n### Issues (${projectResult.issueStats.total} total)\n`;
      output += `- Active: ${projectResult.issueStats.active}\n`;
      output += `- Done: ${projectResult.issueStats.done}\n`;
      if (projectResult.issueStats.blockers > 0) output += `- **Blockers: ${projectResult.issueStats.blockers}**\n`;
      if (projectResult.issueStats.highPriority > 0) output += `- High Priority: ${projectResult.issueStats.highPriority}\n`;

      // Blockers
      if (projectResult.blockerIssues?.length > 0) {
        output += `\n### Blockers\n`;
        for (const issue of projectResult.blockerIssues) {
          output += `- [${issue.identifier}] ${issue.title} (${issue.assignee || "unassigned"})\n`;
        }
      }

      // Active issues (recent)
      if (projectResult.activeIssues?.length > 0) {
        output += `\n### Active Issues (recent)\n`;
        for (const issue of projectResult.activeIssues.slice(0, 8)) {
          const marker = issue.isBlocker ? " [BLOCKER]" : "";
          output += `- [${issue.identifier}] ${issue.title}${marker}\n`;
        }
      }

      // Comments summary
      if (commentsResult?.success && commentsResult.commentCount > 0) {
        output += `\n### Recent Activity (last 14 days)\n`;
        output += `**${commentsResult.commentCount} comments** across issues\n\n`;

        // Try to summarize with LLM
        try {
          const messages = [
            { role: "system", content: commentSummaryPrompt() },
            { role: "user", content: `Project: ${projectResult.project.name}\nPod: ${matchedPod}\n\nRecent comments:\n${commentsResult.mergedText}` },
          ];
          const summary = await fuelixChat({ messages });
          output += summary + "\n";
        } catch (e) {
          // LLM failed, show raw comments
          for (const c of commentsResult.comments.slice(0, 5)) {
            output += `- **[${c.issueIdentifier}]** ${c.author}: ${c.body.substring(0, 150)}${c.body.length > 150 ? "..." : ""}\n`;
          }
        }
      } else {
        output += `\n### Recent Activity\nNo comments found in the last 14 days.\n`;
      }

      output += `\n*Source: LIVE from Linear (${projectResult.fetchedAt})*`;
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
