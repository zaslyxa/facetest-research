import csv
import json
import os
import re
from collections import Counter
from pathlib import Path

import openpyxl


DOWNLOADS = Path(r"C:\Users\azaslavets\Downloads")
OUTPUT_DIR = Path(r"C:\Users\azaslavets\Facetest\outputs\facetest-results")
COMPLETENESS_FILE = DOWNLOADS / "Supabase Snippet Session Answer Completeness Check (1).csv"
EMERGENCY_FILES = [
    DOWNLOADS / "facetest-e1aeb2e5-6d16-4e2c-b9b1-e23fd7ec42bd.csv",
    DOWNLOADS / "Азова Д.csv",
    DOWNLOADS / "Быстрова Татьяна эксп.csv",
    DOWNLOADS / "Ершов.csv",
    DOWNLOADS / "Ершова Мария.csv",
    DOWNLOADS / "Зенин.csv",
    DOWNLOADS / "Косарева.csv",
    DOWNLOADS / "Хватова София.csv",
    DOWNLOADS / "Ладина.csv",
    DOWNLOADS / "Красовская.xlsx",
    DOWNLOADS / "Вероника Петрова.csv",
    DOWNLOADS / "Азовская.csv",
]


def normalize(value):
    return re.sub(r"\s+", " ", str(value or "").strip()).casefold()


def is_test_identifier(value):
    normalized = normalize(value)
    return (
        normalized in {"т", "t", "test", "тест", "1"}
        or "smoke" in normalized
        or "тестов" in normalized
    )


def load_csv(path):
    with path.open("r", encoding="utf-8-sig", newline="") as source:
        return list(csv.DictReader(source))


def load_xlsx(path):
    workbook = openpyxl.load_workbook(path, read_only=True, data_only=True)
    worksheet = workbook.active
    rows = list(worksheet.iter_rows(values_only=True))
    headers = [str(value) for value in rows[0]]
    return [
        {headers[index]: value for index, value in enumerate(row)}
        for row in rows[1:]
    ]


def load_table(path):
    return load_xlsx(path) if path.suffix.lower() == ".xlsx" else load_csv(path)


def write_json(name, value):
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    with (OUTPUT_DIR / name).open("w", encoding="utf-8") as target:
        json.dump(value, target, ensure_ascii=False, indent=2, default=str)


db_sessions = load_csv(COMPLETENESS_FILE)
for row in db_sessions:
    row["questionnaire_answers"] = int(row["questionnaire_answers"])
    row["photo_answers"] = int(row["photo_answers"])
    row["unique_photos"] = int(row["unique_photos"])
    row["participant_normalized"] = normalize(row["participant_identifier"])
    row["is_test"] = is_test_identifier(row["participant_identifier"])

participant_counts = Counter(
    row["participant_normalized"]
    for row in db_sessions
    if not row["is_test"]
)

for row in db_sessions:
    row["duplicate_count"] = participant_counts[row["participant_normalized"]] if not row["is_test"] else 0
    row["duplicate_flag"] = row["duplicate_count"] > 1
    row["include_in_analysis"] = not row["is_test"]

