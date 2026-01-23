/* agent/src/projectAnalyzer.js
 * Unified analyzer that combines Slack discussions with Linear comments
 * Correlates by timestamps and generates cumulative summaries
 */

const { SlackClient } = require("./slackClient");
const { ProjectChannelMapper } = require("./projectChannelMapper");

class ProjectAnalyzer {
  constructor({ linearClient, slackClient }) {
    this.linearClient = linearClient;
    this.slackClient = slackClient;
    this.mapper = new ProjectChannelMapper({ linearClient });
  }

  /**
   * Analyze a single project - fetch both Slack and Linear data
   * @param {string} projectId - Linear project ID
   * @param {object} options - { daysBack, includeThreads }
   */
  async analyzeProject(projectId, options = {}) {
    const daysBack = options.daysBack || 14; // Default 2 weeks
    const includeThreads = options.includeThreads !== false;

    // Get project details and channel mapping
    const mapping = await this.mapper.buildMapping();
    const entry = mapping[projectId];

    if (!entry) {
      throw new Error(`Project ${projectId} not found or has no Slack channel configured`);
    }

    const { project, channelId } = entry;

    // Calculate time range
    const now = Date.now();
    const oldest = ((now - daysBack * 24 * 60 * 60 * 1000) / 1000).toString();

    // Fetch data in parallel
    const [slackData, linearData] = await Promise.all([
      this._fetchSlackData(channelId, { oldest, includeThreads }),
      this._fetchLinearData(projectId),
    ]);

    // Combine and sort by timestamp
    const timeline = this._buildTimeline(slackData, linearData);

    return {
      project,
      channelId,
      timeRange: {
        from: new Date(parseFloat(oldest) * 1000).toISOString(),
        to: new Date().toISOString(),
        daysBack,
      },
      slack: {
        messageCount: slackData.messages.length,
        threadCount: slackData.messages.filter(m => m.threadReplies?.length > 0).length,
        totalReplies: slackData.messages.reduce((sum, m) => sum + (m.threadReplies?.length || 0), 0),
        participants: slackData.participants,
      },
      linear: {
        issueCount: linearData.issues.length,
        commentCount: linearData.totalComments,
        participants: linearData.participants,
      },
      timeline,
    };
  }

  /**
   * Fetch Slack messages and threads
   */
  async _fetchSlackData(channelId, options) {
    try {
      // Join channel first (in case bot isn't a member)
      await this.slackClient.joinChannel(channelId);

      // Fetch messages with threads
      const messages = await this.slackClient.getMessagesWithThreads(channelId, {
        oldest: options.oldest,
        includeThreads: options.includeThreads,
        maxMessages: 200,
      });

      // Extract unique participants
      const userIds = SlackClient.extractUserIds(messages);

      return {
        messages,
        participants: userIds,
      };
    } catch (e) {
      console.warn(`Failed to fetch Slack data for ${channelId}: ${e.message}`);
      return { messages: [], participants: [] };
    }
  }

  /**
   * Fetch Linear issues and comments for a project
   */
  async _fetchLinearData(projectId) {
    try {
      // Get issues for the project
      const issues = await this.linearClient.getIssuesByProject(projectId);

      // Fetch comments for each issue
      const issuesWithComments = [];
      let totalComments = 0;
      const participants = new Set();

      for (const issue of issues) {
        const comments = await this.linearClient.getIssueComments(issue.id, 50);
        totalComments += comments.length;

        // Track participants
        if (issue.assignee?.name) participants.add(issue.assignee.name);
        for (const comment of comments) {
          if (comment.user?.name) participants.add(comment.user.name);
        }

        issuesWithComments.push({
          ...issue,
          comments,
        });
      }

      return {
        issues: issuesWithComments,
        totalComments,
        participants: [...participants],
      };
    } catch (e) {
      console.warn(`Failed to fetch Linear data for ${projectId}: ${e.message}`);
      return { issues: [], totalComments: 0, participants: [] };
    }
  }

