/* agent/src/tableFormatter.js
 * Beautiful box-style table formatter for CLI output
 * Creates tables with Unicode box-drawing characters
 */

// Box drawing characters
const BOX = {
  topLeft: "┌",
  topRight: "┐",
  bottomLeft: "└",
  bottomRight: "┘",
  horizontal: "─",
  vertical: "│",
  leftT: "├",
  rightT: "┤",
  topT: "┬",
  bottomT: "┴",
  cross: "┼",
};

/**
 * Format a table with beautiful box drawing
 * @param {Array<Object>} data - Array of row objects
 * @param {Array<Object>} columns - Column definitions: { key, header, align?, width? }
 *   align: "left" (default), "right", "center"
 *   width: explicit width or auto-calculated
 * @param {Object} options - { title?, showRowNumbers?, totalsRow? }
 * @returns {string} - Formatted table string
 */
function formatTable(data, columns, options = {}) {
  if (!data || data.length === 0) {
    return options.emptyMessage || "No data available.";
  }

  // Calculate column widths
  const colWidths = columns.map((col) => {
    if (col.width) return col.width;
    const headerLen = col.header.length;
    const maxDataLen = Math.max(
      ...data.map((row) => String(row[col.key] ?? "").length)
    );
    return Math.max(headerLen, maxDataLen);
  });

  // Build table
  let out = "";

  // Title
  if (options.title) {
    out += `${options.title}\n\n`;
  }

  // Top border
  out += BOX.topLeft;
  out += colWidths.map((w) => BOX.horizontal.repeat(w + 2)).join(BOX.topT);
  out += BOX.topRight + "\n";

  // Header row
  out += BOX.vertical;
  columns.forEach((col, i) => {
    const padded = padCell(col.header, colWidths[i], col.align || "left");
    out += ` ${padded} ${BOX.vertical}`;
  });
  out += "\n";

  // Header separator
  out += BOX.leftT;
  out += colWidths.map((w) => BOX.horizontal.repeat(w + 2)).join(BOX.cross);
  out += BOX.rightT + "\n";

  // Data rows
  for (const row of data) {
    out += BOX.vertical;
    columns.forEach((col, i) => {
      const value = String(row[col.key] ?? "");
      const padded = padCell(value, colWidths[i], col.align || "left");
      out += ` ${padded} ${BOX.vertical}`;
    });
    out += "\n";
  }

  // Totals row (if provided)
  if (options.totalsRow) {
    // Separator before totals
    out += BOX.leftT;
    out += colWidths.map((w) => BOX.horizontal.repeat(w + 2)).join(BOX.cross);
    out += BOX.rightT + "\n";

    // Totals
    out += BOX.vertical;
    columns.forEach((col, i) => {
      const value = String(options.totalsRow[col.key] ?? "");
      const padded = padCell(value, colWidths[i], col.align || "left");
      out += ` ${padded} ${BOX.vertical}`;
    });
    out += "\n";
  }

  // Bottom border
  out += BOX.bottomLeft;
  out += colWidths.map((w) => BOX.horizontal.repeat(w + 2)).join(BOX.bottomT);
  out += BOX.bottomRight + "\n";

  return out;
}

/**
 * Pad a cell value to specified width with alignment
 */
function padCell(value, width, align) {
  const str = String(value);
  const len = str.length;
  if (len >= width) return str.substring(0, width);

  const padding = width - len;

  switch (align) {
    case "right":
      return " ".repeat(padding) + str;
    case "center":
      const left = Math.floor(padding / 2);
      const right = padding - left;
      return " ".repeat(left) + str + " ".repeat(right);
    default: // left
      return str + " ".repeat(padding);
  }
}

/**
 * Format Feature Movement table with box style
 */
function formatFeatureMovementBox(rows, options = {}) {
  const columns = [
    { key: "pod", header: "Pod", align: "left", width: 16 },
    { key: "plannedFeatures", header: "Planned", align: "right", width: 8 },
    { key: "done", header: "Done", align: "right", width: 6 },
    { key: "inFlight", header: "In-Flight", align: "right", width: 10 },
    { key: "notStarted", header: "Not Started", align: "right", width: 12 },
  ];

  // Calculate totals
  const totals = {
    pod: "TOTAL",
    plannedFeatures: rows.reduce((s, r) => s + (r.plannedFeatures || 0), 0),
    done: rows.reduce((s, r) => s + (r.done || 0), 0),
    inFlight: rows.reduce((s, r) => s + (r.inFlight || 0), 0),
    notStarted: rows.reduce((s, r) => s + (r.notStarted || 0), 0),
  };

  return formatTable(rows, columns, {
    title: options.title || "A) Feature Movement (Weekly Snapshot)",
    totalsRow: totals,
    emptyMessage: "No feature movement data available.",
  });
}

/**
 * Format DEL KPI table with box style
 */
