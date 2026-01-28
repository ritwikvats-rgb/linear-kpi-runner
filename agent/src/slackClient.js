/* agent/src/slackClient.js
 * Slack API client for reading messages, threads, and posting summaries
 */

class SlackClient {
  constructor({ botToken }) {
    this.botToken = botToken;
    this.baseUrl = "https://slack.com/api";
  }

  /**
   * Make a Slack API request
   * @param {string} method - Slack API method
   * @param {object} params - Request parameters
   * @param {object} options - { useForm: boolean } - use form-urlencoded instead of JSON
   */
  async api(method, params = {}, options = {}) {
    const url = `${this.baseUrl}/${method}`;

    let headers = { "Authorization": `Bearer ${this.botToken}` };
    let body;

    if (options.useForm) {
      // Use form-urlencoded (required for some endpoints like conversations.replies)
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      const formParams = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        formParams.append(key, String(value));
      }
      body = formParams.toString();
    } else {
      // Use JSON (default)
      headers["Content-Type"] = "application/json; charset=utf-8";
      body = JSON.stringify(params);
    }

    const res = await fetch(url, { method: "POST", headers, body });

    const json = await res.json().catch(() => ({}));
    if (!json.ok) {
      const e = new Error(`Slack API error: ${json.error || "unknown"}`);
      e.details = json;
      throw e;
    }
    return json;
  }

  /**
   * Test if the token is valid
   */
  async testAuth() {
    return this.api("auth.test");
  }

  /**
   * Join a channel (required before reading private channels)
   */
  async joinChannel(channelId) {
    try {
      const result = await this.api("conversations.join", { channel: channelId });
      return { ok: true, channel: result.channel };
    } catch (e) {
      // Already in channel or can't join (private) - that's okay
      if (e.details?.error === "method_not_supported_for_channel_type") {
        return { ok: true, note: "Private channel - bot must be invited" };
      }
      throw e;
    }
  }

  /**
   * Get channel info
   */
  async getChannelInfo(channelId) {
    try {
      const result = await this.api("conversations.info", { channel: channelId });
      return result.channel;
    } catch (e) {
      // May need channels:read scope
      return null;
    }
  }

  /**
   * Get messages from a channel
   * @param {string} channelId - Channel ID
   * @param {object} options - { limit, oldest, latest, cursor }
   */
  async getMessages(channelId, options = {}) {
    const params = {
      channel: channelId,
      limit: options.limit || 100,
    };

    if (options.oldest) params.oldest = options.oldest;
    if (options.latest) params.latest = options.latest;
    if (options.cursor) params.cursor = options.cursor;

    const result = await this.api("conversations.history", params);
    return {
      messages: result.messages || [],
      hasMore: result.has_more || false,
      nextCursor: result.response_metadata?.next_cursor,
    };
  }

  /**
   * Get all messages from a channel (with pagination)
   * @param {string} channelId - Channel ID
   * @param {object} options - { oldest, latest, maxMessages }
   */
  async getAllMessages(channelId, options = {}) {
    const allMessages = [];
    let cursor = null;
    const maxMessages = options.maxMessages || 100000; // Essentially unlimited

    do {
      const result = await this.getMessages(channelId, {
        ...options,
        limit: Math.min(100, maxMessages - allMessages.length),
        cursor,
      });

      allMessages.push(...result.messages);
      cursor = result.hasMore ? result.nextCursor : null;

      // Rate limiting protection
      if (cursor) await this._sleep(100);
    } while (cursor && allMessages.length < maxMessages);

    return allMessages;
  }

  /**
   * Get thread replies
   * @param {string} channelId - Channel ID
   * @param {string} threadTs - Thread timestamp (parent message ts)
   */
  async getThreadReplies(channelId, threadTs, options = {}) {
    // Validate threadTs format
    if (!threadTs || !/^\d+\.\d+$/.test(threadTs)) {
      return { messages: [], hasMore: false, nextCursor: null };
    }

    const params = {
      channel: channelId,
      ts: threadTs,
      limit: options.limit || 100,
    };

    if (options.cursor) params.cursor = options.cursor;

    try {
      // conversations.replies requires form-urlencoded format
      const result = await this.api("conversations.replies", params, { useForm: true });
      return {
        messages: result.messages || [],
        hasMore: result.has_more || false,
        nextCursor: result.response_metadata?.next_cursor,
      };
    } catch (e) {
      // Thread may be deleted or inaccessible
      console.warn(`Thread ${threadTs} fetch failed: ${e.message}`);
      return { messages: [], hasMore: false, nextCursor: null };
    }
  }

  /**
   * Get all thread replies (with pagination)
   */
  async getAllThreadReplies(channelId, threadTs) {
    const allReplies = [];
    let cursor = null;

    do {
      const result = await this.getThreadReplies(channelId, threadTs, { cursor });
      allReplies.push(...result.messages);
      cursor = result.hasMore ? result.nextCursor : null;

      if (cursor) await this._sleep(100);
    } while (cursor);

    // First message is the parent, skip it
    return allReplies.slice(1);
  }

  /**
   * Get messages with all their thread replies expanded
   * @param {string} channelId - Channel ID
   * @param {object} options - { oldest, latest, maxMessages, includeThreads }
   */
  async getMessagesWithThreads(channelId, options = {}) {
    const messages = await this.getAllMessages(channelId, options);

    if (!options.includeThreads) {
      return messages;
    }

    // Fetch threads for messages that have replies
    const messagesWithThreads = [];

    for (const msg of messages) {
      const enrichedMsg = { ...msg, threadReplies: [] };

      if (msg.reply_count && msg.reply_count > 0) {
        try {
          enrichedMsg.threadReplies = await this.getAllThreadReplies(channelId, msg.ts);
        } catch (e) {
          console.warn(`Failed to fetch thread ${msg.ts}: ${e.message}`);
        }
      }

      messagesWithThreads.push(enrichedMsg);
    }

    return messagesWithThreads;
  }

  /**
   * Post a message to a channel
   */
  async postMessage(channelId, text, options = {}) {
    const params = {
      channel: channelId,
      text,
      ...options,
    };

    const result = await this.api("chat.postMessage", params);
    return result;
  }

  /**
   * Post a message with blocks (rich formatting)
   */
  async postRichMessage(channelId, blocks, text = "") {
    return this.postMessage(channelId, text, { blocks });
  }

  /**
   * Get user info (for mapping user IDs to names)
   */
  async getUserInfo(userId) {
    try {
      const result = await this.api("users.info", { user: userId });
      return result.user;
    } catch (e) {
      return null;
    }
  }

  /**
   * Batch resolve user IDs to names
   */
  async resolveUserNames(userIds) {
    const userMap = {};
    const uniqueIds = [...new Set(userIds)];

    for (const userId of uniqueIds) {
      const user = await this.getUserInfo(userId);
      if (user) {
        userMap[userId] = user.real_name || user.name || userId;
      } else {
        userMap[userId] = userId;
      }
      await this._sleep(50); // Rate limiting
    }

    return userMap;
  }

  /**
   * Format timestamp to readable date
   */
  static formatTimestamp(ts) {
    const date = new Date(parseFloat(ts) * 1000);
    return date.toISOString();
  }

  /**
   * Extract all user IDs from messages
   */
  static extractUserIds(messages) {
    const userIds = new Set();

    for (const msg of messages) {
      if (msg.user) userIds.add(msg.user);
      if (msg.threadReplies) {
        for (const reply of msg.threadReplies) {
          if (reply.user) userIds.add(reply.user);
        }
      }
    }

    return [...userIds];
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { SlackClient };
