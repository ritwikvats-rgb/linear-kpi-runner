/* agent/src/historicalDataService.js
 *
 * Historical Data Service for Q1 Analysis
 * Captures weekly snapshots and enables "what went well/wrong" queries
 *
 * Tables:
 *   - weekly_snapshots: Time-series of all metrics (captured weekly)
 *   - cycle_closings: End-of-cycle summaries with context
 *   - events_log: Notable events, blockers, risks, wins
 */

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const STATE_DIR = path.join(process.cwd(), "state");
const HISTORY_DIR = path.join(STATE_DIR, "history");
const DB_PATH = path.join(STATE_DIR, "kpi_state.db");

/* -------------------- INIT -------------------- */

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function openHistoryDb() {
  ensureDir(STATE_DIR);
  ensureDir(HISTORY_DIR);

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");

  // Weekly snapshots - captures all metrics at a point in time
  db.exec(`
    CREATE TABLE IF NOT EXISTS weekly_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_date TEXT NOT NULL,
      week_number INTEGER NOT NULL,
      cycle TEXT NOT NULL,
      pod TEXT NOT NULL,
      committed_del INTEGER DEFAULT 0,
      completed_del INTEGER DEFAULT 0,
      delivery_pct INTEGER DEFAULT 0,
      spillover INTEGER DEFAULT 0,
      planned_features INTEGER DEFAULT 0,
      features_done INTEGER DEFAULT 0,
      features_in_flight INTEGER DEFAULT 0,
      features_not_started INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(snapshot_date, pod, cycle)
    );
  `);

  // Cycle closings - summary at end of each cycle
  db.exec(`
    CREATE TABLE IF NOT EXISTS cycle_closings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cycle TEXT NOT NULL,
      pod TEXT NOT NULL,
      closed_at TEXT NOT NULL,
      final_committed INTEGER DEFAULT 0,
      final_completed INTEGER DEFAULT 0,
      final_delivery_pct INTEGER DEFAULT 0,
      final_spillover INTEGER DEFAULT 0,
      features_completed INTEGER DEFAULT 0,
      features_total INTEGER DEFAULT 0,
      went_well TEXT,
      went_wrong TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(cycle, pod)
    );
  `);

  // Events log - track notable things as they happen
  db.exec(`
    CREATE TABLE IF NOT EXISTS events_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_date TEXT NOT NULL,
      cycle TEXT,
      pod TEXT,
      event_type TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      impact TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Q1 goals - store quarterly goals for comparison
  db.exec(`
    CREATE TABLE IF NOT EXISTS quarterly_goals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quarter TEXT NOT NULL,
      pod TEXT NOT NULL,
      goal_type TEXT NOT NULL,
      target_value INTEGER,
      target_description TEXT,
      actual_value INTEGER,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(quarter, pod, goal_type)
    );
  `);

  return db;
}

/* -------------------- CAPTURE WEEKLY SNAPSHOT -------------------- */

/**
 * Capture a weekly snapshot of all KPI data
 * Call this from your weekly run script
 */
function captureWeeklySnapshot(db, cycleKpi, featureMovement, currentCycle) {
  const now = new Date();
  const snapshotDate = now.toISOString().split('T')[0]; // YYYY-MM-DD
  const weekNumber = getWeekNumber(now);

  const insertSnapshot = db.prepare(`
    INSERT OR REPLACE INTO weekly_snapshots
    (snapshot_date, week_number, cycle, pod, committed_del, completed_del,
     delivery_pct, spillover, planned_features, features_done,
     features_in_flight, features_not_started)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    // Store cycle KPI data for current cycle
    for (const row of cycleKpi) {
      if (row.cycle !== currentCycle) continue;

      const featureRow = featureMovement.find(f => f.pod === row.pod) || {};
      const deliveryPct = parseInt(row.deliveryPct) || 0;

      insertSnapshot.run(
        snapshotDate,
        weekNumber,
        row.cycle,
        row.pod,
        row.committed || 0,
        row.completed || 0,
        deliveryPct,
        row.spillover || 0,
        featureRow.plannedFeatures || 0,
        featureRow.done || 0,
        featureRow.inFlight || 0,
        featureRow.notStarted || 0
      );
    }
  });

  tx();
  console.log(`[HISTORY] Weekly snapshot captured: ${snapshotDate} (week ${weekNumber})`);

  // Also save a JSON snapshot for detailed analysis
  saveJsonSnapshot(cycleKpi, featureMovement, currentCycle, snapshotDate);

  return { snapshotDate, weekNumber };
}

