const fs = require("fs");
const path = require("path");
const { fuelixChat } = require("./fuelixClient");
const { buildSystemPrompt, buildUserPrompt } = require("./prompt");

async function summarizeWeekly({ kpiMarkdown, deliverablesJson }) {
  const model = process.env.FUELIX_MODEL || "gpt-5.2";

  const messages = [
    { role: "system", content: buildSystemPrompt() },
    { role: "user", content: buildUserPrompt({ kpiMarkdown, deliverablesJson }) },
  ];

  return fuelixChat({ messages, model, temperature: 0.2 });
}

function writeOutput(filename, content) {
  const outDir = path.join(__dirname, "..", "output");
  fs.mkdirSync(outDir, { recursive: true });
  const fp = path.join(outDir, filename);
  fs.writeFileSync(fp, content, "utf8");
  return fp;
}

module.exports = { summarizeWeekly, writeOutput };
