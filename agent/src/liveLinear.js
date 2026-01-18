/* agent/src/liveLinear.js
 * Live Linear data fetcher with caching
 * Wraps LinearClient with TTL cache for efficient repeated queries
 */
require("dotenv").config();
const { LinearClient } = require("./linearClient");
const { withCache, clearCache, cacheStats, DEFAULT_TTL_MS } = require("./cache");
const { loadConfig, getPod, fuzzyMatchPod, getPodNames } = require("./configLoader");

// Cache TTLs
const CACHE_TTL = {
  projects: 5 * 60 * 1000,    // 5 min for project lists
  issues: 3 * 60 * 1000,      // 3 min for issues
  comments: 2 * 60 * 1000,    // 2 min for comments
  project: 5 * 60 * 1000,     // 5 min for single project
};

/**
 * Create a configured Linear client
 */
function createClient() {
  const apiKey = process.env.LINEAR_API_KEY;
  const url = process.env.LINEAR_GQL_URL || "https://api.linear.app/graphql";

  if (!apiKey) {
    throw new Error("Missing LINEAR_API_KEY in environment");
  }

  return new LinearClient({ apiKey, url });
}

// Singleton client instance
let _client = null;
function getClient() {
  if (!_client) {
    _client = createClient();
  }
  return _client;
}

// Singleton config
let _config = null;
function getConfig() {
  if (!_config) {
    _config = loadConfig();
  }
  return _config;
}

/**
 * Normalize project state for display
 */
function normalizeState(state) {
  const s = String(state || "").toLowerCase();
  if (s === "completed") return "done";
  if (s === "started" || s === "paused") return "in_flight";
  if (s === "planned" || s === "backlog") return "not_started";
  if (s === "canceled" || s === "cancelled") return "cancelled";
  return s || "unknown";
}

/**
 * Extract blocker/risk status from issue labels
 */
function classifyIssue(issue) {
  const labels = (issue.labels?.nodes || []).map(l => l.name.toLowerCase());
  const stateType = issue.state?.type || "";

  return {
    isDone: stateType.toLowerCase() === "completed",
    isBlocker: labels.some(l => l.includes("blocker") || l.includes("blocked")),
    isRisk: labels.some(l => l.includes("risk") || l === "at risk"),
    isBug: labels.some(l => l.includes("bug")),
    isHighPriority: (issue.priority ?? 5) <= 2, // 1=urgent, 2=high
  };
}

/**
 * Score how well a project name matches a query
 * Higher score = better match
 * Returns { project, score } or null if no match
 */
function scoreProjectMatch(project, query) {
  // Normalize: lowercase, trim, collapse multiple spaces
  const q = String(query || "").toLowerCase().trim().replace(/\s+/g, " ");
  const pLower = project.name.toLowerCase();

  if (!q) return null;

  // Exact match (highest priority)
  if (pLower === q) {
    return { project, score: 1000 };
  }

  // Project name ends with query (e.g., "Q1 26 - Contributor Portal" matches "Contributor Portal")
  if (pLower.endsWith(q)) {
    return { project, score: 900 };
  }

  // All query words match in order
  const words = q.split(/\s+/);
  const allWordsMatch = words.every(w => pLower.includes(w));

  if (allWordsMatch) {
    // Score based on how much of the project name is covered by the query
    const coverage = q.length / pLower.length;
    return { project, score: 500 + (coverage * 100) };
  }

  // Partial word match - at least first word matches
  if (words.length > 0 && pLower.includes(words[0])) {
    const matchedWords = words.filter(w => pLower.includes(w));
    const wordCoverage = matchedWords.length / words.length;
    if (wordCoverage >= 0.5) {
      return { project, score: 200 + (wordCoverage * 100) };
    }
  }

  // Simple contains (lowest priority - this was causing the bug)
  if (pLower.includes(q.split(/\s+/)[0]) && q.length >= 4) {
    return { project, score: 50 };
  }

  return null;
}

/**
 * Fuzzy match project name within a list
 * Returns best matching project or null
 */
function fuzzyMatchProject(projects, query) {
  const q = String(query || "").toLowerCase().trim();
  if (!q) return null;

  let bestMatch = null;
  let bestScore = 0;

  for (const p of projects) {
    const result = scoreProjectMatch(p, q);
    if (result && result.score > bestScore) {
      bestScore = result.score;
      bestMatch = result.project;
    }
  }

  return bestMatch;
}

/**
 * Find best matching project across all pods
 * Returns { pod, project, score } or null
 */
function findBestProjectMatch(allPodProjects, query) {
  const q = String(query || "").toLowerCase().trim();
  if (!q) return null;

  let best = null;

  for (const { podName, projects } of allPodProjects) {
    for (const p of projects) {
      const result = scoreProjectMatch(p, q);
      if (result && (!best || result.score > best.score)) {
        best = { podName, project: result.project, score: result.score };
      }
    }
  }

  return best;
}

// ============== LIVE DATA FUNCTIONS ==============

/**
 * Get projects for a pod (LIVE from Linear, cached)
 */
