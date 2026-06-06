import csv
from datetime import datetime
import json
import re
import sys
from pathlib import Path


ROOT = Path(r"C:\Users\azaslavets\Facetest")
OUTPUT_DIR = ROOT / "outputs" / "facetest-results"
PAYLOAD_PATH = OUTPUT_DIR / "import_payload.json"
PAYLOAD_CSV_PATH = OUTPUT_DIR / "facetest-emergency-import-current.csv"
SESSIONS_PATH = OUTPUT_DIR / "manual_sessions.json"
ANSWERS_PATH = OUTPUT_DIR / "manual_answers.json"


def normalize(value):
    return re.sub(r"\s+", " ", str(value or "").strip()).casefold()


def is_test_identifier(value):
    normalized = normalize(value)
    return (
        normalized in {"т", "t", "test", "тест", "1"}
        or "smoke" in normalized
        or "тестов" in normalized
    )


def created_at_value(row):
    return datetime.fromisoformat(str(row["created_at"]).replace("Z", "+00:00"))


def load_csv(path):
    for encoding in ("utf-8-sig", "utf-16", "cp1251"):
        try:
            text = path.read_text(encoding=encoding)
        except UnicodeDecodeError:
            continue
        rows = list(csv.DictReader(text.splitlines()))
        if rows and all(row.get("participant_name") is None for row in rows):
            lines = text.splitlines()
            repaired_lines = [lines[0]]
            repaired_lines.extend(
                line[1:-1].replace('""', '"')
                if line.startswith('"') and line.endswith('"')
                else line
                for line in lines[1:]
            )
            rows = list(csv.DictReader(repaired_lines))
        return rows
    raise ValueError(f"Unsupported CSV encoding: {path.name}")


def load_xlsx(path):
    import openpyxl

    workbook = openpyxl.load_workbook(path, read_only=True, data_only=True)
    rows = list(workbook.active.iter_rows(values_only=True))
    headers = [str(value) for value in rows[0]]
    return [
        {headers[index]: value for index, value in enumerate(row)}
        for row in rows[1:]
    ]


def load_table(path):
    return load_xlsx(path) if path.suffix.lower() == ".xlsx" else load_csv(path)


def load_json(path, default):
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else default


def save_json(path, value):
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, default=str), encoding="utf-8")


