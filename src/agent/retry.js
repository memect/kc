/**
 * Retry wrapper with exponential backoff and jitter.
 * Designed for LLM API calls — retries transient errors, fails fast on auth/validation errors.
 */

const MAX_RETRIES = 10;
const INITIAL_DELAY_MS = 1000;
const MAX_DELAY_MS = 60000;
const BACKOFF_MULTIPLIER = 2;
const JITTER_FRACTION = 0.2;

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504, 520, 522, 524]);
const NON_RETRYABLE_STATUS = new Set([400, 401, 403, 404, 422]);

// Phrases that indicate the request itself is too large for the model.
// Some providers return these as 400 (correct), others as 500/503 (incorrect),
// but in either case retrying just delays the inevitable failure.
const CONTEXT_LENGTH_PATTERNS = /context_length|context length|maximum context|too many tokens|prompt is too long|input length|input is too long|exceeds.{0,20}context|exceeded the max|reduce the length/i;

/**
 * Determine if an error is retryable.
 * @param {Error} err
 * @returns {boolean}
 */
function isRetryable(err) {
  const msg = err.message || "";
  // Context-length errors are non-retryable regardless of status code
  if (CONTEXT_LENGTH_PATTERNS.test(msg)) return false;

  if (err.status) {
    if (NON_RETRYABLE_STATUS.has(err.status)) return false;
    if (RETRYABLE_STATUS.has(err.status)) return true;
  }
  // Network errors (ECONNRESET, ETIMEDOUT, fetch TypeError, AbortError)
  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|UND_ERR|fetch failed|network|socket hang up/i.test(msg)) {
    return true;
  }
  if (err.name === "AbortError" || err.name === "TimeoutError") return true;
  // If we have a status code and it's not in our known sets, retry server errors (5xx)
  if (err.status && err.status >= 500) return true;
  // Unknown errors without status — retry conservatively
  return !err.status;
}

/**
 * Calculate delay for a given attempt using exponential backoff with jitter.
 * @param {number} attempt - 0-indexed attempt number
 * @param {number|null} retryAfterSec - Retry-After header value in seconds
 * @returns {number} Delay in milliseconds
 */
function calculateDelay(attempt, retryAfterSec) {
  if (retryAfterSec && retryAfterSec > 0) {
    return Math.min(retryAfterSec * 1000, MAX_DELAY_MS);
  }
  const base = Math.min(INITIAL_DELAY_MS * Math.pow(BACKOFF_MULTIPLIER, attempt), MAX_DELAY_MS);
  const jitter = base * JITTER_FRACTION * Math.random();
  return base + jitter;
}

/**
 * Execute an async function with retry logic.
 *
 * @param {() => Promise<any>} fn - The async function to execute. Should throw with
 *   an error that has `.status` and optionally `.retryAfter` properties on failure.
 * @returns {Promise<any>} The successful result
 * @throws {Error} The last error after all retries exhausted, or a non-retryable error immediately
 */
export async function withRetry(fn) {
  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (!isRetryable(err)) throw err;
      if (attempt === MAX_RETRIES) break;

      const retryAfterSec = err.retryAfter ? parseFloat(err.retryAfter) : null;
      const delay = calculateDelay(attempt, retryAfterSec);

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  const wrapper = new Error(`LLM API call failed after ${MAX_RETRIES + 1} attempts: ${lastError.message}`);
  wrapper.cause = lastError;
  wrapper.status = lastError.status;
  throw wrapper;
}
