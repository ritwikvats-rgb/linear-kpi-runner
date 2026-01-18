/* agent/src/tools.js
 * Deterministic KPI computations (NO LLM)
 */

/**
 * Normalize a name for fuzzy matching:
 * - Trim whitespace
 * - Collapse multiple spaces to single space
 * - Convert to lowercase
 * - Replace fancy dashes (en-dash, em-dash, etc.) with regular hyphen
 */
function normalizeName(name) {
  if (!name || typeof name !== "string") return "";
  return name
    .trim()
    .replace(/\s+/g, " ")           // collapse spaces
    .toLowerCase()
    .replace(/[\u2010-\u2015\u2212]/g, "-"); // fancy dashes → hyphen
}

/**
 * Extract unique initiative names from a list of projects
 */
function extractInitiativeNames(projects) {
  const names = new Set();
  for (const p of projects) {
    const initiatives = p.initiatives?.nodes || [];
    for (const init of initiatives) {
      if (init.name) names.add(init.name);
    }
  }
  return Array.from(names).sort();
}

/**
 * Filter projects by initiative (by ID or normalized name)
 * Returns { filtered: Project[], matchedInitiative: { id, name } | null }
 */
function filterProjectsByInitiative(projects, { initiativeId, initiativeName }) {
  if (!initiativeId && !initiativeName) {
    // No filter configured - return all projects
    return { filtered: projects, matchedInitiative: null, noFilter: true };
  }

  const normalizedTargetName = normalizeName(initiativeName);

  const filtered = [];
  let matchedInitiative = null;

  for (const p of projects) {
    const initiatives = p.initiatives?.nodes || [];

    for (const init of initiatives) {
      // Prefer ID match
      if (initiativeId && init.id === initiativeId) {
        filtered.push(p);
        matchedInitiative = { id: init.id, name: init.name };
        break;
      }
      // Fall back to normalized name match
      if (!initiativeId && initiativeName && normalizeName(init.name) === normalizedTargetName) {
        filtered.push(p);
        matchedInitiative = { id: init.id, name: init.name };
        break;
      }
    }
  }

  return { filtered, matchedInitiative, noFilter: false };
}

function normalizeProjectState(state) {
  // Linear project.state: planned, started, paused, completed, canceled
  const s = String(state || "").toLowerCase();
  if (s === "completed") return "done";
  if (s === "started" || s === "paused") return "in_flight";
  if (s === "planned") return "not_started";
  if (s === "canceled") return "not_started"; // treat as not started (or make its own bucket)
  return "unknown";
}

function classifyIssue(issue) {
  const labels = (issue.labels?.nodes || []).map((l) => l.name.toLowerCase());
  const stateType = issue.state?.type || "";
  const isDone = String(stateType).toLowerCase() === "completed";

  const isBlocker = labels.includes("blocker") || labels.includes("blocked");
  const isRisk = labels.includes("risk") || labels.includes("at risk");

  return { isDone, isBlocker, isRisk, labels };
}

