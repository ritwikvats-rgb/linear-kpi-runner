# Linear KPI Runner - Technical Implementation Notes

## Table of Contents
1. [System Overview](#system-overview)
2. [Architecture Diagram](#architecture-diagram)
3. [Component Architecture](#component-architecture)
4. [Data Flow](#data-flow)
5. [Core Modules](#core-modules)
6. [KPI Computation Logic](#kpi-computation-logic)
7. [Caching Strategy](#caching-strategy)
8. [Configuration Management](#configuration-management)
9. [API Reference](#api-reference)
10. [Database Schema](#database-schema)

---

## System Overview

Linear KPI Runner is an intelligent CLI-based KPI tracking system for engineering teams using Linear project management. It provides:

- **DEL KPI**: Delivery Excellence Level metrics (Committed vs Completed deliverables)
- **Feature Movement**: Project state tracking (Done/In-Flight/Not Started)
- **Live Queries**: Real-time Linear API integration
- **Snapshot System**: Point-in-time data capture for historical analysis

### Tech Stack
- **Runtime**: Node.js (ES6+)
- **Database**: SQLite (better-sqlite3)
- **API**: Linear GraphQL API
- **LLM**: Fuelix API (GPT-5.2) for natural language queries
- **Cache**: File-based TTL cache

---

## Architecture Diagram

### High-Level System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           LINEAR KPI RUNNER                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────────────────────┐ │
│  │   CLI REPL   │     │   Scripts    │     │      External APIs           │ │
│  │  (index.js)  │     │              │     │                              │ │
│  └──────┬───────┘     │ ┌──────────┐ │     │  ┌────────┐  ┌────────────┐  │ │
│         │             │ │ generate │ │     │  │ Linear │  │  Fuelix    │  │ │
│         │             │ │ Snapshot │ │     │  │GraphQL │  │  LLM API   │  │ │
│         │             │ └────┬─────┘ │     │  │  API   │  │            │  │ │
│         │             │      │       │     │  └───┬────┘  └─────┬──────┘  │ │
│         │             │ ┌────┴─────┐ │     │      │             │         │ │
│         │             │ │runWeekly │ │     └──────┼─────────────┼─────────┘ │
│         │             │ │   Kpi    │ │            │             │           │
│         │             │ └────┬─────┘ │            │             │           │
│         │             └──────┼───────┘            │             │           │
│         │                    │                    │             │           │
│  ┌──────▼────────────────────▼────────────────────▼─────────────▼────────┐  │
│  │                        CORE ENGINE                                     │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐   │  │
│  │  │  Answerer   │  │ KPI Computer│  │ Live Linear │  │   Cache     │   │  │
│  │  │   Engine    │◄─┤   Engine    │◄─┤   Fetcher   │◄─┤   System    │   │  │
│  │  └─────────────┘  └─────────────┘  └──────┬──────┘  └─────────────┘   │  │
│  │         │                                  │                           │  │
│  │         │              ┌───────────────────┴───────────────┐          │  │
│  │         │              │                                   │          │  │
│  │  ┌──────▼──────┐  ┌────▼─────┐  ┌─────────────┐  ┌────────▼───────┐  │  │
│  │  │   Prompt    │  │  Linear  │  │   Config    │  │    Fuelix      │  │  │
│  │  │  Templates  │  │  Client  │  │   Loader    │  │    Client      │  │  │
│  │  └─────────────┘  └────┬─────┘  └──────┬──────┘  └────────────────┘  │  │
│  └────────────────────────┼───────────────┼──────────────────────────────┘  │
│                           │               │                                  │
│  ┌────────────────────────▼───────────────▼──────────────────────────────┐  │
│  │                        DATA LAYER                                      │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐   │  │
│  │  │   SQLite    │  │  Snapshot   │  │   Config    │  │   Cache     │   │  │
│  │  │  Database   │  │    JSON     │  │    Files    │  │   Files     │   │  │
│  │  │ (state/db)  │  │  (output/)  │  │  (config/)  │  │ (cache/)    │   │  │
│  │  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘   │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Module Dependency Graph

```
                              ┌─────────────┐
                              │   index.js  │
                              │   (REPL)    │
                              └──────┬──────┘
                                     │
                    ┌────────────────┼────────────────┐
                    │                │                │
                    ▼                ▼                ▼
             ┌──────────┐    ┌──────────────┐  ┌───────────┐
             │ kpiStore │    │  answerer.js │  │  cache.js │
             └──────────┘    └───────┬──────┘  └───────────┘
                                     │
              ┌──────────────────────┼──────────────────────┐
              │                      │                      │
              ▼                      ▼                      ▼
       ┌─────────────┐       ┌─────────────┐        ┌──────────────┐
       │ liveLinear  │       │ kpiComputer │        │ fuelixClient │
       └──────┬──────┘       └──────┬──────┘        └──────────────┘
              │                     │                       │
              │         ┌───────────┴───────────┐          │
              │         │                       │          │
              ▼         ▼                       ▼          ▼
       ┌─────────────────────┐          ┌──────────┐  ┌────────┐
       │   linearClient.js   │          │ cache.js │  │prompt.js│
       └─────────────────────┘          └──────────┘  └────────┘
              │
              ▼
       ┌─────────────┐
       │configLoader │
       └─────────────┘
```

### Data Flow Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         USER INPUT FLOW                                  │
└─────────────────────────────────────────────────────────────────────────┘

  User Input          Command           Answer              Output
      │                Parser            Engine               │
      │                  │                 │                  │
      ▼                  ▼                 ▼                  ▼
┌──────────┐      ┌────────────┐    ┌────────────┐    ┌────────────┐
│  "kpi"   │─────▶│ parseCmd() │───▶│ answer()   │───▶│ Formatted  │
│  "pod X" │      │            │    │            │    │  Output    │
│  "proj Y"│      │ type:      │    │ switch on  │    │            │
└──────────┘      │ combined_  │    │ cmd.type   │    │ Markdown   │
                  │ kpi        │    │            │    │ Tables     │
                  └────────────┘    └─────┬──────┘    └────────────┘
                                          │
                        ┌─────────────────┼─────────────────┐
                        │                 │                 │
                        ▼                 ▼                 ▼
                 ┌────────────┐   ┌────────────┐   ┌────────────┐
                 │ Snapshot   │   │ Live API   │   │ LLM Query  │
                 │ Lookup     │   │ Fetch      │   │ (Fuelix)   │
                 └────────────┘   └────────────┘   └────────────┘


┌─────────────────────────────────────────────────────────────────────────┐
│                         KPI COMPUTATION FLOW                             │
└─────────────────────────────────────────────────────────────────────────┘

┌──────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│  Config  │───▶│ Load Pods &  │───▶│ Fetch DEL    │───▶│  Compute     │
│  Files   │    │ Label IDs    │    │ Issues       │    │  Metrics     │
└──────────┘    └──────────────┘    └──────────────┘    └──────┬───────┘
                                                               │
     ┌─────────────────────────────────────────────────────────┘
     │
     ▼
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│  For Each    │───▶│ Count        │───▶│ Calculate    │
│  Cycle C1-C6 │    │ Committed/   │    │ Delivery %   │
│              │    │ Completed    │    │ & Spillover  │
└──────────────┘    └──────────────┘    └──────────────┘
                                               │
                                               ▼
                                        ┌──────────────┐
                                        │ Format Table │
                                        │ + Insights   │
                                        └──────────────┘
```

---

## Component Architecture

### 1. CLI Layer (`agent/src/index.js`)

```
┌─────────────────────────────────────────┐
│              index.js                    │
├─────────────────────────────────────────┤
│  - REPL interface (readline)            │
│  - Command routing                       │
│  - Slash commands (/help, /refresh)     │
│  - Answer logging                        │
├─────────────────────────────────────────┤
│  Dependencies:                           │
│  ├─ answerer.js                         │
│  ├─ kpiStore.js                         │
│  ├─ cache.js                            │
│  └─ liveLinear.js                       │
└─────────────────────────────────────────┘
```

### 2. Answer Engine (`agent/src/answerer.js`)

```
┌─────────────────────────────────────────┐
│            answerer.js                   │
├─────────────────────────────────────────┤
│  COMMAND PARSER                          │
│  ┌───────────────────────────────────┐  │
│  │ parseCommand(input)               │  │
│  │  → combined_kpi | weekly_kpi      │  │
│  │  → pod_summary | pod_projects     │  │
│  │  → project_detail | blockers      │  │
│  │  → project_comments | deep_dive   │  │
│  └───────────────────────────────────┘  │
├─────────────────────────────────────────┤
│  ANSWER STRATEGIES                       │
│  ┌───────────────────────────────────┐  │
│  │ 1. Deterministic (snapshot-based) │  │
│  │ 2. Live API fetch                 │  │
│  │ 3. LLM fallback                   │  │
│  └───────────────────────────────────┘  │
├─────────────────────────────────────────┤
│  FORMATTERS                              │
│  ├─ formatPodSummary()                  │
│  ├─ formatProjectList()                 │
│  ├─ formatProjectDetail()               │
│  ├─ formatBlockers()                    │
│  └─ formatPodsList()                    │
└─────────────────────────────────────────┘
```

### 3. KPI Computer (`agent/src/kpiComputer.js`)

```
┌─────────────────────────────────────────┐
│           kpiComputer.js                 │
├─────────────────────────────────────────┤
│  COMPUTATION FUNCTIONS                   │
│  ┌───────────────────────────────────┐  │
│  │ computeCycleKpi()                 │  │
│  │  └─ DEL metrics per pod/cycle    │  │
│  │                                    │  │
│  │ computeFeatureMovement()          │  │
│  │  └─ Project states per pod       │  │
│  │                                    │  │
│  │ computeCombinedKpi()              │  │
│  │  └─ Both + project summaries     │  │
│  └───────────────────────────────────┘  │
├─────────────────────────────────────────┤
│  FORMATTERS                              │
│  ├─ formatCycleKpiTable()               │
│  ├─ formatFeatureMovementTable()        │
│  ├─ formatCombinedKpiOutput()           │
│  └─ generateInsights()                  │
├─────────────────────────────────────────┤
│  HELPERS                                 │
│  ├─ getCycleKeyByDate()                 │
│  ├─ isCycleActive()                     │
│  └─ getBestCycleByCommitted()           │
└─────────────────────────────────────────┘
```

### 4. Linear Client (`agent/src/linearClient.js`)

```
┌─────────────────────────────────────────┐
│          linearClient.js                 │
├─────────────────────────────────────────┤
│  class LinearClient                      │
│  ┌───────────────────────────────────┐  │
│  │ constructor({ apiKey, url })      │  │
│  │                                    │  │
│  │ gql(query, variables)             │  │
│  │  └─ Execute GraphQL query         │  │
│  │                                    │  │
│  │ findTeamByName(name)              │  │
│  │ getProjectsByInitiative(id)       │  │
│  │ getIssuesByTeam(teamId)           │  │
│  │ getIssuesByProject(projectId)     │  │
│  │ getProjectById(projectId)         │  │
│  │ getIssueComments(issueId, limit)  │  │
│  │ searchProjects(query, limit)      │  │
│  └───────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

### 5. Live Linear Layer (`agent/src/liveLinear.js`)

```
┌─────────────────────────────────────────┐
│           liveLinear.js                  │
├─────────────────────────────────────────┤
│  SINGLETON MANAGEMENT                    │
│  ├─ getClient()  → LinearClient         │
│  └─ getConfig()  → Config object        │
├─────────────────────────────────────────┤
│  LIVE DATA FUNCTIONS (cached)            │
│  ┌───────────────────────────────────┐  │
│  │ getLiveProjects(podName)          │  │
│  │ getLiveProject(pod, projectQuery) │  │
│  │ getLiveBlockers(pod, project)     │  │
│  │ getLiveComments(pod, proj, days)  │  │
│  │ getLivePodSummary(podName)        │  │
│  │ listPods()                        │  │
│  └───────────────────────────────────┘  │
├─────────────────────────────────────────┤
│  UTILITIES                               │
│  ├─ normalizeState()                    │
│  ├─ classifyIssue()                     │
│  ├─ scoreProjectMatch()                 │
│  └─ fuzzyMatchProject()                 │
└─────────────────────────────────────────┘
```

---

## Data Flow

### 1. KPI Query Flow

```
User: "kpi"
    │
    ▼
┌─────────────────┐
│ parseCommand()  │──────▶ { type: "combined_kpi" }
└─────────────────┘
    │
    ▼
┌─────────────────┐
│ answer()        │──────▶ switch(cmd.type)
└─────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────┐
│ computeCombinedKpi()                                    │
│  ├─ loadLabelIds()  ──────▶ config/label_ids.json      │
│  ├─ loadCycleCalendar() ──▶ config/cycle_calendar.json │
│  ├─ loadPodsConfig() ─────▶ config/linear_ids.json     │
│  │                                                      │
│  ├─ For each pod:                                       │
│  │   └─ fetchDELIssues(teamId, delLabelId)             │
│  │       └─ LinearClient.gql() with pagination         │
│  │                                                      │
│  ├─ For each cycle C1-C6:                              │
│  │   ├─ Count issues with baseline label               │
│  │   ├─ Exclude DEL-CANCELLED                          │
│  │   ├─ Count completed by cycle end                   │
│  │   └─ Calculate spillover                            │
│  │                                                      │
│  └─ computeFeatureMovement()                           │
│      └─ Count project states per pod                   │
└─────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────┐
│ formatCombinedKpiOutput()                               │
│  ├─ DEL KPI Table (markdown)                           │
│  ├─ Feature Movement Table (markdown)                  │
│  ├─ Project-wise Summary by Pod                        │
│  └─ generateInsights()                                 │
└─────────────────────────────────────────────────────────┘
    │
    ▼
Output to Console
```

### 2. Project Query Flow

```
User: "project tagging"
    │
    ▼
┌─────────────────┐
│ parseCommand()  │──────▶ { type: "project_detail", projectName: "tagging" }
└─────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────┐
│ Cross-Pod Project Search                                │
│  ├─ listPods() ───────▶ Get all 6 pods                 │
│  │                                                      │
│  ├─ For each pod:                                       │
│  │   └─ getLiveProjects(pod.name)                      │
│  │       └─ withCache() ──▶ LinearClient               │
│  │                                                      │
│  └─ scoreProjectMatch() for all projects               │
│      ├─ Exact match: 1000 points                       │
│      ├─ Ends with: 900 points                          │
│      ├─ All words: 500-600 points                      │
│      └─ Contains: 50 points                            │
└─────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────┐
│ Best Match:     │──────▶ "Q1 2026 : Tagging system V2" (FTS)
│ Score: 900      │
└─────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────┐
│ getLiveProject(podName, projectName)                    │
│  ├─ getProjectById() ──────▶ Full project details      │
│  └─ getIssuesByProject() ──▶ All issues                │
│      └─ classifyIssue() ──▶ blockers, risks, etc.      │
└─────────────────────────────────────────────────────────┘
    │
    ▼
formatProjectDetail() ──────▶ Output
```

---

## KPI Computation Logic

### DEL (Delivery Excellence Level) Metrics

```
┌─────────────────────────────────────────────────────────┐
│                    DEL COMPUTATION                       │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  COMMITTED = Issues with:                                │
│    ├─ DEL label (e.g., "DEL")                           │
│    ├─ Cycle baseline label (e.g., "2026Q1-C1")          │
│    └─ NOT DEL-CANCELLED label                           │
│                                                          │
│  COMPLETED = Committed issues where:                     │
│    ├─ state.type === "completed"                        │
│    └─ completedAt <= cycleEnd (if cycle closed)         │
│        OR completedAt <= now (if cycle active)          │
│                                                          │
│  SPILLOVER = (cycle active) ? 0 : committed - completed │
│                                                          │
│  DELIVERY % = (completed / committed) * 100             │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

### Cycle Detection Algorithm

```javascript
function getCycleKeyByDate(podCalendar, refDate = new Date()) {
  // 1. Find active cycle (date within [start, end])
  for (let i = 1; i <= 6; i++) {
    const c = podCalendar[`C${i}`];
    if (refDate >= c.start && refDate <= c.end) {
      return `C${i}`;  // Active cycle found
    }
  }

  // 2. No active cycle - find most recently ended
  let best = null, bestEnd = -Infinity;
  for (let i = 1; i <= 6; i++) {
    const c = podCalendar[`C${i}`];
    if (c.end <= refDate && c.end > bestEnd) {
      bestEnd = c.end;
      best = `C${i}`;
    }
  }

  return best || "C1";  // Default fallback
}
```

### Feature Movement Computation

```
┌─────────────────────────────────────────────────────────┐
│              FEATURE MOVEMENT STATES                     │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  Project State        │  Normalized State                │
│  ─────────────────────┼──────────────────────────────── │
│  "completed"          │  "done"                          │
│  "started", "paused"  │  "in_flight"                     │
│  "planned", "backlog" │  "not_started"                   │
│  "canceled"           │  "cancelled"                     │
│                                                          │
│  Per Pod:                                                │
│    plannedFeatures = total projects                      │
│    done = count(state == "done")                        │
│    inFlight = count(state == "in_flight")               │
│    notStarted = count(state == "not_started")           │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

---

## Caching Strategy

### Cache Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    CACHE SYSTEM                          │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  Location: agent/output/cache/                           │
│  Format: JSON files with MD5 hash keys                   │
│                                                          │
│  ┌─────────────────────────────────────────────────┐    │
│  │  Cache Entry Structure                           │    │
│  │  {                                               │    │
│  │    "data": <cached response>,                    │    │
│  │    "expiresAt": <timestamp ms>                   │    │
│  │  }                                               │    │
│  └─────────────────────────────────────────────────┘    │
│                                                          │
│  TTL Configuration:                                      │
│  ├─ Projects:  5 minutes (300,000 ms)                   │
│  ├─ Issues:    3 minutes (180,000 ms)                   │
│  ├─ Comments:  2 minutes (120,000 ms)                   │
│  └─ Default:   5 minutes                                │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

### Cache Decorator Pattern

```javascript
// withCache(key, asyncFn, ttl) → Cached async function
const fetchFn = withCache(
  `projects_${initiativeId}`,
  async () => client.getProjectsByInitiative(initiativeId),
  CACHE_TTL.projects
);

const projects = await fetchFn();  // Returns cached or fresh data
```

### Cache Flow

```
Request
    │
    ▼
┌─────────────┐     ┌─────────────┐
│ Check Cache │────▶│ Cache HIT   │────▶ Return cached data
│   (file)    │     │ & not       │
└─────────────┘     │ expired     │
    │               └─────────────┘
    │ MISS or EXPIRED
    ▼
┌─────────────┐
│ Fetch from  │
│ Linear API  │
└─────────────┘
    │
    ▼
┌─────────────┐
│ Store in    │────▶ Return fresh data
│ Cache       │
└─────────────┘
```

---

## Configuration Management

### Configuration Files

```
config/
├── linear_ids.json       # Primary config (auto-generated)
├── pods.json             # Manual pod config (fallback)
├── cycle_calendar.json   # Cycle date ranges
└── label_ids.json        # Label ID mappings (auto-generated)
```

### Config Load Priority

```
┌─────────────────────────────────────────────────────────┐
│              CONFIG LOADING PRIORITY                     │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  1. config/linear_ids.json (PREFERRED)                  │
│     └─ Contains: org, pods with initiativeId, projects  │
│                                                          │
│  2. config/pods.json (FALLBACK)                         │
│     └─ Contains: minimal pod config with teamId         │
│                                                          │
│  Auto-generated by runWeeklyKpi.js:                     │
│  ├─ config/linear_ids.json                              │
│  └─ config/label_ids.json                               │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

### Pod Configuration Schema

```javascript
// config/linear_ids.json
{
  "org": {
    "id": "org-uuid",
    "name": "Telus Digital AI Engineering",
    "urlKey": "playment"
  },
  "pods": {
    "FTS": {
      "teamId": "team-uuid",
      "initiativeName": "Q1 2026 - FTS Roadmap",
      "initiativeId": "initiative-uuid",
      "projects": [
        {
          "id": "project-uuid",
          "name": "Q1 2026 : Feature Name",
          "state": "started"
        }
      ]
    }
    // ... more pods
  }
}
```

### Cycle Calendar Schema

```javascript
// config/cycle_calendar.json
{
  "pods": {
    "FTS": {
      "C1": { "start": "2026-01-06", "end": "2026-01-20" },
      "C2": { "start": "2026-01-20", "end": "2026-02-03" },
      "C3": { "start": "2026-02-03", "end": "2026-02-17" },
      "C4": { "start": "2026-02-17", "end": "2026-03-03" },
      "C5": { "start": "2026-03-03", "end": "2026-03-17" },
      "C6": { "start": "2026-03-17", "end": "2026-03-31" }
    }
    // ... more pods
  }
}
```

---

## API Reference

### Linear GraphQL Queries

```graphql
# Fetch issues with DEL label for a team
query IssuesByTeamAndLabel($teamId: ID!, $labelId: ID!, $first: Int!, $after: String) {
  issues(first: $first, after: $after, filter: {
    team: { id: { eq: $teamId } },
    labels: { id: { eq: $labelId } }
  }) {
    nodes {
      id
      identifier
      createdAt
      completedAt
      state { type name }
      labels { nodes { id name } }
    }
    pageInfo { hasNextPage endCursor }
  }
}

# Fetch projects by initiative
query ProjectsByInitiative($initiativeId: ID!, $first: Int!, $after: String) {
  projects(first: $first, after: $after, filter: {
    initiatives: { id: { eq: $initiativeId } }
  }) {
    nodes {
      id
      name
      state
      lead { name }
      targetDate
      url
      updatedAt
    }
    pageInfo { hasNextPage endCursor }
  }
}
```

### CLI Commands Reference

| Command | Description | Handler |
|---------|-------------|---------|
| `kpi` | Combined DEL + Feature Movement | `combined_kpi` |
| `weekly kpi` | Same as `kpi` | `combined_kpi` |
| `pods` | List all pods | `list_pods` |
| `pod <name>` | Pod summary | `pod_summary` |
| `pod <name> projects` | List pod projects | `pod_projects` |
| `project <name>` | Project details | `project_detail` |
| `project <name> blockers` | Show blockers | `project_blockers` |
| `project <name> comments` | Comment summary | `project_comments` |
| `/refresh` | Regenerate snapshot | Internal |
| `/help` | Show help | Internal |

---

## Database Schema

### SQLite Schema (`state/kpi_state.db`)

```sql
-- Snapshot issue tracking
CREATE TABLE snapshots (
  pod TEXT NOT NULL,
  cycle TEXT NOT NULL,
  issueId TEXT NOT NULL,
  PRIMARY KEY (pod, cycle, issueId)
);

-- Snapshot metadata
CREATE TABLE snapshot_meta (
  pod TEXT NOT NULL,
  cycle TEXT NOT NULL,
  frozen INTEGER NOT NULL DEFAULT 0,
  frozenAt TEXT,
  lastRefreshAt TEXT,
  committedCount INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (pod, cycle)
);
```

### Freeze Policy

```
┌─────────────────────────────────────────────────────────┐
│                  FREEZE POLICY                           │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  C1, C2 snapshots:                                       │
│    └─ Freeze after end of C2 (adoption grace period)    │
│                                                          │
│  C3, C4, C5, C6 snapshots:                              │
│    └─ Freeze at their own cycle end                     │
│                                                          │
│  While not frozen:                                       │
│    └─ Snapshots can be refreshed (late labeling OK)     │
│                                                          │
│  Once frozen:                                            │
│    └─ committedCount becomes permanent                  │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LINEAR_API_KEY` | Yes | - | Linear API authentication |
| `LINEAR_GQL_URL` | No | `https://api.linear.app/graphql` | GraphQL endpoint |
| `FUELIX_API_KEY` | No | - | LLM API key |
| `FUELIX_API_URL` | No | `https://api.fuelix.ai` | LLM endpoint |
| `FUELIX_MODEL` | No | `gpt-5.2` | LLM model name |
| `SNAPSHOT_PATH` | No | `agent/output/latest_snapshot.json` | Snapshot file path |
| `KPI_CYCLE` | No | Auto-detect | Override cycle (C1-C6) |
| `FREEZE_POLICY_CYCLE` | No | `C2` | When C1/C2 freeze |

---

## Output Artifacts

### Agent Outputs

```
agent/output/
├── latest_snapshot.json    # Point-in-time KPI snapshot
├── answers.log.jsonl       # Q&A audit log
├── cache/                  # API response cache
│   └── *.json
└── weekly_agent_summary.md # Generated summaries
```

### Script Outputs

```
out/
├── kpi_weekly_report.md    # Markdown KPI report
├── pod_cycle_kpi.csv       # DEL metrics CSV
└── pod_feature_movement.csv # Feature movement CSV
```

---

## NPM Scripts

```bash
# Generate snapshot from Linear
npm run snapshot

# Generate with debug output
npm run debug:snapshot

# Start interactive CLI
npm run agent

# Run full weekly KPI (requires LINEAR_API_KEY env)
LINEAR_API_KEY=<key> node scripts/runWeeklyKpi.js
```

---

## Error Handling

### Error Types

| Error Code | Description | Resolution |
|------------|-------------|------------|
| `MISSING_LABEL_IDS` | label_ids.json not found | Run `runWeeklyKpi.js` |
| `MISSING_CYCLE_CALENDAR` | cycle_calendar.json missing | Create config file |
| `POD_NOT_FOUND` | Invalid pod name | Check available pods |
| `PROJECT_NOT_FOUND` | Project not in any pod | Verify project name |
| `NO_INITIATIVE_ID` | Pod missing initiativeId | Update linear_ids.json |
| `FETCH_FAILED` | API request failed | Check API key/network |

---

## Summary

This system provides a comprehensive KPI tracking solution with:

1. **Real-time Integration**: Live Linear API queries with intelligent caching
2. **Historical Tracking**: SQLite-based snapshot storage with freeze policies
3. **Flexible Querying**: Natural language + structured command support
4. **Dual KPI System**: DEL metrics + Feature Movement tracking
5. **Cross-Pod Search**: Fuzzy project matching across all pods
6. **LLM Fallback**: Natural language understanding for complex queries

The architecture follows a layered approach with clear separation between CLI, business logic, data access, and external services.
