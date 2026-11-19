"use strict";

const REGISTRY_SCHEMA_VERSION = 1;
const REGISTRY_STATUSES = new Set(["scheduled", "live", "finalizing", "final"]);
const REGISTRY_FIELDS = [
  "schema_version",
  "contest_id",
  "name",
  "status",
  "start_at",
  "end_at",
  "live_leaderboard_url",
  "final_leaderboard_url",
  "url",
];
const REGISTRY_GROUPS = ["scheduled", "live", "finalizing", "final"];

function registryMapping(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function registryRejectUnknown(data, allowed, context) {
  if (!registryMapping(data)) {
    throw new Error(`${context} must be an object`);
  }
  const unknown = Object.keys(data).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw new Error(`unknown ${context} field(s): ${unknown.sort().join(", ")}`);
  }
}

function registryString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function registryRelativeUrl(value, field) {
  registryString(value, field);
  if (
    value.includes("://") ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    value.split(/[\\/]/).includes("..") ||
    /\s/.test(value)
  ) {
    throw new Error(`${field} must be a safe relative URL`);
  }
  return value;
}

function validateRegistryEntry(entry) {
  registryRejectUnknown(entry, REGISTRY_FIELDS, "contest");
  if (entry.schema_version !== REGISTRY_SCHEMA_VERSION) {
    throw new Error("contest schema_version must be 1");
  }
  const contestId = registryString(entry.contest_id, "contest_id");
  if (!/^[a-z0-9]+(?:[a-z0-9_-]*[a-z0-9])?$/.test(contestId)) {
    throw new Error("contest_id is invalid");
  }
  registryString(entry.name, "contest name");
  if (!REGISTRY_STATUSES.has(entry.status)) {
    throw new Error(`invalid contest status: ${entry.status}`);
  }
  const start = Date.parse(registryString(entry.start_at, "start_at"));
  const end = Date.parse(registryString(entry.end_at, "end_at"));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new Error("contest window is invalid");
  }
  registryRelativeUrl(entry.final_leaderboard_url, "final_leaderboard_url");
  const expectedUrl = `contests/${contestId}/`;
  if (registryRelativeUrl(entry.url, "url") !== expectedUrl) {
    throw new Error(`contest url must be ${expectedUrl}`);
  }
  if (
    (entry.status === "scheduled" || entry.status === "live") &&
    (typeof entry.live_leaderboard_url !== "string" ||
      !entry.live_leaderboard_url.startsWith("https://"))
  ) {
    throw new Error("scheduled and live contests require a live URL");
  }
  if (entry.status === "final" && entry.live_leaderboard_url !== null) {
    throw new Error("final contests must clear the live URL");
  }
  return entry;
}

function validateRegistry(data) {
  registryRejectUnknown(data, ["schema_version", "contests"], "registry");
  if (data.schema_version !== REGISTRY_SCHEMA_VERSION) {
    throw new Error("registry schema_version must be 1");
  }
  if (!Array.isArray(data.contests)) {
    throw new Error("registry contests must be an array");
  }
  const contests = data.contests.map(validateRegistryEntry);
  const ids = contests.map((contest) => contest.contest_id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("registry contest_id values must be unique");
  }
  return contests;
}

async function fetchRegistry(url, fetchImpl = (...args) => globalThis.fetch(...args)) {
  const response = await fetchImpl(url, {
    method: "GET",
    cache: "no-store",
    credentials: "omit",
    headers: { Accept: "application/json" },
  });
  if (!response || response.ok !== true) {
    throw new Error("contest registry request failed");
  }
  return validateRegistry(await response.json());
}

function contestLink(document, contest, registryUrl) {
  const item = document.createElement("li");
  const link = document.createElement("a");
  link.href = new URL(contest.url, registryUrl).href;
  link.textContent = contest.name;
  const dates = document.createElement("span");
  dates.className = "contest-dates";
  dates.textContent = ` — ${contest.start_at} → ${contest.end_at}`;
  item.append(link, dates);
  return item;
}

function renderArchive(document, root, contests, registryUrl) {
  const grouped = new Map(REGISTRY_GROUPS.map((status) => [status, []]));
  for (const contest of contests) {
    grouped.get(contest.status).push(contest);
  }
  const fragment = document.createDocumentFragment();
  for (const status of REGISTRY_GROUPS) {
    const section = document.createElement("section");
    section.id = status;
    const title = document.createElement("h2");
    title.textContent = status[0].toUpperCase() + status.slice(1);
    const list = document.createElement("ul");
    list.className = "contest-list";
    const entries = grouped.get(status);
    if (entries.length) {
      for (const contest of entries) {
        list.append(contestLink(document, contest, registryUrl));
      }
    } else {
      const empty = document.createElement("li");
      empty.textContent = "No contests.";
      list.append(empty);
    }
    section.append(title, list);
    fragment.append(section);
  }
  root.replaceChildren(fragment);
  root.setAttribute("aria-busy", "false");
}

function updateNavigation(document, contests) {
  for (const status of ["scheduled", "live"]) {
    const link = document.querySelector(`[data-contest-nav="${status}"]`);
    if (!link) continue;
    const count = contests.filter((contest) => contest.status === status).length;
    link.textContent = `${status[0].toUpperCase() + status.slice(1)} (${count})`;
    link.setAttribute("aria-label", `${status} contests: ${count}`);
  }
}

async function bootSite(document, fetchImpl) {
  const host = document.querySelector("[data-registry-url]");
  if (!host) return [];
  const registryUrl = new URL(host.getAttribute("data-registry-url"), document.baseURI).href;
  try {
    const contests = await fetchRegistry(registryUrl, fetchImpl);
    updateNavigation(document, contests);
    const archive = document.getElementById("contest-archive");
    if (archive) renderArchive(document, archive, contests, registryUrl);
    return contests;
  } catch (error) {
    const archive = document.getElementById("contest-archive");
    if (archive) {
      archive.textContent = "Contest archive could not be loaded.";
      archive.setAttribute("aria-busy", "false");
    }
    return [];
  }
}

globalThis.ThirtyKaggleSite = {
  bootSite,
  fetchRegistry,
  renderArchive,
  updateNavigation,
  validateRegistry,
};

if (typeof document !== "undefined" && document.querySelector) {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => bootSite(document));
  } else {
    bootSite(document);
  }
}
