/**
 * Linear Weekly KPI Runner (Q1 2026, Baseline C1..C6) + SQLite Snapshots
 *
 * Outputs:
 *  - out/pod_cycle_kpi.csv
 *  - out/pod_feature_movement.csv
 *  - out/kpi_weekly_report.md
 *
 * Reads:
 *  - config/pods.json
 *  - config/cycle_calendar.json   <-- POD-SPECIFIC CANONICAL CALENDAR (you now control this)
 *
 * Writes:
 *  - config/label_ids.json
 *  - config/linear_ids.json
 *
 * Hard rules:
 *  - Cycle grouping uses ONLY baseline labels 2026Q1-C1..C6
 *  - Never uses Linear issue.cycle.number/name for grouping
 *
 * Spillover rules (THIS FIXES YOUR PROBLEM):
 *  - If cycle is ACTIVE for that pod (now <= cycleEnd): Spillover = 0
 *  - If cycle is CLOSED (now > cycleEnd): Spillover = committed_snapshot - completed_by_cycle_end
 *  - committed_snapshot comes from SQLite so we don't lose history
 *
 * Adoption grace (late labeling):
 *  - Until the end of C2, snapshots for C1 and C2 are allowed to refresh.
 *    This allows "someone forgot DEL label earlier" to still count for C1/C2.
 *  - After end of C2, C1 and C2 snapshots freeze permanently.
 *  - For C3+ snapshots freeze at their own cycle end.
 *
 * Config knobs:
 *  - KPI_CYCLE=C1..C6 (optional) override printed cycle table
 *  - FREEZE_POLICY_CYCLE=C2 (default) meaning C1/C2 freeze after C2 ends
 */

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

// Import shared utilities
const {
  getCycleKeyByDate,
  shouldAllowRefreshForCycle,
  shouldFreezeNow,
  isCycleActive,
  cycleIndex,
} = require("../agent/src/shared/cycleUtils");

const { norm } = require("../agent/src/shared/labelUtils");

const LINEAR_API_KEY = process.env.LINEAR_API_KEY;
if (!LINEAR_API_KEY) {
  console.error("Missing LINEAR_API_KEY env var");
  process.exit(1);
}

const KPI_CYCLE_OVERRIDE = process.env.KPI_CYCLE; // e.g. C1..C6
const FREEZE_POLICY_CYCLE = (process.env.FREEZE_POLICY_CYCLE || "C2").toUpperCase(); // default C2

const GQL_URL = "https://api.linear.app/graphql";
const OUT_DIR = path.join(process.cwd(), "out");
const CONFIG_DIR = path.join(process.cwd(), "config");
const STATE_DIR = path.join(process.cwd(), "state");
const DB_PATH = path.join(STATE_DIR, "kpi_state.db");

