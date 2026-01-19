# KPI Assistant

A web-based dashboard for tracking engineering team KPIs from Linear.

```
┌────────────────────────────────────────────────────────────────┐
│  KPI Assistant                                    Live Data    │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  ╔════════════════════════════════════════════════════════╗   │
│  ║  FTS                                       🟢 92/100   ║   │
│  ║  Health: Excellent                                     ║   │
│  ╚════════════════════════════════════════════════════════╝   │
│                                                                │
│  ┌──────────────────┬────────────┐                            │
│  │ Metric           │ Value      │                            │
│  ├──────────────────┼────────────┤                            │
│  │ DEL Committed    │     12     │                            │
│  │ DEL Completed    │     11     │                            │
│  │ Delivery Rate    │    92%     │                            │
│  └──────────────────┴────────────┘                            │
│                                                                │
│  [FTS] [GTS] [Control Center] [Platform] [Talent Studio]      │
│                                                                │
│  Ask a question... [_______________________________] [Ask]     │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

## Features

- **Health Scores** - 0-100 score for each pod based on delivery, blockers, progress
- **DEL Tracking** - Committed vs Completed deliverables with delivery percentage
- **Project Status** - All projects grouped by status (In-Flight, Done, Not Started)
- **AI Insights** - LLM-powered comment summaries and recommendations
- **Live Data** - Real-time data from Linear API with smart caching

## Quick Start

### 1. Clone and Install

```bash
git clone https://github.com/ritwikvats-rgb/linear-kpi-runner.git
cd linear-kpi-runner
npm install
```

### 2. Configure Environment

Create `.env` file:

```
LINEAR_API_KEY=lin_api_your_key_here
FUELIX_API_KEY=your_fuelix_key_here
```

### 3. Run Locally

```bash
npm start
```

Open http://localhost:3000

## Deployment

Deployed on Render: https://linear-kpi-runner.onrender.com

To deploy your own:

1. Push to GitHub
2. Connect repo to [Render](https://render.com)
3. Add environment variables in Render dashboard
4. Deploy

## Documentation

| Document | Description |
|----------|-------------|
| [PROJECT_GUIDE.md](docs/PROJECT_GUIDE.md) | Complete explanation with diagrams |
| [TECHNICAL_IMPLEMENTATION.md](docs/TECHNICAL_IMPLEMENTATION.md) | Technical architecture details |

## Project Structure

```
linear-kpi-runner/
├── agent/src/
│   ├── server.js          # Express web server
│   ├── answerer.js        # Question parser & response generator
│   ├── kpiComputer.js     # KPI calculation engine
│   ├── liveLinear.js      # Linear API integration
│   ├── linearClient.js    # GraphQL client
│   ├── fuelixClient.js    # LLM API client
│   ├── cache.js           # Caching system
│   └── tableFormatter.js  # ASCII table formatting
├── agent/public/
│   └── index.html         # Web UI
├── config/                # Pod & cycle configurations
├── docs/                  # Documentation
└── render.yaml            # Render deployment config
```

## Tech Stack

- **Runtime**: Node.js
- **Web Server**: Express.js
- **API**: Linear GraphQL API
- **AI/LLM**: Fuelix API (GPT-5.2)
- **Hosting**: Render

## License

Private - Internal Use Only