async function getLiveProjects(podName) {
  const config = getConfig();
  const pod = getPod(config, podName);

  if (!pod) {
    const suggestion = fuzzyMatchPod(config, podName);
    return {
      success: false,
      error: "POD_NOT_FOUND",
      message: `Pod "${podName}" not found`,
      suggestion,
      availablePods: getPodNames(config),
    };
  }

  if (!pod.initiativeId) {
    return {
      success: false,
      error: "NO_INITIATIVE_ID",
      message: `Pod "${pod.name}" has no initiativeId configured`,
    };
  }

  const client = getClient();
  const cacheKey = `projects_${pod.initiativeId}`;

  // Use cached function
  const fetchFn = withCache(cacheKey, async () => {
    return await client.getProjectsByInitiative(pod.initiativeId);
  }, CACHE_TTL.projects);

  try {
    const projects = await fetchFn();

    // Compute stats
    const stats = { done: 0, in_flight: 0, not_started: 0, cancelled: 0 };
    for (const p of projects) {
      const state = normalizeState(p.state);
      if (stats[state] !== undefined) stats[state]++;
    }

    return {
      success: true,
      pod: pod.name,
      teamId: pod.teamId,
      initiativeId: pod.initiativeId,
      projectCount: projects.length,
      stats,
      projects: projects.map(p => ({
        id: p.id,
        name: p.name,
        state: p.state,
        normalizedState: normalizeState(p.state),
        lead: p.lead?.name || null,
        targetDate: p.targetDate,
        url: p.url,
        updatedAt: p.updatedAt,
      })),
      fetchedAt: new Date().toISOString(),
    };
  } catch (e) {
    return {
      success: false,
      error: "FETCH_FAILED",
      message: e.message,
      httpStatus: e.details?.errors?.[0]?.extensions?.http?.status,
    };
  }
}

/**
 * Get project by name (fuzzy match within pod)
 */
async function getLiveProject(podName, projectQuery) {
  const projectsResult = await getLiveProjects(podName);
  if (!projectsResult.success) return projectsResult;

  const project = fuzzyMatchProject(projectsResult.projects, projectQuery);
  if (!project) {
    return {
      success: false,
      error: "PROJECT_NOT_FOUND",
      message: `Project "${projectQuery}" not found in pod ${podName}`,
      availableProjects: projectsResult.projects.slice(0, 10).map(p => p.name),
    };
  }

  // Fetch full project details
  const client = getClient();

  try {
    const [fullProject, issues] = await Promise.all([
      withCache(`project_${project.id}`, () => client.getProjectById(project.id), CACHE_TTL.project)(),
      withCache(`issues_${project.id}`, () => client.getIssuesByProject(project.id), CACHE_TTL.issues)(),
    ]);

    // Classify issues
    const issueStats = { total: 0, active: 0, done: 0, blockers: 0, risks: 0, bugs: 0, highPriority: 0 };
    const activeIssues = [];
    const blockerIssues = [];

    for (const issue of issues) {
      const { isDone, isBlocker, isRisk, isBug, isHighPriority } = classifyIssue(issue);
      issueStats.total++;

      if (isDone) {
        issueStats.done++;
      } else {
        issueStats.active++;
        activeIssues.push({
          id: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          state: issue.state?.name,
          assignee: issue.assignee?.name,
          priority: issue.priority,
          isBlocker,
          isRisk,
          url: issue.url,
          updatedAt: issue.updatedAt,
        });

        if (isBlocker) {
          issueStats.blockers++;
          blockerIssues.push(activeIssues[activeIssues.length - 1]);
        }
        if (isRisk) issueStats.risks++;
        if (isBug) issueStats.bugs++;
        if (isHighPriority) issueStats.highPriority++;
      }
    }

    // Sort by updatedAt
    activeIssues.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

    return {
      success: true,
      pod: podName,
      project: {
        id: fullProject?.id || project.id,
        name: fullProject?.name || project.name,
        state: fullProject?.state || project.state,
        normalizedState: normalizeState(fullProject?.state || project.state),
        description: fullProject?.description || null,
        lead: fullProject?.lead?.name || project.lead,
        startDate: fullProject?.startDate,
        targetDate: fullProject?.targetDate || project.targetDate,
        url: fullProject?.url || project.url,
        updatedAt: fullProject?.updatedAt || project.updatedAt,
      },
      issueStats,
      activeIssues: activeIssues.slice(0, 15),
      blockerIssues,
      fetchedAt: new Date().toISOString(),
    };
  } catch (e) {
    return {
      success: false,
      error: "FETCH_FAILED",
      message: e.message,
    };
  }
}

/**
 * Get blockers for a project
 */
