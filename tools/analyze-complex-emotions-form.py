import csv
import json
import re
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path


ROOT = Path(r"C:\Users\azaslavets\Facetest")
OUTPUT_DIR = ROOT / "outputs" / "facetest-results"
FORM_GLOB = "1_11 *.csv"
TEST_RESULTS_PATH = OUTPUT_DIR / "facetest-corrected-participants.csv"
LATEST_COMPLETENESS_SOURCE_PATH = OUTPUT_DIR / "latest_completeness_source.json"
RECONCILIATION_PATH = OUTPUT_DIR / "complex-emotions-form-reconciliation.csv"
SUMMARY_PATH = OUTPUT_DIR / "complex-emotions-form-summary.json"
CONTACT_LIST_PATH = OUTPUT_DIR / "complex-emotions-form-contact-list.csv"


# These pairs have a clear name or Telegram-handle connection, but need an
# explicit override because punctuation, a typo, or a duplicate attempt makes
# automatic matching ambiguous.
MANUAL_MATCHES = {
    "Алиса Лобзина/HorixMorka": "Алиса Лобзина",
    "@monlightchainsaw": "Лукин Кирилл moonlightchainsaw",
    "Колябина Виктория": "@Viktoria_kolyabina",
    "Трофимов @oshibAchka": "Трофимов Георгий",
    "Баринова Софья (Sof (@sofico444)": "Софья Бар  (Sof (@sofico444)",
    "@irrem_ia Тихонова Ирина": "Тихонова Ирина",
    "Полетаева/qwiizlls": "Полетаева Дарья 109 группа",
    "@aalely (Алексеева Алевтина)": "Алексеева Алевтина",
    "elizavetaarnis": "Могилевич Елизавета",
    "@nastasia_tt": "Терешина Анастасия, 109",
    "@ny_meow": "Ершова Мария",
    "Храбрых Мария": "@suzuranme",
    "Жариков Александр": "@whothefuckisk2up",
}

FORM_EXCLUSIONS = {
    "Сухова Софья": "dropout: did not reach the photo-test save step",
    "Белялова Рената @renatabelka": "dropout: responses were not saved",
}

CONTACT_LIST_FIELDS = [
    "priority",
    "form_identifier",
    "test_status",
    "matched_test_participant",
    "stimulus_set_id",
    "responses",
    "session_group",
    "large_group",
]


def read_csv(path):
    with path.open("r", encoding="utf-8-sig", newline="") as source:
        return list(csv.DictReader(source))


