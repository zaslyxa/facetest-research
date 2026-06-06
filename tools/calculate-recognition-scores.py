import csv
import json
import re
from collections import Counter, defaultdict
from pathlib import Path
from statistics import mean, median


ROOT = Path(r"C:\Users\azaslavets\Facetest")
OUTPUT_DIR = ROOT / "outputs" / "facetest-results"
MANIFEST_PATH = ROOT / "data" / "photo-sets.json"
REGISTRY_PATH = OUTPUT_DIR / "facetest-results-current.csv"
ANSWERS_PATH = OUTPUT_DIR / "manual_answers.json"
SCORES_PATH = OUTPUT_DIR / "facetest-recognition-scores-preview.csv"
SUMMARY_PATH = OUTPUT_DIR / "facetest-recognition-scores-preview.json"


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


def read_csv(path):
    with path.open("r", encoding="utf-8-sig", newline="") as source:
        return list(csv.DictReader(source))


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_csv(path, rows):
    fieldnames = list(rows[0]) if rows else []
    with path.open("w", encoding="utf-8-sig", newline="") as target:
        writer = csv.DictWriter(target, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


manifest = read_json(MANIFEST_PATH)
registry = read_csv(REGISTRY_PATH)
manual_answers = read_json(ANSWERS_PATH)

expected_by_set = {}
for photo_set in manifest["sets"]:
    expected = {}
    for stimulus in photo_set["stimuli"]:
        if stimulus["type"] != "image":
            continue
        filename = Path(stimulus["src"]).stem
        expected[stimulus["id"]] = "Y" if "_" in filename else "N"
    expected_by_set[photo_set["id"]] = expected

answers_by_session = defaultdict(list)
for row in manual_answers:
    answers_by_session[str(row["session_id"])].append(row)

selected_local_sessions = []
for row in registry:
    if row["completed_with_local_csv"] != "YES" or row["local_csv_added"] != "YES":
        continue
    session_id = str(row["local_csv_session_id"])
    selected_local_sessions.append((row, session_id))

scores = []
errors = []
for registry_row, session_id in selected_local_sessions:
    rows = answers_by_session.get(session_id, [])
    stimulus_set_id = registry_row["stimulus_set_id"]
    expected = expected_by_set.get(stimulus_set_id, {})
    unique_orders = {str(row["stimulus_order"]) for row in rows}
    unique_stimuli = {str(row["stimulus_id"]) for row in rows}
    if len(rows) != 60 or len(unique_orders) != 60 or len(unique_stimuli) != 60:
        errors.append({
            "participant": registry_row["participant_display_name"],
            "session_id": session_id,
            "reason": (
                f"rows={len(rows)} unique_orders={len(unique_orders)} "
                f"unique_stimuli={len(unique_stimuli)}"
            ),
        })
        continue

    unknown_stimuli = sorted(unique_stimuli - set(expected))
    if unknown_stimuli:
        errors.append({
            "participant": registry_row["participant_display_name"],
            "session_id": session_id,
            "reason": f"unknown_stimuli={unknown_stimuli}",
        })
        continue

    counters = Counter()
    for row in rows:
        stimulus_id = str(row["stimulus_id"])
        answer = str(row["answer"])
        expected_answer = expected[stimulus_id]
        counters["actual_y" if answer == "Y" else "actual_n"] += 1
        counters["expected_y" if expected_answer == "Y" else "expected_n"] += 1
        if answer == expected_answer:
            counters["score"] += 1
            counters["correct_y" if expected_answer == "Y" else "correct_n"] += 1
        else:
            counters["missed_y" if expected_answer == "Y" else "false_y"] += 1

    scores.append({
        "participant": registry_row["participant_display_name"],
        "stimulus_set_id": stimulus_set_id,
        "session_id": session_id,
        "score": counters["score"],
        "score_percent": round(counters["score"] / 60 * 100, 1),
        "correct_y_of_20": counters["correct_y"],
        "correct_n_of_40": counters["correct_n"],
        "missed_y": counters["missed_y"],
        "false_y": counters["false_y"],
        "answers_y": counters["actual_y"],
        "answers_n": counters["actual_n"],
        "source_file": registry_row["local_csv_file"],
    })

scores.sort(key=lambda row: (-row["score"], participant_key(row["participant"])))
for index, row in enumerate(scores, start=1):
    row["rank"] = index
scores = [
    {
        "rank": row["rank"],
        "participant": row["participant"],
        "stimulus_set_id": row["stimulus_set_id"],
        "score": row["score"],
        "score_percent": row["score_percent"],
        "correct_y_of_20": row["correct_y_of_20"],
        "correct_n_of_40": row["correct_n_of_40"],
        "missed_y": row["missed_y"],
        "false_y": row["false_y"],
        "answers_y": row["answers_y"],
        "answers_n": row["answers_n"],
        "session_id": row["session_id"],
        "source_file": row["source_file"],
    }
    for row in scores
]

completed_registry = [
    row for row in registry
    if row["completed_with_local_csv"] == "YES"
]

summary_by_set = {}
for stimulus_set_id in sorted(expected_by_set):
    set_scores = [row["score"] for row in scores if row["stimulus_set_id"] == stimulus_set_id]
    summary_by_set[stimulus_set_id] = {
        "scored_people": len(set_scores),
        "average_score": round(mean(set_scores), 2) if set_scores else None,
        "median_score": median(set_scores) if set_scores else None,
        "min_score": min(set_scores) if set_scores else None,
        "max_score": max(set_scores) if set_scores else None,
    }

score_values = [row["score"] for row in scores]
summary = {
    "status": "preliminary",
    "rule": "underscore in photo filename => expected Y; otherwise expected N; matching answer => 1 point",
    "scored_people": len(scores),
    "completed_people_in_registry": len(completed_registry),
    "not_scored_completed_people": len(completed_registry) - len(scores),
    "coverage_percent": round(len(scores) / len(completed_registry) * 100, 1)
    if completed_registry else 0,
    "average_score": round(mean(score_values), 2) if score_values else None,
    "median_score": median(score_values) if score_values else None,
    "min_score": min(score_values) if score_values else None,
    "max_score": max(score_values) if score_values else None,
    "by_set": summary_by_set,
    "validation_errors": errors,
    "scores_file": SCORES_PATH.name,
}

OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
write_csv(SCORES_PATH, scores)
SUMMARY_PATH.write_text(
    json.dumps(summary, ensure_ascii=False, indent=2),
    encoding="utf-8",
)

print(json.dumps(summary, ensure_ascii=False, indent=2))
print("TOP_10")
for row in scores[:10]:
    print(f'{row["rank"]:>2}. {row["participant"]}: {row["score"]}/60')
print(f"SCORES={SCORES_PATH}")
