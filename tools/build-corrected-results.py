import csv
import json
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path
from statistics import mean, median


ROOT = Path(r"C:\Users\azaslavets\Facetest")
OUTPUT_DIR = ROOT / "outputs" / "facetest-results"
MANIFEST_PATH = ROOT / "data" / "photo-sets.json"
MANUAL_ANSWERS_PATH = OUTPUT_DIR / "manual_answers.json"
PARTICIPANTS_PATH = OUTPUT_DIR / "facetest-corrected-participants.csv"
RESPONSES_PATH = OUTPUT_DIR / "facetest-corrected-responses.csv"
ATTEMPTS_PATH = OUTPUT_DIR / "facetest-correction-log.csv"
RAW_SUPABASE_PATH = OUTPUT_DIR / "facetest-source-supabase.csv"
RAW_LOCAL_PATH = OUTPUT_DIR / "facetest-source-local.csv"
SUMMARY_PATH = OUTPUT_DIR / "facetest-corrected-summary.json"
WORKBOOK_DATA_PATH = OUTPUT_DIR / "facetest-corrected-workbook-data.json"
QUESTIONNAIRE_SUMMARY_PATH = OUTPUT_DIR / "facetest-questionnaire-selected.csv"
QUESTIONNAIRE_LONG_PATH = OUTPUT_DIR / "facetest-questionnaire-answers-long.csv"
RAW_SESSIONS_PATH = OUTPUT_DIR / "facetest-source-sessions.csv"


def normalize(value):
    return re.sub(r"\s+", " ", str(value or "").strip()).casefold()


def participant_key(value):
    normalized = normalize(value)
    aliases = {
        "елизавета могилевич": "могилевич елизавета",
        "могилевич елизавета": "могилевич елизавета",
        "могилевич лиза": "могилевич елизавета",
        "милева ирина 105 группа": "миляева ирина 105 группа",
        "миляева ирина 105 группа": "миляева ирина 105 группа",
        "@ulyana_ssss": "сумина ульяна",
        "сумина ульяна": "сумина ульяна",
        "алексеева алевина": "алексеева алевтина",
        "алексеева алевтина": "алексеева алевтина",
        "полетаева дарья\\qwiizlls": "полетаева дарья 109 группа",
        "полетаева дарья 109 группа": "полетаева дарья 109 группа",
    }
    return aliases.get(normalized, normalized)


def display_name(value):
    key = participant_key(value)
    displays = {
        "могилевич елизавета": "Могилевич Елизавета",
        "миляева ирина 105 группа": "Миляева Ирина 105 группа",
        "сумина ульяна": "Сумина Ульяна / @ulyana_ssss",
        "алексеева алевтина": "Алексеева Алевтина",
        "полетаева дарья 109 группа": "Полетаева Дарья 109 группа",
    }
    return displays.get(key, str(value or "").strip())


def is_test_identifier(value):
    normalized = normalize(value)
    return (
        normalized in {"т", "t", "test", "тест", "1"}
        or "smoke" in normalized
        or "тестов" in normalized
    )


def parse_datetime(value):
    text = str(value or "").strip()
    if not text:
        return datetime.min
    return datetime.fromisoformat(text.replace("Z", "+00:00")).replace(tzinfo=None)


def read_csv(path):
    with path.open("r", encoding="utf-8-sig", newline="") as source:
        return list(csv.DictReader(source))


def write_csv(path, rows, fieldnames=None):
    rows = list(rows)
    if fieldnames is None:
        fieldnames = list(rows[0]) if rows else []
    with path.open("w", encoding="utf-8-sig", newline="") as target:
        writer = csv.DictWriter(target, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


if len(sys.argv) not in {2, 3}:
    raise SystemExit("Usage: build-corrected-results.py SUPABASE_RESPONSES.csv [SUPABASE_SESSIONS.csv]")

supabase_path = Path(sys.argv[1])
sessions_path = Path(sys.argv[2]) if len(sys.argv) == 3 else None
supabase_rows = read_csv(supabase_path)
sessions_rows = read_csv(sessions_path) if sessions_path else []
local_rows = json.loads(MANUAL_ANSWERS_PATH.read_text(encoding="utf-8"))
manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))