/* -------------------- HELPERS -------------------- */

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}
function writeJson(fp, obj) {
  fs.writeFileSync(fp, JSON.stringify(obj, null, 2), "utf8");
}
function writeText(fp, s) {
  fs.writeFileSync(fp, s, "utf8");
}
function csvEscape(v) {
  const s = String(v ?? "");
  if (s.includes(",") || s.includes('"') || s.includes("\n")) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// Use local versions for CSV-specific row format (different property names)
function sumCommittedForCycle(kpiRows, cycleKey) {
  return kpiRows
    .filter(r => r.Cycle === cycleKey)
    .reduce((acc, r) => acc + Number(r.Committed_DEL || 0), 0);
}

function getBestCycleByCommitted(kpiRows) {
  let best = "C1";
  let bestSum = -1;
  for (let i = 1; i <= 6; i++) {
    const c = `C${i}`;
    const s = sumCommittedForCycle(kpiRows, c);
    if (s > bestSum) {
      bestSum = s;
      best = c;
    }
  }
  return { bestCycle: best, bestCommittedSum: bestSum };
}

function printPodCycleTable(kpiRows, cycleKey, titleSuffix = "") {
  const rows = kpiRows
    .filter(r => r.Cycle === cycleKey)
    .map(r => ({
      Pod: r.Pod,
      Cycle: r.Cycle,
      "Committed DEL": r.Committed_DEL,
      "Completed DEL": r.Completed_DEL,
      "Delivery %": r.DeliveryPct,
      Spillover: r.Spillover,
    }));

  console.log(`\nA) Pod-wise Cycle KPI table (cycle=${cycleKey})${titleSuffix}`);
  console.table(rows);
}

function printFeatureMovementTable(featureRows) {
  const rows = featureRows.map(r => ({
    Pod: r.Pod,
    "Planned Features": r.PlannedFeatures,
    Done: r.Done,
    "In-Flight": r.InFlight,
    "Not Started": r.NotStarted,
  }));

  console.log(`\nB) "How are our planned features moving?" (weekly snapshot)`);
  console.table(rows);
}

/* -------------------- SQLITE STATE -------------------- */

function openDb() {
  ensureDir(STATE_DIR);
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS snapshots (
      pod TEXT NOT NULL,
      cycle TEXT NOT NULL,
      issueId TEXT NOT NULL,
      PRIMARY KEY (pod, cycle, issueId)
    );

    CREATE TABLE IF NOT EXISTS snapshot_meta (
      pod TEXT NOT NULL,
      cycle TEXT NOT NULL,
      frozen INTEGER NOT NULL DEFAULT 0,
      frozenAt TEXT,
      lastRefreshAt TEXT,
      committedCount INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (pod, cycle)
    );
  `);

  return db;
}

function getSnapshotIssueIds(db, pod, cycle) {
  const stmt = db.prepare(`SELECT issueId FROM snapshots WHERE pod=? AND cycle=?`);
  return stmt.all(pod, cycle).map(r => r.issueId);
}

function getSnapshotMeta(db, pod, cycle) {
  const stmt = db.prepare(`SELECT * FROM snapshot_meta WHERE pod=? AND cycle=?`);
  return stmt.get(pod, cycle) || null;
}

function upsertSnapshot(db, pod, cycle, issueIds, allowRefresh) {
  const nowIso = new Date().toISOString();

  const meta = getSnapshotMeta(db, pod, cycle);
  const isFrozen = meta?.frozen === 1;

  if (!meta) {
    const insMeta = db.prepare(`
      INSERT INTO snapshot_meta(pod, cycle, frozen, frozenAt, lastRefreshAt, committedCount)
      VALUES (?, ?, 0, NULL, ?, ?)
    `);
    insMeta.run(pod, cycle, nowIso, issueIds.length);

    const ins = db.prepare(`INSERT OR IGNORE INTO snapshots(pod, cycle, issueId) VALUES (?, ?, ?)`);
    const tx = db.transaction(() => {
      for (const id of issueIds) ins.run(pod, cycle, id);
    });
    tx();

    console.log(`[STATE] Snapshot created: pod="${pod}" cycle="${cycle}" committed=${issueIds.length}`);
    return;
  }

  if (isFrozen || !allowRefresh) {
    // do nothing
    return;
  }

  // refresh diff
  const existing = new Set(getSnapshotIssueIds(db, pod, cycle));
  const incoming = new Set(issueIds);

  const toInsert = [];
  const toDelete = [];

  for (const id of incoming) if (!existing.has(id)) toInsert.push(id);
  for (const id of existing) if (!incoming.has(id)) toDelete.push(id);

  const ins = db.prepare(`INSERT OR IGNORE INTO snapshots(pod, cycle, issueId) VALUES (?, ?, ?)`);
  const del = db.prepare(`DELETE FROM snapshots WHERE pod=? AND cycle=? AND issueId=?`);
  const updMeta = db.prepare(`
    UPDATE snapshot_meta
      SET lastRefreshAt=?, committedCount=?
    WHERE pod=? AND cycle=?
  `);

  const tx = db.transaction(() => {
    for (const id of toInsert) ins.run(pod, cycle, id);
    for (const id of toDelete) del.run(pod, cycle, id);
    updMeta.run(nowIso, incoming.size, pod, cycle);
  });
  tx();

  if (toInsert.length || toDelete.length) {
    console.log(
      `[STATE] Snapshot refreshed: pod="${pod}" cycle="${cycle}" +${toInsert.length} -${toDelete.length} now=${incoming.size}`
    );
  }
}

function freezeSnapshot(db, pod, cycle) {
  const meta = getSnapshotMeta(db, pod, cycle);
  if (!meta || meta.frozen === 1) return;

  const nowIso = new Date().toISOString();
  const upd = db.prepare(`
    UPDATE snapshot_meta
      SET frozen=1, frozenAt=?
    WHERE pod=? AND cycle=?
  `);
  upd.run(nowIso, pod, cycle);

  console.log(`[STATE] Snapshot frozen: pod="${pod}" cycle="${cycle}" committed=${meta.committedCount}`);
}

/* -------------------- FREEZE POLICY (using shared utilities) -------------------- */

// Wrapper to use module-level FREEZE_POLICY_CYCLE with shared utilities
function allowRefreshForCycle(podCalendar, cycleKey, now) {
  return shouldAllowRefreshForCycle(podCalendar, cycleKey, now, FREEZE_POLICY_CYCLE);
}

function freezeNow(podCalendar, cycleKey, now) {
  return shouldFreezeNow(podCalendar, cycleKey, now, FREEZE_POLICY_CYCLE);
}

function isCycleActiveForPod(podCalendar, cycleKey, now) {
  return isCycleActive(podCalendar, cycleKey, now);
}

/* -------------------- GQL -------------------- */

async function gql(query, variables = {}) {
  const res = await fetch(GQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": LINEAR_API_KEY
    },
    body: JSON.stringify({ query, variables })
  });

  const json = await res.json();
  if (json.errors?.length) {
    const msg = json.errors.map(e => e.message).join("; ");
    throw new Error(`Linear API error: ${msg}`);
  }
  return json.data;
}

async function paginateNodes(query, variables, pickConnection) {
  const out = [];
  let after = null;
  while (true) {
    const data = await gql(query, { ...variables, first: 100, after });
    const conn = pickConnection(data);
    out.push(...(conn.nodes || []));
    if (!conn.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return out;
}

/* -------------------- QUERIES -------------------- */

const Q_VIEWER_ORG = `
query {
  viewer {
    organization { id name urlKey }
  }
}
`;

const Q_ALL_LABELS = `
query($first:Int!, $after:String) {
  issueLabels(first:$first, after:$after) {
    nodes { id name }
    pageInfo { hasNextPage endCursor }
  }
}
`;

const Q_ALL_INITIATIVES = `
query($first:Int!, $after:String) {
  initiatives(first:$first, after:$after) {
    nodes { id name }
    pageInfo { hasNextPage endCursor }
  }
}
`;

const Q_PROJECTS_BY_INITIATIVE = `
query($first:Int!, $after:String, $initiativeId:ID!) {
  projects(first:$first, after:$after, filter:{
    initiatives:{ id:{ eq:$initiativeId } }
  }) {
    nodes { id name state }
    pageInfo { hasNextPage endCursor }
  }
}
`;

const Q_ISSUES_BY_TEAM_AND_DEL = `
query($first:Int!, $after:String, $teamId:ID!, $delLabelId:ID!) {
  issues(first:$first, after:$after, filter:{
    team: { id: { eq: $teamId } },
    labels: { id: { eq: $delLabelId } }
  }) {
    nodes {
      id
      identifier
      createdAt
      completedAt
      state { type }
      labels { nodes { id name } }
    }
    pageInfo { hasNextPage endCursor }
  }
}
`;

/* -------------------- BOOTSTRAP -------------------- */

async function bootstrap(podsPath) {
  ensureDir(CONFIG_DIR);

  const orgData = await gql(Q_VIEWER_ORG);
  const org = orgData.viewer.organization;
  console.log(`Org: ${org.name} (urlKey=${org.urlKey}, orgId=${org.id})`);

  const pods = JSON.parse(fs.readFileSync(podsPath, "utf8"));

  const allLabels = await paginateNodes(Q_ALL_LABELS, {}, d => d.issueLabels);
  const labelByNormName = new Map(allLabels.map(l => [norm(l.name), l]));

  function resolveLabelId(name) {
    const found = labelByNormName.get(norm(name));
    if (!found) console.log(`[LOUD] Label NOT FOUND: "${name}"`);
    return found?.id || null;
  }

  const labelIds = {
    DEL: resolveLabelId("DEL"),
    "DEL-CANCELLED": resolveLabelId("DEL-CANCELLED"),
  };
  for (let i = 1; i <= 6; i++) {
    labelIds[`2026Q1-C${i}`] = resolveLabelId(`2026Q1-C${i}`);
  }
  writeJson(path.join(CONFIG_DIR, "label_ids.json"), labelIds);

  const allInits = await paginateNodes(Q_ALL_INITIATIVES, {}, d => d.initiatives);

  function findInitiativeIdByName(targetName) {
    const t = String(targetName || "").trim().toLowerCase();
    if (!t) return null;

    let hit = allInits.find(x => (x.name || "").trim().toLowerCase() === t);
    if (hit) return hit.id;

    hit = allInits.find(x => (x.name || "").trim().toLowerCase().includes(t));
    if (hit) return hit.id;

    return null;
  }

  const podsResolved = {};
  for (const [podName, cfg] of Object.entries(pods)) {
    const initiativeId = findInitiativeIdByName(cfg.initiativeName);

    if (!initiativeId) {
      console.log(`[LOUD] Initiative NOT FOUND for pod="${podName}" name="${cfg.initiativeName}"`);
      podsResolved[podName] = { ...cfg, initiativeId: null, projects: [] };
      continue;
    }

    const projects = await paginateNodes(
      Q_PROJECTS_BY_INITIATIVE,
      { initiativeId },
      d => d.projects
    );

    console.log(`Pod="${podName}" initiative ✓ projects=${projects.length}`);

    podsResolved[podName] = {
      ...cfg,
      initiativeId,
      projects: projects.map(p => ({ id: p.id, name: p.name, state: p.state || null })),
    };
  }

  writeJson(path.join(CONFIG_DIR, "linear_ids.json"), { org, pods: podsResolved });
  return { org, labelIds, podsResolved };
}

/* -------------------- LOAD POD CALENDAR -------------------- */

function loadPodCalendars() {
  const fp = path.join(CONFIG_DIR, "cycle_calendar.json");
  if (!fs.existsSync(fp)) throw new Error(`Missing ${fp}`);
  const obj = JSON.parse(fs.readFileSync(fp, "utf8"));
  if (!obj?.pods) throw new Error(`Invalid cycle_calendar.json: missing "pods"`);
  return obj.pods;
}

/* -------------------- KPI-A (Pod x Cycle) -------------------- */

async function generatePodCycleKpi(db, podsResolved, labelIds, podCalendars) {
  const delId = labelIds.DEL;
  const cancelledId = labelIds["DEL-CANCELLED"];
  if (!delId) console.log("[LOUD] DEL labelId missing. KPI-A will be all zeros.");

  const now = new Date();
  const rows = [];

  for (const [podName, pod] of Object.entries(podsResolved)) {
    const podCalendar = podCalendars[podName];
    if (!podCalendar) {
      console.log(`[LOUD] Missing calendar for pod="${podName}" in config/cycle_calendar.json`);
    }

    let issues = [];
    if (delId) {
      issues = await paginateNodes(
        Q_ISSUES_BY_TEAM_AND_DEL,
        { teamId: pod.teamId, delLabelId: delId },
        d => d.issues
      );
    }

    const enriched = issues.map(it => {
      const labels = (it.labels?.nodes || []).map(x => ({ id: x.id, name: x.name }));
      const labelSet = new Set(labels.map(x => x.id));
      return { ...it, _labels: labels, _labelSet: labelSet };
    });

    for (let i = 1; i <= 6; i++) {
      const cycleKey = `C${i}`;
      const baselineId = labelIds[`2026Q1-C${i}`];

      // committed set NOW (used to seed/refresh snapshots)
      const committedNowIds = [];
      for (const it of enriched) {
        const hasBaseline = baselineId ? it._labelSet.has(baselineId) : false;
        if (!hasBaseline) continue;

        const isCancelled = cancelledId ? it._labelSet.has(cancelledId) : false;
        if (isCancelled) continue;

        committedNowIds.push(it.id);
      }

      // snapshot maintenance
      const allowRefresh = allowRefreshForCycle(podCalendar, cycleKey, now);
      upsertSnapshot(db, podName, cycleKey, committedNowIds, allowRefresh);

      // freeze if needed
      if (freezeNow(podCalendar, cycleKey, now)) {
        freezeSnapshot(db, podName, cycleKey);
      }

      // committed count is from snapshot (stable-ish)
      const committedSnapshotIds = getSnapshotIssueIds(db, podName, cycleKey);
      const committed = committedSnapshotIds.length;

      // completed by cycle end (even if label was added later — that’s your adoption leverage)
      const cycleEnd = podCalendar?.[cycleKey]?.end ? new Date(podCalendar[cycleKey].end) : null;
      let completedByEnd = 0;

      if (cycleEnd) {
        const snapSet = new Set(committedSnapshotIds);
        for (const it of enriched) {
          if (!snapSet.has(it.id)) continue;
          const isDone = it.state?.type === "completed";
          if (!isDone) continue;
          const doneAt = it.completedAt ? new Date(it.completedAt) : null;
          if (doneAt && doneAt.getTime() <= cycleEnd.getTime()) completedByEnd += 1;
        }
      }

      // completed SO FAR (for active cycle table / delivery %)
      let completedSoFar = 0;
      {
        const snapSet = new Set(committedSnapshotIds);
        for (const it of enriched) {
          if (!snapSet.has(it.id)) continue;
          const isDone = it.state?.type === "completed";
          if (!isDone) continue;
          const doneAt = it.completedAt ? new Date(it.completedAt) : null;
          if (doneAt && doneAt.getTime() <= now.getTime()) completedSoFar += 1;
        }
      }

      const active = isCycleActiveForPod(podCalendar, cycleKey, now);

      // ✅ THIS IS THE CORE FIX:
      // - active => spillover 0
      // - closed => committed_snapshot - completed_by_end
      const spillover = active ? 0 : Math.max(0, committed - completedByEnd);

      const completedForPct = active ? completedSoFar : completedByEnd;
      const pct = committed === 0 ? "0%" : `${Math.round((completedForPct / committed) * 100)}%`;

      rows.push({
        Pod: podName,
        Cycle: cycleKey,
        Committed_DEL: committed,
        Completed_DEL: completedForPct,
        DeliveryPct: pct,
        Spillover: spillover
      });
    }
  }

  ensureDir(OUT_DIR);
  const header = ["Pod", "Cycle", "Committed_DEL", "Completed_DEL", "DeliveryPct", "Spillover"];
  const lines = [header.join(",")];
  for (const r of rows) lines.push(header.map(h => csvEscape(r[h])).join(","));
  writeText(path.join(OUT_DIR, "pod_cycle_kpi.csv"), lines.join("\n"));

  return rows;
}

/* -------------------- KPI-B (Feature movement) -------------------- */

function generatePodFeatureMovement(podsResolved) {
  const rows = [];
  for (const [podName, pod] of Object.entries(podsResolved)) {
    const projects = pod.projects || [];
    let done = 0, inflight = 0, notStarted = 0;

    for (const p of projects) {
      const st = norm(p.state);
      if (st === "completed") done += 1;
      else if (st === "started" || st === "in_progress" || st === "inprogress") inflight += 1;
      else notStarted += 1;
    }

    rows.push({
      Pod: podName,
      PlannedFeatures: projects.length,
      Done: done,
      InFlight: inflight,
      NotStarted: notStarted,
    });
  }

  ensureDir(OUT_DIR);
  const header = ["Pod", "PlannedFeatures", "Done", "InFlight", "NotStarted"];
  const lines = [header.join(",")];
  for (const r of rows) lines.push(header.map(h => csvEscape(r[h])).join(","));
  writeText(path.join(OUT_DIR, "pod_feature_movement.csv"), lines.join("\n"));

  return rows;
}

/* -------------------- MARKDOWN REPORT -------------------- */

function writeWeeklyReport(org, _podCalendars, kpiB) {
  const md = [];
  md.push(`# Weekly KPI Report`);
  md.push(`- Org: **${org.name}** (${org.urlKey})`);
  md.push(``);
  md.push(`## Pod Feature Movement`);
  md.push(`Pod | PlannedFeatures | Done | InFlight | NotStarted`);
  md.push(`---|---:|---:|---:|---:`);
  for (const r of kpiB) md.push(`${r.Pod} | ${r.PlannedFeatures} | ${r.Done} | ${r.InFlight} | ${r.NotStarted}`);

  md.push(``);
  md.push(`## Calendar source`);
  md.push(`- Using config/cycle_calendar.json (pod-specific canonical dates)`);

  writeText(path.join(OUT_DIR, "kpi_weekly_report.md"), md.join("\n"));
}

/* -------------------- MAIN -------------------- */

async function main() {
  const podsPath = path.join("config", "pods.json");
  if (!fs.existsSync(podsPath)) throw new Error(`Missing ${podsPath}`);

  const podCalendars = loadPodCalendars();

  const db = openDb();
  const { org, labelIds, podsResolved } = await bootstrap(podsPath);

  const kpiA = await generatePodCycleKpi(db, podsResolved, labelIds, podCalendars);
  const kpiB = generatePodFeatureMovement(podsResolved);

  // cycle selection: use FTS calendar as the "global current cycle key"
  const now = new Date();
  const ftsCal = podCalendars["FTS"] || podCalendars[Object.keys(podCalendars)[0]];
  let cycleToPrint = null;

  if (KPI_CYCLE_OVERRIDE && /^C[1-6]$/i.test(KPI_CYCLE_OVERRIDE.trim())) {
    cycleToPrint = KPI_CYCLE_OVERRIDE.trim().toUpperCase();
    console.log(`\n[INFO] Using KPI_CYCLE override: ${cycleToPrint}`);
  } else {
    cycleToPrint = getCycleKeyByDate(ftsCal, now);
    console.log(`\n[INFO] Current cycle by date (using FTS calendar): ${cycleToPrint}`);
  }

  printPodCycleTable(kpiA, cycleToPrint);

  // fallback: show most-committed cycle if chosen cycle is zero
  const committedSum = sumCommittedForCycle(kpiA, cycleToPrint);
  if (committedSum === 0) {
    const { bestCycle, bestCommittedSum } = getBestCycleByCommitted(kpiA);
    if (bestCommittedSum > 0 && bestCycle !== cycleToPrint) {
      printPodCycleTable(kpiA, bestCycle, `  [AUTO-FALLBACK: most committed cycle]`);
      console.log(`[INFO] Reason: cycle (${cycleToPrint}) has 0 committed; most committed is ${bestCycle} (${bestCommittedSum}).`);
    }
  }

  printFeatureMovementTable(kpiB);
  writeWeeklyReport(org, podCalendars, kpiB);

  console.log(`\n=== RUN SUMMARY ===`);
  console.log(`Org: ${org.name} (urlKey=${org.urlKey}, orgId=${org.id})`);
  console.log(`DB: ${DB_PATH}`);
  console.log(`Spillover policy: ACTIVE cycle => 0, CLOSED cycle => committed_snapshot - completed_by_end`);
  console.log(`Freeze policy: C1/C2 freeze after end of ${FREEZE_POLICY_CYCLE} (default C2). C3+ freeze at their end.`);

  for (const [podName, pod] of Object.entries(podsResolved)) {
    console.log(`Pod: ${podName} | initiativeFound=${pod.initiativeId ? "YES" : "NO"} | projects=${pod.projects?.length || 0}`);
  }

  console.log(`Outputs: out/pod_cycle_kpi.csv, out/pod_feature_movement.csv, out/kpi_weekly_report.md`);
  db.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