/**
 * Save detailed JSON snapshot to history folder
 */
function saveJsonSnapshot(cycleKpi, featureMovement, currentCycle, snapshotDate) {
  ensureDir(HISTORY_DIR);

  const snapshot = {
    snapshot_date: snapshotDate,
    captured_at: new Date().toISOString(),
    current_cycle: currentCycle,
    cycle_kpi: cycleKpi,
    feature_movement: featureMovement,
    summary: {
      total_committed: cycleKpi.filter(r => r.cycle === currentCycle).reduce((s, r) => s + (r.committed || 0), 0),
      total_completed: cycleKpi.filter(r => r.cycle === currentCycle).reduce((s, r) => s + (r.completed || 0), 0),
      total_spillover: cycleKpi.filter(r => r.cycle === currentCycle).reduce((s, r) => s + (r.spillover || 0), 0),
      total_features: featureMovement.reduce((s, r) => s + (r.plannedFeatures || 0), 0),
      features_done: featureMovement.reduce((s, r) => s + (r.done || 0), 0),
    }
  };

  const filename = `snapshot_${snapshotDate}.json`;
  const filepath = path.join(HISTORY_DIR, filename);
  fs.writeFileSync(filepath, JSON.stringify(snapshot, null, 2), "utf8");
  console.log(`[HISTORY] JSON snapshot saved: ${filepath}`);
}

/* -------------------- CYCLE CLOSING -------------------- */

/**
 * Record cycle closing summary with analysis
 * Call this when a cycle ends
 */
