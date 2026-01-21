/* agent/src/shared/labelUtils.js
 * Shared label loading and DEL filtering utilities
 * Used by both kpiComputer.js and runWeeklyKpi.js
 */
const fs = require("fs");
const path = require("path");

const { CONFIG_DIR } = require("./cycleUtils");

/**
 * Load label IDs from config/label_ids.json
 * @returns {object|null} - Label IDs object or null if not found
 */
function loadLabelIds() {
  const fp = path.join(CONFIG_DIR, "label_ids.json");
  if (!fs.existsSync(fp)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Save label IDs to config/label_ids.json
 * @param {object} labelIds - Label IDs object
 */
function saveLabelIds(labelIds) {
  const fp = path.join(CONFIG_DIR, "label_ids.json");
  fs.writeFileSync(fp, JSON.stringify(labelIds, null, 2), "utf8");
}

/**
 * Enrich issues with label sets for faster lookups
 * @param {Array} issues - Raw issues from Linear API
 * @returns {Array} - Enriched issues with _labels, _labelSet, _labelNames
 */
function enrichIssuesWithLabels(issues) {
  return issues.map(it => {
    const labels = (it.labels?.nodes || []).map(x => ({ id: x.id, name: x.name }));
    const labelSet = new Set(labels.map(x => x.id));
    const labelNames = labels.map(x => x.name);
    return { ...it, _labels: labels, _labelSet: labelSet, _labelNames: labelNames };
  });
}

/**
 * Filter issues committed to a specific cycle (has baseline label, not cancelled)
 * @param {Array} enrichedIssues - Issues with _labelSet
 * @param {string} baselineLabelId - Cycle baseline label ID (e.g., "2026Q1-C1")
 * @param {string|null} cancelledLabelId - DEL-CANCELLED label ID
 * @returns {Array} - Filtered committed issues
 */
function filterCommittedIssues(enrichedIssues, baselineLabelId, cancelledLabelId) {
  if (!baselineLabelId) return [];

  return enrichedIssues.filter(it => {
    const hasBaseline = it._labelSet.has(baselineLabelId);
    if (!hasBaseline) return false;

    const isCancelled = cancelledLabelId ? it._labelSet.has(cancelledLabelId) : false;
    return !isCancelled;
  });
}

/**
 * Count completed issues by a cutoff date
 * @param {Array} issues - Issues to check
 * @param {Date|null} cutoffDate - Cutoff date (null = count all completed)
 * @returns {number} - Count of completed issues
 */
function countCompletedByCutoff(issues, cutoffDate) {
  let count = 0;
  for (const it of issues) {
    const isDone = it.state?.type === "completed";
    if (!isDone) continue;

    if (cutoffDate) {
      const doneAt = it.completedAt ? new Date(it.completedAt) : null;
      if (doneAt && doneAt.getTime() <= cutoffDate.getTime()) {
        count++;
      }
    } else {
      count++;
    }
  }
  return count;
}

/**
 * Calculate delivery percentage
 * @param {number} completed - Completed count
 * @param {number} committed - Committed count
 * @returns {string} - Percentage string (e.g., "85%")
 */
function calculateDeliveryPct(completed, committed) {
  if (committed === 0) return "0%";
  return `${Math.round((completed / committed) * 100)}%`;
}

/**
 * Extract clean title from DEL issue (removes [DEL] prefix)
 * @param {object} issue - Issue object
 * @returns {string} - Clean title
 */
function extractDelTitle(issue) {
  let title = issue.title || issue.identifier;
  title = title.replace(/^\[DEL\]\s*/i, "").trim();
  return title;
}

/**
 * Normalize string for comparison
 * @param {string} s - Input string
 * @returns {string} - Normalized lowercase trimmed string
 */
function norm(s) {
  return String(s ?? "").trim().toLowerCase();
}

/**
 * GraphQL query for fetching DEL issues by team
 */
const Q_ISSUES_BY_TEAM_AND_LABEL = `
query IssuesByTeamAndLabel($teamId: ID!, $labelId: ID!, $first: Int!, $after: String) {
  issues(first: $first, after: $after, filter: {
    team: { id: { eq: $teamId } },
    labels: { id: { eq: $labelId } }
  }) {
    nodes {
      id
      identifier
      title
      createdAt
      completedAt
      state { type name }
      labels { nodes { id name } }
      assignee { id name }
      project { id name }
    }
    pageInfo { hasNextPage endCursor }
  }
}
`;

/**
 * Fetch all DEL issues for a team (paginated)
 * @param {object} client - Linear GraphQL client with gql() method
 * @param {string} teamId - Team ID
 * @param {string} delLabelId - DEL label ID
 * @returns {Promise<Array>} - Array of issues
 */
async function fetchDELIssues(client, teamId, delLabelId) {
  const issues = [];
  let after = null;

  while (true) {
    const data = await client.gql(Q_ISSUES_BY_TEAM_AND_LABEL, {
      teamId,
      labelId: delLabelId,
      first: 100,
      after,
    });

    const conn = data.issues;
    issues.push(...(conn.nodes || []));

    if (!conn.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }

  return issues;
}

module.exports = {
  loadLabelIds,
  saveLabelIds,
  enrichIssuesWithLabels,
  filterCommittedIssues,
  countCompletedByCutoff,
  calculateDeliveryPct,
  extractDelTitle,
  norm,
  fetchDELIssues,
  Q_ISSUES_BY_TEAM_AND_LABEL,
};
