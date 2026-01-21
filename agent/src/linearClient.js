/* agent/src/linearClient.js
 * Minimal Linear GraphQL client
 */
class LinearClient {
  constructor({ apiKey, url }) {
    this.apiKey = apiKey;
    this.url = url || "https://api.linear.app/graphql";
  }

  async gql(query, variables = {}) {
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        "Authorization": this.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });

    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.errors) {
      const errMsg =
        json?.errors?.[0]?.message ||
        `Linear GraphQL error (HTTP ${res.status})`;
      const e = new Error(errMsg);
      e.details = json;
      throw e;
    }
    return json.data;
  }

  // Fetch team IDs by name (useful if you don't have teamId yet)
  async findTeamByName(name) {
    const query = `
      query Teams($first: Int!) {
        teams(first: $first) {
          nodes { id name }
        }
      }
    `;
    const data = await this.gql(query, { first: 250 });
    const t = data.teams.nodes.find((x) => x.name.toLowerCase() === name.toLowerCase());
    return t || null;
  }

  // Fetch projects by initiative ID (the correct Linear API approach)
  async getProjectsByInitiative(initiativeId) {
    const query = `
      query ProjectsByInitiative($initiativeId: ID!, $first: Int!) {
        projects(first: $first, filter: { initiatives: { id: { eq: $initiativeId } } }) {
          nodes {
            id
            name
            state
            startDate
            targetDate
            lead { id name }
            url
            updatedAt
          }
        }
      }
    `;
    const data = await this.gql(query, { initiativeId, first: 200 });
    return data.projects.nodes || [];
  }

  // Fetch ALL projects with initiative info (for name-based filtering)
  // Note: This is a heavier query, use only when initiativeId is not available
  async getAllProjectsWithInitiatives() {
    const query = `
      query AllProjects($first: Int!) {
        projects(first: $first) {
          nodes {
            id
            name
            state
            startDate
            targetDate
            lead { id name }
            url
            updatedAt
            initiatives {
              nodes {
                id
                name
              }
            }
          }
        }
      }
    `;
    const data = await this.gql(query, { first: 100 }); // Lower limit due to complexity
    return data.projects.nodes || [];
  }

  // Fetch all initiatives (roadmaps) in the organization
  async getInitiatives() {
    const query = `
      query Initiatives($first: Int!) {
        initiatives(first: $first) {
          nodes {
            id
            name
          }
        }
      }
    `;
    const data = await this.gql(query, { first: 200 });
    return data.initiatives.nodes || [];
  }

  // Issues for a team (optional: blockers, risks)
  async getIssuesByTeam(teamId) {
    const query = `
      query IssuesByTeam($teamId: ID!, $first: Int!) {
        issues(first: $first, filter: { team: { id: { eq: $teamId } } }) {
          nodes {
            id
            identifier
            title
            url
            priority
            state { name type }
            assignee { name }
            updatedAt
            createdAt
            dueDate
            labels { nodes { name } }
          }
        }
      }
    `;
    const data = await this.gql(query, { teamId, first: 250 });
    return data.issues.nodes || [];
  }

  // Issues for a specific project
  async getIssuesByProject(projectId) {
    const query = `
      query IssuesByProject($projectId: ID!, $first: Int!) {
        issues(first: $first, filter: { project: { id: { eq: $projectId } } }) {
          nodes {
            id
            identifier
            title
            url
            priority
            state { name type }
            assignee { name }
            updatedAt
            createdAt
            dueDate
            labels { nodes { name } }
            description
          }
        }
      }
    `;
    const data = await this.gql(query, { projectId, first: 100 });
    return data.issues.nodes || [];
  }

  // Get project by ID with full details
  async getProjectById(projectId) {
    const query = `
      query ProjectById($projectId: String!) {
        project(id: $projectId) {
          id
          name
          state
          description
          startDate
          targetDate
          lead { id name }
          url
          updatedAt
          createdAt
        }
      }
    `;
    const data = await this.gql(query, { projectId });
    return data.project || null;
  }

  // Get comments for an issue
  async getIssueComments(issueId, limit = 20) {
    const query = `
      query IssueComments($issueId: String!, $first: Int!) {
        issue(id: $issueId) {
          id
          title
          comments(first: $first) {
            nodes {
              id
              body
              createdAt
              updatedAt
              user { name }
            }
          }
        }
      }
    `;
    const data = await this.gql(query, { issueId, first: limit });
    return data.issue?.comments?.nodes || [];
  }

}

module.exports = { LinearClient };
