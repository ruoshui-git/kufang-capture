import importlib.util
import io
import json
import subprocess
import sys
import zipfile
from pathlib import Path

from test_agent_api import BEARER, CSRF, OWNER, make_client
from test_contract import collection_mutation, entry_mutation, item_mutation

from kufang_capture.auth import user_data_dir
from kufang_capture.db import connect, run_migrations
from kufang_capture.sync import apply_batch

AT = "2026-11-21T12:00:00.000Z"
MOTION = "01KAVC1P9Z4WY6JRQXN3W645T0"


def movement(mid="move-1", entity_id=MOTION, **patch):
    return {
        "id": mid,
        "entity": "movement",
        "entity_id": entity_id,
        "op": "upsert",
        "base_revision": None,
        "fields": {
            "item_id": "e1",
            "from_entry_id": "e1",
            "to_entry_id": "purged-entry",
            "from_collection_id": "c1",
            "to_collection_id": "purged-room",
            "from_sequence": 1,
            "to_sequence": 2,
            "from_name": "Room A",
            "to_name": "Room B",
            "quantity": "2.50",
            "unit": "boxes",
            "count_detail": "two cartons",
            "target_before_quantity": None,
            "kind": "part",
            "moved_at": AT,
            "created_at": AT,
            "updated_at": AT,
            "undone_at": None,
            "source": "app",
            "legacy_text": "",
            **patch,
        },
    }


def push(client, *mutations, schema=3):
    response = client.post("/api/sync/batch", json={"schema": schema, "mutations": mutations}, headers=CSRF)
    assert response.status_code == 200, response.text
    return response.json()


def test_schema_3_movements_schema_2_cursor_and_agent_feed(tmp_path):
    with make_client(tmp_path) as client:
        assert (
            client.post("/api/auth/login", json={"password": "test-password"}, headers=CSRF).status_code
            == 204
        )
        seed = push(client, collection_mutation(), item_mutation(), entry_mutation())
        assert [result["status"] for result in seed["results"]] == ["applied"] * 3
        old_push = push(client, movement(), schema=2)
        assert old_push["results"][0]["status"] == "rejected"
        assert old_push["cursor"] == seed["cursor"]

        missing = push(client, movement("missing", item_id="not-an-item"))
        assert missing["results"][0]["code"] == "missing_parent"

        created = push(client, movement())
        result = created["results"][0]
        assert result["status"] == "applied"
        assert result["record"]["quantity"] == "2.50"
        assert result["record"]["from_collection_id"] == "c1"
        assert result["record"]["to_entry_id"] == "purged-entry"
        assert push(client, movement())["results"][0]["status"] == "duplicate"

        following = push(client, collection_mutation("m-next", "c-next"))
        old = client.get(f"/api/sync/changes?schema=2&cursor={seed['cursor']}&limit=1").json()
        assert old == {"changes": [], "cursor": created["cursor"], "has_more": True}
        old_next = client.get(f"/api/sync/changes?schema=2&cursor={old['cursor']}&limit=1").json()
        assert old_next["cursor"] == following["cursor"]
        assert {record["entity"] for record in old_next["changes"]} == {"collection"}

        for route in ("/api/sync/changes?schema=3&", OWNER + "/changes?"):
            page = client.get(
                route + f"cursor={seed['cursor']}", headers=BEARER if route.startswith(OWNER) else {}
            ).json()
            assert page["changes"][0]["entity"] == "movement"
            assert page["changes"][0]["record"] == result["record"]

        archive = client.get("/api/exports/collections/c1.zip")
        assert archive.status_code == 200
        with zipfile.ZipFile(io.BytesIO(archive.content)) as zf:
            manifest = json.loads(zf.read("capture-export/manifest.json"))
            rows = json.loads(zf.read("capture-export/movements.json"))
        assert manifest["format_version"] == 4
        assert manifest["counts"]["movements"] == 1
        assert rows[0]["movement_id"] == MOTION
        assert rows[0]["quantity"] == "2.50"
        assert rows[0]["to_collection_id"] == "purged-room"

        update = dict(movement("update"), base_revision=1, fields={"undone_at": AT})
        immutable = dict(update, id="immutable", fields={"quantity": "9"})
        assert push(client, immutable)["results"][0]["status"] == "rejected"
        undo = push(client, update)["results"][0]
        assert undo["record"]["undone_at"] == AT
        assert undo["record"]["field_revisions"] == {"undone_at": 2}
        assert (
            push(client, dict(update, id="restore", fields={"undone_at": None}))["results"][0]["status"]
            == "rejected"
        )