def write_csv(path, rows, fieldnames):
    with path.open("w", encoding="utf-8-sig", newline="") as target:
        writer = csv.DictWriter(target, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def parse_form_datetime(value):
    return datetime.strptime(value.strip(), "%Y/%m/%d %I:%M:%S %p GMT+3")


def normalize(value):
    return str(value or "").strip().casefold().replace("ё", "е")


def compact(value):
    return "".join(re.findall(r"[a-zа-я0-9]+", normalize(value)))


def tokens(value):
    return {
        token
        for token in re.findall(r"[a-zа-я0-9]+", normalize(value))
        if len(token) >= 3 and not token.isdigit() and token not in {"группа"}
    }


def is_test_identifier(value):
    normalized = normalize(value)
    return (
        normalized in {"т", "t", "test", "тест", "1"}
        or "smoke" in normalized
        or "тестов" in normalized
    )


def automatic_match(form_identifier, test_rows):
    form_compact = compact(form_identifier)
    form_tokens = tokens(form_identifier)
    candidates = []
    for row in test_rows:
        test_identifier = row["participant"]
        test_compact = compact(test_identifier)
        test_tokens = tokens(test_identifier)
        common = form_tokens & test_tokens
        score = 0
        basis = ""
        if form_compact == test_compact:
            score, basis = 100, "exact normalized identifier"
        elif min(len(form_compact), len(test_compact)) >= 5 and (
            form_compact in test_compact or test_compact in form_compact
        ):
            score, basis = 95, "identifier contained in the other identifier"
        elif any(len(token) >= 4 for token in common):
            # A single exact Telegram handle is enough. A single name token is
            # accepted only when one identifier is a single-token value.
            handle_match = any(
                token in normalize(form_identifier).replace("@", " @").split()
                and f"@{token}" in normalize(form_identifier)
                or f"@{token}" in normalize(test_identifier)
                for token in common
            )
            if handle_match:
                score, basis = 92, "exact Telegram handle"
            elif len(common) >= 2:
                score, basis = 88, "two or more exact name tokens"
            elif len(form_tokens) == 1 or len(test_tokens) == 1:
                score, basis = 80, "single distinctive identifier token"
        if score:
            candidates.append((score, row["status"] == "complete", row, basis))
    if not candidates:
        return None, ""
    candidates.sort(key=lambda item: (item[0], item[1]), reverse=True)
    best = candidates[0]
    if len(candidates) > 1 and candidates[1][:2] == best[:2]:
        return None, ""
    return best[2], best[3]


form_path = next(Path.home().joinpath("Downloads").glob(FORM_GLOB))
with form_path.open("r", encoding="utf-8-sig", newline="") as source:
    reader = csv.reader(source)
    headers = next(reader)
    form_rows = list(reader)

test_rows = read_csv(TEST_RESULTS_PATH)
latest_completeness_source = json.loads(
    LATEST_COMPLETENESS_SOURCE_PATH.read_text(encoding="utf-8")
)
completeness_path = Path.home() / "Downloads" / latest_completeness_source["file"]
completeness_rows = read_csv(completeness_path)
detailed_complete_keys = {
    (compact(row["participant"]), row["stimulus_set_id"])
    for row in test_rows
    if row["status"] == "complete"
}
for row in completeness_rows:
    participant = row["participant_identifier"]
    stimulus_set_id = row["stimulus_set_id"]
    key = (compact(participant), stimulus_set_id)
    if (
        row["status"] == "OK"
        and int(row["unique_photos"] or 0) >= 60
        and not is_test_identifier(participant)
        and key not in detailed_complete_keys
    ):
        test_rows.append({
            "participant": participant,
            "participant_original": participant,
            "stimulus_set_id": stimulus_set_id,
            "status": "complete",
            "responses": row["photo_answers"],
            "source": "supabase_completeness_only",
        })
test_by_name = {row["participant"]: row for row in test_rows}

parsed_rows = []
previous_timestamp = None
session_group = 0
for source_row_number, row in enumerate(form_rows, start=2):
    timestamp = parse_form_datetime(row[0])
    if previous_timestamp is None or (timestamp - previous_timestamp).total_seconds() > 30 * 60:
        session_group += 1
    previous_timestamp = timestamp

    form_identifier = row[1].strip()
    manual_name = MANUAL_MATCHES.get(form_identifier)
    if manual_name:
        test_row = test_by_name[manual_name]
        match_basis = "manual verified alias"
    else:
        test_row, match_basis = automatic_match(form_identifier, test_rows)

    test_status = test_row["status"] if test_row else "unmatched"
    exclusion_note = FORM_EXCLUSIONS.get(form_identifier, "")
    if exclusion_note:
        test_status = "dropout"

    parsed_rows.append({
        "source_row": source_row_number,
        "form_timestamp": timestamp.isoformat(sep=" "),
        "form_identifier": form_identifier,
        "raw_hall_answer": row[2].strip(),
        "session_group": session_group,
        "large_group": "1,3,5" if session_group % 2 else "2,4,6",
        "matched_test_participant": test_row["participant"] if test_row else "",
        "stimulus_set_id": test_row["stimulus_set_id"] if test_row else "",
        "test_status": test_status,
        "responses": test_row["responses"] if test_row else "",
        "match_source": test_row.get("source", "") if test_row else "",
        "match_basis": match_basis,
        "exclusion_note": exclusion_note,
    })

matched_test_names = {
    row["matched_test_participant"]
    for row in parsed_rows
    if row["matched_test_participant"]
}
unmatched_test_rows = [
    {
        "participant": row["participant"],
        "stimulus_set_id": row["stimulus_set_id"],
        "status": row["status"],
        "responses": row["responses"],
    }
    for row in test_rows
    if row["participant"] not in matched_test_names
]


def distribution(rows):
    by_set_all_matched = Counter(
        row["stimulus_set_id"] for row in rows if row["stimulus_set_id"]
    )
    by_set_complete = Counter(
        row["stimulus_set_id"]
        for row in rows
        if row["test_status"] == "complete"
    )
    status = Counter(row["test_status"] for row in rows)
    return {
        "form_people": len(rows),
        "status": dict(sorted(status.items())),
        "test_set_distribution_all_matched": dict(sorted(by_set_all_matched.items())),
        "test_set_distribution_complete_only": dict(sorted(by_set_complete.items())),
    }


summary = {
    "source_form": str(form_path),
    "source_test_results": str(TEST_RESULTS_PATH),
    "source_supabase_completeness": str(completeness_path),
    "form_rows": len(parsed_rows),
    "session_groups_detected": session_group,
    "session_group_rule": "new group after a timestamp gap greater than 30 minutes",
    "overall": distribution(parsed_rows),
    "large_groups": {
        large_group: distribution([
            row for row in parsed_rows if row["large_group"] == large_group
        ])
        for large_group in ("1,3,5", "2,4,6")
    },
    "not_confirmed_complete_test": [
        row for row in parsed_rows if row["test_status"] != "complete"
    ],
    "unmatched_test_records": unmatched_test_rows,
}

OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
write_csv(RECONCILIATION_PATH, parsed_rows, list(parsed_rows[0]))
contact_rows = []
for row in parsed_rows:
    if row["test_status"] in {"complete", "dropout"}:
        continue
    contact_rows.append({
        "priority": "1 - started but incomplete"
        if row["test_status"] == "incomplete"
        else "2 - no confident test match",
        "form_identifier": row["form_identifier"],
        "test_status": row["test_status"],
        "matched_test_participant": row["matched_test_participant"],
        "stimulus_set_id": row["stimulus_set_id"],
        "responses": row["responses"],
        "session_group": row["session_group"],
        "large_group": row["large_group"],
    })
write_csv(CONTACT_LIST_PATH, contact_rows, CONTACT_LIST_FIELDS)
SUMMARY_PATH.write_text(
    json.dumps(summary, ensure_ascii=False, indent=2),
    encoding="utf-8",
)

print(json.dumps(summary, ensure_ascii=False, indent=2))
print(f"RECONCILIATION={RECONCILIATION_PATH}")
print(f"CONTACT_LIST={CONTACT_LIST_PATH}")
print(f"SUMMARY={SUMMARY_PATH}")