expected_by_set = {}
for photo_set in manifest["sets"]:
    expected = {}
    for stimulus in photo_set["stimuli"]:
        if stimulus["type"] != "image":
            continue
        expected[stimulus["id"]] = "Y" if "_" in Path(stimulus["src"]).stem else "N"
    expected_by_set[photo_set["id"]] = expected

merged_by_key = {}
sources_by_key = defaultdict(set)
conflicts = []

for row in supabase_rows:
    session_id = str(row.get("session_id") or "")
    order = str(row.get("stimulus_order") or "")
    if not session_id or not order:
        continue
    key = (session_id, order)
    enriched = dict(row)
    enriched["row_source"] = "supabase"
    merged_by_key[key] = enriched
    sources_by_key[key].add("supabase")

local_rows_by_session = defaultdict(list)
for row in local_rows:
    local_rows_by_session[str(row.get("session_id") or "")].append(row)

replaced_supabase_fragment_rows = Counter()
for session_id, rows in local_rows_by_session.items():
    unique_orders = {str(row.get("stimulus_order") or "") for row in rows}
    unique_stimuli = {str(row.get("stimulus_id") or "") for row in rows}
    if len(rows) != 60 or len(unique_orders) != 60 or len(unique_stimuli) != 60:
        continue
    keys_to_remove = [key for key in merged_by_key if key[0] == session_id]
    replaced_supabase_fragment_rows[session_id] = len(keys_to_remove)
    for key in keys_to_remove:
        del merged_by_key[key]
        del sources_by_key[key]

for row in local_rows:
    session_id = str(row.get("session_id") or "")
    order = str(row.get("stimulus_order") or "")
    if not session_id or not order:
        continue
    key = (session_id, order)
    enriched = dict(row)
    enriched["created_at"] = ""
    enriched["participant_identifier"] = row.get("participant_name", "")
    enriched["row_source"] = "local_csv"
    previous = merged_by_key.get(key)
    if previous:
        for field in ("stimulus_id", "answer"):
            if str(previous.get(field) or "") != str(enriched.get(field) or ""):
                conflicts.append({
                    "session_id": session_id,
                    "stimulus_order": order,
                    "field": field,
                    "supabase_value": previous.get(field, ""),
                    "local_value": enriched.get(field, ""),
                })
    merged_by_key[key] = enriched
    sources_by_key[key].add("local_csv")

if conflicts:
    raise RuntimeError(f"Conflicting Supabase and local answers: {conflicts[:5]}")

for key, row in merged_by_key.items():
    sources = sources_by_key[key]
    row["row_source"] = "+".join(sorted(sources))

session_rows = defaultdict(list)
session_meta = {}
for row in merged_by_key.values():
    session_id = str(row["session_id"])
    session_rows[session_id].append(row)
    previous = session_meta.get(session_id, {})
    created_at = row.get("created_at") or previous.get("created_at") or row.get("shown_at") or ""
    session_meta[session_id] = {
        "session_id": session_id,
        "participant_identifier": row.get("participant_identifier") or row.get("participant_name") or previous.get("participant_identifier", ""),
        "stimulus_set_id": row.get("stimulus_set_id") or previous.get("stimulus_set_id", ""),
        "created_at": created_at,
    }

