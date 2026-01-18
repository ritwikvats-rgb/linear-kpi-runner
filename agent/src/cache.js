/* agent/src/cache.js
 * TTL-based file cache for Linear API responses
 * Stores cache under agent/output/cache/
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Cache directory relative to repo root
const CACHE_DIR = path.resolve(__dirname, "../output/cache");

// Default TTL: 5 minutes
const DEFAULT_TTL_MS = 5 * 60 * 1000;

/**
 * Generate a cache key from arbitrary arguments
 */
function cacheKey(...args) {
  const str = JSON.stringify(args);
  return crypto.createHash("md5").update(str).digest("hex");
}

/**
 * Get cached value if exists and not expired
 * @param {string} key - Cache key
 * @param {number} ttlMs - TTL in milliseconds (default 5 min)
 * @returns {any|null} - Cached value or null
 */
function getCache(key, ttlMs = DEFAULT_TTL_MS) {
  const filePath = path.join(CACHE_DIR, `${key}.json`);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const stat = fs.statSync(filePath);
    const age = Date.now() - stat.mtimeMs;

    if (age > ttlMs) {
      // Expired
      fs.unlinkSync(filePath);
      return null;
    }

    const content = fs.readFileSync(filePath, "utf8");
    return JSON.parse(content);
  } catch (e) {
    // Corrupted cache file
    try { fs.unlinkSync(filePath); } catch {}
    return null;
  }
}

/**
 * Set cache value
 * @param {string} key - Cache key
 * @param {any} value - Value to cache (must be JSON-serializable)
 */
function setCache(key, value) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const filePath = path.join(CACHE_DIR, `${key}.json`);
  fs.writeFileSync(filePath, JSON.stringify(value), "utf8");
}

/**
 * Clear all cache files
 */
function clearCache() {
  if (!fs.existsSync(CACHE_DIR)) return;

  const files = fs.readdirSync(CACHE_DIR);
  for (const file of files) {
    if (file.endsWith(".json")) {
      try {
        fs.unlinkSync(path.join(CACHE_DIR, file));
      } catch {}
    }
  }
}

/**
 * Get cache stats
 */
function cacheStats() {
  if (!fs.existsSync(CACHE_DIR)) {
    return { entries: 0, totalSize: 0 };
  }

  const files = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith(".json"));
  let totalSize = 0;

  for (const file of files) {
    try {
      const stat = fs.statSync(path.join(CACHE_DIR, file));
      totalSize += stat.size;
    } catch {}
  }

  return {
    entries: files.length,
    totalSize,
    totalSizeKb: Math.round(totalSize / 1024),
  };
}

/**
 * Wrapper to cache async function results
 * @param {string} namespace - Cache namespace (e.g., "projects", "issues")
 * @param {Function} fn - Async function to cache
 * @param {number} ttlMs - TTL in milliseconds
 */
function withCache(namespace, fn, ttlMs = DEFAULT_TTL_MS) {
  return async (...args) => {
    const key = cacheKey(namespace, ...args);
    const cached = getCache(key, ttlMs);

    if (cached !== null) {
      return cached;
    }

    const result = await fn(...args);
    setCache(key, result);
    return result;
  };
}

module.exports = {
  cacheKey,
  getCache,
  setCache,
  clearCache,
  cacheStats,
  withCache,
  DEFAULT_TTL_MS,
  CACHE_DIR,
};
