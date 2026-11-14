"use strict";

// Scheduled, live, finalizing, and final contest page.
// Manifest times are authoritative for the countdown and for moving a
// scheduled or live manifest forward. Final and finalizing manifest statuses
// are never moved backward. The problem statement stays hidden until start.
// Dynamic values are assigned with textContent and createTextNode; tag names
// passed to createElement are fixed literals.

const SCHEMA_VERSION = 1;
const POLL_INTERVAL_MS = 15000;
const UTC_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;
const ID_RE = /^[a-z0-9]+(?:[a-z0-9_-]*[a-z0-9])?$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MANIFEST_FIELDS = [
  "schema_version",
  "contest_id",
  "name",
  "status",
  "start_at",
  "end_at",
  "live_leaderboard_url",
  "final_leaderboard_url",
];
const MANIFEST_STATUSES = new Set(["scheduled", "live", "finalizing", "final"]);
const LEADERBOARD_STATUSES = new Set(["live", "final"]);

class ContractError extends Error {
  constructor(message) {
    super(message);
    this.name = "ContractError";
  }
}

function isMapping(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rejectUnknown(data, allowed, context) {
  if (!isMapping(data)) {
    throw new ContractError(`${context} must be an object`);
  }
  const unknown = Object.keys(data)
    .filter((key) => !allowed.includes(key))
    .sort();
  if (unknown.length) {
    throw new ContractError(`unknown ${context} field(s): ${unknown.join(", ")}`);
  }
}

function required(data, key) {
  if (!Object.prototype.hasOwnProperty.call(data, key)) {
    throw new ContractError(`missing required field: ${key}`);
  }
  return data[key];
}

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ContractError(`${field} must be a non-empty string`);
  }
  return value;
}

function requireIdentifier(value, field) {
  requireString(value, field);
  if (!ID_RE.test(value)) {
    throw new ContractError(
      `${field} must contain lowercase letters, numbers, underscores, or hyphens`
    );
  }
  return value;
}

function requireSchemaVersion(value) {
  if (!Number.isInteger(value) || value !== SCHEMA_VERSION) {
    throw new ContractError(`schema_version must be the integer ${SCHEMA_VERSION}`);
  }
}

function requireFiniteNumber(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ContractError(`${field} must be a finite number`);
  }
}

function requirePositiveInt(value, field) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ContractError(`${field} must be a positive integer`);
  }
}

function requireOptionalPositiveInt(value, field) {
  if (value !== null) {
    requirePositiveInt(value, field);
  }
}

function requireNonnegativeInt(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw new ContractError(`${field} must be a non-negative integer`);
  }
}

function requireStringList(value, field) {
  if (!Array.isArray(value)) {
    throw new ContractError(`${field} must be an array`);
  }
  return value.map((item) => requireString(item, field));
}

function formatUtc(date) {
  const pad = (part) => String(part).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}Z`
  );
}

function displayUtc(date) {
  return formatUtc(date).replace("T", " ").replace("Z", " UTC");
}

function parseUtc(value, field) {
  if (typeof value !== "string") {
    throw new ContractError(`${field} must use UTC format YYYY-MM-DDTHH:MM:SSZ`);
  }
  const parts = UTC_RE.exec(value);
  if (!parts) {
    throw new ContractError(`${field} must use UTC format YYYY-MM-DDTHH:MM:SSZ`);
  }
  const date = new Date(
    Date.UTC(
      Number(parts[1]),
      Number(parts[2]) - 1,
      Number(parts[3]),
      Number(parts[4]),
      Number(parts[5]),
      Number(parts[6])
    )
  );
  if (Number.isNaN(date.getTime()) || formatUtc(date) !== value) {
    throw new ContractError(`${field} must use UTC format YYYY-MM-DDTHH:MM:SSZ`);
  }
  return date;
}

function requireHttpsUrl(value, field) {
  requireString(value, field);
  if (!value.startsWith("https://") || /\s/.test(value)) {
    throw new ContractError(`${field} must be an HTTPS URL`);
  }
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    throw new ContractError(`${field} must be an HTTPS URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new ContractError(`${field} must be an HTTPS URL`);
  }
}

function requireRelativeUrl(value, field) {
  requireString(value, field);
  const parts = value.split(/[\\/]/);
  if (
    value.includes("://") ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /\s/.test(value) ||
    parts.includes("..")
  ) {
    throw new ContractError(`${field} must be a safe relative URL`);
  }
}