session_summaries = []
for session_id, rows in session_rows.items():
    meta = session_meta[session_id]
    stimulus_set_id = meta["stimulus_set_id"]
    expected = expected_by_set.get(stimulus_set_id, {})
    unique_orders = {str(row.get("stimulus_order") or "") for row in rows}
    unique_stimuli = {str(row.get("stimulus_id") or "") for row in rows}
    invalid_stimuli = sorted(stimulus_id for stimulus_id in unique_stimuli if stimulus_id not in expected)
    valid_answers = all(str(row.get("answer") or "") in {"Y", "N"} for row in rows)
    is_complete = (
        len(rows) == 60
        and len(unique_orders) == 60
        and len(unique_stimuli) == 60
        and not invalid_stimuli
        and valid_answers
    )
    source_set = {part for row in rows for part in str(row["row_source"]).split("+")}
    session_summaries.append({
        **meta,
        "participant_key": participant_key(meta["participant_identifier"]),
        "participant_display_name": display_name(meta["participant_identifier"]),
        "rows": len(rows),
        "unique_orders": len(unique_orders),
        "unique_stimuli": len(unique_stimuli),
        "status": "complete" if is_complete else "incomplete",
        "is_test": is_test_identifier(meta["participant_identifier"]),
        "sources": "+".join(sorted(source_set)),
        "invalid_stimuli": ", ".join(invalid_stimuli),
        "supabase_fragment_rows_replaced": replaced_supabase_fragment_rows[session_id],
    })

sessions_by_participant = defaultdict(list)
for session in session_summaries:
    if not session["is_test"]:
        sessions_by_participant[session["participant_key"]].append(session)


def selection_key(session):
    return (
        session["status"] == "complete",
        session["unique_stimuli"],
        parse_datetime(session["created_at"]),
    )


selected_by_participant = {
    participant: max(sessions, key=selection_key)
    for participant, sessions in sessions_by_participant.items()
}
selected_session_ids = {
    session["session_id"]
    for session in selected_by_participant.values()
}

corrected_responses = []
participants = []
for participant, selected in selected_by_participant.items():
    rows = session_rows[selected["session_id"]]
    score = ""
    score_percent = ""
    correct_y = ""
    correct_n = ""
    missed_y = ""
    false_y = ""

    if selected["status"] == "complete":
        counters = Counter()
        expected = expected_by_set[selected["stimulus_set_id"]]
        for row in sorted(rows, key=lambda value: int(value["stimulus_order"])):
            answer = str(row["answer"])
            expected_answer = expected[str(row["stimulus_id"])]
            point = 1 if answer == expected_answer else 0
            counters["score"] += point
            counters["correct_y" if expected_answer == "Y" and point else "correct_n" if expected_answer == "N" and point else "missed_y" if expected_answer == "Y" else "false_y"] += 1
            corrected_responses.append({
                "participant": selected["participant_display_name"],
                "participant_original": selected["participant_identifier"],
                "stimulus_set_id": selected["stimulus_set_id"],
                "session_id": selected["session_id"],
                "stimulus_order": int(row["stimulus_order"]),
                "stimulus_id": row["stimulus_id"],
                "expected_answer": expected_answer,
                "actual_answer": answer,
                "point": point,
                "reaction_time_ms": row.get("reaction_time_ms", ""),
                "shown_at": row.get("shown_at", ""),
                "row_source": row["row_source"],
            })
        score = counters["score"]
        score_percent = round(score / 60 * 100, 1)
        correct_y = counters["correct_y"]
        correct_n = counters["correct_n"]
        missed_y = counters["missed_y"]
        false_y = counters["false_y"]

    participants.append({
        "participant": selected["participant_display_name"],
        "participant_original": selected["participant_identifier"],
        "stimulus_set_id": selected["stimulus_set_id"],
        "selected_session_id": selected["session_id"],
        "status": selected["status"],
        "responses": selected["unique_stimuli"],
        "source": selected["sources"],
        "score": score,
        "score_percent": score_percent,
        "correct_y_of_20": correct_y,
        "correct_n_of_40": correct_n,
        "missed_y": missed_y,
        "false_y": false_y,
        "attempts_total": len(sessions_by_participant[participant]),
        "correction_note": (
            "selected full attempt"
            if selected["status"] == "complete" and len(sessions_by_participant[participant]) > 1
            else "full attempt"
            if selected["status"] == "complete"
            else "CSV required: no full photo response set"
        ),
    })

participants.sort(
    key=lambda row: (
        row["status"] != "complete",
        -(row["score"] if row["score"] != "" else -1),
        participant_key(row["participant"]),
    )
)
rank = 0
for row in participants:
    if row["status"] == "complete":
        rank += 1
        row["rank"] = rank
    else:
        row["rank"] = ""
