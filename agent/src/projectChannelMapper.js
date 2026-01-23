/* agent/src/projectChannelMapper.js
 * Maps Linear projects to Slack channels by detecting channel IDs in project labels
 * Channel IDs follow pattern: C followed by alphanumeric (e.g., C0A738HAPEC)
 */

const { LinearClient } = require("./linearClient");

// Slack channel ID pattern: starts with C, followed by alphanumeric, 8-11 chars total
const SLACK_CHANNEL_PATTERN = /^C[A-Z0-9]{8,11}$/;

class ProjectChannelMapper {
  constructor({ linearClient }) {
    this.linearClient = linearClient;
    this.cache = null;
    this.cacheTimestamp = null;
    this.cacheTTL = 5 * 60 * 1000; // 5 minutes
  }

  /**
   * Check if a label looks like a Slack channel ID
   */
  static isSlackChannelId(label) {
    return SLACK_CHANNEL_PATTERN.test(label);
  }

  /**
   * Extract Slack channel ID from project labels
   * Returns first matching channel ID or null
   */
  static extractChannelId(labels) {
    if (!labels || !Array.isArray(labels)) return null;

    for (const label of labels) {
      const name = typeof label === "string" ? label : label.name;
      if (name && ProjectChannelMapper.isSlackChannelId(name)) {
        return name;
      }
    }
    return null;
  }

  /**
   * Fetch all projects with their labels from Linear
   * Uses pagination to get all projects
   */
  async fetchProjectsWithLabels() {
    const allProjects = [];
    let hasMore = true;
    let cursor = null;

    while (hasMore) {
      const query = `
        query AllProjectsWithLabels($first: Int!, $after: String) {
          projects(first: $first, after: $after) {
            nodes {
              id
              name
              state
              targetDate
              lead { name }
              url
              labels {
                nodes {
                  name
                }
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      `;

      const variables = { first: 50 };
      if (cursor) variables.after = cursor;

      const data = await this.linearClient.gql(query, variables);
      const nodes = data.projects.nodes || [];
      allProjects.push(...nodes);

      hasMore = data.projects.pageInfo?.hasNextPage || false;
      cursor = data.projects.pageInfo?.endCursor || null;

      // Safety limit - max 500 projects
      if (allProjects.length >= 500) break;
    }

    return allProjects;
  }

  /**
   * Build mapping of projects to Slack channels
   * Returns: { projectId: { project, channelId }, ... }
   */
  async buildMapping() {
    // Check cache
    if (this.cache && this.cacheTimestamp &&
        (Date.now() - this.cacheTimestamp) < this.cacheTTL) {
      return this.cache;
    }

    const projects = await this.fetchProjectsWithLabels();
    const mapping = {};

    for (const project of projects) {
      const labels = project.labels?.nodes || [];
      const channelId = ProjectChannelMapper.extractChannelId(labels);

      if (channelId) {
        mapping[project.id] = {
          project: {
            id: project.id,
            name: project.name,
            state: project.state,
            targetDate: project.targetDate,
            lead: project.lead,
            url: project.url,
          },
          channelId,
          labels: labels.map(l => l.name),
        };
      }
    }

    // Update cache
    this.cache = mapping;
    this.cacheTimestamp = Date.now();

    return mapping;
  }

  /**
   * Get all projects that have Slack channels configured
   * Returns array of { project, channelId }
   */
  async getProjectsWithChannels() {
    const mapping = await this.buildMapping();
    return Object.values(mapping);
  }

  /**
   * Get Slack channel ID for a specific project
   */
  async getChannelForProject(projectId) {
    const mapping = await this.buildMapping();
    return mapping[projectId]?.channelId || null;
  }

  /**
   * Get project for a specific Slack channel
   */
  async getProjectForChannel(channelId) {
    const mapping = await this.buildMapping();
    for (const entry of Object.values(mapping)) {
      if (entry.channelId === channelId) {
        return entry.project;
      }
    }
    return null;
  }

  /**
   * Get all unique channel IDs
   */
  async getAllChannelIds() {
    const mapping = await this.buildMapping();
    return [...new Set(Object.values(mapping).map(e => e.channelId))];
  }

  /**
   * Filter projects by team name
   */
  async getProjectsWithChannelsByTeam(teamName) {
    const allProjects = await this.getProjectsWithChannels();
    const normalizedTeam = teamName.toLowerCase().trim();

    return allProjects.filter(entry => {
      const teams = entry.project.teams || [];
      return teams.some(t => t.name.toLowerCase().includes(normalizedTeam));
    });
  }

  /**
   * Clear the cache (force refresh on next call)
   */
  clearCache() {
    this.cache = null;
    this.cacheTimestamp = null;
  }

  /**
   * Get summary of all mappings (for debugging)
   */
  async getSummary() {
    const mapping = await this.buildMapping();
    const entries = Object.values(mapping);

    return {
      totalProjects: entries.length,
      projects: entries.map(e => ({
        name: e.project.name,
        channelId: e.channelId,
        state: e.project.state,
        lead: e.project.lead?.name || "Unassigned",
      })),
    };
  }
}

module.exports = { ProjectChannelMapper, SLACK_CHANNEL_PATTERN };