def test_removing_room_keeps_movements_and_purging_last_entry_purges_them(tmp_path):
    with make_client(tmp_path) as client:
        assert (
            client.post("/api/auth/login", json={"password": "test-password"}, headers=CSRF).status_code
            == 204
        )
        other_entry = entry_mutation("second-entry", "e2", "c2")
        other_entry["fields"]["item_id"] = "e1"
        assert [
            row["status"]
            for row in push(
                client,
                collection_mutation(),
                collection_mutation("m-c2", "c2", "Room B"),
                item_mutation(),
                entry_mutation(),
                other_entry,
                movement(to_collection_id="c2", to_entry_id="e2"),
            )["results"]
        ] == ["applied"] * 6
        assert (
            client.delete(
                "/api/collections/c1/server-copy", headers={**CSRF, "X-Confirm-Name": "Room%20A"}
            ).status_code
            == 204
        )
        stored = client.get("/api/sync/changes?schema=3").json()
        assert any(row.get("record", {}).get("id") == MOTION for row in stored["changes"])
        deletion = dict(other_entry, id="delete-last", op="delete", fields={}, base_revision=1)
        purging = dict(deletion, id="purge-last", op="purge", base_revision=2)
        reply = push(client, deletion, purging)
        assert [result["status"] for result in reply["results"]] == ["applied", "applied"]
        latest = client.get(f"/api/sync/changes?schema=3&cursor={stored['cursor']}").json()
        assert any(row["entity"] == "movement" and row.get("purged") for row in latest["changes"])


