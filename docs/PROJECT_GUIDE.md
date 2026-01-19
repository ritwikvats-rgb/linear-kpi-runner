# KPI Assistant - Complete Project Guide

> A comprehensive guide explaining every aspect of the KPI Assistant project in simple terms.

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [Understanding the Problem](#2-understanding-the-problem)
3. [Solution Overview](#3-solution-overview)
4. [Key Concepts & Terminology](#4-key-concepts--terminology)
5. [System Architecture](#5-system-architecture)
6. [How Data Flows Through the System](#6-how-data-flows-through-the-system)
7. [Core Components Deep Dive](#7-core-components-deep-dive)
8. [Technology Stack Explained](#8-technology-stack-explained)
9. [Features in Detail](#9-features-in-detail)
10. [Configuration & Setup](#10-configuration--setup)
11. [Deployment Explained](#11-deployment-explained)
12. [Glossary](#12-glossary)

---

## 1. Introduction

### What is KPI Assistant?

KPI Assistant is a web application that helps engineering managers and team leads track their team's performance by automatically pulling data from Linear (a project management tool) and presenting it in an easy-to-understand format.

Think of it like a smart dashboard that answers questions like:
- "How is the Platform team doing this quarter?"
- "Are we on track to deliver our commitments?"
- "What's blocking progress?"

Instead of manually clicking through Linear, opening multiple projects, and calculating percentages yourself, KPI Assistant does all of this automatically in seconds.

### Who is this guide for?

This guide is written for anyone who wants to understand how the project works, including:
- **Developers** who need to maintain or extend the code
- **Managers** who want to understand what the tool does
- **New team members** getting familiar with the codebase
- **Anyone** curious about how such a system is built

We explain everything from basic concepts to technical implementation details, assuming no prior knowledge of the specific technologies used.

---

## 2. Understanding the Problem

### The Challenge of Tracking Engineering Progress

Engineering teams use project management tools like Linear to track their work. In a typical setup:

- **Teams** are groups of engineers (e.g., "Platform Team", "FTS Team")
- **Projects** are major features or initiatives (e.g., "User Authentication Redesign")
- **Issues** are individual tasks or tickets within projects
- **Cycles** are time-boxed periods (like 2-week sprints)

The problem is that when you have multiple teams working on dozens of projects with hundreds of issues, getting a clear picture of overall progress becomes difficult.

### Manual Process (Before KPI Assistant)

Without automation, a manager would need to:

1. Open Linear
2. Navigate to each team's workspace
3. Open each project to see its status
4. Count how many tasks are done vs. pending
5. Calculate delivery percentages manually
6. Read through comments to understand blockers
7. Repeat for every team (6 teams = 6x the work)
8. Compile everything into a report

This process takes 30+ minutes and needs to be repeated regularly (daily or weekly).

### What We Wanted

We wanted a system that could:

1. **Automate data collection** - Pull all relevant data from Linear automatically
2. **Calculate metrics** - Compute delivery percentages and other KPIs without manual math
3. **Provide instant answers** - Ask a question in plain English and get an immediate response
4. **Generate insights** - Use AI to summarize discussions and highlight important issues
5. **Be accessible anywhere** - Work in a web browser, accessible to anyone with the link

---

## 3. Solution Overview

### What We Built

KPI Assistant is a web application with three main parts:

**1. A Web Interface (Frontend)**

This is what users see in their browser. It's a simple page with:
- A text box where you can type questions
- Quick-action buttons for common queries (e.g., "FTS Status", "All Pods")
- A display area showing the response

**2. A Server (Backend)**

This runs on a cloud server and handles:
- Receiving questions from the web interface
- Fetching data from Linear's API
- Calculating metrics and KPIs
- Generating AI-powered summaries
- Sending formatted responses back

**3. External Services (APIs)**

The system connects to:
- **Linear API** - To fetch project, issue, and comment data
- **Fuelix API** - An AI service that helps summarize information

### How It Works (Simple Version)

```
User types: "What is the status of FTS?"
                    │
                    ▼
        Browser sends request to server
                    │
                    ▼
        Server fetches data from Linear
                    │
                    ▼
        Server calculates metrics (delivery %, health score)
                    │
                    ▼
        Server asks AI to summarize recent discussions
                    │
                    ▼
        Server formats everything into a nice report
                    │
                    ▼
        Response displayed in browser
```

---

## 4. Key Concepts & Terminology

Before diving deeper, let's define the key terms used throughout this project.

### Linear Concepts

**Linear** is a project management tool (like Jira or Asana) used by engineering teams. Here are the Linear-specific terms:

| Term | Definition | Example |
|------|------------|---------|
| **Team** | A group of people working together | "Platform Team" with 8 engineers |
| **Initiative** | A high-level goal containing multiple projects | "Q1 2026 Roadmap" |
| **Project** | A specific feature or deliverable | "User Authentication Redesign" |
| **Issue** | A single task or ticket | "Implement login button" |
| **Label** | A tag attached to issues for categorization | "DEL", "Blocker", "Bug" |
| **State** | The status of an issue | "Todo", "In Progress", "Done" |
| **Cycle** | A time period for planning work | "C1" (Cycle 1), typically 2 weeks |

### KPI Concepts

**KPI** stands for Key Performance Indicator - a measurable value that shows how effectively a team is achieving objectives.

| Term | Definition | How We Calculate It |
|------|------------|---------------------|
| **DEL** | Delivery Excellence Level - a commitment made by a team | Issues with the "DEL" label |
| **Committed DELs** | DELs planned for a specific cycle | DELs with cycle label (e.g., "2026Q1-C1") |
| **Completed DELs** | DELs that are finished | Committed DELs with state = "Done" |
| **Delivery %** | Percentage of commitments delivered | (Completed / Committed) × 100 |
| **Spillover** | Work not completed in its planned cycle | Committed - Completed (for past cycles) |
| **Health Score** | Overall pod performance score (0-100) | Algorithm considering delivery %, blockers, etc. |

### Pod Structure

In this system, a **Pod** is a team with its associated initiative. We have 6 pods:

1. **FTS** - Feature Team Services
2. **GTS** - Global Team Services
3. **Control Center** - Operations management
4. **Talent Studio** - HR/Talent features
5. **Platform** - Core infrastructure
6. **Growth & Reuse** - Growth initiatives

Each pod has:
- A **Team ID** - Linear's unique identifier for the team
- An **Initiative ID** - Linear's unique identifier for their Q1 2026 roadmap
- Multiple **Projects** under that initiative

### Technical Terms

| Term | Definition |
|------|------------|
| **API** | Application Programming Interface - a way for programs to communicate with each other |
| **GraphQL** | A query language for APIs that lets you request exactly the data you need |
| **REST** | Another API style where you access fixed endpoints (Linear uses GraphQL instead) |
| **Cache** | Temporary storage to avoid fetching the same data repeatedly |
| **TTL** | Time To Live - how long cached data remains valid before refreshing |
| **LLM** | Large Language Model - AI that understands and generates human language |
| **Express** | A web framework for Node.js that makes building servers easy |
| **Node.js** | A JavaScript runtime that lets you run JavaScript on servers |

---

## 5. System Architecture

### Overview

The system follows a standard three-tier architecture:

```
┌─────────────────────────────────────────────────────────────────┐
│                         TIER 1: CLIENT                          │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                   Web Browser                              │  │
│  │                                                            │  │
│  │  User interacts with a web page (index.html) that has:    │  │
│  │  • A text input for typing questions                       │  │
│  │  • Buttons for quick actions                               │  │
│  │  • A display area for responses                            │  │
│  │                                                            │  │
│  │  The browser sends HTTP requests to the server and         │  │
│  │  displays the responses it receives.                       │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ HTTP Requests
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                       TIER 2: SERVER                            │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                  Node.js + Express                         │  │
│  │                                                            │  │
│  │  The server handles all the business logic:                │  │
│  │  • Receives questions from the browser                     │  │
│  │  • Parses questions to understand what data is needed      │  │
│  │  • Fetches data from Linear API                            │  │
│  │  • Calculates KPIs and metrics                             │  │
│  │  • Calls AI for summaries                                  │  │
│  │  • Formats and returns responses                           │  │
│  │                                                            │  │
│  │  Hosted on Render (cloud platform)                         │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ API Calls
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      TIER 3: SERVICES                           │
│  ┌─────────────────────┐    ┌─────────────────────────────────┐ │
│  │    Linear API       │    │         Fuelix AI API           │ │
│  │                     │    │                                 │ │
│  │  Provides:          │    │  Provides:                      │ │
│  │  • Team data        │    │  • Text summarization           │ │
│  │  • Project data     │    │  • Insight generation           │ │
│  │  • Issue data       │    │  • Natural language processing  │ │
│  │  • Comments         │    │                                 │ │
│  │  • Labels           │    │  Uses GPT-5.2 model             │ │
│  └─────────────────────┘    └─────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### Why This Architecture?

**Separation of Concerns**: Each tier has a specific job:
- Client handles user interaction
- Server handles business logic
- External services provide specialized functionality

**Scalability**: If more users need access, we can scale the server without changing the client or services.

**Security**: Sensitive data (API keys) stays on the server, never exposed to browsers.

**Maintainability**: Each part can be updated independently.

---

## 6. How Data Flows Through the System

Let's trace what happens when a user asks "What is the status of Platform?"

### Step 1: User Interaction

The user either:
- Types "What is the status of Platform?" in the text box and clicks "Ask"
- OR clicks the "Platform" quick-action button

The browser's JavaScript creates an HTTP POST request:
```javascript
fetch('/api/ask', {
  method: 'POST',
  body: JSON.stringify({ question: "What is the status of Platform?" })
})
```

### Step 2: Server Receives Request

The Express server receives the request at the `/api/ask` endpoint:

```javascript
app.post('/api/ask', async (req, res) => {
  const { question } = req.body;
  const answer = await answerQuestion(question);
  res.json({ success: true, answer });
});
```

### Step 3: Question Parsing

The `answerer.js` module analyzes the question to determine:
- What type of query is this? (pod status, DEL info, etc.)
- Which pod/project is being asked about?

It uses pattern matching to identify keywords:
- "status of Platform" → pod_narrative query for "Platform"
- "pending DELs" → pending_dels query
- "all pods" → all_pods_summary query

### Step 4: Data Fetching

Based on the query type, the system fetches relevant data from Linear:

**For a pod status query, it fetches:**

1. **Projects** - All projects under the pod's initiative
   ```graphql
   query {
     projects(filter: { initiative: { id: { eq: "xxx" } } }) {
       name, state, lead { name }, updatedAt
     }
   }
   ```

2. **DEL Issues** - Issues with the "DEL" label for the team
   ```graphql
   query {
     issues(filter: { team: { id: { eq: "xxx" } }, labels: { id: { eq: "DEL_LABEL_ID" } } }) {
       title, state { type }, labels { name }, assignee { name }
     }
   }
   ```

3. **Comments** - Recent comments on active project issues (for AI summary)

### Step 5: Caching

Before making API calls, the system checks if the data is already cached:

```javascript
function withCache(key, fetchFunction, ttl) {
  // Check if we have recent data
  if (cache.has(key) && !isExpired(cache.get(key))) {
    return cache.get(key).data;  // Return cached data
  }

  // Fetch fresh data
  const data = await fetchFunction();

  // Store in cache with expiration time
  cache.set(key, { data, expiresAt: Date.now() + ttl });

  return data;
}
```

**Why caching matters:**
- Linear API has rate limits (too many requests get blocked)
- Same data doesn't change every second
- Cached responses are instant (no network delay)

**Cache durations:**
- Projects: 5 minutes (changes less frequently)
- Issues: 3 minutes
- Comments: 2 minutes (changes more often)

### Step 6: KPI Calculation

The `kpiComputer.js` module calculates metrics:

**Health Score Calculation:**
```javascript
function calculateHealthScore(stats, delData, issueStats) {
  let score = 100;  // Start with perfect score

  // Deduct for low delivery percentage
  if (deliveryPct < 50) score -= 30;
  else if (deliveryPct < 70) score -= 20;
  else if (deliveryPct < 80) score -= 10;

  // Deduct for blockers (each blocker = -8, max -25)
  score -= Math.min(25, blockers * 8);

  // Deduct for risks (each risk = -5, max -15)
  score -= Math.min(15, risks * 5);

  // Deduct for spillover
  score -= Math.min(15, spillover * 5);

  // Bonus for completed work
  score += completionRate * 10;

  return Math.max(0, Math.min(100, score));
}
```

**DEL Metrics Calculation:**
```javascript
// Committed = DELs with cycle label (e.g., "2026Q1-C1")
const committed = issues.filter(i => hasLabel(i, "2026Q1-C1")).length;

// Completed = Committed DELs that are done
const completed = issues.filter(i =>
  hasLabel(i, "2026Q1-C1") && i.state.type === "completed"
).length;

// Delivery percentage
const deliveryPct = Math.round((completed / committed) * 100);

// Spillover (only for past cycles)
const spillover = isCyclePast ? Math.max(0, committed - completed) : 0;
```

### Step 7: AI Processing

For comment summaries and insights, the system calls the Fuelix AI:

**Comment Summarization:**
```javascript
const messages = [
  {
    role: "system",
    content: "Summarize these project comments in 2-3 sentences. Focus on current work, blockers, and progress."
  },
  {
    role: "user",
    content: "Comments from Platform pod:\n" + commentText
  }
];

const summary = await fuelixChat({ messages });
```

**Insight Generation:**
```javascript
const messages = [
  {
    role: "system",
    content: "Provide 2-3 actionable insights based on these metrics."
  },
  {
    role: "user",
    content: JSON.stringify(podMetrics)
  }
];

const insights = await fuelixChat({ messages });
```

### Step 8: Response Formatting

The `tableFormatter.js` module creates beautiful ASCII tables:

```javascript
function formatTable(data, columns, options) {
  // Create header
  let output = "┌" + columns.map(c => "─".repeat(c.width + 2)).join("┬") + "┐\n";

  // Add header row
  output += "│" + columns.map(c => ` ${c.header.padEnd(c.width)} `).join("│") + "│\n";

  // Add separator
  output += "├" + columns.map(c => "─".repeat(c.width + 2)).join("┼") + "┤\n";

  // Add data rows
  for (const row of data) {
    output += "│" + columns.map(c => ` ${row[c.key].padEnd(c.width)} `).join("│") + "│\n";
  }

  // Add bottom border
  output += "└" + columns.map(c => "─".repeat(c.width + 2)).join("┴") + "┘\n";

  return output;
}
```

### Step 9: Response Delivery

The formatted response is sent back to the browser:

```javascript
res.json({
  success: true,
  answer: formattedReport,
  source: "live",
  fetchedAt: new Date().toISOString()
});
```

The browser's JavaScript receives this and displays it in the response area.

---

## 7. Core Components Deep Dive

### 7.1 Server (server.js)

**Purpose:** Serves the web interface and handles API requests.

**What is Express?**
Express is a web framework for Node.js. It makes it easy to:
- Define URL routes (endpoints)
- Handle HTTP requests (GET, POST, etc.)
- Serve static files (HTML, CSS, JS)
- Process request/response data

**Key Code Explained:**

```javascript
const express = require("express");
const app = express();

// Middleware to parse JSON request bodies
app.use(express.json());

// Serve static files from 'public' folder
// When someone visits /, they get index.html
app.use(express.static(path.join(__dirname, "../public")));

// API endpoint for questions
app.post("/api/ask", async (req, res) => {
  try {
    const { question } = req.body;  // Extract question from request
    const answer = await answerQuestion(question);  // Process it
    res.json({ success: true, answer });  // Send response
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Health check endpoint (Render uses this to verify app is running)
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
```

**Why Express?**
- Simple and lightweight
- Massive community and documentation
- Perfect for small-to-medium APIs
- Easy to deploy anywhere

---

### 7.2 Answerer (answerer.js)

**Purpose:** The "brain" that understands questions and generates appropriate responses.

**How Question Parsing Works:**

The system uses pattern matching to understand questions:

```javascript
function parseCommand(input) {
  const lower = input.toLowerCase().trim();

  // Check for "all pods" queries
  if (lower.includes("all pods") || lower.includes("across all")) {
    return { type: "all_pods_summary" };
  }

  // Check for specific pod queries
  const podMatch = lower.match(/status of (\w+)/);
  if (podMatch) {
    return { type: "pod_narrative", podName: podMatch[1] };
  }

  // Check for DEL queries
  if (lower.includes("pending del")) {
    return { type: "pending_dels" };
  }

  // Check for cycle-specific queries
  const cycleMatch = lower.match(/dels? in (c\d)/i);
  if (cycleMatch) {
    return { type: "dels_by_cycle", cycle: cycleMatch[1] };
  }

  // Default: try to find a pod name anywhere in the query
  for (const podName of allPodNames) {
    if (lower.includes(podName.toLowerCase())) {
      return { type: "pod_narrative", podName };
    }
  }

  return { type: "unknown" };
}
```

**Why This Approach?**

We chose pattern matching over natural language processing (NLP) because:
1. Our queries are predictable and limited in scope
2. Pattern matching is fast and doesn't require API calls
3. It's deterministic (same input always gives same result)
4. Easy to debug and extend

---

### 7.3 KPI Computer (kpiComputer.js)

**Purpose:** Calculates all metrics and KPIs from raw Linear data.

**DEL KPI Calculation Explained:**

DEL (Delivery Excellence Level) is our main metric for tracking commitments.

```javascript
async function computeCycleKpi() {
  // For each pod...
  for (const [podName, pod] of Object.entries(pods)) {

    // Fetch all issues with "DEL" label for this team
    const allDELs = await fetchDELIssues(pod.teamId, delLabelId);

    // For each cycle (C1 through C6)...
    for (let cycle = 1; cycle <= 6; cycle++) {
      const cycleLabel = `2026Q1-C${cycle}`;

      // Find DELs committed to this cycle
      // (issues that have BOTH "DEL" and "2026Q1-C1" labels)
      const committed = allDELs.filter(issue =>
        issue.labels.some(l => l.name === cycleLabel)
      );

      // Find completed DELs
      // (committed DELs where state.type is "completed")
      const completed = committed.filter(issue =>
        issue.state.type === "completed"
      );

      // Calculate delivery percentage
      const deliveryPct = committed.length > 0
        ? Math.round((completed.length / committed.length) * 100)
        : 0;

      // Calculate spillover (only for past cycles)
      const isCyclePast = new Date() > cycleEndDate;
      const spillover = isCyclePast
        ? Math.max(0, committed.length - completed.length)
        : 0;
    }
  }
}
```

**Feature Movement Explained:**

Tracks how many projects are in each state:

```javascript
async function computeFeatureMovement() {
  for (const [podName, pod] of Object.entries(pods)) {
    const projects = await getProjectsByInitiative(pod.initiativeId);

    const stats = { done: 0, inFlight: 0, notStarted: 0 };

    for (const project of projects) {
      switch (project.state.toLowerCase()) {
        case "completed":
          stats.done++;
          break;
        case "started":
        case "paused":
          stats.inFlight++;
          break;
        case "planned":
        case "backlog":
          stats.notStarted++;
          break;
      }
    }
  }
}
```

---

### 7.4 Live Linear (liveLinear.js)

**Purpose:** Fetches real-time data from Linear's API with caching.

**What is an API?**

An API (Application Programming Interface) is like a waiter in a restaurant:
- You (the client) tell the waiter what you want
- The waiter goes to the kitchen (server) to get it
- The waiter brings back your food (data)

Linear's API lets us ask for data about teams, projects, issues, etc.

**GraphQL vs REST:**

Linear uses GraphQL, not REST. The difference:

**REST (what most APIs use):**
```
GET /projects          → Returns all projects
GET /projects/123      → Returns project 123
GET /projects/123/issues → Returns issues for project 123
```
You might need 3 separate requests to get what you need.

**GraphQL (what Linear uses):**
```graphql
query {
  project(id: "123") {
    name
    state
    issues {
      title
      state { name }
    }
  }
}
```
One request gets exactly the data you need.

**Key Functions:**

```javascript
// Get all projects for a pod
async function getLiveProjects(podName) {
  const pod = getPod(podName);  // Get pod config

  // Use cache to avoid redundant API calls
  const cacheKey = `projects_${pod.initiativeId}`;

  const projects = await withCache(cacheKey, async () => {
    // This only runs if cache is empty/expired
    return await client.getProjectsByInitiative(pod.initiativeId);
  }, CACHE_TTL.projects);

  // Calculate statistics
  const stats = { done: 0, inFlight: 0, notStarted: 0 };
  for (const p of projects) {
    const state = normalizeState(p.state);
    stats[state]++;
  }

  return { success: true, pod: podName, projects, stats };
}
```

---

### 7.5 Linear Client (linearClient.js)

**Purpose:** Low-level GraphQL communication with Linear's API.

**How GraphQL Queries Work:**

A GraphQL query is like a shopping list - you specify exactly what you want:

```graphql
query GetProjects($initiativeId: ID!) {
  initiative(id: $initiativeId) {
    projects {
      nodes {
        id
        name
        state
        lead {
          name
        }
        updatedAt
      }
    }
  }
}
```

The variables (`$initiativeId`) are passed separately:
```javascript
const variables = { initiativeId: "abc123" };
const result = await client.gql(query, variables);
```

**Why Variables?**

Using variables (instead of string concatenation) prevents:
1. **Injection attacks** - Malicious input can't break the query
2. **Syntax errors** - Special characters are handled properly
3. **Caching issues** - Same query with different variables can be cached separately

---

### 7.6 Cache System (cache.js)

**Purpose:** Stores API responses temporarily to improve performance and reduce API calls.

**The Problem Without Caching:**

If a user:
1. Clicks "FTS" → API call takes 2 seconds
2. Clicks "FTS" again 5 seconds later → Another 2 second API call
3. Clicks "All Pods" (which includes FTS) → Yet another FTS API call

That's wasteful because FTS data didn't change in 10 seconds.

**How Our Cache Works:**

```javascript
const cache = new Map();  // Simple key-value storage

function withCache(key, fetchFunction, ttl) {
  const now = Date.now();
  const cached = cache.get(key);

  // Check if we have valid cached data
  if (cached && cached.expiresAt > now) {
    console.log(`Cache HIT for ${key}`);
    return cached.data;
  }

  // Cache miss - fetch fresh data
  console.log(`Cache MISS for ${key}`);
  const data = await fetchFunction();

  // Store in cache with expiration
  cache.set(key, {
    data,
    expiresAt: now + ttl
  });

  return data;
}
```

**TTL (Time To Live) Values:**

| Data Type | TTL | Why |
|-----------|-----|-----|
| Projects | 5 minutes | Projects don't change often |
| Issues | 3 minutes | Issues change more frequently |
| Comments | 2 minutes | Comments are very dynamic |

---

### 7.7 Fuelix Client (fuelixClient.js)

**Purpose:** Connects to the AI service for generating summaries and insights.

**What is an LLM?**

LLM (Large Language Model) is an AI that understands and generates human language. Examples include GPT-4, Claude, and Gemini.

We use Fuelix (which uses GPT-5.2) for:
1. **Summarizing comments** - Turn 20 comments into 2-3 sentences
2. **Generating insights** - Analyze metrics and suggest actions

**How We Use It:**

```javascript
async function fuelixChat({ messages, model }) {
  const response = await fetch(FUELIX_API_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${FUELIX_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: model || "gpt-5.2",
      messages: messages  // Array of {role, content} objects
    })
  });

  const data = await response.json();
  return data.choices[0].message.content;
}
```

**Message Format:**

```javascript
const messages = [
  {
    role: "system",  // Instructions for the AI
    content: "You are a project summarizer. Be concise."
  },
  {
    role: "user",    // The actual request
    content: "Summarize these comments: ..."
  }
];
```

---

### 7.8 Table Formatter (tableFormatter.js)

**Purpose:** Creates beautiful ASCII tables for displaying data.

**Why ASCII Tables?**

Our response is plain text (not HTML). ASCII tables make data readable:

```
┌──────────────────┬────────────┐
│ Metric           │      Value │
├──────────────────┼────────────┤
│ DEL Committed    │         12 │
│ DEL Completed    │         10 │
│ Delivery Rate    │        83% │
└──────────────────┴────────────┘
```

**How It Works:**

```javascript
// Box-drawing characters
const BOX = {
  topLeft: "┌",
  topRight: "┐",
  bottomLeft: "└",
  bottomRight: "┘",
  horizontal: "─",
  vertical: "│",
  cross: "┼"
};

function formatTable(data, columns) {
  // Calculate column widths
  const widths = columns.map(col =>
    Math.max(col.header.length, ...data.map(row => String(row[col.key]).length))
  );

  // Build the table string
  let output = "";

  // Top border: ┌────┬────┐
  output += BOX.topLeft + widths.map(w => "─".repeat(w + 2)).join("┬") + BOX.topRight + "\n";

  // Header row: │ Name │ Value │
  output += BOX.vertical + columns.map((col, i) =>
    ` ${col.header.padEnd(widths[i])} `
  ).join(BOX.vertical) + BOX.vertical + "\n";

  // Separator: ├────┼────┤
  output += "├" + widths.map(w => "─".repeat(w + 2)).join("┼") + "┤\n";

  // Data rows
  for (const row of data) {
    output += BOX.vertical + columns.map((col, i) =>
      ` ${String(row[col.key]).padEnd(widths[i])} `
    ).join(BOX.vertical) + BOX.vertical + "\n";
  }

  // Bottom border: └────┴────┘
  output += BOX.bottomLeft + widths.map(w => "─".repeat(w + 2)).join("┴") + BOX.bottomRight + "\n";

  return output;
}
```

---

## 8. Technology Stack Explained

### Node.js

**What it is:** A JavaScript runtime that lets you run JavaScript on servers (not just in browsers).

**Why we chose it:**
- Same language (JavaScript) on frontend and backend
- Great for I/O-heavy applications (lots of API calls)
- Huge ecosystem of packages (npm)
- Easy deployment to cloud platforms

**Alternatives considered:**
- Python - Would work well, but JS keeps everything in one language
- Go - Faster, but more complex for a small project

---

### Express.js

**What it is:** A minimal web framework for Node.js.

**Why we chose it:**
- Very simple to set up (just a few lines of code)
- Huge community and documentation
- Flexible - doesn't force a specific structure
- Perfect for APIs and small web apps

**Example:**
```javascript
const express = require("express");
const app = express();

app.get("/hello", (req, res) => {
  res.send("Hello World!");
});

app.listen(3000);
```

---

### GraphQL (Linear API)

**What it is:** A query language for APIs that lets you request exactly the data you need.

**Why Linear uses it:**
- Flexible - clients request only what they need
- Efficient - one request can fetch related data
- Type-safe - queries are validated before execution

**We didn't choose GraphQL** - Linear only offers GraphQL, so we use it.

---

### Render (Hosting)

**What it is:** A cloud platform for deploying web applications.

**Why we chose it:**
- Free tier available
- Auto-deploys from GitHub
- Easy environment variable management
- Built-in HTTPS
- Health checks included

**Alternatives considered:**
- Vercel - Better for serverless, not persistent servers
- Railway - Similar to Render, slightly less free tier
- Heroku - Classic choice, but paid now

**Limitation:** Free tier sleeps after 15 minutes of inactivity. We use UptimeRobot to ping it every 14 minutes to keep it awake.

---

## 9. Features in Detail

### 9.1 Health Score

**What it is:** A number from 0 to 100 that indicates how well a pod is performing.

**Why we built it:** Managers need a quick way to see which pods need attention without reading detailed metrics.

**How it's calculated:**

Starting from 100 points, we deduct for problems:

| Factor | Deduction | Reasoning |
|--------|-----------|-----------|
| Delivery < 50% | -30 | Severe underperformance |
| Delivery < 70% | -20 | Below expectations |
| Delivery < 80% | -10 | Slight concern |
| Each blocker | -8 (max -25) | Blockers halt progress |
| Each risk | -5 (max -15) | Risks may become blockers |
| Each spillover | -5 (max -15) | Past commitments not met |
| No work in flight | -10 | Nothing actively progressing |

We add bonus points for:
| Factor | Bonus |
|--------|-------|
| Completed projects | +10 × completion rate |

**Display:**
| Score | Indicator | Meaning |
|-------|-----------|---------|
| 85-100 | 🟢 Excellent | Pod is performing well |
| 70-84 | 🟡 Good | Minor issues to address |
| 50-69 | 🟠 Needs Attention | Significant concerns |
| 0-49 | 🔴 At Risk | Urgent intervention needed |

---

### 9.2 DEL Tracking

**What it is:** Tracks delivery commitments (DELs) across cycles.

**Key metrics:**

1. **Committed:** How many DELs were planned for a cycle
2. **Completed:** How many were actually finished
3. **Delivery %:** The ratio of completed to committed
4. **Spillover:** Work not finished in its planned cycle

**Why it matters:**
- Shows if teams are keeping their commitments
- Helps identify if estimates are realistic
- Tracks improvement over time

---

### 9.3 AI-Powered Insights

**Comment Summarization:**

Instead of reading 50 comments, get a 2-3 sentence summary:

*"Teams are working on security fixes and observability improvements. Main concern is the timeline for auth migration. Overall progress is steady."*

**Actionable Recommendations:**

Based on metrics, the AI suggests specific actions:

1. Complete the 1 pending DEL to reach 100% delivery rate.
2. Start work on 9 backlog projects to avoid end-of-quarter rush.
3. Review 2 blocker issues and assign owners.

---

## 10. Configuration & Setup

### Environment Variables

Environment variables store sensitive configuration that shouldn't be in code:

**File: `.env`**
```
LINEAR_API_KEY=lin_api_xxxxxxxxxxxxxxxxxxxxx
FUELIX_API_KEY=fuelix_xxxxxxxxxxxxxxxxxx
```

**How to get these:**

**LINEAR_API_KEY:**
1. Go to Linear
2. Click your avatar → Settings
3. Go to "API" section
4. Click "Create key"
5. Copy the key (starts with `lin_api_`)

**FUELIX_API_KEY:**
Contact your administrator for access.

---

### Pod Configuration

**File: `config/linear_ids.json`**

This maps pod names to Linear IDs:

```json
{
  "org": {
    "name": "Your Organization"
  },
  "pods": {
    "FTS": {
      "teamId": "abc123-def456-...",
      "initiativeId": "ghi789-jkl012-...",
      "initiativeName": "Q1 2026 - FTS Roadmap"
    },
    "Platform": {
      "teamId": "...",
      "initiativeId": "...",
      "initiativeName": "..."
    }
  }
}
```

**How to find Linear IDs:**
- Open the team/initiative in Linear
- Look at the URL or use the Linear API to query

---

### Cycle Calendar

**File: `config/cycle_calendar.json`**

Defines when each cycle starts and ends:

```json
{
  "pods": {
    "FTS": {
      "C1": { "start": "2026-01-06", "end": "2026-01-17" },
      "C2": { "start": "2026-01-20", "end": "2026-01-31" },
      "C3": { "start": "2026-02-03", "end": "2026-02-14" }
    }
  }
}
```

This is used to:
- Determine which cycle is currently active
- Calculate spillover (only for past cycles)

---

## 11. Deployment Explained

### How Deployment Works

1. **You push code to GitHub**
   ```bash
   git push origin main
   ```

2. **Render detects the change** (via webhook)

3. **Render builds the app**
   ```bash
   npm install
   ```

4. **Render starts the server**
   ```bash
   npm start
   ```

5. **App is live** at your Render URL

### The render.yaml File

This tells Render how to deploy:

```yaml
services:
  - type: web              # This is a web service
    name: kpi-assistant    # Name shown in dashboard
    runtime: node          # Use Node.js
    buildCommand: npm install  # How to build
    startCommand: npm start    # How to start
    envVars:
      - key: LINEAR_API_KEY
        sync: false        # Must be set in dashboard (secret)
      - key: FUELIX_API_KEY
        sync: false
    healthCheckPath: /api/health  # Render pings this to verify health
```

### Keeping the App Awake

Render's free tier sleeps after 15 minutes of inactivity. To prevent this:

1. Sign up for [UptimeRobot](https://uptimerobot.com) (free)
2. Create a new monitor
3. Set URL to: `https://your-app.onrender.com/api/health`
4. Set interval to 5 minutes

This pings your app regularly, keeping it awake.

---

## 12. Glossary

| Term | Definition |
|------|------------|
| **API** | Application Programming Interface - a way for programs to communicate |
| **ASCII** | American Standard Code for Information Interchange - basic text characters |
| **Cache** | Temporary storage for frequently accessed data |
| **Cycle** | A time-boxed period for planning work (typically 2 weeks) |
| **DEL** | Delivery Excellence Level - a tracked commitment |
| **Endpoint** | A specific URL where an API accepts requests |
| **Express** | A web framework for Node.js |
| **GraphQL** | A query language for APIs |
| **HTTP** | HyperText Transfer Protocol - how browsers communicate with servers |
| **Initiative** | A high-level goal in Linear containing multiple projects |
| **Issue** | A single task or ticket in Linear |
| **JSON** | JavaScript Object Notation - a data format |
| **KPI** | Key Performance Indicator |
| **Label** | A tag attached to issues for categorization |
| **LLM** | Large Language Model - AI that processes language |
| **Node.js** | A JavaScript runtime for servers |
| **Pod** | A team with its associated initiative |
| **Project** | A specific feature or deliverable in Linear |
| **REST** | Representational State Transfer - an API architecture style |
| **Spillover** | Work not completed in its planned cycle |
| **TTL** | Time To Live - how long cached data is valid |

---

## Summary

KPI Assistant is a web application that:

1. **Connects to Linear** using their GraphQL API
2. **Fetches data** about teams, projects, issues, and comments
3. **Calculates metrics** like delivery percentage and health score
4. **Uses AI** to summarize discussions and generate recommendations
5. **Displays results** in a beautiful, easy-to-read format

The system is built with:
- **Node.js + Express** for the server
- **Linear GraphQL API** for project data
- **Fuelix AI** for intelligent summaries
- **Render** for hosting

Key design decisions:
- **Caching** to reduce API calls and improve speed
- **Pattern matching** for fast, deterministic query parsing
- **ASCII tables** for readable plain-text output
- **Health scores** for quick status assessment

---

*Document Version: 2.0*
*Last Updated: January 2026*