function optionalLabel(data, key, field) {
  if (!Object.prototype.hasOwnProperty.call(data, key) || data[key] === null) {
    return null;
  }
  return requireString(data[key], field);
}

function validateCompetition(data) {
  rejectUnknown(
    data,
    ["slug", "weight", "name", "metric", "score_direction"],
    "competition"
  );
  const slug = required(data, "slug");
  requireString(slug, "competition slug");
  if (!SLUG_RE.test(slug)) {
    throw new ContractError("competition slug must contain lowercase letters, numbers, and single hyphens");
  }
  const weight = required(data, "weight");
  requireFiniteNumber(weight, "competition weight");
  if (weight <= 0) {
    throw new ContractError("competition weight must be greater than zero");
  }
  let scoreDirection = null;
  if (
    Object.prototype.hasOwnProperty.call(data, "score_direction") &&
    data.score_direction !== null
  ) {
    scoreDirection = data.score_direction;
    if (scoreDirection !== "maximize" && scoreDirection !== "minimize") {
      throw new ContractError(`invalid score_direction: ${scoreDirection}`);
    }
  }
  return {
    slug,
    weight,
    name: optionalLabel(data, "name", "competition name"),
    metric: optionalLabel(data, "metric", "competition metric"),
    scoreDirection,
  };
}

function validateResult(data) {
  rejectUnknown(
    data,
    ["submitted", "registered_rank", "kaggle_rank", "score", "points"],
    "competition result"
  );
  const submitted = required(data, "submitted");
  if (typeof submitted !== "boolean") {
    throw new ContractError("submitted must be a boolean");
  }
  const registeredRank = required(data, "registered_rank");
  const kaggleRank = required(data, "kaggle_rank");
  const score = required(data, "score");
  const points = required(data, "points");
  requireOptionalPositiveInt(registeredRank, "registered_rank");
  requireOptionalPositiveInt(kaggleRank, "kaggle_rank");
  if (score !== null) {
    requireFiniteNumber(score, "score");
  }
  requireFiniteNumber(points, "points");
  if (points < 0) {
    throw new ContractError("points must not be negative");
  }
  if (!submitted && (registeredRank !== null || kaggleRank !== null || score !== null)) {
    throw new ContractError("a non-submission cannot have ranks or a score");
  }
  if (!submitted && points !== 0) {
    throw new ContractError("a non-submission must have zero points");
  }
  return { submitted, registeredRank, kaggleRank, score, points };
}

function validateStanding(data, slugs) {
  rejectUnknown(
    data,
    [
      "rank",
      "competitor_id",
      "display_name",
      "total_points",
      "entered_competitions",
      "placement_sum",
      "competitions",
    ],
    "standing"
  );
  const rank = required(data, "rank");
  requirePositiveInt(rank, "rank");
  const competitorId = requireIdentifier(required(data, "competitor_id"), "competitor_id");
  const displayName = requireString(required(data, "display_name"), "display_name");
  const totalPoints = required(data, "total_points");
  requireFiniteNumber(totalPoints, "total_points");
  if (totalPoints < 0) {
    throw new ContractError("total_points must not be negative");
  }
  const enteredCompetitions = required(data, "entered_competitions");
  const placementSum = required(data, "placement_sum");
  requireNonnegativeInt(enteredCompetitions, "entered_competitions");
  requireNonnegativeInt(placementSum, "placement_sum");
  const competitions = required(data, "competitions");
  rejectUnknown(competitions, slugs, "standing competitions");
  if (Object.keys(competitions).length !== slugs.length) {
    throw new ContractError(
      `standing ${competitorId} must contain every configured competition`
    );
  }
  const results = {};
  let entered = 0;
  for (const slug of slugs) {
    results[slug] = validateResult(required(competitions, slug));
    if (results[slug].submitted) {
      entered += 1;
    }
  }
  if (entered !== enteredCompetitions) {
    throw new ContractError("entered_competitions does not match submitted results");
  }
  return {
    rank,
    competitorId,
    displayName,
    totalPoints,
    enteredCompetitions,
    placementSum,
    competitions: results,
  };
}

