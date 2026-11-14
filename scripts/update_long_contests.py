#!/usr/bin/env python3
"""Update every long-running contest stored in this Pages repository.

This file intentionally uses only the Python standard library. The workflow
installs the Kaggle CLI, while all validation, scoring, and persistence needed
by scheduled updates lives here.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import math
import os
import re
import subprocess
import sys
import tempfile
import zipfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Mapping, Sequence


SCHEMA_VERSION = 1
UTC_FORMAT = "%Y-%m-%dT%H:%M:%SZ"
CONTESTS_DIRECTORY = Path("30kaggle/contests")
ARCHIVE_INDEX = Path("30kaggle/index.md")
CONTEST_FILENAME = "contest.json"
ROSTER_FILENAME = "roster.json"
MANIFEST_FILENAME = "manifest.json"
LIVE_FILENAME = "leaderboard-live.json"
FINAL_FILENAME = "leaderboard-final.json"
ENTRIES_START = "<!-- contests:start -->"
ENTRIES_END = "<!-- contests:end -->"
ID_RE = re.compile(r"^[a-z0-9]+(?:[a-z0-9_-]*[a-z0-9])?$")
SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


class UpdateError(Exception):
    """Expected per-contest update failure."""


@dataclass(frozen=True)
class UpdateResult:
    contest_id: str
    outcome: str
    changed_paths: tuple[Path, ...] = ()
    error: str | None = None


LeaderboardFetcher = Callable[[Mapping[str, object]], tuple[dict[str, object], ...]]


def utc_now() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def parse_utc(value: object, field: str) -> datetime:
    if not isinstance(value, str):
        raise UpdateError(f"{field} must use UTC format YYYY-MM-DDTHH:MM:SSZ")
    try:
        parsed = datetime.strptime(value, UTC_FORMAT).replace(tzinfo=timezone.utc)
    except ValueError as exc:
        raise UpdateError(
            f"{field} must use UTC format YYYY-MM-DDTHH:MM:SSZ"
        ) from exc
    if format_utc(parsed) != value:
        raise UpdateError(f"{field} must use UTC format YYYY-MM-DDTHH:MM:SSZ")
    return parsed


def format_utc(value: datetime) -> str:
    return value.astimezone(timezone.utc).replace(microsecond=0).strftime(UTC_FORMAT)


def normalize_team_name(value: str) -> str:
    return " ".join(value.split()).casefold()


class KaggleFetcher:
    def __init__(self, executable: str = "kaggle", timeout: float = 120.0) -> None:
        self.executable = executable
        self.timeout = timeout

    def __call__(
        self, competition: Mapping[str, object]
    ) -> tuple[dict[str, object], ...]:
        slug = _string(competition.get("slug"), "competition slug")
        if not SLUG_RE.fullmatch(slug):
            raise UpdateError(f"invalid competition slug: {slug}")
        with tempfile.TemporaryDirectory(prefix="long-contest-kaggle-") as temporary:
            try:
                completed = subprocess.run(
                    [
                        self.executable,
                        "competitions",
                        "leaderboard",
                        slug,
                        "--download",
                        "--path",
                        temporary,
                        "--quiet",
                    ],
                    check=False,
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    timeout=self.timeout,
                    shell=False,
                )
            except (OSError, subprocess.TimeoutExpired) as exc:
                raise UpdateError(f"{slug}: Kaggle download failed: {exc}") from exc
            if completed.returncode != 0:
                detail = _redact((completed.stderr or completed.stdout).strip())
                raise UpdateError(
                    f"{slug}: Kaggle download failed with status "
                    f"{completed.returncode}: {detail}"
                )
            return parse_download(Path(temporary))


def parse_download(directory: Path) -> tuple[dict[str, object], ...]:
    archives = sorted(directory.glob("*.zip"))
    if len(archives) > 1:
        raise UpdateError("Kaggle download produced multiple zip archives")
    if archives:
        try:
            with zipfile.ZipFile(archives[0]) as archive:
                names = [
                    name
                    for name in archive.namelist()
                    if name.casefold().endswith(".csv") and not name.endswith("/")
                ]
                selected = _select_csv(names)
                payload = archive.read(selected).decode("utf-8-sig")
        except (OSError, KeyError, UnicodeError, zipfile.BadZipFile) as exc:
            raise UpdateError(f"could not read Kaggle leaderboard archive: {exc}") from exc
        return parse_leaderboard_csv(payload)
    files = sorted(directory.glob("*.csv"))
    selected = _select_csv([path.name for path in files])
    return parse_leaderboard_csv((directory / selected).read_text(encoding="utf-8-sig"))


def parse_leaderboard_csv(text: str) -> tuple[dict[str, object], ...]:
    if not text.strip():
        raise UpdateError("Kaggle leaderboard is empty")
    reader = csv.DictReader(io.StringIO(text.lstrip("\ufeff")))
    if not reader.fieldnames:
        raise UpdateError("Kaggle leaderboard header is missing")
    indexed = {_header_key(name): name for name in reader.fieldnames if name}
    team_header = _first_header(indexed, ("teamname",), "team name")
    score_header = _first_header(indexed, ("score", "publicscore"), "score")
    rank_header = next(
        (indexed[name] for name in ("rank", "position") if name in indexed),
        None,
    )
    rows: list[dict[str, object]] = []
    for position, record in enumerate(reader, start=1):
        if not any((value or "").strip() for value in record.values()):
            continue
        team = (record.get(team_header) or "").strip()
        if not team:
            raise UpdateError(f"empty team name on leaderboard row {position}")
        rank_text = (record.get(rank_header) or "").strip() if rank_header else ""
        try:
            rank = int(rank_text) if rank_header else position
            score = float((record.get(score_header) or "").strip())
        except ValueError as exc:
            raise UpdateError(f"invalid rank or score on leaderboard row {position}") from exc
        if rank < 1 or not math.isfinite(score):
            raise UpdateError(f"invalid rank or score on leaderboard row {position}")
        rows.append({"team_name": team, "rank": rank, "score": score})
    rows.sort(key=lambda row: (int(row["rank"]), str(row["team_name"]).casefold()))
    return tuple(rows)


def score_snapshot(
    contest: Mapping[str, object],
    roster: Mapping[str, object],
    rows_by_slug: Mapping[str, Sequence[Mapping[str, object]]],
    *,
    now: datetime,
    status: str,
) -> dict[str, object]:
    contest_id, name, start_at, end_at, competitions = validate_contest(contest)
    del name
    competitors = validate_roster(roster)
    results: dict[str, dict[str, dict[str, object]]] = {
        str(competitor["id"]): {} for competitor in competitors
    }
    warnings: list[str] = []
    for competition in competitions:
        slug = str(competition["slug"])
        grouped: dict[str, list[Mapping[str, object]]] = {}
        for row in rows_by_slug.get(slug, ()):
            grouped.setdefault(normalize_team_name(str(row["team_name"])), []).append(row)
        matched: list[tuple[str, Mapping[str, object]]] = []
        for competitor in competitors:
            competitor_id = str(competitor["id"])
            team = str(competitor["kaggle_team_name"])
            found = grouped.get(normalize_team_name(team), [])
            if len(found) == 1:
                matched.append((competitor_id, found[0]))
            elif len(found) > 1:
                warnings.append(f"Multiple leaderboard rows matched {team} in {slug}")
            else:
                warnings.append(f"No submission matched {team} in {slug}")
            results[competitor_id][slug] = _no_submission()
        _assign_points(results, matched, slug, len(competitors), float(competition["weight"]))

    by_id = {str(item["id"]): item for item in competitors}

    def ordering(competitor_id: str) -> tuple[object, ...]:
        entries = results[competitor_id]
        entered = sum(bool(item["submitted"]) for item in entries.values())
        placement_sum = sum(
            int(item["registered_rank"] or 0)
            for item in entries.values()
            if item["submitted"]
        )
        total = sum(float(item["points"]) for item in entries.values())
        display = str(by_id[competitor_id]["display_name"])
        return -total, -entered, placement_sum, display.casefold(), display, competitor_id

    standings: list[dict[str, object]] = []
    for rank, competitor_id in enumerate(sorted(results, key=ordering), start=1):
        entries = results[competitor_id]
        standings.append(
            {
                "rank": rank,
                "competitor_id": competitor_id,
                "display_name": by_id[competitor_id]["display_name"],
                "total_points": float(
                    sum(float(item["points"]) for item in entries.values())
                ),
                "entered_competitions": sum(
                    bool(item["submitted"]) for item in entries.values()
                ),
                "placement_sum": sum(
                    int(item["registered_rank"] or 0)
                    for item in entries.values()
                    if item["submitted"]
                ),
                "competitions": entries,
            }
        )
    return {
        "schema_version": SCHEMA_VERSION,
        "contest_id": contest_id,
        "status": status,
        "start_at": format_utc(start_at),
        "end_at": format_utc(end_at),
        "generated_at": format_utc(now),
        "source": {
            "fresh": True,
            "last_success_at": format_utc(now),
            "errors": [],
        },
        "competitions": [_public_competition(item) for item in competitions],
        "standings": standings,
        "warnings": warnings,
    }


def update_all(
    repo: Path,
    *,
    now: datetime | None = None,
    fetcher: LeaderboardFetcher | None = None,
) -> tuple[UpdateResult, ...]:
    """Discover and independently update every configured long contest."""

    root = Path(repo)
    current = (now or utc_now()).astimezone(timezone.utc).replace(microsecond=0)
    source = fetcher or KaggleFetcher()
    pattern = root / CONTESTS_DIRECTORY
    results: list[UpdateResult] = []
    for config_path in sorted(pattern.glob(f"*/{CONTEST_FILENAME}")):
        contest_id = config_path.parent.name
        try:
            results.append(
                update_one(root, config_path.parent, current, fetcher=source)
            )
        except Exception as exc:
            results.append(
                UpdateResult(
                    contest_id=contest_id,
                    outcome="error",
                    error=_redact(str(exc)) or "contest update failed",
                )
            )
    return tuple(results)


def update_one(
    repo: Path,
    directory: Path,
    now: datetime,
    *,
    fetcher: LeaderboardFetcher,
) -> UpdateResult:
    contest = _load_json(directory / CONTEST_FILENAME)
    roster = _load_json(directory / ROSTER_FILENAME)
    manifest = _load_json(directory / MANIFEST_FILENAME)
    contest_id, name, start_at, end_at, competitions = validate_contest(contest)
    validate_roster(roster)
    if directory.name != contest_id:
        raise UpdateError("contest_id must match its directory name")
    if manifest.get("contest_id") != contest_id:
        raise UpdateError("manifest contest_id does not match contest.json")
    if manifest.get("status") == "final":
        return UpdateResult(contest_id, "final-noop")
    if now < start_at:
        return UpdateResult(contest_id, "scheduled-noop")

    final = now >= end_at
    rows: dict[str, tuple[dict[str, object], ...]] = {}
    error: str | None = None
    try:
        for competition in competitions:
            rows[str(competition["slug"])] = fetcher(competition)
        snapshot = score_snapshot(
            contest,
            roster,
            rows,
            now=now,
            status="final" if final else "live",
        )
    except Exception as exc:
        error = _redact(str(exc)) or "leaderboard refresh failed"
        previous = _load_previous(directory)
        if previous is None:
            changed = _set_manifest_status(
                repo,
                directory,
                manifest,
                contest_id=contest_id,
                name=name,
                start_at=start_at,
                end_at=end_at,
                status="finalizing" if final else "live",
            )
            return UpdateResult(
                contest_id,
                "unavailable",
                changed_paths=changed,
                error=error,
            )
        snapshot = _stale_snapshot(previous, now=now, error=error, final=final)

    snapshot_path = directory / (FINAL_FILENAME if final else LIVE_FILENAME)
    changed_paths: list[Path] = []
    if _write_json_if_changed(snapshot_path, snapshot):
        changed_paths.append(snapshot_path.relative_to(repo))
    changed_paths.extend(
        _set_manifest_status(
            repo,
            directory,
            manifest,
            contest_id=contest_id,
            name=name,
            start_at=start_at,
            end_at=end_at,
            status="final" if final else "live",
        )
    )
    return UpdateResult(
        contest_id,
        "finalized" if final else "updated",
        changed_paths=tuple(dict.fromkeys(changed_paths)),
        error=error,
    )


def validate_contest(
    data: Mapping[str, object],
) -> tuple[str, str, datetime, datetime, tuple[dict[str, object], ...]]:
    if data.get("schema_version") != SCHEMA_VERSION:
        raise UpdateError(f"schema_version must be {SCHEMA_VERSION}")
    contest_id = _string(data.get("contest_id"), "contest_id")
    if not ID_RE.fullmatch(contest_id):
        raise UpdateError("invalid contest_id")
    name = _string(data.get("name"), "contest name")
    start_at = parse_utc(data.get("start_at"), "start_at")
    end_at = parse_utc(data.get("end_at"), "end_at")
    if end_at <= start_at:
        raise UpdateError("end_at must be later than start_at")
    raw = data.get("competitions")
    if not isinstance(raw, list) or not raw:
        raise UpdateError("competitions must be a non-empty array")
    competitions: list[dict[str, object]] = []
    slugs: set[str] = set()
    for item in raw:
        if not isinstance(item, dict):
            raise UpdateError("competition must be an object")
        slug = _string(item.get("slug"), "competition slug")
        link = _string(item.get("link"), "competition link")
        weight = item.get("weight", 1.0)
        if not SLUG_RE.fullmatch(slug) or slug in slugs:
            raise UpdateError(f"invalid or duplicate competition slug: {slug}")
        if not isinstance(weight, (int, float)) or isinstance(weight, bool) or weight <= 0:
            raise UpdateError(f"invalid competition weight for {slug}")
        if not link.startswith("https://"):
            raise UpdateError(f"competition link must be HTTPS for {slug}")
        slugs.add(slug)
        competitions.append(dict(item, slug=slug, link=link, weight=float(weight)))
    return contest_id, name, start_at, end_at, tuple(competitions)


def validate_roster(data: Mapping[str, object]) -> tuple[dict[str, str], ...]:
    if data.get("schema_version") != SCHEMA_VERSION:
        raise UpdateError(f"roster schema_version must be {SCHEMA_VERSION}")
    raw = data.get("competitors")
    if not isinstance(raw, list) or not raw:
        raise UpdateError("roster competitors must be a non-empty array")
    competitors: list[dict[str, str]] = []
    ids: set[str] = set()
    teams: set[str] = set()
    for item in raw:
        if not isinstance(item, dict):
            raise UpdateError("roster competitor must be an object")
        competitor_id = _string(item.get("id"), "competitor id")
        display = _string(item.get("display_name"), "display_name")
        team = _string(item.get("kaggle_team_name"), "kaggle_team_name")
        normalized = normalize_team_name(team)
        if not ID_RE.fullmatch(competitor_id) or competitor_id in ids:
            raise UpdateError(f"invalid or duplicate competitor id: {competitor_id}")
        if normalized in teams:
            raise UpdateError(f"duplicate Kaggle team name: {team}")
        ids.add(competitor_id)
        teams.add(normalized)
        competitors.append(
            {
                "id": competitor_id,
                "display_name": display,
                "kaggle_team_name": team,
            }
        )
    return tuple(competitors)


def _assign_points(
    results: dict[str, dict[str, dict[str, object]]],
    matched: Sequence[tuple[str, Mapping[str, object]]],
    slug: str,
    registered_count: int,
    weight: float,
) -> None:
    ordered = sorted(matched, key=lambda item: (int(item[1]["rank"]), item[0]))
    groups: list[list[tuple[str, Mapping[str, object]]]] = []
    for item in ordered:
        if not groups:
            groups.append([item])
            continue
        previous = groups[-1][-1][1]
        current = item[1]
        if current["rank"] == previous["rank"] or current["score"] == previous["score"]:
            groups[-1].append(item)
        else:
            groups.append([item])
    slot = 1
    for group in groups:
        size = len(group)
        points = (
            sum(registered_count - (slot + offset) + 1 for offset in range(size))
            / size
            * weight
        )
        for competitor_id, row in group:
            results[competitor_id][slug] = {
                "submitted": True,
                "registered_rank": slot,
                "kaggle_rank": int(row["rank"]),
                "score": float(row["score"]),
                "points": float(points),
            }
        slot += size


def _set_manifest_status(
    repo: Path,
    directory: Path,
    manifest: Mapping[str, object],
    *,
    contest_id: str,
    name: str,
    start_at: datetime,
    end_at: datetime,
    status: str,
) -> tuple[Path, ...]:
    updated = dict(manifest)
    updated["status"] = status
    if status == "final":
        updated["live_leaderboard_url"] = None
    changed: list[Path] = []
    manifest_path = directory / MANIFEST_FILENAME
    if _write_json_if_changed(manifest_path, updated):
        changed.append(manifest_path.relative_to(repo))
    archive = repo / ARCHIVE_INDEX
    if _update_archive(
        archive,
        contest_id=contest_id,
        name=name,
        status=status,
        start_at=start_at,
        end_at=end_at,
    ):
        changed.append(archive.relative_to(repo))
    return tuple(changed)


def _update_archive(
    path: Path,
    *,
    contest_id: str,
    name: str,
    status: str,
    start_at: datetime,
    end_at: datetime,
) -> bool:
    existing = path.read_text(encoding="utf-8")
    start = existing.find(ENTRIES_START)
    end = existing.find(ENTRIES_END)
    if start < 0 or end < start:
        raise UpdateError("archive index is missing contest markers")
    line = (
        f"- [{name.replace('[', r'\[').replace(']', r'\]')}]"
        f"(contests/{contest_id}/) | {status} | "
        f"{format_utc(start_at)} | {format_utc(end_at)}"
    )
    needle = f"(contests/{contest_id}/)"
    inner = existing[start + len(ENTRIES_START) : end]
    entries = [
        item for item in inner.splitlines() if item.strip() and needle not in item
    ]
    entries.append(line)
    entries.sort()
    updated = (
        existing[: start + len(ENTRIES_START)]
        + "\n"
        + "\n".join(entries)
        + "\n"
        + existing[end:]
    )
    return _atomic_write_if_changed(path, updated)


def _load_previous(directory: Path) -> dict[str, object] | None:
    for name in (LIVE_FILENAME, FINAL_FILENAME):
        path = directory / name
        if path.exists():
            try:
                loaded = _load_json(path)
                if loaded.get("schema_version") == SCHEMA_VERSION:
                    return loaded
            except (OSError, json.JSONDecodeError, UpdateError):
                continue
    return None


def _stale_snapshot(
    previous: Mapping[str, object],
    *,
    now: datetime,
    error: str,
    final: bool,
) -> dict[str, object]:
    snapshot = json.loads(json.dumps(previous))
    snapshot["status"] = "final" if final else "live"
    snapshot["generated_at"] = format_utc(now)
    source = snapshot.get("source")
    if not isinstance(source, dict):
        source = {}
    source["fresh"] = False
    source["errors"] = [error]
    source.setdefault("last_success_at", None)
    snapshot["source"] = source
    return snapshot


def _public_competition(competition: Mapping[str, object]) -> dict[str, object]:
    result: dict[str, object] = {
        "slug": competition["slug"],
        "weight": float(competition["weight"]),
    }
    for field in ("name", "metric", "score_direction"):
        if competition.get(field) is not None:
            result[field] = competition[field]
    return result


def _no_submission() -> dict[str, object]:
    return {
        "submitted": False,
        "registered_rank": None,
        "kaggle_rank": None,
        "score": None,
        "points": 0.0,
    }


def _load_json(path: Path) -> dict[str, object]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise UpdateError(f"could not read {path}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise UpdateError(f"invalid JSON in {path}: {exc}") from exc
    if not isinstance(data, dict):
        raise UpdateError(f"{path} must contain a JSON object")
    return data


def _write_json_if_changed(path: Path, payload: object) -> bool:
    text = json.dumps(payload, indent=2, ensure_ascii=False, allow_nan=False) + "\n"
    return _atomic_write_if_changed(path, text)


def _atomic_write_if_changed(path: Path, text: str) -> bool:
    if path.exists() and path.read_text(encoding="utf-8") == text:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(text, encoding="utf-8")
    os.replace(temporary, path)
    return True


def _string(value: object, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise UpdateError(f"{field} must be a non-empty string")
    return value.strip()


def _select_csv(names: Sequence[str]) -> str:
    if len(names) == 1:
        return names[0]
    leaderboard = [name for name in names if "leaderboard" in name.casefold()]
    if len(leaderboard) == 1:
        return leaderboard[0]
    raise UpdateError("expected one Kaggle leaderboard CSV")


def _header_key(value: str) -> str:
    return re.sub(r"[\s_]+", "", value).casefold()


def _first_header(
    indexed: Mapping[str, str], aliases: Sequence[str], label: str
) -> str:
    found = [indexed[name] for name in aliases if name in indexed]
    if len(found) != 1:
        raise UpdateError(f"Kaggle leaderboard {label} column is missing or ambiguous")
    return found[0]


def _redact(value: str) -> str:
    text = re.sub(
        r"(?i)\b(kaggle_key|kaggle_api_token|token|password|secret)"
        r"(\s*[:=]\s*|\s+)(\S+)",
        r"\1\2[redacted]",
        str(value),
    )
    text = re.sub(r"\bKGAT_[A-Za-z0-9._-]+", "KGAT_[redacted]", text)
    return text[:500]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", type=Path, default=Path.cwd())
    parser.add_argument("--kaggle", default="kaggle")
    parser.add_argument("--now", help="test override in YYYY-MM-DDTHH:MM:SSZ")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    now = parse_utc(args.now, "now") if args.now else utc_now()
    results = update_all(
        args.repo,
        now=now,
        fetcher=KaggleFetcher(args.kaggle),
    )
    for result in results:
        message = f"{result.contest_id}: {result.outcome}"
        if result.error:
            message += f": {result.error}"
        print(message, file=sys.stderr if result.error else sys.stdout)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