manual_sessions = []
manual_answers = []
for path in EMERGENCY_FILES:
    rows = load_table(path)
    session_ids = sorted({str(row["session_id"]) for row in rows})
    names = sorted({str(row["participant_name"]) for row in rows})
    sets = sorted({str(row["stimulus_set_id"]) for row in rows})
    stimulus_ids = {str(row["stimulus_id"]) for row in rows}
    stimulus_orders = {str(row["stimulus_order"]) for row in rows}

    if len(session_ids) != 1 or len(names) != 1 or len(sets) != 1:
        raise ValueError(f"Mixed session file: {path.name}")

    participant_name = names[0]
    participant_normalized = normalize(participant_name)
    stimulus_set_id = sets[0]
    matching_db = [
        row for row in db_sessions
        if row["participant_normalized"] == participant_normalized
        and row["stimulus_set_id"] == stimulus_set_id
    ]
    is_test = is_test_identifier(participant_name)
    valid_60 = len(rows) == 60 and len(stimulus_ids) == 60 and len(stimulus_orders) == 60
    db_photo_answers = sorted({row["photo_answers"] for row in matching_db})
    safe_candidate = (
        not is_test
        and valid_60
        and len(matching_db) == 1
        and db_photo_answers == [0]
    )

    manual_session = {
        "source_file": path.name,
        "session_id": session_ids[0],
        "participant_name": participant_name,
        "participant_normalized": participant_normalized,
        "stimulus_set_id": stimulus_set_id,
        "rows": len(rows),
        "unique_stimuli": len(stimulus_ids),
        "unique_orders": len(stimulus_orders),
        "answers_y": sum(str(row["answer"]) == "Y" for row in rows),
        "answers_n": sum(str(row["answer"]) == "N" for row in rows),
        "is_test": is_test,
        "include_in_analysis": not is_test,
        "db_match_count": len(matching_db),
        "db_photo_answers": ", ".join(str(value) for value in db_photo_answers),
        "import_candidate": safe_candidate,
        "import_status": (
            "exclude_test"
            if is_test
            else "ready_for_import"
            if safe_candidate
            else "review_required"
        ),
    }
    manual_sessions.append(manual_session)

    for row in rows:
        clean_row = {key: value for key, value in row.items()}
        clean_row["source_file"] = path.name
        clean_row["include_in_analysis"] = not is_test
        clean_row["import_candidate"] = safe_candidate
        manual_answers.append(clean_row)

real_db_sessions = [row for row in db_sessions if row["include_in_analysis"]]
test_db_sessions = [row for row in db_sessions if not row["include_in_analysis"]]
real_manual_sessions = [row for row in manual_sessions if row["include_in_analysis"]]
import_candidates = [row for row in manual_sessions if row["import_candidate"]]
candidate_answers = [
    row for row in manual_answers
    if row["import_candidate"]
]

summary = {
    "db_export_file": COMPLETENESS_FILE.name,
    "db_sessions_total": len(db_sessions),
    "db_sessions_real": len(real_db_sessions),
    "db_sessions_test_excluded": len(test_db_sessions),
    "db_complete_real_before_import": sum(row["status"] == "OK" for row in real_db_sessions),
    "db_incomplete_real_before_import": sum(row["status"] != "OK" for row in real_db_sessions),
    "manual_files_total": len(manual_sessions),
    "manual_files_real": len(real_manual_sessions),
    "manual_files_test_excluded": sum(row["is_test"] for row in manual_sessions),
    "manual_files_ready_for_import": len(import_candidates),
    "manual_rows_ready_for_import": len(candidate_answers),
    "expected_complete_real_after_import": (
        sum(row["status"] == "OK" for row in real_db_sessions)
        + len(import_candidates)
    ),
    "duplicate_participant_ids": sum(count > 1 for count in participant_counts.values()),
    "db_real_by_set": dict(Counter(row["stimulus_set_id"] for row in real_db_sessions)),
    "db_complete_real_by_set_before_import": dict(
        Counter(row["stimulus_set_id"] for row in real_db_sessions if row["status"] == "OK")
    ),
    "manual_import_candidates_by_set": dict(
        Counter(row["stimulus_set_id"] for row in import_candidates)
    ),
}

write_json("summary.json", summary)
write_json("db_sessions.json", db_sessions)
write_json("manual_sessions.json", manual_sessions)
write_json("manual_answers.json", manual_answers)
write_json("import_candidates.json", import_candidates)
write_json("import_payload.json", candidate_answers)

print(json.dumps(summary, ensure_ascii=False, indent=2))
print("IMPORT_CANDIDATES")
for row in import_candidates:
    print(json.dumps(row, ensure_ascii=False))
print("DUPLICATE_PARTICIPANTS")
for participant, count in sorted(participant_counts.items()):
    if count > 1:
        print(json.dumps({"participant_normalized": participant, "count": count}, ensure_ascii=False))