function validateSource(data) {
  rejectUnknown(data, ["fresh", "last_success_at", "errors"], "source");
  const fresh = required(data, "fresh");
  if (typeof fresh !== "boolean") {
    throw new ContractError("source fresh must be a boolean");
  }
  const lastSuccess = required(data, "last_success_at");
  const errors = requireStringList(required(data, "errors"), "source error");
  if (fresh && errors.length) {
    throw new ContractError("a fresh source cannot contain errors");
  }
  return {
    fresh,
    lastSuccessAt: lastSuccess === null ? null : parseUtc(lastSuccess, "last_success_at"),
    lastSuccessAtText: lastSuccess,
    errors,
  };
}

function validateManifest(data) {
  rejectUnknown(data, MANIFEST_FIELDS, "manifest");
  requireSchemaVersion(required(data, "schema_version"));
  const contestId = requireIdentifier(required(data, "contest_id"), "contest_id");
  const name = requireString(required(data, "name"), "manifest name");
  const status = required(data, "status");
  if (!MANIFEST_STATUSES.has(status)) {
    throw new ContractError(`invalid manifest status: ${status}`);
  }
  const startAtText = required(data, "start_at");
  const endAtText = required(data, "end_at");
  const startAt = parseUtc(startAtText, "start_at");
  const endAt = parseUtc(endAtText, "end_at");
  if (endAt.getTime() <= startAt.getTime()) {
    throw new ContractError("end_at must be later than start_at");
  }
  const liveLeaderboardUrl = required(data, "live_leaderboard_url");
  const finalLeaderboardUrl = required(data, "final_leaderboard_url");
  if (liveLeaderboardUrl !== null) {
    requireHttpsUrl(liveLeaderboardUrl, "live_leaderboard_url");
  }
  requireRelativeUrl(finalLeaderboardUrl, "final_leaderboard_url");
  if ((status === "scheduled" || status === "live") && liveLeaderboardUrl === null) {
    throw new ContractError("scheduled and live manifests require live_leaderboard_url");
  }
  if (status === "final" && liveLeaderboardUrl !== null) {
    throw new ContractError("a final manifest must not retain live_leaderboard_url");
  }
  return {
    contestId,
    name,
    status,
    startAt,
    endAt,
    startAtText,
    endAtText,
    liveLeaderboardUrl,
    finalLeaderboardUrl,
  };
}

function validateLeaderboard(data) {
  rejectUnknown(
    data,
    [
      "schema_version",
      "contest_id",
      "status",
      "start_at",
      "end_at",
      "generated_at",
      "source",
      "competitions",
      "standings",
      "warnings",
    ],
    "leaderboard"
  );
  requireSchemaVersion(required(data, "schema_version"));
  const contestId = requireIdentifier(required(data, "contest_id"), "contest_id");
  const status = required(data, "status");
  if (!LEADERBOARD_STATUSES.has(status)) {
    throw new ContractError(`invalid leaderboard status: ${status}`);
  }
  const startAt = parseUtc(required(data, "start_at"), "start_at");
  const endAt = parseUtc(required(data, "end_at"), "end_at");
  const generatedAtText = required(data, "generated_at");
  const generatedAt = parseUtc(generatedAtText, "generated_at");
  if (endAt.getTime() <= startAt.getTime()) {
    throw new ContractError("end_at must be later than start_at");
  }
  const competitionsData = required(data, "competitions");
  if (!Array.isArray(competitionsData) || competitionsData.length === 0) {
    throw new ContractError("leaderboard must contain competitions");
  }
  const competitions = competitionsData.map(validateCompetition);
  const slugs = competitions.map((competition) => competition.slug);
  if (new Set(slugs).size !== slugs.length) {
    throw new ContractError("leaderboard competition slugs must be unique");
  }
  const standingsData = required(data, "standings");
  if (!Array.isArray(standingsData)) {
    throw new ContractError("standings must be an array");
  }
  const standings = standingsData.map((standing) => validateStanding(standing, slugs));
  const ids = standings.map((standing) => standing.competitorId);
  if (new Set(ids).size !== ids.length) {
    throw new ContractError("leaderboard competitor ids must be unique");
  }
  return {
    contestId,
    status,
    startAt,
    endAt,
    generatedAt,
    generatedAtText,
    source: validateSource(required(data, "source")),
    competitions,
    standings,
    warnings: requireStringList(required(data, "warnings"), "warning"),
  };
}

