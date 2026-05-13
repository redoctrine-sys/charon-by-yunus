export function now() {
  return Date.now();
}

export function safeJson(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function json(value) {
  return JSON.stringify(value ?? null);
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function stripThinking(text) {
  return String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<\/?think>/gi, '').trim();
}

export function pruneSeen(map, ttlMs) {
  const at = now();
  for (const [key, ts] of map) {
    if (at - ts > ttlMs) map.delete(key);
  }
}

export function firstPositiveNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return null;
}

export function marketCapFromGmgn(info) {
  const direct = Number(info?.market_cap ?? info?.mcap);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const price = Number(info?.price);
  const supply = Number(info?.circulating_supply ?? info?.total_supply);
  return Number.isFinite(price) && Number.isFinite(supply) ? price * supply : null;
}

export function tokenPriceFromGmgn(info) {
  const price = Number(info?.price);
  return Number.isFinite(price) ? price : null;
}

export function base58Encode(bytes) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const digits = [0];
  for (const b of bytes) {
    let carry = b;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  for (const b of bytes) {
    if (b !== 0) break;
    digits.push(0);
  }
  return digits.reverse().map(x => alphabet[x]).join('');
}

export function readPubkey(buf, offset) {
  return base58Encode(buf.subarray(offset, offset + 32));
}

export function readU64(buf, offset) {
  return buf.readBigUInt64LE(offset);
}

export function readI64(buf, offset) {
  return buf.readBigInt64LE(offset);
}

export function lamToSol(lamports) {
  return Number(lamports) / 1_000_000_000;
}

export function discMatch(buf, disc) {
  return disc.every((b, i) => buf[i] === b);
}

export function parseDistFees(data) {
  let offset = 8;
  const timestamp = readI64(data, offset); offset += 8;
  const mint = readPubkey(data, offset); offset += 32;
  const bondingCurve = readPubkey(data, offset); offset += 32;
  const sharingConfig = readPubkey(data, offset); offset += 32;
  const admin = readPubkey(data, offset); offset += 32;
  const count = data.readUInt32LE(offset); offset += 4;
  const shareholders = [];
  for (let i = 0; i < count && offset + 34 <= data.length; i++) {
    const pubkey = readPubkey(data, offset); offset += 32;
    const bps = data.readUInt16LE(offset); offset += 2;
    shareholders.push({ pubkey, bps });
  }
  const distributed = data.length >= offset + 8 ? readU64(data, offset) : 0n;
  return { timestamp, mint, bondingCurve, sharingConfig, admin, shareholders, distributed };
}

export function strictJsonFromText(text) {
  const clean = stripThinking(text);
  const fenced = clean.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const raw = fenced || clean.match(/\{[\s\S]*\}/)?.[0] || clean;
  try {
    return JSON.parse(raw);
  } catch (firstErr) {
    // Attempt to repair truncated JSON by closing unclosed brackets/braces.
    // This happens when LLM output is cut off mid-stream (max_tokens too low, etc.).
    try {
      const repaired = repairTruncatedJson(raw);
      return JSON.parse(repaired);
    } catch {
      // Re-throw the original error with useful context
      throw new SyntaxError(`${firstErr.message} — raw snippet: ${String(raw).slice(0, 120)}`);
    }
  }
}

/** Best-effort repair for JSON truncated mid-generation.
 *  Handles: unterminated strings, trailing commas, unclosed brackets/braces. */
function repairTruncatedJson(raw) {
  let s = String(raw).trimEnd();

  // ── Pass 1: detect if we ended inside a string ────────────────────────────
  let inString = false;
  let escape = false;
  for (const ch of s) {
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
  }
  // If the string is still open, close it
  if (inString) s += '"';

  // ── Pass 2: remove trailing comma before a close delimiter ────────────────
  s = s.replace(/,\s*([}\]])/g, '$1');  // {"a":1,}  → {"a":1}
  s = s.replace(/,\s*$/, '');           // trailing comma at end

  // ── Pass 3: close unclosed braces/brackets ───────────────────────────────
  const stack = [];
  inString = false;
  escape = false;
  for (const ch of s) {
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') stack.pop();
  }
  // Remove trailing comma again after all repairs, then close structures
  s = s.replace(/,\s*$/, '');
  return s + stack.reverse().join('');
}

export function parseNumericInput(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/[$,%\s,_]/g, '');
  if (raw === 'off' || raw === 'none' || raw === 'disable') return 0;
  const match = raw.match(/^(-?\d+(?:\.\d+)?)([kmb])?$/);
  if (!match) return null;
  const multipliers = { k: 1_000, m: 1_000_000, b: 1_000_000_000 };
  const parsed = Number(match[1]) * (multipliers[match[2]] || 1);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseWindowMs(value = '12h') {
  const raw = String(value || '12h').trim().toLowerCase();
  const match = raw.match(/^(\d+(?:\.\d+)?)(m|h|d)?$/);
  if (!match) return 12 * 60 * 60 * 1000;
  const amount = Number(match[1]);
  const unit = match[2] || 'h';
  const multipliers = { m: 60_000, h: 60 * 60_000, d: 24 * 60 * 60_000 };
  return Math.max(5 * 60_000, Math.min(30 * 24 * 60 * 60_000, amount * multipliers[unit]));
}

export function formatWindow(ms) {
  if (ms % (24 * 60 * 60_000) === 0) return `${ms / (24 * 60 * 60_000)}d`;
  if (ms % (60 * 60_000) === 0) return `${ms / (60 * 60_000)}h`;
  return `${Math.round(ms / 60_000)}m`;
}

export function makeFailureTracker(name, alertFn, threshold = 3) {
  let count = 0;
  return async (fn) => {
    try {
      await fn();
      count = 0;
    } catch (err) {
      count++;
      console.log(`[${name}] ${err.message}`);
      if (count >= threshold) {
        alertFn(`⚠️ <b>${name}</b> failed ${count}x in a row: ${err.message}`).catch(() => {});
        count = 0;
      }
    }
  };
}