def save_csv(path, rows):
    headers = []
    for row in rows:
        for key in row:
            if key not in headers:
                headers.append(key)
    with path.open("w", encoding="utf-8-sig", newline="") as output:
        writer = csv.DictWriter(output, fieldnames=headers, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


if len(sys.argv) < 3:
    raise SystemExit("Usage: append-emergency-responses.py COMPLETENESS.csv EMERGENCY_FILE...")

completeness_path = Path(sys.argv[1])
new_paths = [Path(value) for value in sys.argv[2:]]
db_sessions = load_csv(completeness_path)
existing_payload = load_json(PAYLOAD_PATH, [])
existing_sessions = load_json(SESSIONS_PATH, [])
existing_answers = load_json(ANSWERS_PATH, [])
existing_payload = list({
    (str(row["session_id"]), str(row["stimulus_order"])): row
    for row in existing_payload
}.values())
existing_session_ids = {str(row["session_id"]) for row in existing_sessions}
payload_session_ids = {str(row["session_id"]) for row in existing_payload}

db_index = {}
for row in db_sessions:
    key = (normalize(row["participant_identifier"]), row["stimulus_set_id"])
    db_index.setdefault(key, []).append(row)

added_sessions = []
added_payload_rows = []
added_answer_rows = []
skipped = []

for path in new_paths:
    rows = load_table(path)
    for row in rows:
        row["stimulus_set_id"] = re.sub(r"\s+", "", str(row["stimulus_set_id"]))
    session_ids = sorted({str(row["session_id"]) for row in rows})
    names = sorted({str(row["participant_name"]) for row in rows})
    sets = sorted({str(row["stimulus_set_id"]) for row in rows})
    stimulus_ids = {str(row["stimulus_id"]) for row in rows}
    stimulus_orders = {str(row["stimulus_order"]) for row in rows}

    if len(session_ids) != 1 or len(names) != 1 or len(sets) != 1:
        raise ValueError(f"Mixed session file: {path.name}")

    session_id = session_ids[0]
    participant_name = names[0]
    stimulus_set_id = sets[0]
    is_test = is_test_identifier(participant_name)
    valid_60 = len(rows) == 60 and len(stimulus_ids) == 60 and len(stimulus_orders) == 60
    matching_db = db_index.get((normalize(participant_name), stimulus_set_id), [])
    latest_matching_db = max(matching_db, key=created_at_value) if matching_db else None
    db_photo_answers = sorted({int(row["photo_answers"]) for row in matching_db})
    safe_candidate = (
        not is_test
        and valid_60
        and len(matching_db) >= 1
        and db_photo_answers == [0]
    )

    session_summary = {
        "source_file": path.name,
        "session_id": session_id,
        "participant_name": participant_name,
        "participant_normalized": normalize(participant_name),
        "stimulus_set_id": stimulus_set_id,
        "rows": len(rows),
        "unique_stimuli": len(stimulus_ids),
        "unique_orders": len(stimulus_orders),
        "answers_y": sum(str(row["answer"]) == "Y" for row in rows),
        "answers_n": sum(str(row["answer"]) == "N" for row in rows),
        "is_test": is_test,
        "include_in_analysis": not is_test,
        "db_match_count": len(matching_db),
        "db_latest_created_at": latest_matching_db["created_at"] if latest_matching_db else "",
        "db_photo_answers": ", ".join(str(value) for value in db_photo_answers),
        "import_candidate": safe_candidate,
        "import_status": (
            "exclude_test"
            if is_test
            else "ready_for_import"
            if safe_candidate and len(matching_db) == 1
            else "queued_latest_attempt_check"
            if safe_candidate
            else "review_required"
        ),
    }

    if session_id in existing_session_ids:
        existing_summary = next(row for row in existing_sessions if str(row["session_id"]) == session_id)
        existing_summary.update(session_summary)
        if safe_candidate and session_id not in payload_session_ids:
            promoted_rows = [
                row for row in existing_answers
                if str(row["session_id"]) == session_id
            ]
            payload_session_ids.add(session_id)
            added_payload_rows.extend(promoted_rows)
        skipped.append({"file": path.name, "session_id": session_id, "reason": "updated_existing_local_session"})
        continue

    added_sessions.append(session_summary)
    existing_session_ids.add(session_id)

    for row in rows:
        enriched = dict(row)
        enriched["source_file"] = path.name
        enriched["include_in_analysis"] = not is_test
        enriched["import_candidate"] = safe_candidate
        added_answer_rows.append(enriched)

        if safe_candidate:
            added_payload_rows.append(enriched)
            payload_session_ids.add(session_id)

existing_sessions.extend(added_sessions)
existing_answers.extend(added_answer_rows)
existing_payload.extend(added_payload_rows)
existing_payload = list({
    (str(row["session_id"]), str(row["stimulus_order"])): row
    for row in existing_payload
}.values())
save_json(SESSIONS_PATH, existing_sessions)
save_json(ANSWERS_PATH, existing_answers)
save_json(PAYLOAD_PATH, existing_payload)
save_csv(PAYLOAD_CSV_PATH, existing_payload)
save_json(OUTPUT_DIR / "latest_completeness_source.json", {
    "file": completeness_path.name,
    "rows": len(db_sessions),
})

print(json.dumps({
    "fresh_export": completeness_path.name,
    "fresh_export_rows": len(db_sessions),
    "new_files_received": len(new_paths),
    "new_sessions_added": len(added_sessions),
    "new_import_candidates": sum(row["import_candidate"] for row in added_sessions),
    "new_payload_rows": len(added_payload_rows),
    "local_package_sessions_total": len(existing_sessions),
    "local_payload_rows_total": len(existing_payload),
    "skipped": skipped,
    "sessions": added_sessions,
}, ensure_ascii=False, indent=2))