function derivePhase(manifest, now) {
  if (manifest.status === "final") {
    return "final";
  }
  if (manifest.status === "finalizing") {
    return "finalizing";
  }
  const time = now.getTime();
  if (time >= manifest.endAt.getTime()) {
    return "finalizing";
  }
  if (time < manifest.startAt.getTime()) {
    return "scheduled";
  }
  return "live";
}

function viewPhase(phase, finalSnapshot) {
  if (finalSnapshot && (phase === "final" || phase === "finalizing")) {
    return "final";
  }
  return phase;
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (days) {
    parts.push(`${days}d`);
  }
  if (days || hours) {
    parts.push(`${hours}h`);
  }
  if (days || hours || minutes) {
    parts.push(`${minutes}m`);
  }
  parts.push(`${seconds}s`);
  return parts.join(" ");
}

function formatNumber(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "—";
  }
  const text = value.toFixed(6).replace(/\.?0+$/, "");
  return text === "-0" ? "0" : text;
}

function cacheBustUrl(href, nowMs) {
  const url = new URL(href);
  url.searchParams.set("t", String(nowMs));
  return url.href;
}

function ensureDirectoryUrl(href) {
  const url = new URL(href);
  const last = url.pathname.split("/").pop();
  if (last && !last.includes(".") && !url.pathname.endsWith("/")) {
    url.pathname = `${url.pathname}/`;
  }
  return url.href;
}

function resolveUrl(relativeOrAbsolute, baseUrl) {
  return new URL(relativeOrAbsolute, baseUrl).href;
}

function statusText(state) {
  const { phase, snapshot, liveOutage, manifestOutage, manifest } = state;
  let text;
  if (phase === "scheduled") {
    text = "The contest has not started. Problems stay hidden until the start time.";
  } else if (phase === "live") {
    if (liveOutage && snapshot) {
      text = `The contest is live, but new results are unavailable. Showing the last valid update. ${liveOutage}`;
    } else if (liveOutage) {
      text = `The contest is live, but results are unavailable. ${liveOutage}`;
    } else if (snapshot && snapshot.source.fresh === false) {
      text = "The contest is live, and the latest results are stale.";
    } else {
      text = "The contest is live.";
    }
  } else if (phase === "finalizing") {
    text = snapshot
      ? "The contest has ended. Final standings are being published. Showing the last valid update."
      : "The contest has ended. Waiting for the permanent leaderboard.";
  } else if (!snapshot) {
    text = "The permanent leaderboard could not be loaded.";
  } else if (snapshot.source.fresh === false) {
    text = "These standings are the permanent final results, frozen from the last valid update.";
  } else {
    text = "These standings are the permanent final results.";
  }
  if (manifestOutage && manifest) {
    text += " Contest status could not be refreshed. Showing the last valid status.";
  }
  return text;
}

function countdownText(phase, manifest, now) {
  if (phase === "scheduled") {
    return `Starts in ${formatDuration(manifest.startAt.getTime() - now.getTime())}.`;
  }
  if (phase === "live") {
    return `Ends in ${formatDuration(manifest.endAt.getTime() - now.getTime())}.`;
  }
  return `Ended at ${displayUtc(manifest.endAt)}.`;
}

function competitionLabel(competition) {
  return competition.name || competition.slug;
}

function competitionMeta(competition) {
  const parts = [];
  if (competition.metric) {
    parts.push(competition.metric);
  }
  if (competition.scoreDirection === "maximize") {
    parts.push("higher is better");
  } else if (competition.scoreDirection === "minimize") {
    parts.push("lower is better");
  }
  parts.push(`weight ${formatNumber(competition.weight)}`);
  return parts.join(" · ");
}

function describeFetchError(error, target) {
  if (error instanceof ContractError) {
    return error.message;
  }
  const status = error && Number.isInteger(error.status) ? error.status : null;
  if (target === "final" && status === 404) {
    return "The permanent leaderboard is not available yet.";
  }
  const name =
    target === "final"
      ? "permanent leaderboard"
      : target === "manifest"
        ? "contest status"
        : "live leaderboard";
  if (status != null) {
    return `The ${name} request failed (${status}).`;
  }
  return `The ${name} request failed.`;
}

