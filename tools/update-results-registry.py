import csv
import json
import re
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path


ROOT = Path(r"C:\Users\azaslavets\Facetest")
OUTPUT_DIR = ROOT / "outputs" / "facetest-results"
MANUAL_SESSIONS_PATH = OUTPUT_DIR / "manual_sessions.json"
REGISTRY_PATH = OUTPUT_DIR / "facetest-results-current.csv"
SUMMARY_PATH = OUTPUT_DIR / "facetest-results-summary.json"
LATEST_SOURCE_PATH = OUTPUT_DIR / "latest_completeness_source.json"


def normalize(value):
    return re.sub(r"\s+", " ", str(value or "").strip()).casefold()


def participant_key(value):
    normalized = normalize(value)
    aliases = {
        "\u0435\u043b\u0438\u0437\u0430\u0432\u0435\u0442\u0430 \u043c\u043e\u0433\u0438\u043b\u0435\u0432\u0438\u0447": "\u043c\u043e\u0433\u0438\u043b\u0435\u0432\u0438\u0447 \u0435\u043b\u0438\u0437\u0430\u0432\u0435\u0442\u0430",
        "\u043c\u043e\u0433\u0438\u043b\u0435\u0432\u0438\u0447 \u0435\u043b\u0438\u0437\u0430\u0432\u0435\u0442\u0430": "\u043c\u043e\u0433\u0438\u043b\u0435\u0432\u0438\u0447 \u0435\u043b\u0438\u0437\u0430\u0432\u0435\u0442\u0430",
        "\u043c\u043e\u0433\u0438\u043b\u0435\u0432\u0438\u0447 \u043b\u0438\u0437\u0430": "\u043c\u043e\u0433\u0438\u043b\u0435\u0432\u0438\u0447 \u0435\u043b\u0438\u0437\u0430\u0432\u0435\u0442\u0430",
        "\u043c\u0438\u043b\u0435\u0432\u0430 \u0438\u0440\u0438\u043d\u0430 105 \u0433\u0440\u0443\u043f\u043f\u0430": "\u043c\u0438\u043b\u044f\u0435\u0432\u0430 \u0438\u0440\u0438\u043d\u0430 105 \u0433\u0440\u0443\u043f\u043f\u0430",
        "\u043c\u0438\u043b\u044f\u0435\u0432\u0430 \u0438\u0440\u0438\u043d\u0430 105 \u0433\u0440\u0443\u043f\u043f\u0430": "\u043c\u0438\u043b\u044f\u0435\u0432\u0430 \u0438\u0440\u0438\u043d\u0430 105 \u0433\u0440\u0443\u043f\u043f\u0430",
        "@ulyana_ssss": "\u0441\u0443\u043c\u0438\u043d\u0430 \u0443\u043b\u044c\u044f\u043d\u0430",
        "\u0441\u0443\u043c\u0438\u043d\u0430 \u0443\u043b\u044c\u044f\u043d\u0430": "\u0441\u0443\u043c\u0438\u043d\u0430 \u0443\u043b\u044c\u044f\u043d\u0430",
        "\u0430\u043b\u0435\u043a\u0441\u0435\u0435\u0432\u0430 \u0430\u043b\u0435\u0432\u0438\u043d\u0430": "\u0430\u043b\u0435\u043a\u0441\u0435\u0435\u0432\u0430 \u0430\u043b\u0435\u0432\u0442\u0438\u043d\u0430",
        "\u0430\u043b\u0435\u043a\u0441\u0435\u0435\u0432\u0430 \u0430\u043b\u0435\u0432\u0442\u0438\u043d\u0430": "\u0430\u043b\u0435\u043a\u0441\u0435\u0435\u0432\u0430 \u0430\u043b\u0435\u0432\u0442\u0438\u043d\u0430",
        "\u043f\u043e\u043b\u0435\u0442\u0430\u0435\u0432\u0430 \u0434\u0430\u0440\u044c\u044f\\qwiizlls": "\u043f\u043e\u043b\u0435\u0442\u0430\u0435\u0432\u0430 \u0434\u0430\u0440\u044c\u044f 109 \u0433\u0440\u0443\u043f\u043f\u0430",
        "\u043f\u043e\u043b\u0435\u0442\u0430\u0435\u0432\u0430 \u0434\u0430\u0440\u044c\u044f 109 \u0433\u0440\u0443\u043f\u043f\u0430": "\u043f\u043e\u043b\u0435\u0442\u0430\u0435\u0432\u0430 \u0434\u0430\u0440\u044c\u044f 109 \u0433\u0440\u0443\u043f\u043f\u0430",
    }
    return aliases.get(normalized, normalized)


def participant_display_name(value):
    if participant_key(value) == "\u0441\u0443\u043c\u0438\u043d\u0430 \u0443\u043b\u044c\u044f\u043d\u0430":
        return "\u0421\u0443\u043c\u0438\u043d\u0430 \u0423\u043b\u044c\u044f\u043d\u0430 / @ulyana_ssss"
    if participant_key(value) == "\u0430\u043b\u0435\u043a\u0441\u0435\u0435\u0432\u0430 \u0430\u043b\u0435\u0432\u0442\u0438\u043d\u0430":
        return "\u0410\u043b\u0435\u043a\u0441\u0435\u0435\u0432\u0430 \u0410\u043b\u0435\u0432\u0442\u0438\u043d\u0430"
    if participant_key(value) == "\u043f\u043e\u043b\u0435\u0442\u0430\u0435\u0432\u0430 \u0434\u0430\u0440\u044c\u044f 109 \u0433\u0440\u0443\u043f\u043f\u0430":
        return "\u041f\u043e\u043b\u0435\u0442\u0430\u0435\u0432\u0430 \u0414\u0430\u0440\u044c\u044f 109 \u0433\u0440\u0443\u043f\u043f\u0430"
    return value