async function getLiveBlockers(podName, projectQuery) {
  const result = await getLiveProject(podName, projectQuery);
  if (!result.success) return result;

  // Also check for blocker keywords in issue titles/descriptions
  const client = getClient();
  const issues = await withCache(
    `issues_${result.project.id}`,
    () => client.getIssuesByProject(result.project.id),
    CACHE_TTL.issues
  )();

  const blockers = [];

  for (const issue of issues) {
    const { isDone, isBlocker } = classifyIssue(issue);
    if (isDone) continue;

    // Check labels
    if (isBlocker) {
      blockers.push({
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        reason: "labeled as blocker",
        state: issue.state?.name,
        assignee: issue.assignee?.name,
        priority: issue.priority,
        url: issue.url,
        updatedAt: issue.updatedAt,
      });
      continue;
    }

    // Check title for blocker keywords
    const titleLower = (issue.title || "").toLowerCase();
    if (titleLower.includes("blocker") || titleLower.includes("blocked by") || titleLower.includes("blocking")) {
      blockers.push({
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        reason: "title contains blocker keyword",
        state: issue.state?.name,
        assignee: issue.assignee?.name,
        priority: issue.priority,
        url: issue.url,
        updatedAt: issue.updatedAt,
      });
    }
  }

  return {
    success: true,
    pod: podName,
    project: result.project.name,
    projectUrl: result.project.url,
    blockerCount: blockers.length,
    blockers,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Get recent comments for a project's issues
 */
async function getLiveComments(podName, projectQuery, daysBack = 7) {
  const projectResult = await getLiveProject(podName, projectQuery);
  if (!projectResult.success) return projectResult;

  const client = getClient();
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysBack);

  const allComments = [];

  // Fetch comments for active issues (limit to top 10 by recency)
  const issuesToCheck = projectResult.activeIssues.slice(0, 10);

  for (const issue of issuesToCheck) {
    try {
      const comments = await withCache(
        `comments_${issue.id}`,
        () => client.getIssueComments(issue.id, 10),
        CACHE_TTL.comments
      )();

      for (const comment of comments) {
        const commentDate = new Date(comment.createdAt);
        if (commentDate >= cutoffDate) {
          allComments.push({
            issueId: issue.id,
            issueIdentifier: issue.identifier,
            issueTitle: issue.title,
            commentId: comment.id,
            body: comment.body,
            author: comment.user?.name || "Unknown",
            createdAt: comment.createdAt,
          });
        }
      }
    } catch (e) {
      // Skip issues where comments fail
    }
  }

  // Sort by date
  allComments.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  // Create merged text blob for summarization
  const mergedText = allComments
    .slice(0, 20)
    .map(c => `[${c.issueIdentifier}] ${c.author}: ${c.body}`)
    .join("\n\n---\n\n");

  return {
    success: true,
    pod: podName,
    project: projectResult.project.name,
    daysBack,
    commentCount: allComments.length,
    comments: allComments.slice(0, 20),
    mergedText: mergedText || "(No recent comments found)",
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Get pod summary (LIVE)
 */
async function getLivePodSummary(podName) {
  const config = getConfig();
  const pod = getPod(config, podName);

  if (!pod) {
    const suggestion = fuzzyMatchPod(config, podName);
    return {
      success: false,
      error: "POD_NOT_FOUND",
      message: `Pod "${podName}" not found`,
      suggestion,
      availablePods: getPodNames(config),
    };
  }

  const projectsResult = await getLiveProjects(podName);
  if (!projectsResult.success) return projectsResult;

  // Get issues for team
  const client = getClient();
  let teamIssues = [];
  let issueStats = { total: 0, active: 0, blockers: 0, risks: 0 };

  if (pod.teamId) {
    try {
      teamIssues = await withCache(
        `team_issues_${pod.teamId}`,
        () => client.getIssuesByTeam(pod.teamId),
        CACHE_TTL.issues
      )();

      for (const issue of teamIssues) {
        const { isDone, isBlocker, isRisk } = classifyIssue(issue);
        issueStats.total++;
        if (!isDone) {
          issueStats.active++;
          if (isBlocker) issueStats.blockers++;
          if (isRisk) issueStats.risks++;
        }
      }
    } catch (e) {
      // Issues fetch failed, continue without
    }
  }

  // Top projects by updatedAt
  const topProjects = [...projectsResult.projects]
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .slice(0, 5);

  return {
    success: true,
    pod: pod.name,
    teamId: pod.teamId,
    initiativeId: pod.initiativeId,
    initiativeName: pod.initiativeName,
    projectCount: projectsResult.projectCount,
    projectStats: projectsResult.stats,
    issueStats,
    topProjects,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * List all pods with basic info
 */
function listPods() {
  const config = getConfig();
  const pods = [];

  for (const [name, data] of Object.entries(config.pods)) {
    pods.push({
      name,
      teamId: data.teamId ? "configured" : "missing",
      initiativeId: data.initiativeId ? "configured" : "missing",
      hasConfig: !!(data.teamId && data.initiativeId),
    });
  }

  return {
    success: true,
    source: config.source,
    org: config.org?.name || null,
    podCount: pods.length,
    pods,
  };
}

module.exports = {
  // Core functions
  getLiveProjects,
  getLiveProject,
  getLiveBlockers,
  getLiveComments,
  getLivePodSummary,
  listPods,

  // Utilities
  getConfig,
  getClient,
  normalizeState,
  classifyIssue,
  fuzzyMatchProject,
  scoreProjectMatch,
  findBestProjectMatch,

  // Cache management
  clearCache,
  cacheStats,
};