function el(doc, tag, props = {}) {
  const node = doc.createElement(tag);
  if (props.className) {
    node.className = props.className;
  }
  if (props.attrs) {
    for (const [key, value] of Object.entries(props.attrs)) {
      node.setAttribute(key, String(value));
    }
  }
  if (props.text != null) {
    node.textContent = String(props.text);
  } else if (props.children) {
    for (const child of props.children) {
      if (child) {
        node.append(child);
      }
    }
  }
  return node;
}

function timeElement(doc, date) {
  return el(doc, "time", {
    text: displayUtc(date),
    attrs: { datetime: formatUtc(date) },
  });
}

function labeledTime(doc, label, date) {
  const item = el(doc, "li");
  item.append(doc.createTextNode(`${label} `));
  item.append(timeElement(doc, date));
  return item;
}

function resultElement(doc, result) {
  if (!result.submitted) {
    return el(doc, "div", {
      className: "result result-none",
      children: [
        el(doc, "p", { text: "No submission" }),
        el(doc, "p", { text: "Points 0" }),
      ],
    });
  }
  const score = result.score === null ? "—" : formatNumber(result.score);
  const place = result.registeredRank === null ? "—" : String(result.registeredRank);
  const kaggleRank = result.kaggleRank === null ? "—" : String(result.kaggleRank);
  return el(doc, "div", {
    className: "result",
    children: [
      el(doc, "p", { text: `Place ${place}` }),
      el(doc, "p", { text: `Kaggle rank ${kaggleRank}` }),
      el(doc, "p", { text: `Score ${score}` }),
      el(doc, "p", { text: `Points ${formatNumber(result.points)}` }),
    ],
  });
}

function standingsTable(doc, snapshot) {
  const ordered = snapshot.standings.slice().sort((left, right) => {
    return left.rank - right.rank || left.competitorId.localeCompare(right.competitorId);
  });
  const headRow = el(doc, "tr", {
    children: [
      el(doc, "th", { className: "rank", text: "Rank", attrs: { scope: "col" } }),
      el(doc, "th", { text: "Competitor", attrs: { scope: "col" } }),
      el(doc, "th", { text: "Points", attrs: { scope: "col" } }),
    ],
  });
  for (const competition of snapshot.competitions) {
    headRow.append(
      el(doc, "th", {
        attrs: { scope: "col" },
        children: [
          el(doc, "span", { className: "comp-name", text: competitionLabel(competition) }),
          el(doc, "span", { className: "comp-meta", text: competitionMeta(competition) }),
        ],
      })
    );
  }
  const body = el(doc, "tbody");
  for (const standing of ordered) {
    const row = el(doc, "tr", {
      children: [
        el(doc, "th", {
          className: "rank",
          text: String(standing.rank),
          attrs: { scope: "row" },
        }),
        el(doc, "td", {
          className: "competitor",
          children: [
            el(doc, "p", { className: "display-name", text: standing.displayName }),
            el(doc, "p", { className: "competitor-id", text: standing.competitorId }),
            el(doc, "p", {
              className: "tie-break",
              text: `Entered ${standing.enteredCompetitions}. Placement sum ${standing.placementSum}.`,
            }),
          ],
        }),
        el(doc, "td", {
          className: "total-points",
          text: formatNumber(standing.totalPoints),
        }),
      ],
    });
    for (const competition of snapshot.competitions) {
      row.append(
        el(doc, "td", {
          children: [resultElement(doc, standing.competitions[competition.slug])],
        })
      );
    }
    body.append(row);
  }
  return el(doc, "div", {
    className: "table-scroll",
    attrs: { tabindex: "0", role: "region", "aria-labelledby": "standings-title" },
    children: [
      el(doc, "table", {
        className: "standings",
        children: [
          el(doc, "caption", {
            className: "visually-hidden",
            text: "Overall rank, name, points, and per-competition place, score, and points.",
          }),
          el(doc, "thead", { children: [headRow] }),
          body,
        ],
      }),
    ],
  });
}

