/* agent/src/contextCaptureService.js
 *
 * Context Capture Service for Q1 Analysis
 *
 * Captures qualitative data to complement KPI metrics:
 * - Linear comments on DEL issues
 * - Linear project updates and descriptions
 * - Slack messages (when configured)
 *
 * This data helps answer "WHY" things went well or wrong,
 * not just "WHAT" the numbers were.
 */

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { getClient } = require("./liveLinear");
const { loadLabelIds } = require("./shared/labelUtils");
const { loadPodsConfig } = require("./shared/podsUtils");
const { SlackClient } = require("./slackClient");
const { ProjectChannelMapper } = require("./projectChannelMapper");

const STATE_DIR = path.join(process.cwd(), "state");
const DB_PATH = path.join(STATE_DIR, "kpi_state.db");

/* -------------------- DATABASE SETUP -------------------- */

function openContextDb() {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");

  // Linear comments table
  db.exec(`
    CREATE TABLE IF NOT EXISTS linear_comments (
      id TEXT PRIMARY KEY,
      issue_id TEXT NOT NULL,
      issue_identifier TEXT,
      issue_title TEXT,
      project_id TEXT,
      project_name TEXT,
      pod TEXT,
      cycle TEXT,
      author TEXT,
      body TEXT,
      created_at TEXT,
      captured_at TEXT DEFAULT (datetime('now')),
      sentiment TEXT,
      is_blocker INTEGER DEFAULT 0,
      is_risk INTEGER DEFAULT 0,
      is_decision INTEGER DEFAULT 0,
      keywords TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_comments_pod ON linear_comments(pod);
    CREATE INDEX IF NOT EXISTS idx_comments_cycle ON linear_comments(cycle);
    CREATE INDEX IF NOT EXISTS idx_comments_date ON linear_comments(created_at);
  `);

  // Project updates table (status changes, descriptions)
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      project_name TEXT,
      pod TEXT,
      update_type TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      description TEXT,
      captured_at TEXT DEFAULT (datetime('now')),
      UNIQUE(project_id, update_type, captured_at)
    );
    CREATE INDEX IF NOT EXISTS idx_project_updates_pod ON project_updates(pod);
  `);

  // Slack messages table
  db.exec(`
    CREATE TABLE IF NOT EXISTS slack_messages (
      id TEXT PRIMARY KEY,
      channel_id TEXT,
      channel_name TEXT,
      pod TEXT,
      cycle TEXT,
      author TEXT,
      text TEXT,
      thread_ts TEXT,
      ts TEXT,
      created_at TEXT,
      captured_at TEXT DEFAULT (datetime('now')),
      sentiment TEXT,
      is_blocker INTEGER DEFAULT 0,
      is_risk INTEGER DEFAULT 0,
      is_announcement INTEGER DEFAULT 0,
      keywords TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_slack_pod ON slack_messages(pod);
    CREATE INDEX IF NOT EXISTS idx_slack_date ON slack_messages(created_at);
  `);

  // DEL issue details (for richer context than just counts)
  db.exec(`
    CREATE TABLE IF NOT EXISTS del_issues (
      id TEXT PRIMARY KEY,
      identifier TEXT,
      title TEXT,
      pod TEXT,
      cycle TEXT,
      state TEXT,
      assignee TEXT,
      created_at TEXT,
      completed_at TEXT,
      due_date TEXT,
      description TEXT,
      labels TEXT,
      captured_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_del_pod_cycle ON del_issues(pod, cycle);
  `);

  return db;
}

/* -------------------- SENTIMENT & CLASSIFICATION -------------------- */

/**
 * Simple keyword-based sentiment/classification
 * In production, could use AI for better accuracy
 */
function classifyText(text) {
  const lower = (text || "").toLowerCase();

  const classification = {
    sentiment: "neutral",
    isBlocker: false,
    isRisk: false,
    isDecision: false,
    keywords: [],
  };

  // Blocker indicators
  const blockerWords = ["blocked", "blocker", "blocking", "stuck", "waiting on", "can't proceed", "dependency"];
  if (blockerWords.some(w => lower.includes(w))) {
    classification.isBlocker = true;
    classification.keywords.push("blocker");
  }

  // Risk indicators
  const riskWords = ["risk", "concern", "worried", "might slip", "delayed", "behind schedule", "issue"];
  if (riskWords.some(w => lower.includes(w))) {
    classification.isRisk = true;
    classification.keywords.push("risk");
  }

  // Decision indicators
  const decisionWords = ["decided", "decision", "agreed", "confirmed", "approved", "will do", "going with"];
  if (decisionWords.some(w => lower.includes(w))) {
    classification.isDecision = true;
    classification.keywords.push("decision");
  }

  // Positive sentiment
  const positiveWords = ["done", "completed", "shipped", "launched", "fixed", "resolved", "great", "excellent", "ahead"];
  if (positiveWords.some(w => lower.includes(w))) {
    classification.sentiment = "positive";
  }

  // Negative sentiment
  const negativeWords = ["failed", "broken", "bug", "error", "problem", "issue", "delayed", "missed"];
  if (negativeWords.some(w => lower.includes(w))) {
    classification.sentiment = "negative";
  }

  return classification;
}

/* -------------------- LINEAR COMMENTS CAPTURE -------------------- */

/**
 * Capture comments from all DEL issues for a pod
 */
async function captureDELComments(db, pod, teamId, cycle = null) {
  const client = getClient();
  const labelIds = loadLabelIds();
  const delLabelId = labelIds?.DEL;

  if (!delLabelId) {
    console.log(`[CONTEXT] No DEL label found, skipping comments for ${pod}`);
    return { captured: 0 };
  }

  console.log(`[CONTEXT] Fetching DEL issues for ${pod}...`);

  // Fetch DEL issues for this team
  const query = `
    query DelIssuesWithComments($teamId: ID!, $delLabelId: ID!, $first: Int!) {
      issues(first: $first, filter: {
        team: { id: { eq: $teamId } },
        labels: { id: { eq: $delLabelId } }
      }) {
        nodes {
          id
          identifier
          title
          state { name type }
          assignee { name }
          createdAt
          completedAt
          dueDate
          description
          labels { nodes { id name } }
          project { id name }
          comments(first: 50) {
            nodes {
              id
              body
              createdAt
              user { name }
            }
          }
        }
      }
    }
  `;

  const data = await client.gql(query, { teamId, delLabelId, first: 100 });
  const issues = data?.issues?.nodes || [];

  console.log(`[CONTEXT] Found ${issues.length} DEL issues for ${pod}`);

  const insertComment = db.prepare(`
    INSERT OR REPLACE INTO linear_comments
    (id, issue_id, issue_identifier, issue_title, project_id, project_name,
     pod, cycle, author, body, created_at, sentiment, is_blocker, is_risk, is_decision, keywords)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertDel = db.prepare(`
    INSERT OR REPLACE INTO del_issues
    (id, identifier, title, pod, cycle, state, assignee, created_at, completed_at, due_date, description, labels)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let capturedComments = 0;

  const tx = db.transaction(() => {
    for (const issue of issues) {
      // Determine cycle from labels
      const issueLabels = (issue.labels?.nodes || []).map(l => l.name);
      let issueCycle = cycle;
      for (const label of issueLabels) {
        const match = label.match(/2026Q1-C(\d)/i);
        if (match) {
          issueCycle = `C${match[1]}`;
          break;
        }
      }

      // Store DEL issue details
      insertDel.run(
        issue.id,
        issue.identifier,
        issue.title,
        pod,
        issueCycle,
        issue.state?.name,
        issue.assignee?.name,
        issue.createdAt,
        issue.completedAt,
        issue.dueDate,
        (issue.description || "").substring(0, 5000),
        JSON.stringify(issueLabels)
      );

      // Store comments
      const comments = issue.comments?.nodes || [];
      for (const comment of comments) {
        const classification = classifyText(comment.body);

        insertComment.run(
          comment.id,
          issue.id,
          issue.identifier,
          issue.title,
          issue.project?.id,
          issue.project?.name,
          pod,
          issueCycle,
          comment.user?.name,
          comment.body,
          comment.createdAt,
          classification.sentiment,
          classification.isBlocker ? 1 : 0,
          classification.isRisk ? 1 : 0,
          classification.isDecision ? 1 : 0,
          JSON.stringify(classification.keywords)
        );

        capturedComments++;
      }
    }
  });

  tx();

  console.log(`[CONTEXT] Captured ${capturedComments} comments for ${pod}`);
  return { captured: capturedComments, issues: issues.length };
}

/**
 * Capture comments from all project issues
 */
async function captureProjectComments(db, pod, projectId, projectName) {
  const client = getClient();

  console.log(`[CONTEXT] Fetching issues for project: ${projectName}...`);

  const query = `
    query ProjectIssuesWithComments($projectId: ID!, $first: Int!) {
      issues(first: $first, filter: { project: { id: { eq: $projectId } } }) {
        nodes {
          id
          identifier
          title
          state { name type }
          labels { nodes { name } }
          comments(first: 30) {
            nodes {
              id
              body
              createdAt
              user { name }
            }
          }
        }
      }
    }
  `;

  const data = await client.gql(query, { projectId, first: 100 });
  const issues = data?.issues?.nodes || [];

  const insertComment = db.prepare(`
    INSERT OR REPLACE INTO linear_comments
    (id, issue_id, issue_identifier, issue_title, project_id, project_name,
     pod, cycle, author, body, created_at, sentiment, is_blocker, is_risk, is_decision, keywords)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let capturedComments = 0;

  const tx = db.transaction(() => {
    for (const issue of issues) {
      const comments = issue.comments?.nodes || [];
      for (const comment of comments) {
        const classification = classifyText(comment.body);

        insertComment.run(
          comment.id,
          issue.id,
          issue.identifier,
          issue.title,
          projectId,
          projectName,
          pod,
          null, // cycle determined by issue labels if needed
          comment.user?.name,
          comment.body,
          comment.createdAt,
          classification.sentiment,
          classification.isBlocker ? 1 : 0,
          classification.isRisk ? 1 : 0,
          classification.isDecision ? 1 : 0,
          JSON.stringify(classification.keywords)
        );

        capturedComments++;
      }
    }
  });

  tx();

  return { captured: capturedComments };
}

/* -------------------- PROJECT UPDATES CAPTURE -------------------- */

/**
 * Capture project status/description as an update
 */
function captureProjectUpdate(db, projectId, projectName, pod, updateType, oldValue, newValue, description = null) {
  const insert = db.prepare(`
    INSERT INTO project_updates
    (project_id, project_name, pod, update_type, old_value, new_value, description)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  insert.run(projectId, projectName, pod, updateType, oldValue, newValue, description);
  console.log(`[CONTEXT] Project update captured: ${projectName} - ${updateType}`);
}

/* -------------------- SLACK INTEGRATION -------------------- */

/**
 * Slack message capture using existing SlackClient
 * Fetches messages from specified channels
 */
async function captureSlackMessages(db, channelId, channelName, pod = null, cycle = null, options = {}) {
  const slackToken = process.env.SLACK_BOT_TOKEN;

  if (!slackToken) {
    console.log("[CONTEXT] SLACK_BOT_TOKEN not set, skipping Slack capture");
    return { captured: 0, error: "SLACK_BOT_TOKEN not configured" };
  }

  const { oldest, latest, limit = 100, includeThreads = false } = options;

  console.log(`[CONTEXT] Fetching Slack messages from #${channelName}...`);

  try {
    const slack = new SlackClient({ botToken: slackToken });

    // Get messages (optionally with threads)
    const messages = includeThreads
      ? await slack.getMessagesWithThreads(channelId, { oldest, latest, maxMessages: limit, includeThreads: true })
      : await slack.getAllMessages(channelId, { oldest, latest, maxMessages: limit });

    console.log(`[CONTEXT] Found ${messages.length} Slack messages`);

    const insertMessage = db.prepare(`
      INSERT OR REPLACE INTO slack_messages
      (id, channel_id, channel_name, pod, cycle, author, text, thread_ts, ts, created_at,
       sentiment, is_blocker, is_risk, is_announcement, keywords)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let captured = 0;

    const tx = db.transaction(() => {
      for (const msg of messages) {
        // Skip bot messages and join/leave messages
        if (msg.subtype && ["bot_message", "channel_join", "channel_leave"].includes(msg.subtype)) {
          continue;
        }

        const classification = classifyText(msg.text);
        const createdAt = SlackClient.formatTimestamp(msg.ts);

        // Check for announcements (messages with many reactions or in announcement format)
        const isAnnouncement = (msg.reactions?.length > 3) ||
                               (msg.text?.startsWith(":") && msg.text?.includes("announcement"));

        insertMessage.run(
          `${channelId}_${msg.ts}`,
          channelId,
          channelName,
          pod,
          cycle,
          msg.user,
          msg.text,
          msg.thread_ts || null,
          msg.ts,
          createdAt,
          classification.sentiment,
          classification.isBlocker ? 1 : 0,
          classification.isRisk ? 1 : 0,
          isAnnouncement ? 1 : 0,
          JSON.stringify(classification.keywords)
        );

        captured++;

        // Also capture thread replies if included
        if (msg.threadReplies && msg.threadReplies.length > 0) {
          for (const reply of msg.threadReplies) {
            const replyClassification = classifyText(reply.text);
            const replyCreatedAt = SlackClient.formatTimestamp(reply.ts);

            insertMessage.run(
              `${channelId}_${reply.ts}`,
              channelId,
              channelName,
              pod,
              cycle,
              reply.user,
              reply.text,
              msg.ts, // parent thread ts
              reply.ts,
              replyCreatedAt,
              replyClassification.sentiment,
              replyClassification.isBlocker ? 1 : 0,
              replyClassification.isRisk ? 1 : 0,
              0, // thread replies are not announcements
              JSON.stringify(replyClassification.keywords)
            );

            captured++;
          }
        }
      }
    });

    tx();

    console.log(`[CONTEXT] Captured ${captured} Slack messages from #${channelName}`);
    return { captured };

  } catch (error) {
    console.error(`[CONTEXT] Slack fetch error:`, error.message);
    return { captured: 0, error: error.message };
  }
}

/**
 * Capture Slack messages for all projects that have channel mappings
 * Uses the ProjectChannelMapper to find project->channel relationships
 */
async function captureSlackForAllProjects(db, options = {}) {
  const slackToken = process.env.SLACK_BOT_TOKEN;

  if (!slackToken) {
    console.log("[CONTEXT] SLACK_BOT_TOKEN not set, skipping Slack capture");
    return { captured: 0, error: "SLACK_BOT_TOKEN not configured" };
  }

  const linearClient = getClient();
  const mapper = new ProjectChannelMapper({ linearClient });

  console.log("[CONTEXT] Building project-to-channel mapping...");
  const projectsWithChannels = await mapper.getProjectsWithChannels();

  console.log(`[CONTEXT] Found ${projectsWithChannels.length} projects with Slack channels`);

  const results = {
    total_captured: 0,
    projects: [],
  };

  for (const entry of projectsWithChannels) {
    const { project, channelId } = entry;

    console.log(`[CONTEXT] Capturing from ${project.name} -> ${channelId}`);

    try {
      const result = await captureSlackMessages(
        db,
        channelId,
        project.name, // Use project name as channel name for context
        null, // Pod could be determined from project if needed
        null,
        { limit: options.limit || 100, includeThreads: options.includeThreads }
      );

      results.projects.push({
        project: project.name,
        channelId,
        captured: result.captured,
        error: result.error,
      });

      results.total_captured += result.captured || 0;

    } catch (error) {
      results.projects.push({
        project: project.name,
        channelId,
        captured: 0,
        error: error.message,
      });
    }
  }

  console.log(`[CONTEXT] Total Slack messages captured: ${results.total_captured}`);
  return results;
}

/* -------------------- BULK CAPTURE -------------------- */

/**
 * Capture all context for all pods
 * Run this weekly alongside your KPI capture
 */
async function captureAllContext(currentCycle = null) {
  const db = openContextDb();
  const podsConfig = loadPodsConfig();

  if (!podsConfig) {
    console.error("[CONTEXT] No pods configuration found");
    return { error: "MISSING_PODS_CONFIG" };
  }

  const results = {
    captured_at: new Date().toISOString(),
    pods: {},
    totals: { comments: 0, issues: 0 },
  };

  for (const [podName, pod] of Object.entries(podsConfig.pods)) {
    if (!pod.teamId) {
      console.log(`[CONTEXT] Skipping ${podName} - no teamId`);
      continue;
    }

    try {
      const delResult = await captureDELComments(db, podName, pod.teamId, currentCycle);
      results.pods[podName] = delResult;
      results.totals.comments += delResult.captured;
      results.totals.issues += delResult.issues || 0;
    } catch (error) {
      console.error(`[CONTEXT] Error capturing ${podName}:`, error.message);
      results.pods[podName] = { error: error.message };
    }
  }

  db.close();

  console.log(`\n[CONTEXT] Capture complete: ${results.totals.comments} comments from ${results.totals.issues} issues`);
  return results;
}

/* -------------------- QUERY FUNCTIONS -------------------- */

/**
 * Get all comments related to blockers
 */
function getBlockerComments(db, pod = null, cycle = null) {
  let query = `SELECT * FROM linear_comments WHERE is_blocker = 1`;
  const params = [];

  if (pod) {
    query += ` AND pod = ?`;
    params.push(pod);
  }
  if (cycle) {
    query += ` AND cycle = ?`;
    params.push(cycle);
  }

  query += ` ORDER BY created_at DESC`;
  return db.prepare(query).all(...params);
}

/**
 * Get all comments related to risks
 */
function getRiskComments(db, pod = null, cycle = null) {
  let query = `SELECT * FROM linear_comments WHERE is_risk = 1`;
  const params = [];

  if (pod) {
    query += ` AND pod = ?`;
    params.push(pod);
  }
  if (cycle) {
    query += ` AND cycle = ?`;
    params.push(cycle);
  }

  query += ` ORDER BY created_at DESC`;
  return db.prepare(query).all(...params);
}

/**
 * Get key decisions from comments
 */
function getDecisionComments(db, pod = null) {
  let query = `SELECT * FROM linear_comments WHERE is_decision = 1`;
  const params = [];

  if (pod) {
    query += ` AND pod = ?`;
    params.push(pod);
  }

  query += ` ORDER BY created_at DESC`;
  return db.prepare(query).all(...params);
}

/**
 * Get all DEL issues with details
 */
function getDELIssues(db, pod = null, cycle = null) {
  let query = `SELECT * FROM del_issues WHERE 1=1`;
  const params = [];

  if (pod) {
    query += ` AND pod = ?`;
    params.push(pod);
  }
  if (cycle) {
    query += ` AND cycle = ?`;
    params.push(cycle);
  }

  query += ` ORDER BY created_at DESC`;
  return db.prepare(query).all(...params);
}

/**
 * Get Slack messages with filters
 */
function getSlackMessages(db, options = {}) {
  let query = `SELECT * FROM slack_messages WHERE 1=1`;
  const params = [];

  if (options.pod) {
    query += ` AND pod = ?`;
    params.push(options.pod);
  }
  if (options.channel) {
    query += ` AND channel_name = ?`;
    params.push(options.channel);
  }
  if (options.isBlocker) {
    query += ` AND is_blocker = 1`;
  }
  if (options.startDate) {
    query += ` AND created_at >= ?`;
    params.push(options.startDate);
  }

  query += ` ORDER BY created_at DESC LIMIT ?`;
  params.push(options.limit || 100);

  return db.prepare(query).all(...params);
}

/**
 * Get context summary for Q1 analysis
 */
function getContextSummary(db) {
  const summary = {
    total_comments: 0,
    total_del_issues: 0,
    total_slack_messages: 0,
    blockers_mentioned: 0,
    risks_mentioned: 0,
    decisions_made: 0,
    by_pod: {},
  };

  // Total counts
  summary.total_comments = db.prepare(`SELECT COUNT(*) as cnt FROM linear_comments`).get().cnt;
  summary.total_del_issues = db.prepare(`SELECT COUNT(*) as cnt FROM del_issues`).get().cnt;
  summary.total_slack_messages = db.prepare(`SELECT COUNT(*) as cnt FROM slack_messages`).get().cnt;
  summary.blockers_mentioned = db.prepare(`SELECT COUNT(*) as cnt FROM linear_comments WHERE is_blocker = 1`).get().cnt;
  summary.risks_mentioned = db.prepare(`SELECT COUNT(*) as cnt FROM linear_comments WHERE is_risk = 1`).get().cnt;
  summary.decisions_made = db.prepare(`SELECT COUNT(*) as cnt FROM linear_comments WHERE is_decision = 1`).get().cnt;

  // By pod
  const pods = db.prepare(`SELECT DISTINCT pod FROM linear_comments WHERE pod IS NOT NULL`).all();
  for (const { pod } of pods) {
    summary.by_pod[pod] = {
      comments: db.prepare(`SELECT COUNT(*) as cnt FROM linear_comments WHERE pod = ?`).get(pod).cnt,
      blockers: db.prepare(`SELECT COUNT(*) as cnt FROM linear_comments WHERE pod = ? AND is_blocker = 1`).get(pod).cnt,
      risks: db.prepare(`SELECT COUNT(*) as cnt FROM linear_comments WHERE pod = ? AND is_risk = 1`).get(pod).cnt,
    };
  }

  return summary;
}

/* -------------------- EXPORTS -------------------- */

module.exports = {
  openContextDb,
  captureDELComments,
  captureProjectComments,
  captureProjectUpdate,
  captureSlackMessages,
  captureSlackForAllProjects,
  captureAllContext,
  getBlockerComments,
  getRiskComments,
  getDecisionComments,
  getDELIssues,
  getSlackMessages,
  getContextSummary,
  classifyText,
};