def load_backfill():
    path = Path(__file__).parents[2] / "tools" / "backfill_movements.py"
    spec = importlib.util.spec_from_file_location("backfill_movements", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def placement(room, entry, item, sequence, notes, deleted_at=None):
    mutation = entry_mutation(f"make-{entry}", entry, room, sequence)
    mutation["fields"].update(item_id=item, entry_notes=notes, deleted_at=deleted_at, updated_at=AT)
    return mutation


def test_backfill_read_only_exact_pairs_copies_mixed_stale_idempotent_and_undo(tmp_path):
    backfill = load_backfill()
    owner = tmp_path / "db"
    helper = user_data_dir(owner, MOTION)
    run_migrations(owner)
    run_migrations(helper)
    mutations = [collection_mutation(f"make-{room}", room, room) for room in "ABCD"]
    originals = {
        "a": 'Moved to "B" #0002\r\n \r\n',
        "b": 'Moved from "Old A" #0001: 5 boxes\r\nMoved to "C" #0003',
        "c": 'Already here: 2 boxes\nMoved from "B" #0002: 5 boxes\nMoved from "Old A" #0001: 5 boxes\n',
        "d": 'Moved from "C" #0003: 1 boxes',
        "m1": 'Keep this text.\nMoved to "B" #0012\n',
        "m2": 'Moved from "A" #0011: 1 bag',
        "p1": 'Moved 2.50 kg to "D" #0022',
        "p2": 'Moved from "C" #0021: 2.50 kg',
        "s1": 'Moved to "B" #0032',
        "s2": 'Moved from "A" #0031: 3',
    }
    for item, rooms, identifiers, start in (
        ("shared", "ABCD", "abcd", 1),
        ("mixed", "AB", ("m1", "m2"), 11),
        ("partial", "CD", ("p1", "p2"), 21),
        ("stale", "AB", ("s1", "s2"), 31),
    ):
        mutations += [item_mutation(item, rooms[0])]
        for sequence, (room, entry) in enumerate(zip(rooms, identifiers, strict=True), start=start):
            mutations.append(
                placement(room, entry, item, sequence, originals[entry], AT if entry in "ab" else None)
            )
    results, initial_cursor = apply_batch(helper, mutations, lambda: None)
    assert all(row["status"] == "applied" for row in results)
    plan = backfill.make_plan(helper)
    assert plan == backfill.make_plan(helper)
    assert plan["counts"] == {
        "entries_with_lines": 10,
        "from_lines": 7,
        "resolvable_from": 7,
        "exact_pairs": 4,
        "duplicates": 1,
        "mixed": 1,
        "unclear": 2,
    }
    assert backfill.make_plan(owner)["groups"] == []
    with connect(helper) as db:
        assert db.execute("SELECT MAX(seq) FROM changes").fetchone()[0] == initial_cursor
        assert db.execute("SELECT COUNT(*) FROM movements").fetchone()[0] == 0

    stale = dict(placement("A", "s1", "stale", 31, "changed"), id="edit-stale", base_revision=1)
    stale["fields"] = {"entry_notes": "changed"}
    apply_batch(helper, [stale], lambda: None)
    script = Path(backfill.__file__)
    plan_file = tmp_path / "reviewed.json"
    backfill.write_json(plan_file, plan)
    args = [sys.executable, str(script), "--data-dir", str(helper)]
    applied = subprocess.run([*args, "--apply", str(plan_file)], capture_output=True, text=True, check=True)
    report = json.loads(applied.stdout)
    undo_file = Path(report["undo_file"])
    assert undo_file == tmp_path / "reviewed.undo.json"
    assert json.loads(undo_file.read_text()) == plan
    assert report["entries_written"] == 5
    assert report["movements_written"] == 3
    assert report["skipped"] == [{"entries": ["s1", "s2"], "reason": "entry s1 changed"}]
    with connect(helper) as db:
        notes = dict(db.execute("SELECT id,entry_notes FROM entries"))
        assert notes == {**originals, "a": " \r\n", "b": "", "c": "", "p1": "", "p2": "", "s1": "changed"}
        history = {row["from_entry_id"]: row for row in db.execute("SELECT * FROM movements")}
        assert history["a"]["legacy_text"] == 'Moved to "B" #0002\nMoved from "Old A" #0001: 5 boxes'
        assert history["b"]["target_before_quantity"] == "2"
        assert history["p1"]["quantity"] == "2.50"
        assert history["p1"]["moved_at"] == AT
        assert history["p1"]["kind"] == "part"
        assert history["b"]["source"] == "text"
        assert history["b"]["revision"] == 1
        applied_cursor = db.execute("SELECT MAX(seq) FROM changes").fetchone()[0]
    again = backfill.run_plan(helper, plan)
    assert again["entries_written"] == again["movements_written"] == 0
    assert again["already_applied"] == 5
    with connect(helper) as db:
        assert db.execute("SELECT MAX(seq) FROM changes").fetchone()[0] == applied_cursor

    restored = subprocess.run([*args, "--undo", str(undo_file)], capture_output=True, text=True, check=True)
    undo = json.loads(restored.stdout)
    assert undo["entries_written"] == 5
    assert undo["movements_written"] == 3
    with connect(helper) as db:
        assert dict(db.execute("SELECT id,entry_notes FROM entries")) == {**originals, "s1": "changed"}
        assert db.execute("SELECT COUNT(*) FROM movements WHERE undone_at IS NOT NULL").fetchone()[0] == 3
    assert backfill.run_plan(helper, plan, undo=True)["already_applied"] == 5