function renderPanel(doc, state) {
  const { manifest, phase, snapshot, fetchedAt, now, finalOutage } = state;
  const countdown = el(doc, "p", { className: "countdown", text: countdownText(phase, manifest, now) });
  const badges = [
    el(doc, "p", { className: `badge badge-${phase}`, text: phaseLabel(phase) }),
  ];
  if (snapshot && snapshot.source.fresh === false) {
    badges.push(el(doc, "p", { className: "badge badge-stale", text: "Stale" }));
  }
  if (phase === "live" && state.liveOutage) {
    badges.push(el(doc, "p", { className: "badge badge-unavailable", text: "Unavailable" }));
  }
  const children = [
    el(doc, "div", {
      className: "contest-heading",
      children: [
        el(doc, "p", { className: "contest-kicker", text: manifest.name }),
        el(doc, "div", { className: "badge-row", children: badges }),
      ],
    }),
    countdown,
    el(doc, "p", {
      className: "status-line",
      text: statusText(state),
      attrs: { id: "contest-status", role: "status", "aria-live": "polite", "aria-atomic": "true" },
    }),
    el(doc, "p", {
      className: "contest-window",
      children: [
        doc.createTextNode("Start "),
        timeElement(doc, manifest.startAt),
        doc.createTextNode(". End "),
        timeElement(doc, manifest.endAt),
        doc.createTextNode("."),
      ],
    }),
  ];
  if ((phase === "finalizing" || phase === "final") && finalOutage && !state.finalSnapshot) {
    children.push(el(doc, "p", { className: "notice notice-info", text: finalOutage }));
  }
  if (snapshot) {
    const meta = [labeledTime(doc, "Generated", snapshot.generatedAt)];
    if (snapshot.source.lastSuccessAt) {
      meta.push(labeledTime(doc, "Last successful refresh", snapshot.source.lastSuccessAt));
    } else {
      meta.push(el(doc, "li", { text: "No successful refresh recorded." }));
    }
    if (fetchedAt) {
      meta.push(labeledTime(doc, "Received", fetchedAt));
    }
    children.push(el(doc, "ul", { className: "meta-list", children: meta }));
    if (snapshot.source.errors.length) {
      children.push(el(doc, "p", { className: "notice notice-stale", text: "Results are stale." }));
      children.push(
        el(doc, "ul", {
          className: "error-list",
          children: snapshot.source.errors.map((error) => el(doc, "li", { text: error })),
        })
      );
    }
    if (snapshot.warnings.length) {
      children.push(el(doc, "p", { text: "Warnings" }));
      children.push(
        el(doc, "ul", {
          className: "warning-list",
          children: snapshot.warnings.map((warning) => el(doc, "li", { text: warning })),
        })
      );
    }
    children.push(el(doc, "h2", { className: "standings-title", text: "Standings", attrs: { id: "standings-title" } }));
    if (snapshot.standings.length) {
      children.push(standingsTable(doc, snapshot));
    } else {
      children.push(el(doc, "p", { className: "empty-standings", text: "No standings are available in this update." }));
    }
  }
  const panel = el(doc, "div", { className: "contest-panel", children });
  panel.countdownNode = countdown;
  return panel;
}

function panelSignature(state) {
  const snapshot = state.snapshot;
  return JSON.stringify({
    phase: state.phase,
    name: state.manifest.name,
    start: state.manifest.startAtText,
    end: state.manifest.endAtText,
    liveOutage: state.liveOutage,
    finalOutage: state.finalOutage,
    manifestOutage: state.manifestOutage,
    fetched: state.fetchedAt ? state.fetchedAt.getTime() : null,
    generated: snapshot ? snapshot.generatedAtText : null,
    fresh: snapshot ? snapshot.source.fresh : null,
    errors: snapshot ? snapshot.source.errors : null,
    warnings: snapshot ? snapshot.warnings : null,
    standings: snapshot
      ? snapshot.standings.map((standing) => ({
          rank: standing.rank,
          name: standing.displayName,
          points: standing.totalPoints,
          results: snapshot.competitions.map((competition) => {
            const result = standing.competitions[competition.slug];
            return [result.submitted, result.registeredRank, result.kaggleRank, result.score, result.points];
          }),
        }))
      : null,
  });
}

function phaseLabel(phase) {
  if (phase === "scheduled") return "Scheduled";
  if (phase === "live") return "Live";
  if (phase === "finalizing") return "Finalizing";
  return "Final";
}

function renderFailure(doc, message) {
  return el(doc, "p", {
    className: "status-line",
    text: message,
    attrs: { role: "status", "aria-live": "polite" },
  });
}

