#!/usr/bin/env node
/**
 * List available Slack channels for context capture configuration
 */
require("dotenv").config();

async function main() {
  const token = process.env.SLACK_BOT_TOKEN;

  if (!token) {
    console.log("SLACK_BOT_TOKEN not found in .env");
    return;
  }

  console.log("Fetching Slack channels...\n");

  try {
    const response = await fetch(
      "https://slack.com/api/conversations.list?types=public_channel,private_channel&limit=100",
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    const data = await response.json();

    if (!data.ok) {
      console.log("Slack API Error:", data.error);
      if (data.error === "missing_scope") {
        console.log("\nYour bot needs these scopes:");
        console.log("  - channels:read");
        console.log("  - channels:history");
        console.log("  - groups:read (for private channels)");
        console.log("  - groups:history (for private channels)");
      }
      return;
    }

    const channels = data.channels || [];
    console.log(`Found ${channels.length} channels:\n`);

    // Group by joined status
    const joined = channels.filter((c) => c.is_member);
    const notJoined = channels.filter((c) => !c.is_member);

    if (joined.length > 0) {
      console.log("✅ Bot is in these channels (can capture messages):");
      for (const ch of joined) {
        console.log(`   ${ch.id} | #${ch.name}`);
      }
      console.log();
    }

    if (notJoined.length > 0) {
      console.log("⚪ Bot NOT in these channels (invite bot to capture):");
      for (const ch of notJoined.slice(0, 20)) {
        console.log(`   ${ch.id} | #${ch.name}`);
      }
      if (notJoined.length > 20) {
        console.log(`   ... and ${notJoined.length - 20} more`);
      }
    }

    console.log("\n📋 To configure, edit scripts/captureContext.js and add channels to SLACK_CHANNELS:");
    console.log('   "channel-name": { id: "CXXXXXXXX", name: "channel-name", pod: "FTS" },');

  } catch (error) {
    console.log("Error:", error.message);
  }
}

main();