  /**
   * Build unified timeline from Slack and Linear data
   */
  _buildTimeline(slackData, linearData) {
    const events = [];

    // Add Slack messages
    for (const msg of slackData.messages) {
      const ts = parseFloat(msg.ts) * 1000;

      events.push({
        type: "slack_message",
        timestamp: new Date(ts).toISOString(),
        timestampMs: ts,
        source: "slack",
        user: msg.user,
        text: this._truncateText(msg.text, 200),
        hasThread: (msg.threadReplies?.length || 0) > 0,
        replyCount: msg.threadReplies?.length || 0,
        reactions: msg.reactions?.map(r => r.name) || [],
      });

      // Add thread replies
      for (const reply of (msg.threadReplies || [])) {
        const replyTs = parseFloat(reply.ts) * 1000;
        events.push({
          type: "slack_reply",
          timestamp: new Date(replyTs).toISOString(),
          timestampMs: replyTs,
          source: "slack",
          user: reply.user,
          text: this._truncateText(reply.text, 200),
          parentTs: msg.ts,
        });
      }
    }

    // Add Linear comments
    for (const issue of linearData.issues) {
      for (const comment of issue.comments) {
        const ts = new Date(comment.createdAt).getTime();

        events.push({
          type: "linear_comment",
          timestamp: comment.createdAt,
          timestampMs: ts,
          source: "linear",
          user: comment.user?.name || "Unknown",
          text: this._truncateText(comment.body, 200),
          issueId: issue.identifier,
          issueTitle: issue.title,
        });
      }

      // Add issue state changes (using updatedAt as proxy)
      const issueTs = new Date(issue.updatedAt).getTime();
      events.push({
        type: "linear_issue_update",
        timestamp: issue.updatedAt,
        timestampMs: issueTs,
        source: "linear",
        issueId: issue.identifier,
        issueTitle: issue.title,
        state: issue.state?.name,
        assignee: issue.assignee?.name,
      });
    }

    // Sort by timestamp (newest first)
    events.sort((a, b) => b.timestampMs - a.timestampMs);

    return events;
  }

  /**
   * Truncate text to max length
   */
  _truncateText(text, maxLength) {
    if (!text) return "";
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + "...";
  }

  /**
   * Analyze all projects with Slack channels configured
   * @param {object} options - { daysBack, includeThreads }
   */
  async analyzeAllProjects(options = {}) {
    const projectsWithChannels = await this.mapper.getProjectsWithChannels();
    const results = [];

    for (const entry of projectsWithChannels) {
      try {
        const analysis = await this.analyzeProject(entry.project.id, options);
        results.push(analysis);
      } catch (e) {
        console.warn(`Failed to analyze project ${entry.project.name}: ${e.message}`);
        results.push({
          project: entry.project,
          channelId: entry.channelId,
          error: e.message,
        });
      }
    }

    return results;
  }

  /**
   * Generate a text summary for LLM consumption
   */
  generateSummaryText(analysis) {
    const lines = [];

    lines.push(`## Project: ${analysis.project.name}`);
    lines.push(`Slack Channel: ${analysis.channelId}`);
    lines.push(`Time Range: ${analysis.timeRange.from} to ${analysis.timeRange.to}`);
    lines.push("");

    lines.push("### Activity Summary");
    lines.push(`- Slack: ${analysis.slack.messageCount} messages, ${analysis.slack.totalReplies} thread replies`);
    lines.push(`- Linear: ${analysis.linear.issueCount} issues, ${analysis.linear.commentCount} comments`);
    lines.push("");

    lines.push("### Recent Activity Timeline (last 20 events)");
    const recentEvents = analysis.timeline.slice(0, 20);

    for (const event of recentEvents) {
      const time = event.timestamp.split("T")[0];

      if (event.type === "slack_message") {
        lines.push(`[${time}] Slack: ${event.text}`);
      } else if (event.type === "slack_reply") {
        lines.push(`[${time}] Slack reply: ${event.text}`);
      } else if (event.type === "linear_comment") {
        lines.push(`[${time}] Linear (${event.issueId}): ${event.text}`);
      } else if (event.type === "linear_issue_update") {
        lines.push(`[${time}] Linear ${event.issueId} - ${event.issueTitle} [${event.state}]`);
      }
    }

    return lines.join("\n");
  }

  /**
   * Generate structured data for KPI reporting
   */
  generateKPIData(analysis) {
    // Group events by day
    const byDay = {};

    for (const event of analysis.timeline) {
      const day = event.timestamp.split("T")[0];
      if (!byDay[day]) {
        byDay[day] = { slack: 0, linear: 0, total: 0 };
      }

      if (event.source === "slack") {
        byDay[day].slack++;
      } else {
        byDay[day].linear++;
      }
      byDay[day].total++;
    }

    return {
      projectId: analysis.project.id,
      projectName: analysis.project.name,
      channelId: analysis.channelId,
      summary: {
        slackMessages: analysis.slack.messageCount,
        slackThreads: analysis.slack.threadCount,
        slackReplies: analysis.slack.totalReplies,
        linearIssues: analysis.linear.issueCount,
        linearComments: analysis.linear.commentCount,
        totalEvents: analysis.timeline.length,
      },
      activityByDay: byDay,
      slackParticipants: analysis.slack.participants.length,
      linearParticipants: analysis.linear.participants.length,
    };
  }
}

module.exports = { ProjectAnalyzer };