async function fetchJson(url, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      redirect: "follow",
      referrerPolicy: "no-referrer",
      headers: { Accept: "application/json" },
    });
  } catch (error) {
    const wrapped = new Error("The request failed.");
    wrapped.cause = error;
    throw wrapped;
  }
  if (!response || response.ok !== true) {
    const failed = new Error("The request failed.");
    failed.status = response && Number.isInteger(response.status) ? response.status : null;
    throw failed;
  }
  try {
    return await response.json();
  } catch (error) {
    const failed = new Error("Response was not valid JSON.");
    failed.cause = error;
    throw failed;
  }
}

class ContestApp {
  constructor(root, options = {}) {
    if (!root) {
      throw new Error("root is required");
    }
    this.root = root;
    this.doc = options.document || root.ownerDocument;
    this.fetchImpl = options.fetchImpl || ((...args) => globalThis.fetch(...args));
    this.now = options.now || (() => new Date());
    this.schedule = options.schedule || ((fn, ms) => setTimeout(fn, ms));
    this.cancel = options.cancel || ((id) => clearTimeout(id));
    this.pollIntervalMs = options.pollIntervalMs || POLL_INTERVAL_MS;
    this.manifestUrl =
      options.manifestUrl ||
      (root.getAttribute && root.getAttribute("data-manifest-url")) ||
      "manifest.json";
    const rawBase =
      options.baseUrl ||
      (this.doc && this.doc.baseURI) ||
      (globalThis.location && globalThis.location.href);
    if (!rawBase) {
      throw new Error("baseUrl is required");
    }
    this.baseUrl = ensureDirectoryUrl(rawBase);
    this.running = false;
    this.started = false;
    this.inFlight = false;
    this.timer = null;
    this.manifest = null;
    this.leaderboard = null;
    this.finalSnapshot = null;
    this.leaderboardFetchedAt = null;
    this.finalFetchedAt = null;
    this.lastManifestPollAt = null;
    this.lastLivePollAt = null;
    this.lastFinalPollAt = null;
    this.manifestOutage = null;
    this.liveOutage = null;
    this.finalOutage = null;
    this.renderedSignature = null;
    this.countdownNode = null;
  }

  async start() {
    if (this.started) {
      return;
    }
    this.started = true;
    this.running = true;
    await this.step();
  }

  stop() {
    this.running = false;
    if (this.timer != null) {
      this.cancel(this.timer);
      this.timer = null;
    }
  }

  async step() {
    if (!this.running || this.inFlight) {
      return;
    }
    this.inFlight = true;
    let delay = 1000;
    try {
      delay = await this.advance();
    } catch (error) {
      this.renderedSignature = null;
      this.countdownNode = null;
      this.root.replaceChildren(renderFailure(this.doc, "Contest status could not be updated."));
      this.root.setAttribute("aria-busy", "false");
      delay = 5000;
    } finally {
      this.inFlight = false;
    }
    if (this.running && delay != null) {
      this.timer = this.schedule(() => {
        this.step();
      }, delay);
    }
  }

  async advance() {
    const now = this.now();
    if (this.due(this.lastManifestPollAt, now)) {
      await this.refreshManifest(now);
    }
    if (!this.manifest) {
      this.renderedSignature = null;
      this.countdownNode = null;
      this.root.replaceChildren(
        renderFailure(this.doc, this.manifestOutage || "Contest status could not be loaded.")
      );
      this.root.setAttribute("aria-busy", "false");
      return 5000;
    }
    const phase = derivePhase(this.manifest, now);
    if (this.shouldPollLive(phase, now)) {
      await this.pollLive(now);
    }
    if (this.shouldPollFinal(phase, now)) {
      await this.pollFinal(now);
    }
    const shown = viewPhase(phase, this.finalSnapshot);
    this.syncStatement(shown);
    const snapshot = shown === "final" ? this.finalSnapshot : this.leaderboard;
    const fetchedAt = shown === "final" ? this.finalFetchedAt : this.leaderboardFetchedAt;
    const panelState = {
      manifest: this.manifest,
      phase: shown,
      snapshot,
      fetchedAt,
      now,
      liveOutage: this.liveOutage,
      finalOutage: this.finalOutage,
      manifestOutage: this.manifestOutage,
      finalSnapshot: this.finalSnapshot,
    };
    const signature = panelSignature(panelState);
    if (signature === this.renderedSignature && this.countdownNode) {
      const countdown = countdownText(shown, this.manifest, now);
      if (this.countdownNode.textContent !== countdown) {
        this.countdownNode.textContent = countdown;
      }
    } else {
      const panel = renderPanel(this.doc, panelState);
      this.countdownNode = panel.countdownNode;
      this.renderedSignature = signature;
      this.root.replaceChildren(panel);
    }
    this.root.setAttribute("aria-busy", "false");
    if (shown === "final" && this.finalSnapshot) {
      this.running = false;
      return null;
    }
    return 1000;
  }

