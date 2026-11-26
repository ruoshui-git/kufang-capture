#!/usr/bin/env python3
"""Convert verified pairs of legacy move notes in one account's capture.sqlite3.

Run with the backend virtualenv, e.g. backend/.venv/bin/python tools/backfill_movements.py
--data-dir /path/to/account --plan movements-plan.json. Review the plan before applying it.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
from collections import Counter, defaultdict
from contextlib import closing
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Any

from kufang_capture.sync import QUANTITY_RE, apply_batch, now

FROM = re.compile(r'^Moved from "(?P<room>.+)" #(?P<seq>[0-9]+)(?:: (?P<count>.+))?$')
TO = re.compile(
    r"^Moved(?: (?P<quantity>-?[0-9]+(?:\.[0-9]+)?)(?: (?P<unit>.+?))?)?"
    r' to "(?P<room>.+)" #(?P<seq>[0-9]+)$'
)
ALREADY = re.compile(r"^Already here: (?P<count>.+)$")
COUNT = re.compile(r"^(?P<quantity>-?[0-9]+(?:\.[0-9]+)?)(?: (?P<unit>.+))?$")
ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
PLAN_VERSION = 1


def stable_id(at: str, *values: str) -> str:
    milliseconds = int(datetime.fromisoformat(at).timestamp() * 1_000)
    payload = json.dumps(values, ensure_ascii=False, separators=(",", ":")).encode()
    entropy = int.from_bytes(hashlib.sha256(payload).digest()[:10], "big")
    value = (milliseconds << 80) | entropy
    return "".join(ULID_ALPHABET[(value >> shift) & 31] for shift in range(125, -1, -5))


@dataclass(eq=False)
class Line:
    entry_id: str
    index: int
    text: str
    kind: str
    match: re.Match[str]
    other: str | None = None


@dataclass
class Hop:
    source: Line
    target: Line
    record: dict[str, Any]
    removed: list[Line] = field(default_factory=list)


def physical_lines(text: str) -> list[str]:
    # Keep each original terminator, including CRLF and whitespace-only lines.
    return re.findall(r"[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$", text)


def count_parts(text: str, entry: dict) -> tuple[str | None, str, str]:
    if not text:
        return None, "", ""
    primary, sep, detail = text.partition("; ")
    if match := COUNT.fullmatch(primary):
        return match["quantity"], match["unit"] or "", detail
    if text == entry["count_detail"].strip():
        return None, "", text
    if primary == entry["unit"].strip() or sep:
        return None, primary, detail
    # A count with neither digits nor a known unit may be free-form count detail.
    return None, "", text


def account_db(data_dir: Path) -> sqlite3.Connection:
    # Read-only mode also detects an incorrect user directory without creating a database.
    db = sqlite3.connect((data_dir / "capture.sqlite3").resolve().as_uri() + "?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    return db


def make_plan(data_dir: Path) -> dict:
    with closing(account_db(data_dir)) as db:
        entries = {
            row["id"]: dict(row)
            for row in db.execute(
                "SELECT e.*,c.name AS room FROM entries e "
                "JOIN collections c ON c.id=e.collection_id ORDER BY e.id"
            )
        }
    references: dict[tuple[str, int], list[dict]] = defaultdict(list)
    for row in entries.values():
        references[(row["item_id"], row["sequence_number"])].append(row)
    lines: list[Line] = []
    by_location: dict[tuple[str, int], Line] = {}
    mixed: set[str] = set()
    for row in entries.values():
        found, other_text = [], False
        for index, piece in enumerate(physical_lines(row["entry_notes"])):
            text = piece.rstrip("\r\n")
            if not text.strip():
                continue
            for kind, pattern in (("from", FROM), ("to", TO), ("already", ALREADY)):
                if match := pattern.fullmatch(text):
                    line = Line(row["id"], index, text, kind, match)
                    if kind != "already":
                        candidates = references[(row["item_id"], int(match["seq"]))]
                        named = [candidate for candidate in candidates if candidate["room"] == match["room"]]
                        possible = named or candidates
                        if len(possible) == 1 and (possible[0]["collection_id"] != row["collection_id"]):
                            line.other = possible[0]["id"]
                    found.append(line)
                    by_location[(row["id"], index)] = line
                    break
            else:
                other_text = True
        if found and other_text:
            mixed.add(row["id"])
        lines.extend(found)

    outgoing: dict[tuple[str, str], list[Line]] = defaultdict(list)
    incoming = [line for line in lines if line.kind == "from"]
    for line in lines:
        if line.kind == "to" and line.other and line.entry_id not in mixed:
            outgoing[(line.entry_id, line.other)].append(line)
    candidates: dict[Line, list[Line]] = defaultdict(list)
    reverse: Counter[Line] = Counter()
    for arrival in incoming:
        if not arrival.other or arrival.entry_id in mixed:
            continue
        source_row = entries[arrival.other]
        quantity, unit, detail = count_parts(arrival.match["count"] or "", source_row)
        if len(unit) > 40 or (
            quantity is not None and (not QUANTITY_RE.fullmatch(quantity) or len(quantity) > 30)
        ):
            continue
        for departure in outgoing[(arrival.other, arrival.entry_id)]:
            partial = departure.match["quantity"] is not None
            if partial and (
                quantity is None
                or quantity.startswith("-")
                or not re.search(r"[1-9]", quantity)
                or (quantity, unit, detail)
                != (departure.match["quantity"], departure.match["unit"] or "", "")
            ):
                continue
            candidates[arrival].append(departure)
            reverse[departure] += 1

    hops: list[Hop] = []
    used: set[Line] = set()
    legs: dict[str, set[str]] = defaultdict(set)
    for arrival, departures in candidates.items():
        if len(departures) != 1 or reverse[departures[0]] != 1:
            continue
        departure = departures[0]
        source, target = entries[departure.entry_id], entries[arrival.entry_id]
        quantity, unit, detail = count_parts(arrival.match["count"] or "", source)
        partial = departure.match["quantity"] is not None
        at = target["updated_at"] if partial else source["deleted_at"] or target["updated_at"]
        movement_id = stable_id(
            at, "legacy-movement", source["id"], target["id"], departure.text, arrival.text
        )
        prior = by_location.get((arrival.entry_id, arrival.index - 1))
        # The old app inserted this marker immediately before the first incoming count.
        before = None
        if prior and prior.kind == "already" and arrival.match["count"]:
            before, _, _ = count_parts(prior.match["count"], target)
            if before and len(before) > 30:
                before = None
        record = {
            "id": movement_id,
            "item_id": source["item_id"],
            "from_entry_id": source["id"],
            "to_entry_id": target["id"],
            "from_collection_id": source["collection_id"],
            "to_collection_id": target["collection_id"],
            "from_sequence": source["sequence_number"],
            "to_sequence": target["sequence_number"],
            "from_name": arrival.match["room"],
            "to_name": departure.match["room"],
            "quantity": quantity,
            "unit": unit,
            "count_detail": detail,
            "target_before_quantity": before,
            "kind": "part" if partial else "move",
            "moved_at": at,
            "undone_at": None,
            "source": "text",
            "legacy_text": departure.text + "\n" + arrival.text,
            "created_at": at,
            "updated_at": at,
        }
        hop = Hop(departure, arrival, record, [departure, arrival])
        if prior and prior.kind == "already" and arrival.match["count"]:
            hop.removed.append(prior)
        hops.append(hop)
        used.update(hop.removed)
        legs[source["id"]].add(target["id"])

    def descendants(origin: str, exclude: str | None = None) -> set[str]:
        seen = {origin}
        queue = [origin]
        while queue:
            parent = queue.pop()
            children = legs[parent] - seen
            if parent == origin and exclude is not None:
                children.discard(exclude)
            seen.update(children)
            queue.extend(children)
        return seen - {origin}

    # A copied line must have one proven origin and a proven chain carrying it to this entry.
    # Keep candidates for genuine but ambiguous pairs (even if they look like a copy).
    originals: dict[str, list[tuple[Hop, Line, set[str]]]] = defaultdict(list)
    for hop in hops:
        for line in hop.removed:
            # A departure line was appended after that hop had already copied the notes.
            exclude = line.other if line.kind == "to" else None
            originals[line.text].append((hop, line, descendants(line.entry_id, exclude)))
    duplicates = []
    for line in lines:
        if line in used or line.entry_id in mixed or candidates.get(line) or reverse[line]:
            continue
        matches = [
            hop
            for hop, original, copied_to in originals[line.text]
            if original.other == line.other and line.entry_id in copied_to
        ]
        if len(matches) == 1:
            matches[0].removed.append(line)
            duplicates.append(line)
            used.add(line)

    # Each connected set of entries and movement line edits is committed atomically.
    linked: dict[str, set[int]] = defaultdict(set)
    for index, hop in enumerate(hops):
        for line in hop.removed:
            linked[line.entry_id].add(index)
    groups = []
    remaining = set(range(len(hops)))
    while remaining:
        group = {min(remaining)}
        queue = list(group)
        while queue:
            for line in hops[queue.pop()].removed:
                related = linked[line.entry_id] - group
                group.update(related)
                queue.extend(related)
        remaining -= group
        selected = [hops[index] for index in sorted(group)]
        removals: dict[str, set[int]] = defaultdict(set)
        for hop in selected:
            for deletion in hop.removed:
                removals[deletion.entry_id].add(deletion.index)
        edits = []
        for entry_id, indexes in sorted(removals.items()):
            row = entries[entry_id]
            original = row["entry_notes"]
            edits.append(
                {
                    "id": entry_id,
                    "collection_id": row["collection_id"],
                    "revision": row["revision"],
                    "original_entry_notes": original,
                    "entry_notes": "".join(
                        piece for i, piece in enumerate(physical_lines(original)) if i not in indexes
                    ),
                }
            )
        groups.append({"entries": edits, "movements": [hop.record for hop in selected]})

    unclear = [line for line in lines if line not in used and line.entry_id not in mixed]
    return {
        "version": PLAN_VERSION,
        "data_dir": str(data_dir.resolve()),
        "counts": {
            "entries_with_lines": len({line.entry_id for line in lines}),
            "from_lines": len(incoming),
            "resolvable_from": sum(line.other is not None for line in incoming),
            "exact_pairs": len(hops),
            "duplicates": len(duplicates),
            "mixed": len(mixed),
            "unclear": len(unclear),
        },
        "mixed_entry_ids": sorted(mixed),
        "unclear": [
            {"entry_id": line.entry_id, "line_number": line.index + 1, "text": line.text} for line in unclear
        ],
        "groups": groups,
    }


def mutate(entity: str, record_id: str, at: str, label: str, fields: dict, revision=None, collection_id=""):
    return {
        "id": stable_id(at, label, entity, record_id, str(revision)),
        "entity": entity,
        "entity_id": record_id,
        "collection_id": collection_id,
        "base_revision": revision,
        "op": "upsert",
        "fields": fields,
    }


def run_plan(data_dir: Path, plan: dict, undo: bool = False) -> dict:
    if plan.get("version") != PLAN_VERSION or data_dir.resolve() != Path(plan["data_dir"]):
        raise ValueError("Plan version or account data directory does not match")
    report = {"entries_written": 0, "movements_written": 0, "already_applied": 0, "skipped": []}
    for group in plan["groups"]:
        rows = group["entries"]
        motions = group["movements"]
        at = min(row["moved_at"] for row in motions)
        expected: dict[str, dict[str, int]] = {"entry": {}, "movement": {}}
        mutations = []
        with closing(account_db(data_dir)) as db:
            recorded = {
                row["id"]: db.execute("SELECT * FROM movements WHERE id=?", (row["id"],)).fetchone()
                for row in motions
            }
        if all(recorded.values()) and (
            not undo or all(row["undone_at"] is not None for row in recorded.values())
        ):
            report["already_applied"] += len(rows)
            continue
        if (undo and not all(recorded.values())) or (not undo and any(recorded.values())):
            report["skipped"].append(
                {"entries": [row["id"] for row in rows], "reason": "movement set differs"}
            )
            continue
        for row in rows:
            revision = row["revision"] + int(undo)
            expected["entry"][row["id"]] = revision
            note = row["original_entry_notes"] if undo else row["entry_notes"]
            mutations.append(
                mutate(
                    "entry",
                    row["id"],
                    at,
                    "restore-notes" if undo else "replace-notes",
                    {"entry_notes": note},
                    revision,
                    row["collection_id"],
                )
            )
        for movement in motions:
            movement_id = movement["id"]
            revision = recorded[movement_id]["revision"] if undo else None
            if undo:
                expected["movement"][movement_id] = revision
            mutations.append(
                mutate(
                    "movement",
                    movement_id,
                    at,
                    "undo-backfill" if undo else "backfill",
                    {"undone_at": now()} if undo else movement,
                    revision,
                )
            )
        try:
            apply_batch(data_dir, mutations, lambda: None, expected_revisions=expected)
        except ValueError as exc:
            report["skipped"].append({"entries": [row["id"] for row in rows], "reason": str(exc)})
            continue
        report["entries_written"] += len(rows)
        report["movements_written"] += len(motions)
    return report


def write_json(path: Path, value: dict) -> None:
    with NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as output:
        tmp = Path(output.name)
        try:
            json.dump(value, output, ensure_ascii=False, indent=2)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        except BaseException:
            tmp.unlink(missing_ok=True)
            raise
    try:
        tmp.replace(path)
    finally:
        tmp.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", required=True, type=Path, help="The specific user's database directory")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--plan", type=Path, metavar="OUT.json", help="Write a read-only plan (default)")
    mode.add_argument("--apply", type=Path, metavar="PLAN.json")
    mode.add_argument("--undo", type=Path, metavar="UNDO.json")
    args = parser.parse_args()
    try:
        if args.apply or args.undo:
            plan = json.loads((args.apply or args.undo).read_text(encoding="utf-8"))
            if args.apply:
                if plan.get("version") != PLAN_VERSION or args.data_dir.resolve() != Path(plan["data_dir"]):
                    raise ValueError("Plan version or account data directory does not match")
                undo_path = args.apply.with_suffix(".undo.json")
                if undo_path.exists() and json.loads(undo_path.read_text(encoding="utf-8")) != plan:
                    raise ValueError(f"Undo file {undo_path} already belongs to a different plan")
                write_json(undo_path, plan)
            result = run_plan(args.data_dir, plan, undo=bool(args.undo))
            if args.apply:
                result["undo_file"] = str(undo_path)
        else:
            plan = make_plan(args.data_dir)
            write_json(args.plan or Path("movements-plan.json"), plan)
            result = plan["counts"]
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except (KeyError, ValueError, sqlite3.Error, OSError) as exc:
        parser.exit(1, f"{exc}\n")


if __name__ == "__main__":
    main()