async function buildSnapshot({ linear, pods }) {
  const generated_at = new Date().toISOString();

  const outPods = [];

  for (const pod of pods) {
    let teamId = pod.teamId || null;

    // If no teamId, try resolve by pod name (best-effort)
    if (!teamId) {
      try {
        const found = await linear.findTeamByName(pod.name);
        if (found?.id) teamId = found.id;
      } catch {
        // ignore
      }
    }

    // If still no teamId, produce "no data" pod snapshot (but agent will explain it)
    if (!teamId) {
      outPods.push({
        name: pod.name,
        teamId: null,
        data_status: "NO_TEAM_ID",
        projectsCount: 0,
        plannedFeatures: 0,
        done: 0,
        inFlight: 0,
        notStarted: 0,
        topProjects: [],
        blockers: [],
        risks: [],
      });
      continue;
    }

    let projects = [];
    let issues = [];
    let data_status = "OK";
    let initiativeDebug = null;

    // Fetch projects - prefer by initiative ID (most efficient)
    const initiativeId = pod.initiativeId || null;
    const initiativeName = pod.initiativeName || null;

    try {
      if (initiativeId) {
        // Best case: fetch directly by initiative ID
        projects = await linear.getProjectsByInitiative(initiativeId);
        initiativeDebug = {
          method: "by_initiative_id",
          initiativeId,
          projectsCount: projects.length,
        };
      } else if (initiativeName) {
        // Fallback: fetch all projects and filter by initiative name
        const allProjects = await linear.getAllProjectsWithInitiatives();
        const { filtered, matchedInitiative } = filterProjectsByInitiative(allProjects, {
          initiativeId: null,
          initiativeName,
        });

        if (filtered.length === 0) {
          // Initiative name not found
          data_status = "INITIATIVE_NOT_FOUND";
          const seenInitiatives = extractInitiativeNames(allProjects);
          initiativeDebug = {
            method: "by_initiative_name",
            configuredInitiativeName: initiativeName,
            totalProjectsFetched: allProjects.length,
            initiativesSeen: seenInitiatives,
          };
          projects = [];
        } else {
          projects = filtered;
          initiativeDebug = {
            method: "by_initiative_name",
            matchedInitiative,
            projectsBeforeFilter: allProjects.length,
            projectsAfterFilter: filtered.length,
          };
        }
      } else {
        // No initiative configured - this pod won't have project data
        data_status = "NO_INITIATIVE_CONFIGURED";
        initiativeDebug = {
          method: "none",
          message: "Pod has no initiativeId or initiativeName configured",
        };
        projects = [];
      }
    } catch (e) {
      data_status = "PROJECT_FETCH_FAILED";
      initiativeDebug = {
        error: e.message,
      };
    }

    try {
      issues = await linear.getIssuesByTeam(teamId);
    } catch (e) {
      if (data_status === "OK") data_status = "ISSUE_FETCH_FAILED";
    }

    // Project movement counts
    let done = 0, inFlight = 0, notStarted = 0;
    const topProjects = [];

    for (const p of projects) {
      const bucket = normalizeProjectState(p.state);
      if (bucket === "done") done++;
      else if (bucket === "in_flight") inFlight++;
      else if (bucket === "not_started") notStarted++;

      topProjects.push({
        title: p.name,
        state: p.state,
        owner: p.lead?.name || null,
        eta: p.targetDate || null,
        url: p.url || null,
        updatedAt: p.updatedAt || null,
      });
    }

    // Reduce noise: keep recent 10
    topProjects.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    const topProjectsTrimmed = topProjects.slice(0, 10);

    // Blockers & risks from issues (label-based)
    const blockers = [];
    const risks = [];

    for (const it of issues) {
      const { isDone, isBlocker, isRisk } = classifyIssue(it);
      if (isDone) continue;

      const entry = {
        title: it.title,
        owner: it.assignee?.name || null,
        priority: it.priority ?? null,
        dueDate: it.dueDate || null,
        state: it.state?.name || null,
        url: it.url || null,
        updatedAt: it.updatedAt || null,
      };

      if (isBlocker) blockers.push(entry);
      if (isRisk) risks.push(entry);
    }

    blockers.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    risks.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));

    const podOutput = {
      name: pod.name,
      teamId,
      data_status,
      projectsCount: projects.length,
      plannedFeatures: projects.length,
      done,
      inFlight,
      notStarted,
      topProjects: topProjectsTrimmed,
      blockers: blockers.slice(0, 10),
      risks: risks.slice(0, 10),
    };

    // Include initiative debug info if available
    if (initiativeDebug) {
      podOutput.initiativeDebug = initiativeDebug;
    }

    outPods.push(podOutput);
  }

  // Convenience tables (for fast answers)
  const featureMovementTable = outPods.map((p) => ({
    pod: p.name,
    plannedFeatures: p.plannedFeatures,
    done: p.done,
    inFlight: p.inFlight,
    notStarted: p.notStarted,
    projectsCount: p.projectsCount,
    data_status: p.data_status,
  }));

  const zeroProjectsPods = outPods
    .filter((p) => p.projectsCount === 0)
    .map((p) => ({ pod: p.name, reason: p.data_status }));

  return {
    generated_at,
    org: "Linear KPI Runner",
    pods: outPods,
    tables: {
      featureMovement: featureMovementTable,
      zeroProjects: zeroProjectsPods,
    },
  };
}

module.exports = { buildSnapshot };
