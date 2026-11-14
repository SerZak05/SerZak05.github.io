from __future__ import annotations

import json
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.update_long_contests import UpdateError, update_all


NOW = datetime(2030, 1, 10, 12, 0, tzinfo=timezone.utc)


class UpdaterTests(unittest.TestCase):
    def test_overlapping_contests_update_and_finalize_independently(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            repo = make_repo(Path(temporary))
            add_contest(repo, "ended", "source-ended", "2030-01-10T11:00:00Z")
            add_contest(repo, "active", "source-active", "2030-01-10T13:00:00Z")

            results = update_all(repo, now=NOW, fetcher=fetch)

            self.assertEqual(
                [(item.contest_id, item.outcome) for item in results],
                [("active", "updated"), ("ended", "finalized")],
            )
            self.assertTrue(
                (repo / "30kaggle/contests/active/leaderboard-live.json").exists()
            )
            self.assertTrue(
                (repo / "30kaggle/contests/ended/leaderboard-final.json").exists()
            )

    def test_one_failure_keeps_other_contests_fresh(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            repo = make_repo(Path(temporary))
            add_contest(repo, "alpha", "source-alpha")
            add_contest(repo, "beta", "source-beta")
            update_all(repo, now=NOW, fetcher=fetch)

            def fail_alpha(competition):
                if competition["slug"] == "source-alpha":
                    raise UpdateError("temporary outage")
                return fetch(competition)

            later = datetime(2030, 1, 10, 12, 15, tzinfo=timezone.utc)
            results = update_all(repo, now=later, fetcher=fail_alpha)

            self.assertIn("temporary outage", results[0].error)
            alpha = load(repo / "30kaggle/contests/alpha/leaderboard-live.json")
            beta = load(repo / "30kaggle/contests/beta/leaderboard-live.json")
            self.assertFalse(alpha["source"]["fresh"])
            self.assertTrue(beta["source"]["fresh"])


def make_repo(root: Path) -> Path:
    archive = root / "30kaggle/index.md"
    archive.parent.mkdir(parents=True)
    archive.write_text(
        "# Archive\n\n<!-- contests:start -->\n<!-- contests:end -->\n",
        encoding="utf-8",
    )
    return root


def add_contest(
    repo: Path,
    slug: str,
    source_slug: str,
    end: str = "2030-01-11T10:00:00Z",
) -> None:
    directory = repo / "30kaggle/contests" / slug
    directory.mkdir(parents=True)
    dump(
        directory / "contest.json",
        {
            "schema_version": 1,
            "contest_id": slug,
            "name": slug.title(),
            "start_at": "2030-01-10T10:00:00Z",
            "end_at": end,
            "competitions": [
                {
                    "slug": source_slug,
                    "weight": 1.0,
                    "link": f"https://www.kaggle.com/competitions/{source_slug}",
                }
            ],
        },
    )
    dump(
        directory / "roster.json",
        {
            "schema_version": 1,
            "competitors": [
                {
                    "id": "ada",
                    "display_name": "Ada",
                    "kaggle_team_name": "Analytical Engines",
                }
            ],
        },
    )
    dump(
        directory / "manifest.json",
        {
            "schema_version": 1,
            "contest_id": slug,
            "name": slug.title(),
            "status": "scheduled",
            "start_at": "2030-01-10T10:00:00Z",
            "end_at": end,
            "live_leaderboard_url": (
                f"https://example.test/30kaggle/contests/{slug}/"
                "leaderboard-live.json"
            ),
            "final_leaderboard_url": "leaderboard-final.json",
        },
    )


def fetch(_competition):
    return ({"team_name": "Analytical Engines", "rank": 1, "score": 0.9},)


def dump(path: Path, value: object) -> None:
    path.write_text(json.dumps(value), encoding="utf-8")


def load(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