function recordCycleClosing(db, cycle, pod, stats, analysis = {}) {
  const now = new Date().toISOString();

  const insert = db.prepare(`
    INSERT OR REPLACE INTO cycle_closings
    (cycle, pod, closed_at, final_committed, final_completed, final_delivery_pct,
     final_spillover, features_completed, features_total, went_well, went_wrong, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insert.run(
    cycle,
    pod,
    now,
    stats.committed || 0,
    stats.completed || 0,
    stats.deliveryPct || 0,
    stats.spillover || 0,
    stats.featuresCompleted || 0,
    stats.featuresTotal || 0,
    analysis.wentWell || null,
    analysis.wentWrong || null,
    analysis.notes || null
  );

  console.log(`[HISTORY] Cycle closing recorded: ${cycle} / ${pod}`);
}

/* -------------------- LOG EVENTS -------------------- */

/**
 * Log a notable event (blocker, risk, win, etc.)
 */
function logEvent(db, eventType, title, options = {}) {
  const now = new Date().toISOString().split('T')[0];

  const insert = db.prepare(`
    INSERT INTO events_log (event_date, cycle, pod, event_type, title, description, impact)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  insert.run(
    options.date || now,
    options.cycle || null,
    options.pod || null,
    eventType,
    title,
    options.description || null,
    options.impact || null
  );

  console.log(`[HISTORY] Event logged: [${eventType}] ${title}`);
}

// Convenience methods for different event types
function logBlocker(db, title, options = {}) {
  logEvent(db, 'blocker', title, options);
}

function logRisk(db, title, options = {}) {
  logEvent(db, 'risk', title, options);
}

function logWin(db, title, options = {}) {
  logEvent(db, 'win', title, options);
}

function logMilestone(db, title, options = {}) {
  logEvent(db, 'milestone', title, options);
}

/* -------------------- QUARTERLY GOALS -------------------- */

/**
 * Set a quarterly goal for tracking
 */
function setQuarterlyGoal(db, quarter, pod, goalType, target, description = null) {
  const insert = db.prepare(`
    INSERT OR REPLACE INTO quarterly_goals
    (quarter, pod, goal_type, target_value, target_description, status)
    VALUES (?, ?, ?, ?, ?, 'pending')
  `);

  insert.run(quarter, pod, goalType, target, description);
  console.log(`[HISTORY] Goal set: Q${quarter} ${pod} ${goalType} = ${target}`);
}

/**
 * Update goal progress
 */
function updateGoalProgress(db, quarter, pod, goalType, actualValue, status = null) {
  const update = db.prepare(`
    UPDATE quarterly_goals
    SET actual_value = ?, status = COALESCE(?, status)
    WHERE quarter = ? AND pod = ? AND goal_type = ?
  `);

  update.run(actualValue, status, quarter, pod, goalType);
}

/* -------------------- ANALYSIS QUERIES -------------------- */

/**
 * Get all weekly snapshots for a pod/cycle
 */
function getWeeklyTrend(db, pod, cycle = null) {
  let query = `
    SELECT * FROM weekly_snapshots
    WHERE pod = ?
  `;
  const params = [pod];

  if (cycle) {
    query += ` AND cycle = ?`;
    params.push(cycle);
  }

  query += ` ORDER BY snapshot_date ASC`;

  return db.prepare(query).all(...params);
}

/**
 * Get delivery % trend across weeks for all pods
 */
function getDeliveryTrend(db, cycle = null) {
  let query = `
    SELECT snapshot_date, pod, delivery_pct, committed_del, completed_del
    FROM weekly_snapshots
  `;

  if (cycle) {
    query += ` WHERE cycle = ?`;
  }

  query += ` ORDER BY snapshot_date ASC, pod ASC`;

  return cycle ? db.prepare(query).all(cycle) : db.prepare(query).all();
}

/**
 * Get all events in date range
 */
function getEvents(db, startDate = null, endDate = null, eventType = null) {
  let query = `SELECT * FROM events_log WHERE 1=1`;
  const params = [];

  if (startDate) {
    query += ` AND event_date >= ?`;
    params.push(startDate);
  }
  if (endDate) {
    query += ` AND event_date <= ?`;
    params.push(endDate);
  }
  if (eventType) {
    query += ` AND event_type = ?`;
    params.push(eventType);
  }

  query += ` ORDER BY event_date DESC`;

  return db.prepare(query).all(...params);
}

/**
 * Get cycle closing summaries
 */
function getCycleClosings(db, cycle = null) {
  let query = `SELECT * FROM cycle_closings`;

  if (cycle) {
    query += ` WHERE cycle = ?`;
    return db.prepare(query).all(cycle);
  }

  query += ` ORDER BY cycle ASC, pod ASC`;
  return db.prepare(query).all();
}

/**
 * Get quarterly goals with progress
 */
function getQuarterlyGoals(db, quarter) {
  const query = `
    SELECT * FROM quarterly_goals
    WHERE quarter = ?
    ORDER BY pod, goal_type
  `;
  return db.prepare(query).all(quarter);
}

/* -------------------- Q1 ANALYSIS: WHAT WENT WELL/WRONG -------------------- */

/**
 * Generate comprehensive Q1 analysis
 * This is what you'll call at the end of Q1 to get precise answers
 */
function generateQ1Analysis(db) {
  const quarter = "2026-Q1";

  // Get all cycle closings
  const closings = getCycleClosings(db);

  // Get all weekly snapshots
  const allSnapshots = db.prepare(`
    SELECT * FROM weekly_snapshots ORDER BY snapshot_date ASC
  `).all();

  // Get all events
  const allEvents = getEvents(db);

  // Get goals
  const goals = getQuarterlyGoals(db, quarter);

  // Analyze what went well
  const wentWell = analyzeWentWell(closings, allSnapshots, allEvents, goals);

  // Analyze what went wrong
  const wentWrong = analyzeWentWrong(closings, allSnapshots, allEvents, goals);

  // Trend analysis
  const trends = analyzeTrends(allSnapshots);

  // Pod rankings
  const podRankings = rankPods(closings, allSnapshots);

  return {
    quarter,
    generated_at: new Date().toISOString(),
    summary: {
      total_cycles_completed: new Set(closings.map(c => c.cycle)).size,
      total_events_logged: allEvents.length,
      blockers_count: allEvents.filter(e => e.event_type === 'blocker').length,
      wins_count: allEvents.filter(e => e.event_type === 'win').length,
      goals_met: goals.filter(g => g.status === 'achieved').length,
      goals_total: goals.length,
    },
    went_well: wentWell,
    went_wrong: wentWrong,
    trends,
    pod_rankings: podRankings,
    recommendations: generateRecommendations(wentWell, wentWrong, trends),
  };
}

/**
 * Analyze what went well
 */
function analyzeWentWell(closings, snapshots, events, goals) {
  const well = {
    high_performers: [],
    improving_pods: [],
    goals_achieved: [],
    wins: [],
    milestones: [],
  };

  // Find high performers (>80% delivery consistently)
  const podDelivery = {};
  for (const snap of snapshots) {
    if (!podDelivery[snap.pod]) podDelivery[snap.pod] = [];
    podDelivery[snap.pod].push(snap.delivery_pct);
  }

  for (const [pod, deliveries] of Object.entries(podDelivery)) {
    const avg = deliveries.reduce((a, b) => a + b, 0) / deliveries.length;
    if (avg >= 80) {
      well.high_performers.push({
        pod,
        avg_delivery: Math.round(avg),
        weeks_tracked: deliveries.length,
      });
    }
  }

  // Find improving pods (upward trend)
  for (const [pod, deliveries] of Object.entries(podDelivery)) {
    if (deliveries.length >= 3) {
      const firstHalf = deliveries.slice(0, Math.floor(deliveries.length / 2));
      const secondHalf = deliveries.slice(Math.floor(deliveries.length / 2));
      const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
      const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;

      if (secondAvg > firstAvg + 10) { // >10% improvement
        well.improving_pods.push({
          pod,
          improvement: Math.round(secondAvg - firstAvg),
          from: Math.round(firstAvg),
          to: Math.round(secondAvg),
        });
      }
    }
  }

  // Goals achieved
  well.goals_achieved = goals.filter(g => g.status === 'achieved').map(g => ({
    pod: g.pod,
    goal_type: g.goal_type,
    target: g.target_value,
    actual: g.actual_value,
  }));

  // Wins from events
  well.wins = events.filter(e => e.event_type === 'win').map(e => ({
    date: e.event_date,
    pod: e.pod,
    title: e.title,
    description: e.description,
  }));

  // Milestones
  well.milestones = events.filter(e => e.event_type === 'milestone').map(e => ({
    date: e.event_date,
    pod: e.pod,
    title: e.title,
  }));

  return well;
}

/**
 * Analyze what went wrong
 */
function analyzeWentWrong(closings, snapshots, events, goals) {
  const wrong = {
    low_performers: [],
    declining_pods: [],
    high_spillover: [],
    blockers: [],
    risks_realized: [],
    goals_missed: [],
    features_stuck: [],
  };

  // Find low performers (<50% delivery)
  const podDelivery = {};
  for (const snap of snapshots) {
    if (!podDelivery[snap.pod]) podDelivery[snap.pod] = [];
    podDelivery[snap.pod].push(snap.delivery_pct);
  }

  for (const [pod, deliveries] of Object.entries(podDelivery)) {
    const avg = deliveries.reduce((a, b) => a + b, 0) / deliveries.length;
    if (avg < 50 && deliveries.some(d => d > 0)) {
      wrong.low_performers.push({
        pod,
        avg_delivery: Math.round(avg),
        lowest: Math.min(...deliveries),
      });
    }
  }

  // Find declining pods
  for (const [pod, deliveries] of Object.entries(podDelivery)) {
    if (deliveries.length >= 3) {
      const firstHalf = deliveries.slice(0, Math.floor(deliveries.length / 2));
      const secondHalf = deliveries.slice(Math.floor(deliveries.length / 2));
      const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
      const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;

      if (secondAvg < firstAvg - 10) { // >10% decline
        wrong.declining_pods.push({
          pod,
          decline: Math.round(firstAvg - secondAvg),
          from: Math.round(firstAvg),
          to: Math.round(secondAvg),
        });
      }
    }
  }

  // High spillover cycles
  for (const closing of closings) {
    if (closing.final_spillover > 0 && closing.final_committed > 0) {
      const spilloverPct = (closing.final_spillover / closing.final_committed) * 100;
      if (spilloverPct >= 30) {
        wrong.high_spillover.push({
          cycle: closing.cycle,
          pod: closing.pod,
          spillover: closing.final_spillover,
          committed: closing.final_committed,
          spillover_pct: Math.round(spilloverPct),
        });
      }
    }
  }

  // Blockers
  wrong.blockers = events.filter(e => e.event_type === 'blocker').map(e => ({
    date: e.event_date,
    pod: e.pod,
    cycle: e.cycle,
    title: e.title,
    impact: e.impact,
  }));

  // Risks realized
  wrong.risks_realized = events.filter(e => e.event_type === 'risk').map(e => ({
    date: e.event_date,
    pod: e.pod,
    title: e.title,
    impact: e.impact,
  }));

  // Goals missed
  wrong.goals_missed = goals.filter(g => g.status === 'missed' ||
    (g.actual_value !== null && g.actual_value < g.target_value * 0.8)
  ).map(g => ({
    pod: g.pod,
    goal_type: g.goal_type,
    target: g.target_value,
    actual: g.actual_value,
    gap: g.target_value - (g.actual_value || 0),
  }));

  // Features stuck (many not started or 0 done over time)
  const latestSnaps = {};
  for (const snap of snapshots) {
    if (!latestSnaps[snap.pod] || snap.snapshot_date > latestSnaps[snap.pod].snapshot_date) {
      latestSnaps[snap.pod] = snap;
    }
  }

  for (const [pod, snap] of Object.entries(latestSnaps)) {
    if (snap.planned_features > 0 && snap.features_done === 0 && snap.features_in_flight === 0) {
      wrong.features_stuck.push({
        pod,
        planned: snap.planned_features,
        done: snap.features_done,
        in_flight: snap.features_in_flight,
      });
    }
  }

  return wrong;
}

/**
 * Analyze trends over time
 */
function analyzeTrends(snapshots) {
  const trends = {
    overall_delivery_trend: [],
    commitment_trend: [],
    feature_completion_trend: [],
  };

  // Group by week
  const byWeek = {};
  for (const snap of snapshots) {
    if (!byWeek[snap.snapshot_date]) byWeek[snap.snapshot_date] = [];
    byWeek[snap.snapshot_date].push(snap);
  }

  // Calculate weekly aggregates
  for (const [date, snaps] of Object.entries(byWeek)) {
    const totalCommitted = snaps.reduce((s, r) => s + r.committed_del, 0);
    const totalCompleted = snaps.reduce((s, r) => s + r.completed_del, 0);
    const totalFeatures = snaps.reduce((s, r) => s + r.planned_features, 0);
    const featuresDone = snaps.reduce((s, r) => s + r.features_done, 0);

    trends.overall_delivery_trend.push({
      date,
      delivery_pct: totalCommitted > 0 ? Math.round((totalCompleted / totalCommitted) * 100) : 0,
    });

    trends.commitment_trend.push({
      date,
      total_committed: totalCommitted,
    });

    trends.feature_completion_trend.push({
      date,
      features_done: featuresDone,
      features_total: totalFeatures,
      completion_pct: totalFeatures > 0 ? Math.round((featuresDone / totalFeatures) * 100) : 0,
    });
  }

  return trends;
}

/**
 * Rank pods by performance
 */
function rankPods(closings, snapshots) {
  const podScores = {};

  // Calculate composite score per pod
  const podDelivery = {};
  const podSpillover = {};

  for (const snap of snapshots) {
    if (!podDelivery[snap.pod]) podDelivery[snap.pod] = [];
    podDelivery[snap.pod].push(snap.delivery_pct);
  }

  for (const closing of closings) {
    if (!podSpillover[closing.pod]) podSpillover[closing.pod] = [];
    if (closing.final_committed > 0) {
      podSpillover[closing.pod].push(closing.final_spillover / closing.final_committed);
    }
  }

  const pods = [...new Set([...Object.keys(podDelivery), ...Object.keys(podSpillover)])];

  for (const pod of pods) {
    const deliveries = podDelivery[pod] || [];
    const spillovers = podSpillover[pod] || [];

    const avgDelivery = deliveries.length > 0
      ? deliveries.reduce((a, b) => a + b, 0) / deliveries.length
      : 0;

    const avgSpillover = spillovers.length > 0
      ? spillovers.reduce((a, b) => a + b, 0) / spillovers.length
      : 0;

    // Score = delivery % - (spillover % penalty)
    const score = avgDelivery - (avgSpillover * 50);

    podScores[pod] = {
      pod,
      avg_delivery: Math.round(avgDelivery),
      avg_spillover_pct: Math.round(avgSpillover * 100),
      score: Math.round(score),
    };
  }

  return Object.values(podScores).sort((a, b) => b.score - a.score);
}

/**
 * Generate actionable recommendations based on analysis
 */
function generateRecommendations(wentWell, wentWrong, trends) {
  const recommendations = [];

  // Based on low performers
  for (const lp of wentWrong.low_performers) {
    recommendations.push({
      priority: 'high',
      pod: lp.pod,
      type: 'performance',
      recommendation: `${lp.pod} averaged only ${lp.avg_delivery}% delivery. Investigate capacity constraints, scope clarity, and blockers.`,
    });
  }

  // Based on high spillover
  for (const hs of wentWrong.high_spillover) {
    recommendations.push({
      priority: 'high',
      pod: hs.pod,
      type: 'planning',
      recommendation: `${hs.pod} had ${hs.spillover_pct}% spillover in ${hs.cycle}. Review estimation practices and commitment process.`,
    });
  }

  // Based on stuck features
  for (const sf of wentWrong.features_stuck) {
    recommendations.push({
      priority: 'medium',
      pod: sf.pod,
      type: 'execution',
      recommendation: `${sf.pod} has ${sf.planned} features planned but none started. Clarify priorities and remove blockers.`,
    });
  }

  // Based on declining pods
  for (const dp of wentWrong.declining_pods) {
    recommendations.push({
      priority: 'high',
      pod: dp.pod,
      type: 'trend',
      recommendation: `${dp.pod} delivery declined from ${dp.from}% to ${dp.to}%. Investigate causes: scope creep, team changes, technical debt.`,
    });
  }

  // Positive reinforcement
  for (const hp of wentWell.high_performers) {
    recommendations.push({
      priority: 'low',
      pod: hp.pod,
      type: 'recognition',
      recommendation: `${hp.pod} maintained ${hp.avg_delivery}% delivery over ${hp.weeks_tracked} weeks. Consider sharing their practices.`,
    });
  }

  return recommendations;
}

/* -------------------- HELPERS -------------------- */

function getWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

/* -------------------- EXPORTS -------------------- */

module.exports = {
  openHistoryDb,
  captureWeeklySnapshot,
  recordCycleClosing,
  logEvent,
  logBlocker,
  logRisk,
  logWin,
  logMilestone,
  setQuarterlyGoal,
  updateGoalProgress,
  getWeeklyTrend,
  getDeliveryTrend,
  getEvents,
  getCycleClosings,
  getQuarterlyGoals,
  generateQ1Analysis,
  HISTORY_DIR,
};
