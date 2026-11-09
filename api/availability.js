'use strict';

/*
 * GET /api/availability
 *
 * Reads Ruth's private calendar exports on the server (Booking.com, Airbnb and,
 * later, her own direct-bookings calendar) and returns only the nights that are
 * taken, merged into date ranges. The export links live in Vercel environment
 * variables (BOOKING_ICS_URL, AIRBNB_ICS_URL, DIRECT_ICS_URL) and never reach
 * the browser. The response carries no guest names, reservation codes, phone
 * digits or links.
 *
 * Each platform's export leaves out the other platform's bookings, so merging
 * them is what makes the calendar correct.
 *
 * Ranges are nights: { start: "2026-11-13", end: "2026-11-17" } means the
 * nights of 13, 14, 15 and 16 November are taken, and 17 November is a
 * checkout day (free for a new check-in).
 */

const FEEDS = [
  { id: 'booking', env: 'BOOKING_ICS_URL' },
  { id: 'airbnb', env: 'AIRBNB_ICS_URL' },
  { id: 'direct', env: 'DIRECT_ICS_URL' },
];

const TIME_ZONE = 'Pacific/Auckland';
const HORIZON_DAYS = 365; // how far ahead the calendar shows
const MIN_NIGHTS = 2; // matches her Airbnb listing
const FETCH_TIMEOUT_MS = 8000;
const MAX_FEED_CHARS = 2000000;
const LAST_GOOD_MAX_AGE_MS = 6 * 60 * 60 * 1000; // reuse a feed for up to 6 hours if it briefly fails
const MIN_REFETCH_MS = 60 * 1000; // never fetch the same feed more than once a minute per instance
const DAY_MS = 86400000;

const CACHE_OK = 'public, s-maxage=300, stale-while-revalidate=600';
const CACHE_PARTIAL = 'public, s-maxage=60, stale-while-revalidate=120';

// Last good copy of each feed, kept while this function instance stays warm.
const lastGood = new Map();

const nzDateParts = new Intl.DateTimeFormat('en-NZ', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

// Day number (days since 1 Jan 1970) of the calendar date in New Zealand at this instant.
function nzDay(date) {
  const p = {};
  for (const part of nzDateParts.formatToParts(date)) p[part.type] = part.value;
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)) / DAY_MS;
}

function toISODate(day) {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

function isProp(line, name) {
  const next = line.charAt(name.length);
  return line.startsWith(name) && (next === ':' || next === ';');
}

function valueOf(line) {
  return line.slice(line.indexOf(':') + 1).trim();
}

// DTSTART / DTEND: all-day dates (20261113), UTC times (20261113T020000Z)
// or local times (TZID=Pacific/Auckland:20261113T140000).
function parseDate(line) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(valueOf(line));
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  if (m[4] && m[7]) {
    return nzDay(new Date(Date.UTC(y, mo, d, Number(m[4]), Number(m[5]), Number(m[6]))));
  }
  return Date.UTC(y, mo, d) / DAY_MS;
}

function parseDurationDays(line) {
  const m = /^P(?:(\d+)W)?(?:(\d+)D)?/.exec(valueOf(line));
  if (!m) return 0;
  return Number(m[1] || 0) * 7 + Number(m[2] || 0);
}

// Returns the taken nights in a feed as [{ s, e }] day numbers, e exclusive.
function parseCalendar(text) {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const ranges = [];
  let ev = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === 'BEGIN:VEVENT') {
      ev = {};
      continue;
    }
    if (!ev) continue;
    if (line === 'END:VEVENT') {
      if (ev.start != null && ev.status !== 'CANCELLED') {
        let end = ev.end != null ? ev.end : ev.start + (ev.durationDays || 1);
        if (end <= ev.start) end = ev.start + 1;
        ranges.push({ s: ev.start, e: end });
      }
      ev = null;
      continue;
    }
    if (isProp(line, 'DTSTART')) ev.start = parseDate(line);
    else if (isProp(line, 'DTEND')) ev.end = parseDate(line);
    else if (isProp(line, 'DURATION')) ev.durationDays = parseDurationDays(line);
    else if (isProp(line, 'STATUS')) ev.status = valueOf(line).toUpperCase();
  }
  return ranges;
}