function formatDelKpiBox(rows, cycleKey, options = {}) {
  const columns = [
    { key: "pod", header: "Pod", align: "left", width: 16 },
    { key: "committed", header: "Committed", align: "right", width: 10 },
    { key: "completed", header: "Completed", align: "right", width: 10 },
    { key: "deliveryPct", header: "Delivery %", align: "right", width: 11 },
    { key: "spillover", header: "Spillover", align: "right", width: 10 },
  ];

  // Calculate totals
  const totalCommitted = rows.reduce((s, r) => s + (r.committed || 0), 0);
  const totalCompleted = rows.reduce((s, r) => s + (r.completed || 0), 0);
  const totalSpillover = rows.reduce((s, r) => s + (r.spillover || 0), 0);
  const totalPct =
    totalCommitted === 0
      ? "0%"
      : `${Math.round((totalCompleted / totalCommitted) * 100)}%`;

  const totals = {
    pod: "TOTAL",
    committed: totalCommitted,
    completed: totalCompleted,
    deliveryPct: totalPct,
    spillover: totalSpillover,
  };

  return formatTable(rows, columns, {
    title: options.title || `B) DEL KPI (Cycle=${cycleKey})`,
    totalsRow: totals,
    emptyMessage: `No DEL data for cycle ${cycleKey}.`,
  });
}

/**
 * Format Pending DELs table with box style
 */
function formatPendingDelsBox(dels, podName, options = {}) {
  const columns = [
    { key: "identifier", header: "ID", align: "left", width: 10 },
    { key: "title", header: "Title", align: "left", width: 35 },
    { key: "project", header: "Project", align: "left", width: 30 },
    { key: "assignee", header: "Assignee", align: "left", width: 18 },
    { key: "state", header: "State", align: "left", width: 12 },
  ];

  // Truncate long values
  const truncatedData = dels.map((d) => ({
    ...d,
    title: truncate(d.title, 35),
    project: truncate(d.project, 30),
    assignee: truncate(d.assignee, 18),
  }));

  return formatTable(truncatedData, columns, {
    title: options.title || `${podName} (${dels.length} pending)`,
    emptyMessage: `No pending DELs for ${podName}.`,
  });
}

/**
 * Format Projects list table with box style
 */
function formatProjectsBox(projects, podName, options = {}) {
  const columns = [
    { key: "name", header: "Project", align: "left", width: 45 },
    { key: "normalizedState", header: "State", align: "left", width: 12 },
    { key: "lead", header: "Lead", align: "left", width: 18 },
    { key: "updated", header: "Updated", align: "left", width: 12 },
  ];

  // Prepare data
  const preparedData = projects.map((p) => ({
    name: truncate(p.name, 45),
    normalizedState: p.normalizedState || p.state || "-",
    lead: p.lead || "-",
    updated: p.updatedAt ? new Date(p.updatedAt).toLocaleDateString() : "-",
  }));

  return formatTable(preparedData, columns, {
    title: options.title || `${podName} Projects (${projects.length} total)`,
    emptyMessage: `No projects found for ${podName}.`,
  });
}

/**
 * Format Blockers table with box style
 */
function formatBlockersBox(blockers, projectName, options = {}) {
  const columns = [
    { key: "identifier", header: "Issue", align: "left", width: 12 },
    { key: "title", header: "Title", align: "left", width: 35 },
    { key: "reason", header: "Reason", align: "left", width: 12 },
    { key: "assignee", header: "Assignee", align: "left", width: 15 },
    { key: "priority", header: "Priority", align: "left", width: 10 },
  ];

  // Truncate long values
  const truncatedData = blockers.map((b) => ({
    ...b,
    title: truncate(b.title, 35),
    assignee: b.assignee || "-",
    priority: b.priority ?? "-",
  }));

  return formatTable(truncatedData, columns, {
    title: options.title || `Blockers for ${projectName}`,
    emptyMessage: `No blockers found for ${projectName}.`,
  });
}

/**
 * Format Pods list table with box style
 */
function formatPodsListBox(pods, options = {}) {
  const columns = [
    { key: "name", header: "Pod", align: "left", width: 18 },
    { key: "teamIdShort", header: "Team ID", align: "left", width: 12 },
    { key: "initiativeIdShort", header: "Initiative ID", align: "left", width: 12 },
  ];

  // Prepare data with shortened IDs
  const preparedData = pods.map((p) => ({
    name: p.name,
    teamIdShort: p.teamId ? p.teamId.substring(0, 10) + "..." : "-",
    initiativeIdShort: p.initiativeId
      ? p.initiativeId.substring(0, 10) + "..."
      : "-",
  }));

  return formatTable(preparedData, columns, {
    title: options.title || `Available Pods (${pods.length})`,
    emptyMessage: "No pods configured.",
  });
}

/**
 * Truncate a string with ellipsis
 */
function truncate(str, maxLen) {
  if (!str) return "";
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen - 3) + "...";
}

/**
 * Create a simple summary box
 */
function formatSummaryBox(title, lines) {
  const maxLineLen = Math.max(title.length, ...lines.map((l) => l.length));
  const width = maxLineLen + 2;

  let out = "";
  out += BOX.topLeft + BOX.horizontal.repeat(width) + BOX.topRight + "\n";
  out += BOX.vertical + " " + title.padEnd(width - 1) + BOX.vertical + "\n";
  out += BOX.leftT + BOX.horizontal.repeat(width) + BOX.rightT + "\n";

  for (const line of lines) {
    out += BOX.vertical + " " + line.padEnd(width - 1) + BOX.vertical + "\n";
  }

  out += BOX.bottomLeft + BOX.horizontal.repeat(width) + BOX.bottomRight + "\n";

  return out;
}

module.exports = {
  formatTable,
  formatFeatureMovementBox,
  formatDelKpiBox,
  formatPendingDelsBox,
  formatProjectsBox,
  formatBlockersBox,
  formatPodsListBox,
  formatSummaryBox,
  truncate,
  padCell,
  BOX,
};
