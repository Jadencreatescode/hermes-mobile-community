"""Focused tests for the canonical schema v2 public meeting store."""

import importlib.util
import json
import sqlite3
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
DASHBOARD = ROOT / "plugins" / "operations" / "dashboard"


def load_meeting_store():
    module_path = DASHBOARD / "meeting_store.py"
    spec = importlib.util.spec_from_file_location("operations_meeting_store_v2_test", module_path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


LOCAL = "local"


def route(profile: str, connection: str = LOCAL) -> dict:
    return {"connection": connection, "profile": profile}


ORCHESTRATOR = route("orchestrator")
PRODUCER = route("producer")
REVIEWER = route("reviewer")
EXTRA = route("analyst")


def conclusion_record(**overrides) -> dict:
    record = {
        "id": "meeting_release_1",
        "source": route("default"),
        "title": "Release readiness",
        "agenda": "Review evidence and decide whether to release.",
        "chair": ORCHESTRATOR,
        "participants": [ORCHESTRATOR, PRODUCER],
        "state": "draft",
        "max_rounds": 3,
        "current_round": 0,
        "contributions": [],
        "evidence": [],
        "decisions": [],
        "dissent": [],
        "action_items": [],
    }
    record.update(overrides)
    return record


def production_record(**overrides) -> dict:
    participants = [ORCHESTRATOR, PRODUCER, REVIEWER]
    record = conclusion_record(
        id="meeting_production_1",
        title="Ship the onboarding document",
        participants=participants,
        chair=ORCHESTRATOR,
        orchestrator=ORCHESTRATOR,
        producer=PRODUCER,
        seats=[
            {"bot": ORCHESTRATOR, "role": "specialist", "label": "Orchestrator"},
            {"bot": PRODUCER, "role": "contributor", "label": "Producer"},
            {"bot": REVIEWER, "role": "reviewer", "label": "Reviewer"},
        ],
        product_kind="document",
        output_title="Onboarding guide",
        acceptance_statement="A reviewer confirms every onboarding step is reproducible.",
        production_stage="briefing",
    )
    record.update(overrides)
    return record


# ---------------------------------------------------------------------------
# canonical schema v2
# ---------------------------------------------------------------------------


def test_new_records_are_canonical_snake_case_schema_version_2(tmp_path):
    api = load_meeting_store()
    store = api.MeetingStore(tmp_path / "meetings.db")

    saved = store.put(conclusion_record(), expected_version=0)

    assert saved["meeting"]["schema_version"] == 2
    assert saved["version"] == 1
    serialized = json.dumps(saved["meeting"])
    for camel in ("evidenceRefs", "ownerRoute", "acceptanceCriteria", "dueIntent", "dedupeKey", "maxRounds"):
        assert camel not in serialized


def test_camel_case_input_is_normalized_into_canonical_keys(tmp_path):
    api = load_meeting_store()
    store = api.MeetingStore(tmp_path / "meetings.db")
    completed = conclusion_record(
        state="completed",
        current_round=2,
        contributions=[{
            "id": "c1",
            "round": 1,
            "participant": ORCHESTRATOR,
            "kind": "speak",
            "text": "Ready.",
            "evidenceRefs": ["note://one"],
        }, {
            "id": "c2",
            "round": 1,
            "participant": PRODUCER,
            "kind": "pass",
            "text": "",
        }],
        decisions=[{"id": "d1", "text": "Release.", "evidenceRefs": []}],
        action_items=[{
            "id": "publish",
            "ownerRoute": PRODUCER,
            "title": "Publish the release",
            "acceptanceCriteria": "Tagged and announced.",
            "priority": "high",
            "dueIntent": "This week",
            "dedupeKey": "meeting:meeting_release_1:action:publish",
        }],
    )

    saved = store.put(completed, expected_version=0)["meeting"]

    assert saved["contributions"][0]["evidence_refs"] == ["note://one"]
    assert saved["action_items"][0]["owner_route"] == PRODUCER
    assert saved["action_items"][0]["acceptance_criteria"] == "Tagged and announced."
    assert saved["action_items"][0]["due_intent"] == "This week"
    assert saved["action_items"][0]["dedupe_key"] == "meeting:meeting_release_1:action:publish"


def test_ordinary_conclusion_meeting_keeps_the_existing_path(tmp_path):
    api = load_meeting_store()
    store = api.MeetingStore(tmp_path / "meetings.db")

    draft = store.put(conclusion_record(), expected_version=0)
    running = store.put(
        conclusion_record(
            state="running",
            current_round=1,
            contributions=[{
                "id": "c1", "round": 1, "participant": ORCHESTRATOR,
                "kind": "speak", "text": "Evidence looks good.", "evidence_refs": [],
            }],
        ),
        expected_version=draft["version"],
    )
    completed = store.put(
        conclusion_record(
            state="completed",
            current_round=2,
            contributions=[
                {"id": "c1", "round": 1, "participant": ORCHESTRATOR, "kind": "speak",
                 "text": "Evidence looks good.", "evidence_refs": []},
                {"id": "c2", "round": 1, "participant": PRODUCER, "kind": "pass", "text": ""},
            ],
            decisions=[{"id": "d1", "text": "Release on Friday.", "evidence_refs": []}],
        ),
        expected_version=running["version"],
    )

    assert completed["meeting"]["state"] == "completed"
    assert "production_stage" not in completed["meeting"]
    assert "artifact_binding" not in completed["meeting"]


# ---------------------------------------------------------------------------
# production bundle invariants
# ---------------------------------------------------------------------------


def test_complete_production_bundle_is_accepted_and_starts_at_briefing(tmp_path):
    api = load_meeting_store()
    store = api.MeetingStore(tmp_path / "meetings.db")

    saved = store.put(production_record(), expected_version=0)["meeting"]

    assert saved["production_stage"] == "briefing"
    assert saved["product_kind"] == "document"
    assert saved["output_title"] == "Onboarding guide"
    assert saved["seats"][2]["role"] == "reviewer"
    assert "artifact_binding" not in saved


def test_production_stage_defaults_to_briefing_when_absent(tmp_path):
    api = load_meeting_store()
    store = api.MeetingStore(tmp_path / "meetings.db")
    record = production_record()
    record.pop("production_stage")

    assert store.put(record, expected_version=0)["meeting"]["production_stage"] == "briefing"


@pytest.mark.parametrize("missing", [
    "orchestrator", "producer", "seats", "product_kind", "output_title", "acceptance_statement",
])
def test_partial_production_bundles_are_rejected(tmp_path, missing):
    api = load_meeting_store()
    store = api.MeetingStore(tmp_path / f"{missing}.db")
    record = production_record()
    record.pop(missing)

    with pytest.raises(ValueError, match="production"):
        store.put(record, expected_version=0)


def test_identical_orchestrator_and_producer_are_rejected(tmp_path):
    api = load_meeting_store()
    store = api.MeetingStore(tmp_path / "meetings.db")

    with pytest.raises(ValueError, match="distinct"):
        store.put(production_record(producer=ORCHESTRATOR), expected_version=0)


def test_reviewer_matching_orchestrator_or_producer_is_rejected(tmp_path):
    api = load_meeting_store()
    store = api.MeetingStore(tmp_path / "meetings.db")

    for impostor in (ORCHESTRATOR, PRODUCER):
        seats = [
            {"bot": ORCHESTRATOR, "role": "reviewer" if impostor == ORCHESTRATOR else "specialist", "label": "O"},
            {"bot": PRODUCER, "role": "reviewer" if impostor == PRODUCER else "contributor", "label": "P"},
            {"bot": REVIEWER, "role": "contributor", "label": "R"},
        ]
        with pytest.raises(ValueError, match="reviewer"):
            store.put(production_record(seats=seats), expected_version=0)


def test_missing_reviewer_seat_is_rejected(tmp_path):
    api = load_meeting_store()
    store = api.MeetingStore(tmp_path / "meetings.db")
    seats = [
        {"bot": ORCHESTRATOR, "role": "specialist", "label": "O"},
        {"bot": PRODUCER, "role": "contributor", "label": "P"},
        {"bot": REVIEWER, "role": "thinker", "label": "R"},
    ]

    with pytest.raises(ValueError, match="reviewer"):
        store.put(production_record(seats=seats), expected_version=0)


def test_seats_must_be_an_ordered_bijection_of_participants(tmp_path):
    api = load_meeting_store()
    store = api.MeetingStore(tmp_path / "meetings.db")

    duplicate = [
        {"bot": ORCHESTRATOR, "role": "specialist", "label": "O"},
        {"bot": ORCHESTRATOR, "role": "contributor", "label": "O again"},
        {"bot": REVIEWER, "role": "reviewer", "label": "R"},
    ]
    with pytest.raises(ValueError, match="seat"):
        store.put(production_record(seats=duplicate), expected_version=0)

    short = [
        {"bot": ORCHESTRATOR, "role": "specialist", "label": "O"},
        {"bot": REVIEWER, "role": "reviewer", "label": "R"},
    ]
    with pytest.raises(ValueError, match="seat"):
        store.put(production_record(seats=short), expected_version=0)

    stranger = [
        {"bot": ORCHESTRATOR, "role": "specialist", "label": "O"},
        {"bot": PRODUCER, "role": "contributor", "label": "P"},
        {"bot": EXTRA, "role": "reviewer", "label": "Stranger"},
    ]
    with pytest.raises(ValueError, match="seat|participant"):
        store.put(production_record(seats=stranger), expected_version=0)


def test_production_requires_three_participants(tmp_path):
    api = load_meeting_store()
    store = api.MeetingStore(tmp_path / "meetings.db")
    record = production_record(
        participants=[ORCHESTRATOR, PRODUCER],
        seats=[
            {"bot": ORCHESTRATOR, "role": "specialist", "label": "O"},
            {"bot": PRODUCER, "role": "reviewer", "label": "P"},
        ],
    )

    with pytest.raises(ValueError, match="reviewer|three"):
        store.put(record, expected_version=0)


def test_product_kind_is_bounded(tmp_path):
    api = load_meeting_store()
    store = api.MeetingStore(tmp_path / "meetings.db")

    with pytest.raises(ValueError, match="product_kind"):
        store.put(production_record(product_kind="nuclear_reactor"), expected_version=0)


def test_non_participant_production_role_is_rejected(tmp_path):
    api = load_meeting_store()
    store = api.MeetingStore(tmp_path / "meetings.db")

    with pytest.raises(ValueError, match="participant"):
        store.put(production_record(orchestrator=route("stranger")), expected_version=0)


@pytest.mark.parametrize("field,value", [
    ("orchestrator", ORCHESTRATOR),
    ("producer", PRODUCER),
    ("seats", [{"bot": ORCHESTRATOR, "role": "reviewer", "label": "O"}]),
    ("product_kind", "document"),
    ("output_title", "Guide"),
    ("acceptance_statement", "Reviewed."),
    ("production_stage", "briefing"),
    ("artifact_binding", {
        "output_id": "out_1", "artifact_version": 1,
        "game_sha256": "a" * 64, "manifest_sha256": "b" * 64, "zip_sha256": "c" * 64,
        "approved_by": "Owner", "approved_at": 1_800_000_000,
    }),
])
def test_conclusion_meetings_reject_every_production_field(tmp_path, field, value):
    api = load_meeting_store()
    store = api.MeetingStore(tmp_path / f"{field}.db")

    # artifact_binding is refused as a server-owned authority failure; the rest
    # are refused as incomplete production bundles on a conclusion meeting.
    with pytest.raises(ValueError, match="production|server owned"):
        store.put(conclusion_record(**{field: value}), expected_version=0)


# ---------------------------------------------------------------------------
# server-owned fields
# ---------------------------------------------------------------------------


def test_client_put_may_echo_but_never_change_the_server_owned_stage(tmp_path):
    api = load_meeting_store()
    store = api.MeetingStore(tmp_path / "meetings.db")
    created = store.put(production_record(), expected_version=0)

    echoed = store.put(
        production_record(state="running", current_round=1, contributions=[{
            "id": "c1", "round": 1, "participant": ORCHESTRATOR,
            "kind": "speak", "text": "Brief frozen.", "evidence_refs": [],
        }]),
        expected_version=created["version"],
    )
    assert echoed["meeting"]["production_stage"] == "briefing"

    with pytest.raises(api.ServerOwnedField, match="production_stage"):
        store.put(
            production_record(state="running", current_round=1, production_stage="producing",
                              contributions=[{
                                  "id": "c1", "round": 1, "participant": ORCHESTRATOR,
                                  "kind": "speak", "text": "Brief frozen.", "evidence_refs": [],
                              }]),
            expected_version=echoed["version"],
        )


def test_client_put_cannot_fabricate_an_artifact_binding(tmp_path):
    api = load_meeting_store()
    store = api.MeetingStore(tmp_path / "meetings.db")
    created = store.put(production_record(), expected_version=0)

    binding = {
        "output_id": "out_1", "artifact_version": 1,
        "game_sha256": "a" * 64, "manifest_sha256": "b" * 64, "zip_sha256": "c" * 64,
        "approved_by": "Owner", "approved_at": 1_800_000_000,
    }

    with pytest.raises(api.ServerOwnedField, match="artifact_binding"):
        store.put(production_record(artifact_binding=binding), expected_version=created["version"])


def test_generic_conclude_cannot_complete_a_production_meeting(tmp_path):
    api = load_meeting_store()
    store = api.MeetingStore(tmp_path / "meetings.db")
    created = store.put(production_record(), expected_version=0)
    running = store.put(
        production_record(state="running", current_round=1, contributions=[{
            "id": "c1", "round": 1, "participant": ORCHESTRATOR,
            "kind": "speak", "text": "Brief.", "evidence_refs": [],
        }]),
        expected_version=created["version"],
    )

    with pytest.raises(api.InvalidMeetingTransition, match="approval"):
        store.put(
            production_record(
                state="completed", current_round=1,
                contributions=[{
                    "id": "c1", "round": 1, "participant": ORCHESTRATOR,
                    "kind": "speak", "text": "Brief.", "evidence_refs": [],
                }],
                decisions=[{"id": "d1", "text": "Done.", "evidence_refs": []}],
            ),
            expected_version=running["version"],
        )


def test_production_meeting_does_not_auto_complete_on_all_pass_or_max_round(tmp_path):
    api = load_meeting_store()
    store = api.MeetingStore(tmp_path / "meetings.db")
    created = store.put(production_record(max_rounds=1), expected_version=0)
    contributions = [
        {"id": "c1", "round": 1, "participant": ORCHESTRATOR, "kind": "pass", "text": ""},
        {"id": "c2", "round": 1, "participant": PRODUCER, "kind": "pass", "text": ""},
        {"id": "c3", "round": 1, "participant": REVIEWER, "kind": "pass", "text": ""},
    ]

    saved = store.put(
        production_record(max_rounds=1, state="running", current_round=1, contributions=contributions),
        expected_version=created["version"],
    )

    assert saved["meeting"]["state"] == "running"
    assert saved["meeting"]["production_stage"] == "briefing"


def test_conclusion_meeting_still_requires_completion_on_a_terminal_round(tmp_path):
    api = load_meeting_store()
    store = api.MeetingStore(tmp_path / "meetings.db")
    store.put(conclusion_record(max_rounds=1), expected_version=0)
    contributions = [
        {"id": "c1", "round": 1, "participant": ORCHESTRATOR, "kind": "pass", "text": ""},
        {"id": "c2", "round": 1, "participant": PRODUCER, "kind": "pass", "text": ""},
    ]

    with pytest.raises(ValueError, match="terminal"):
        store.put(
            conclusion_record(max_rounds=1, state="running", current_round=1, contributions=contributions),
            expected_version=1,
        )


# ---------------------------------------------------------------------------
# server-owned transactions
# ---------------------------------------------------------------------------


def test_advance_production_stage_is_a_server_owned_transaction(tmp_path):
    api = load_meeting_store()
    store = api.MeetingStore(tmp_path / "meetings.db")
    created = store.put(production_record(), expected_version=0)
    running = store.put(
        production_record(state="running", current_round=1, contributions=[{
            "id": "c1", "round": 1, "participant": ORCHESTRATOR,
            "kind": "speak", "text": "Brief.", "evidence_refs": [],
        }]),
        expected_version=created["version"],
    )

    advanced = store.advance_production_stage(
        "meeting_production_1", "working", expected_version=running["version"]
    )
    assert advanced["meeting"]["production_stage"] == "working"
    assert advanced["version"] == running["version"] + 1

    with pytest.raises(api.VersionConflict):
        store.advance_production_stage(
            "meeting_production_1", "production_ready", expected_version=running["version"]
        )

    # The stage ladder is exact: working cannot skip straight to approval.
    with pytest.raises(api.InvalidMeetingTransition):
        store.advance_production_stage(
            "meeting_production_1", "approval_ready", expected_version=advanced["version"]
        )

    # completed is reachable only through the owner approval transaction.
    with pytest.raises(api.InvalidMeetingTransition, match="approval"):
        store.advance_production_stage(
            "meeting_production_1", "completed", expected_version=advanced["version"]
        )


def test_advance_production_stage_refuses_a_conclusion_meeting(tmp_path):
    api = load_meeting_store()
    store = api.MeetingStore(tmp_path / "meetings.db")
    store.put(conclusion_record(), expected_version=0)

    with pytest.raises(api.InvalidMeetingTransition, match="production"):
        store.advance_production_stage("meeting_release_1", "working", expected_version=1)


def test_complete_production_meeting_binds_and_completes_atomically(tmp_path):
    api = load_meeting_store()
    store = api.MeetingStore(tmp_path / "meetings.db")
    store.put(production_record(), expected_version=0)
    version = 1
    for stage in ("working", "production_ready", "producing", "reviewing", "approval_ready"):
        version = store.advance_production_stage(
            "meeting_production_1", stage, expected_version=version
        )["version"]

    binding = {
        "output_id": "out_1", "artifact_version": 1,
        "game_sha256": "a" * 64, "manifest_sha256": "b" * 64, "zip_sha256": "c" * 64,
        "approved_by": "Owner", "approved_at": 1_800_000_000,
    }
    completed = store.complete_production_meeting(
        "meeting_production_1", artifact_binding=binding, expected_version=version
    )

    assert completed["meeting"]["state"] == "completed"
    assert completed["meeting"]["production_stage"] == "completed"
    assert completed["meeting"]["artifact_binding"] == binding

    # Approved evidence is terminal: no further client PUT can rewrite it.
    with pytest.raises((ValueError, api.InvalidMeetingTransition, api.ImmutableMeetingHistory)):
        store.put(
            production_record(state="running", current_round=0),
            expected_version=completed["version"],
        )


def test_complete_production_meeting_refuses_a_client_authored_approver(tmp_path):
    api = load_meeting_store()
    store = api.MeetingStore(tmp_path / "meetings.db")
    store.put(production_record(), expected_version=0)
    version = 1
    for stage in ("working", "production_ready", "producing", "reviewing", "approval_ready"):
        version = store.advance_production_stage(
            "meeting_production_1", stage, expected_version=version
        )["version"]

    with pytest.raises(ValueError, match="approved_by"):
        store.complete_production_meeting(
            "meeting_production_1",
            artifact_binding={
                "output_id": "out_1", "artifact_version": 1,
                "game_sha256": "a" * 64, "manifest_sha256": "b" * 64, "zip_sha256": "c" * 64,
                "approved_by": "jane@example.test", "approved_at": 1_800_000_000,
            },
            expected_version=version,
        )


# ---------------------------------------------------------------------------
# migration and immutability
# ---------------------------------------------------------------------------


def test_legacy_records_are_read_unchanged_and_append_a_v2_version(tmp_path):
    api = load_meeting_store()
    db_path = tmp_path / "meetings.db"
    store = api.MeetingStore(db_path)
    legacy = {
        "id": "meeting_legacy_1",
        "source": route("default"),
        "title": "Legacy meeting",
        "agenda": "Legacy agenda.",
        "chair": ORCHESTRATOR,
        "participants": [ORCHESTRATOR, PRODUCER],
        "state": "running",
        "max_rounds": 3,
        "current_round": 1,
        "contributions": [{
            "id": "c1", "round": 1, "participant": ORCHESTRATOR,
            "kind": "speak", "text": "Legacy text.", "evidenceRefs": ["note://legacy"],
        }],
        "evidence": [],
        "decisions": [],
        "dissent": [],
        "action_items": [],
    }
    raw = json.dumps(legacy, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    with sqlite3.connect(db_path) as connection:
        connection.execute(
            "INSERT INTO meeting_versions (meeting_id, version, state, record_json, created_at)"
            " VALUES (?, ?, ?, ?, ?)",
            ("meeting_legacy_1", 1, "running", raw, 1_700_000_000),
        )

    reopened = api.MeetingStore(db_path)
    loaded = reopened.get("meeting_legacy_1")
    assert loaded["meeting"]["contributions"][0]["evidenceRefs"] == ["note://legacy"]
    assert loaded["meeting"].get("schema_version") is None
    assert loaded["schema_version"] == 1

    appended = reopened.put(
        {**legacy, "current_round": 2, "contributions": [
            legacy["contributions"][0],
            {"id": "c2", "round": 1, "participant": PRODUCER, "kind": "pass", "text": ""},
        ]},
        expected_version=1,
    )
    assert appended["meeting"]["schema_version"] == 2
    assert appended["meeting"]["contributions"][0]["evidence_refs"] == ["note://legacy"]

    with sqlite3.connect(db_path) as connection:
        stored = connection.execute(
            "SELECT record_json FROM meeting_versions WHERE meeting_id = ? AND version = 1",
            ("meeting_legacy_1",),
        ).fetchone()[0]
    assert stored == raw


def test_reopening_the_store_is_idempotent_and_additive(tmp_path):
    api = load_meeting_store()
    db_path = tmp_path / "meetings.db"
    for _ in range(3):
        api.MeetingStore(db_path).put(conclusion_record(), expected_version=0) if not db_path.exists() \
            else api.MeetingStore(db_path)

    with sqlite3.connect(db_path) as connection:
        objects = connection.execute(
            "SELECT type, name FROM sqlite_master WHERE name LIKE 'meeting_%' ORDER BY name"
        ).fetchall()

    names = [row[1] for row in objects]
    assert len(names) == len(set(names))
    assert "meeting_versions" in names
    assert "meeting_versions_no_update" in names
    assert "meeting_versions_no_delete" in names
    assert api.MeetingStore(db_path).get("meeting_release_1")["version"] == 1


def test_meeting_history_remains_append_only_against_direct_sql(tmp_path):
    api = load_meeting_store()
    db_path = tmp_path / "meetings.db"
    api.MeetingStore(db_path).put(conclusion_record(), expected_version=0)

    with sqlite3.connect(db_path) as connection:
        with pytest.raises(sqlite3.DatabaseError):
            connection.execute("UPDATE meeting_versions SET state = 'completed'")
        with pytest.raises(sqlite3.DatabaseError):
            connection.execute("DELETE FROM meeting_versions")


def test_immutable_identity_and_history_prefix_are_enforced(tmp_path):
    api = load_meeting_store()
    store = api.MeetingStore(tmp_path / "meetings.db")
    store.put(production_record(), expected_version=0)

    with pytest.raises(api.ImmutableMeetingHistory, match="orchestrator|cannot change"):
        store.put(production_record(orchestrator=REVIEWER, producer=ORCHESTRATOR, seats=[
            {"bot": REVIEWER, "role": "specialist", "label": "R"},
            {"bot": ORCHESTRATOR, "role": "contributor", "label": "O"},
            {"bot": PRODUCER, "role": "reviewer", "label": "P"},
        ]), expected_version=1)

    with pytest.raises(api.ImmutableMeetingHistory, match="product_kind|cannot change"):
        store.put(production_record(product_kind="audio_asset"), expected_version=1)