def is_test_identifier(value):
    normalized = normalize(value)
    return (
        normalized in {"\u0442", "t", "test", "\u0442\u0435\u0441\u0442", "1"}
        or "smoke" in normalized
        or "\u0442\u0435\u0441\u0442\u043e\u0432" in normalized
    )


def created_at_value(row):
    return datetime.fromisoformat(str(row["created_at"]).replace("Z", "+00:00"))


def read_csv(path):
    with path.open("r", encoding="utf-8-sig", newline="") as source:
        return list(csv.DictReader(source))


def read_json(path, default):
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else default


if len(sys.argv) != 2:
    raise SystemExit("Usage: update-results-registry.py COMPLETENESS.csv")

completeness_path = Path(sys.argv[1])
db_attempts = read_csv(completeness_path)
manual_sessions = read_json(MANUAL_SESSIONS_PATH, [])

db_rows_by_key = {}
excluded_db_tests = 0
for row in db_attempts:
    if is_test_identifier(row.get("participant_identifier")):
        excluded_db_tests += 1
        continue
    key = (normalize(row.get("participant_identifier")), row.get("stimulus_set_id"))
    db_rows_by_key.setdefault(key, []).append(row)

latest_db = {}
for key, rows in db_rows_by_key.items():
    ok_rows = [row for row in rows if row.get("status") == "OK"]
    latest_db[key] = max(ok_rows or rows, key=created_at_value)

manual_by_key = {}
excluded_manual_tests = 0
for row in manual_sessions:
    if row.get("is_test") or is_test_identifier(row.get("participant_name")):
        excluded_manual_tests += 1
        continue
    key = (normalize(row.get("participant_name")), row.get("stimulus_set_id"))
    manual_by_key[key] = row

registry = []
for key in sorted(set(latest_db) | set(manual_by_key)):
    db_row = latest_db.get(key, {})
    manual_row = manual_by_key.get(key)
    db_photo_answers = int(db_row.get("photo_answers") or 0)
    db_unique_photos = int(db_row.get("unique_photos") or 0)
    has_local_csv = manual_row is not None
    complete = db_unique_photos >= 60 or has_local_csv
    completion_source = (
        "supabase_and_local_csv"
        if db_unique_photos >= 60 and has_local_csv
        else "supabase"
        if db_unique_photos >= 60
        else "local_csv_pending_upload"
        if has_local_csv
        else "incomplete"
    )
    registry.append({
        "participant_identifier": db_row.get("participant_identifier")
        or manual_row.get("participant_name"),
        "participant_display_name": participant_display_name(
            db_row.get("participant_identifier") or manual_row.get("participant_name")
        ),
        "stimulus_set_id": key[1],
        "latest_db_created_at": db_row.get("created_at", ""),
        "questionnaire_answers": db_row.get("questionnaire_answers", ""),
        "db_photo_answers": db_photo_answers,
        "db_unique_photos": db_unique_photos,
        "db_status": db_row.get("status", ""),
        "local_csv_added": "YES" if has_local_csv else "NO",
        "local_csv_file": manual_row.get("source_file", "") if manual_row else "",
        "local_csv_session_id": manual_row.get("session_id", "") if manual_row else "",
        "completed_with_local_csv": "YES" if complete else "NO",
        "completion_source": completion_source,
    })

rows_by_participant = {}
for row in registry:
    rows_by_participant.setdefault(participant_key(row["participant_identifier"]), []).append(row)

selected_registry = []
for rows in rows_by_participant.values():
    completed_rows = [row for row in rows if row["completed_with_local_csv"] == "YES"]
    candidates = completed_rows or rows
    selected_registry.append(max(candidates, key=lambda row: row["latest_db_created_at"]))
registry = sorted(
    selected_registry,
    key=lambda row: (row["stimulus_set_id"], participant_key(row["participant_identifier"])),
)

OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
fieldnames = list(registry[0]) if registry else []
with REGISTRY_PATH.open("w", encoding="utf-8-sig", newline="") as output:
    writer = csv.DictWriter(output, fieldnames=fieldnames)
    writer.writeheader()
    writer.writerows(registry)

completed = [row for row in registry if row["completed_with_local_csv"] == "YES"]
completed_by_set = Counter(row["stimulus_set_id"] for row in completed)
incomplete_by_set = Counter(
    row["stimulus_set_id"]
    for row in registry
    if row["completed_with_local_csv"] == "NO"
)
summary = {
    "source_file": completeness_path.name,
    "source_attempt_rows": len(db_attempts),
    "latest_real_participant_set_rows": len(registry),
    "completed_people": len({normalize(row["participant_identifier"]) for row in completed}),
    "completed_participant_sets": len(completed),
    "completed_by_set": dict(sorted(completed_by_set.items())),
    "incomplete_by_set": dict(sorted(incomplete_by_set.items())),
    "local_csv_completed": sum(row["completion_source"] == "local_csv_pending_upload" for row in completed),
    "excluded_db_test_attempts": excluded_db_tests,
    "excluded_manual_test_exports": excluded_manual_tests,
}
SUMMARY_PATH.write_text(
    json.dumps(summary, ensure_ascii=False, indent=2),
    encoding="utf-8",
)
LATEST_SOURCE_PATH.write_text(
    json.dumps({"file": completeness_path.name, "rows": len(db_attempts)}, ensure_ascii=False, indent=2),
    encoding="utf-8",
)
print(json.dumps(summary, ensure_ascii=False, indent=2))
print(f"REGISTRY={REGISTRY_PATH}")