  syncStatement(phase) {
    const statement = this.doc.getElementById("contest-statement");
    if (!statement) {
      return;
    }
    statement.hidden = phase === "scheduled";
  }

  due(last, now) {
    return last == null || now.getTime() - last >= this.pollIntervalMs;
  }

  shouldPollLive(phase, now) {
    if (this.finalSnapshot || !this.manifest.liveLeaderboardUrl) {
      return false;
    }
    if (phase !== "live" && phase !== "finalizing") {
      return false;
    }
    return this.due(this.lastLivePollAt, now);
  }

  shouldPollFinal(phase, now) {
    if (this.finalSnapshot || (phase !== "finalizing" && phase !== "final")) {
      return false;
    }
    return this.due(this.lastFinalPollAt, now);
  }

  async refreshManifest(now) {
    this.lastManifestPollAt = now.getTime();
    const url = cacheBustUrl(resolveUrl(this.manifestUrl, this.baseUrl), now.getTime());
    try {
      const data = await fetchJson(url, this.fetchImpl);
      const manifest = validateManifest(data);
      if (this.manifest && manifest.contestId !== this.manifest.contestId) {
        throw new ContractError("contest_id changed");
      }
      this.manifest = manifest;
      this.manifestOutage = null;
    } catch (error) {
      this.manifestOutage = describeFetchError(error, "manifest");
    }
  }

  assertMatchesContest(snapshot) {
    if (snapshot.contestId !== this.manifest.contestId) {
      throw new ContractError("leaderboard contest_id does not match the manifest");
    }
    if (snapshot.startAt.getTime() !== this.manifest.startAt.getTime()) {
      throw new ContractError("leaderboard start_at does not match the manifest");
    }
    if (snapshot.endAt.getTime() !== this.manifest.endAt.getTime()) {
      throw new ContractError("leaderboard end_at does not match the manifest");
    }
  }

  async pollLive(now) {
    this.lastLivePollAt = now.getTime();
    const url = cacheBustUrl(this.manifest.liveLeaderboardUrl, now.getTime());
    try {
      const data = await fetchJson(url, this.fetchImpl);
      const snapshot = validateLeaderboard(data);
      this.assertMatchesContest(snapshot);
      this.leaderboard = snapshot;
      this.leaderboardFetchedAt = now;
      this.liveOutage = null;
    } catch (error) {
      this.liveOutage = describeFetchError(error, "live");
    }
  }

  async pollFinal(now) {
    this.lastFinalPollAt = now.getTime();
    const url = cacheBustUrl(
      resolveUrl(this.manifest.finalLeaderboardUrl, this.baseUrl),
      now.getTime()
    );
    try {
      const data = await fetchJson(url, this.fetchImpl);
      const snapshot = validateLeaderboard(data);
      this.assertMatchesContest(snapshot);
      if (snapshot.status !== "final") {
        throw new ContractError("permanent leaderboard status must be final");
      }
      this.finalSnapshot = snapshot;
      this.finalFetchedAt = now;
      this.finalOutage = null;
    } catch (error) {
      this.finalOutage = describeFetchError(error, "final");
    }
  }
}

function boot(document) {
  const root = document.getElementById("contest-app");
  if (!root || root.getAttribute("data-contest-ready") === "true") {
    return;
  }
  root.setAttribute("data-contest-ready", "true");
  const app = new ContestApp(root);
  app.start().catch(() => {
    const message = document.createElement("p");
    message.textContent = "Contest status could not be loaded.";
    root.replaceChildren(message);
  });
}

if (typeof document !== "undefined" && document.getElementById) {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => boot(document));
  } else {
    boot(document);
  }
}

globalThis.ContestApp = {
  ContestApp,
  ContractError,
  POLL_INTERVAL_MS,
  cacheBustUrl,
  derivePhase,
  ensureDirectoryUrl,
  formatDuration,
  validateLeaderboard,
  validateManifest,
};