// Joins overlapping and back-to-back ranges.
function mergeRanges(ranges) {
  const sorted = ranges.slice().sort((a, b) => a.s - b.s);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.s <= last.e) last.e = Math.max(last.e, r.e);
    else out.push({ s: r.s, e: r.e });
  }
  return out;
}

async function fetchFeed(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; LanguorAvailability/1.0)',
      Accept: 'text/calendar, text/plain;q=0.9, */*;q=0.5',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const text = await res.text();
  if (text.length > MAX_FEED_CHARS || !text.includes('BEGIN:VCALENDAR')) {
    throw new Error('Not a calendar');
  }
  return text;
}

async function readFeed(feed) {
  const recent = lastGood.get(feed.id);
  if (recent && Date.now() - recent.at < MIN_REFETCH_MS) {
    return { id: feed.id, status: 'ok', ranges: recent.ranges };
  }
  try {
    const ranges = parseCalendar(await fetchFeed(feed.url));
    lastGood.set(feed.id, { at: Date.now(), ranges });
    return { id: feed.id, status: 'ok', ranges };
  } catch (err) {
    // Never log the feed link itself: it is private.
    const reason = err && /^(HTTP \d+|Not a calendar)$/.test(err.message) ? err.message : (err && err.name) || 'Error';
    console.error('availability: ' + feed.id + ' feed failed: ' + reason);
    const kept = lastGood.get(feed.id);
    if (kept && Date.now() - kept.at < LAST_GOOD_MAX_AGE_MS) {
      return { id: feed.id, status: 'stale', ranges: kept.ranges };
    }
    return { id: feed.id, status: 'failed', ranges: [] };
  }
}

function send(res, status, body, cacheControl) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', cacheControl);
  res.setHeader('X-Robots-Tag', 'noindex');
  res.end(JSON.stringify(body));
}

async function buildAvailability(env, now) {
  const today = nzDay(now);
  const horizon = today + HORIZON_DAYS;
  const feeds = FEEDS.map((f) => ({ id: f.id, url: String(env[f.env] || '').trim() })).filter((f) => f.url);
  if (!feeds.length) return { status: 503, body: { ok: false, reason: 'not_configured' } };

  const results = await Promise.all(feeds.map(readFeed));
  const usable = results.filter((r) => r.status !== 'failed');
  if (!usable.length) return { status: 503, body: { ok: false, reason: 'feeds_unavailable' } };

  const booked = mergeRanges(usable.flatMap((r) => r.ranges))
    .filter((r) => r.e > today && r.s < horizon)
    .map((r) => ({ start: toISODate(Math.max(r.s, today)), end: toISODate(Math.min(r.e, horizon)) }));

  const sources = {};
  for (const r of results) sources[r.id] = r.status;

  return {
    status: 200,
    body: {
      ok: true,
      partial: results.some((r) => r.status !== 'ok'),
      updated: now.toISOString(),
      today: toISODate(today),
      until: toISODate(horizon),
      minNights: MIN_NIGHTS,
      sources,
      booked,
    },
  };
}

async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return send(res, 405, { ok: false }, 'no-store');
  }
  const out = await buildAvailability(process.env, new Date());
  // Errors are sent with no-store so a short outage is not cached.
  const cache = out.status !== 200 ? 'no-store' : out.body.partial ? CACHE_PARTIAL : CACHE_OK;
  return send(res, out.status, out.body, cache);
}

module.exports = handler;
module.exports.parseCalendar = parseCalendar;
module.exports.mergeRanges = mergeRanges;
module.exports.buildAvailability = buildAvailability;