participants = [
    {
        "rank": row["rank"],
        **{key: value for key, value in row.items() if key != "rank"},
    }
    for row in participants
]

questionnaire_summary = []
questionnaire_long = []
questionnaire_questions = []
if sessions_rows:
    raw_questionnaires_by_session = {}
    question_ids = set()
    for row in sessions_rows:
        answers = json.loads(row.get("questionnaire_answers") or "{}")
        if not isinstance(answers, dict):
            answers = {}
        raw_questionnaires_by_session[str(row.get("session_id") or "")] = {
            **row,
            "answers": answers,
        }
        question_ids.update(
            question_id
            for question_id in answers
            if question_id.partition("_")[0] in {"motivation", "values", "empathy"}
        )

    section_order = {"motivation": 0, "values": 1, "empathy": 2}

    def question_sort_key(question_id):
        section, _, number = question_id.partition("_")
        return (section_order.get(section, 99), int(number) if number.isdigit() else number)

    questionnaire_questions = sorted(question_ids, key=question_sort_key)
    participants_by_session = {
        row["selected_session_id"]: row
        for row in participants
    }
    for selected_session_id, participant in participants_by_session.items():
        session = raw_questionnaires_by_session.get(selected_session_id)
        if session is None:
            continue
        answers = session["answers"]

        def descriptive_mean(prefix):
            values = [
                int(value)
                for question_id, value in answers.items()
                if question_id.startswith(f"{prefix}_") and str(value).isdigit()
            ]
            return round(mean(values), 2) if values else ""

        row = {
            "participant": participant["participant"],
            "participant_original": participant["participant_original"],
            "selected_session_id": selected_session_id,
            "stimulus_set_id": participant["stimulus_set_id"],
            "photo_status": participant["status"],
            "photo_score": participant["score"],
            "created_at": session.get("created_at", ""),
            "participant_age": session.get("participant_age", ""),
            "participant_gender": session.get("participant_gender", ""),
            "institution": session.get("institution", ""),
            "questionnaire_answers": len(answers),
            "motivation_mean_descriptive": descriptive_mean("motivation"),
            "values_mean_descriptive": descriptive_mean("values"),
            "empathy_mean_descriptive": descriptive_mean("empathy"),
        }
        for question_id in questionnaire_questions:
            row[question_id] = answers.get(question_id, "")
        questionnaire_summary.append(row)
        for question_id in questionnaire_questions:
            questionnaire_long.append({
                "participant": participant["participant"],
                "participant_original": participant["participant_original"],
                "selected_session_id": selected_session_id,
                "stimulus_set_id": participant["stimulus_set_id"],
                "photo_status": participant["status"],
                "photo_score": participant["score"],
                "section": question_id.partition("_")[0],
                "question_id": question_id,
                "answer": answers.get(question_id, ""),
            })

    questionnaire_summary.sort(key=lambda row: participant_key(row["participant"]))
    questionnaire_long.sort(
        key=lambda row: (participant_key(row["participant"]), question_sort_key(row["question_id"]))
    )

attempts = []
for session in sorted(session_summaries, key=lambda row: parse_datetime(row["created_at"])):
    if session["is_test"]:
        resolution = "excluded_test"
    elif session["session_id"] in selected_session_ids:
        resolution = "selected"
    elif session["status"] == "complete":
        resolution = "superseded_complete_attempt"
    else:
        resolution = "superseded_incomplete_attempt"
    attempts.append({
        "participant": session["participant_display_name"],
        "participant_original": session["participant_identifier"],
        "stimulus_set_id": session["stimulus_set_id"],
        "session_id": session["session_id"],
        "created_at": session["created_at"],
        "rows": session["rows"],
        "unique_stimuli": session["unique_stimuli"],
        "status": session["status"],
        "source": session["sources"],
        "resolution": resolution,
        "invalid_stimuli": session["invalid_stimuli"],
        "supabase_fragment_rows_replaced": session["supabase_fragment_rows_replaced"],
    })

