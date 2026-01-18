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
  formatWeeklyKpiOutput,
  formatCombinedKpiOutput,
  generateInsights,
} = require("./kpiComputer");

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

  let output = `## ${pod} - Projects (${projectCount} total)\n\n`;

  // Stats
  output += `**Status breakdown:** Done=${stats.done}, In-Flight=${stats.in_flight}, Not Started=${stats.not_started}\n\n`;

  // Project list
  output += `| Project | State | Lead | Updated |\n`;
  output += `|---------|-------|------|--------|\n`;

  for (const p of projects) {
    const updated = p.updatedAt ? new Date(p.updatedAt).toLocaleDateString() : "-";
    output += `| ${p.name.substring(0, 40)}${p.name.length > 40 ? "..." : ""} | ${p.normalizedState} | ${p.lead || "-"} | ${updated} |\n`;
  }

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
  output += `**Pod:** ${pod}\n`;
  output += `**Total Blockers:** ${blockerCount}\n`;
  if (projectUrl) output += `**Project URL:** ${projectUrl}\n`;

  if (blockers.length === 0) {
    output += `\nNo blockers found for this project.\n`;
  } else {
    output += `\n| Issue | Title | Reason | Assignee | Priority |\n`;
    output += `|-------|-------|--------|----------|----------|\n`;
    for (const b of blockers) {
      output += `| ${b.identifier} | ${b.title.substring(0, 30)}${b.title.length > 30 ? "..." : ""} | ${b.reason} | ${b.assignee || "-"} | ${b.priority ?? "-"} |\n`;
    }
  }

  output += `\n*Source: LIVE from Linear (${fetchedAt})*`;
  return output;
}

function formatPodsList(result) {
  let output = `## Available Pods\n\n`;
  output += `**Source:** ${result.source}\n`;
  if (result.org) output += `**Organization:** ${result.org}\n`;
  output += `**Count:** ${result.podCount}\n\n`;

  output += `| Pod | Team ID | Initiative ID |\n`;
  output += `|-----|---------|---------------|\n`;
  for (const p of result.pods) {
    output += `| ${p.name} | ${p.teamId} | ${p.initiativeId} |\n`;
  }

  return output;
}

// ============== COMMAND PARSING ==============

/**
 * Extract project name from natural language queries like:
 * - "what's going on in FTS Evals manual actions replacements"
 * - "status of Data-Driven Cohorts"
 * - "update on tagging project"
 */
function extractProjectFromNaturalLanguage(input) {
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
      // Skip if it's just a pod name (too short or common pod names)
      if (projectName.length > 3 && !["fts", "gts", "pod"].includes(projectName.toLowerCase())) {
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
      return { type: "combined_kpi" };
    }
  }

  // KPI queries - detect various ways users ask for KPI
  const kpiPatterns = [
    /^(?:what(?:'s|s| is) )?(?:the )?(?:weekly )?kpi/i,
    /^(?:show )?kpi (?:tables?|report|snapshot)/i,
    /^pod kpi/i,
    /^weekly (?:kpi|report|snapshot)/i,
    /^kpi (?:for )?(?:this )?week/i,
    /^(?:show|get|display) (?:the )?(?:weekly )?kpi/i,
    /^del (?:kpi|metrics|report)/i,
    /^cycle kpi/i,
    /^(?:what(?:'s|s| is) )?(?:the )?del (?:status|progress|metrics)/i,
    /^(?:how are we doing|team status|sprint status)/i,
  ];

  for (const pattern of kpiPatterns) {
    if (pattern.test(lower)) {
      // Default to combined KPI for better user experience
      return { type: "combined_kpi" };
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

// ============== MAIN ANSWER FUNCTION ==============

/**
 * Answer a question using live data or snapshot
 * @param {string} question - User question
 * @param {object} snapshot - Snapshot data (optional, for fallback)
 * @param {object} options - Options { useLive: boolean }
 */
async function answer(question, snapshot, options = {}) {
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
