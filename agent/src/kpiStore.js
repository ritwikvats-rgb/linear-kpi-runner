const fs = require("fs");
const path = require("path");

function readSnapshot(snapshotPath) {
  const p = path.resolve(snapshotPath);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function writeJsonl(logPath, obj) {
  const p = path.resolve(logPath);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify(obj) + "\n", "utf8");
}

module.exports = { readSnapshot, writeJsonl };