complete_participants = [row for row in participants if row["status"] == "complete"]
incomplete_participants = [row for row in participants if row["status"] != "complete"]
scores = [int(row["score"]) for row in complete_participants]
by_set = {}
for stimulus_set_id in sorted(expected_by_set):
    rows = [row for row in complete_participants if row["stimulus_set_id"] == stimulus_set_id]
    set_scores = [int(row["score"]) for row in rows]
    by_set[stimulus_set_id] = {
        "complete_people": len(rows),
        "average_score": round(mean(set_scores), 2) if set_scores else None,
        "median_score": median(set_scores) if set_scores else None,
        "min_score": min(set_scores) if set_scores else None,
        "max_score": max(set_scores) if set_scores else None,
    }

summary = {
    "source_supabase_file": supabase_path.name,
    "source_supabase_rows": len(supabase_rows),
    "source_local_rows": len(local_rows),
    "merged_unique_response_rows": len(merged_by_key),
    "source_sessions": len(session_summaries),
    "excluded_test_sessions": sum(session["is_test"] for session in session_summaries),
    "canonical_people": len(participants),
    "complete_people": len(complete_participants),
    "incomplete_people": len(incomplete_participants),
    "corrected_response_rows": len(corrected_responses),
    "questionnaire_source_sessions": len(sessions_rows),
    "questionnaire_selected_people": len(questionnaire_summary),
    "questionnaire_selected_answers": len(questionnaire_long),
    "questionnaire_questions": len(questionnaire_questions),
    "average_score": round(mean(scores), 2) if scores else None,
    "median_score": median(scores) if scores else None,
    "min_score": min(scores) if scores else None,
    "max_score": max(scores) if scores else None,
    "by_set": by_set,
    "corrections": {
        "local_sessions_replacing_supabase_fragments": sum(
            count > 0 for count in replaced_supabase_fragment_rows.values()
        ),
        "supabase_fragment_rows_replaced": sum(replaced_supabase_fragment_rows.values()),
        "superseded_incomplete_attempts": sum(
            row["resolution"] == "superseded_incomplete_attempt" for row in attempts
        ),
        "superseded_complete_attempts": sum(
            row["resolution"] == "superseded_complete_attempt" for row in attempts
        ),
    },
    "top_10": [
        {
            "rank": row["rank"],
            "participant": row["participant"],
            "stimulus_set_id": row["stimulus_set_id"],
            "score": row["score"],
            "score_percent": row["score_percent"],
        }
        for row in complete_participants[:10]
    ],
    "incomplete_participants": [
        {
            "participant": row["participant"],
            "stimulus_set_id": row["stimulus_set_id"],
            "responses": row["responses"],
        }
        for row in incomplete_participants
    ],
}

OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
write_csv(PARTICIPANTS_PATH, participants)
write_csv(RESPONSES_PATH, corrected_responses)
write_csv(ATTEMPTS_PATH, attempts)
write_csv(RAW_SUPABASE_PATH, supabase_rows)
write_csv(RAW_LOCAL_PATH, local_rows)
write_csv(QUESTIONNAIRE_SUMMARY_PATH, questionnaire_summary)
write_csv(QUESTIONNAIRE_LONG_PATH, questionnaire_long)
write_csv(RAW_SESSIONS_PATH, sessions_rows)
SUMMARY_PATH.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
WORKBOOK_DATA_PATH.write_text(
    json.dumps(
        {
            "participants": participants,
            "responses": corrected_responses,
            "attempts": attempts,
            "supabase": supabase_rows,
            "local": local_rows,
            "questionnaire": questionnaire_summary,
            "questionnaire_long": questionnaire_long,
            "sessions": sessions_rows,
        },
        ensure_ascii=False,
    ),
    encoding="utf-8",
)

print(json.dumps(summary, ensure_ascii=False, indent=2))
print(f"PARTICIPANTS={PARTICIPANTS_PATH}")
print(f"RESPONSES={RESPONSES_PATH}")
print(f"ATTEMPTS={ATTEMPTS_PATH}")
