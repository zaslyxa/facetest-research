import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path


ROOT = Path(r"C:\Users\azaslavets\Facetest")
ENV_PATH = ROOT / ".env.local"
PAYLOAD_PATH = ROOT / "outputs" / "facetest-results" / "import_payload.json"
RESPONSE_FIELDS = {
    "id",
    "session_id",
    "participant_id",
    "participant_name",
    "participant_age",
    "participant_gender",
    "screen_width",
    "screen_height",
    "viewport_width",
    "viewport_height",
    "device_pixel_ratio",
    "stimulus_set_id",
    "stimulus_id",
    "stimulus_order",
    "stimulus_type",
    "stimulus_value",
    "answer",
    "recognized",
    "memory_text",
    "reaction_time_ms",
    "shown_at",
    "user_agent",
}


def load_env(path):
    values = {}
    if not path.exists():
        raise RuntimeError(f"Missing local credentials file: {path}")

    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        values[key.strip()] = value.strip()
    return values


def normalize(value):
    return re.sub(r"\s+", " ", str(value or "").strip()).casefold()


def created_at_value(row):
    return datetime.fromisoformat(str(row["created_at"]).replace("Z", "+00:00"))


def request_json(method, url, key, body=None, prefer=None):
    headers = {
        "apikey": key,
        "Content-Type": "application/json",
    }
    if key.count(".") == 2:
        headers["Authorization"] = f"Bearer {key}"
    if prefer:
        headers["Prefer"] = prefer

    data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            content = response.read().decode("utf-8")
            return json.loads(content) if content else None
    except urllib.error.HTTPError as error:
        content = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{method} {url} failed: HTTP {error.code}: {content}") from error


env = load_env(ENV_PATH)
supabase_url = env.get("SUPABASE_URL", "").rstrip("/")
secret_key = env.get("SUPABASE_SECRET_KEY", "")
if not supabase_url or not secret_key or secret_key == "PASTE_SB_SECRET_KEY_HERE":
    raise RuntimeError("SUPABASE_URL and SUPABASE_SECRET_KEY are required in .env.local")
if not PAYLOAD_PATH.exists():
    raise RuntimeError(f"Missing reconciled import payload: {PAYLOAD_PATH}")

payload = json.loads(PAYLOAD_PATH.read_text(encoding="utf-8"))
by_session = defaultdict(list)
raw_by_session = defaultdict(list)
for raw_row in payload:
    raw_by_session[raw_row["session_id"]].append(raw_row)
    row = {key: value for key, value in raw_row.items() if key in RESPONSE_FIELDS}
    by_session[row["session_id"]].append(row)

session_ids = sorted(by_session)
quoted_ids = ",".join(session_ids)
filters = urllib.parse.urlencode({
    "select": "session_id,stimulus_order",
    "session_id": f"in.({quoted_ids})",
})
responses_url = f"{supabase_url}/rest/v1/experiment_responses?{filters}"
existing_rows = request_json("GET", responses_url, secret_key) or []
existing_counts = Counter(row["session_id"] for row in existing_rows)

sessions_filters = urllib.parse.urlencode({
    "select": "session_id,participant_identifier,stimulus_set_id,created_at",
})
sessions_url = f"{supabase_url}/rest/v1/experiment_sessions?{sessions_filters}"
existing_sessions = request_json("GET", sessions_url, secret_key) or []
existing_session_ids = {row["session_id"] for row in existing_sessions}
latest_session_by_participant_set = {}
for row in existing_sessions:
    key = (normalize(row["participant_identifier"]), row["stimulus_set_id"])
    previous = latest_session_by_participant_set.get(key)
    if previous is None or created_at_value(row) > created_at_value(previous):
        latest_session_by_participant_set[key] = row

missing_sessions = [session_id for session_id in session_ids if session_id not in existing_session_ids]
unrecoverable_sessions = []
for session_id in missing_sessions:
    sample = raw_by_session[session_id][0]
    questionnaire_answers = sample.get("questionnaire_answers")
    institution = sample.get("session_institution")
    if not questionnaire_answers or not institution:
        unrecoverable_sessions.append(session_id)
        continue

    session_row = {
        "session_id": session_id,
        "participant_id": sample["participant_id"],
        "participant_identifier": sample["participant_name"],
        "participant_age": int(sample["participant_age"]),
        "participant_gender": sample["participant_gender"],
        "institution": institution,
        "screen_width": int(sample["screen_width"]),
        "screen_height": int(sample["screen_height"]),
        "viewport_width": int(sample["viewport_width"]),
        "viewport_height": int(sample["viewport_height"]),
        "device_pixel_ratio": float(sample["device_pixel_ratio"]),
        "stimulus_set_id": sample["stimulus_set_id"],
        "questionnaire_answers": json.loads(questionnaire_answers),
        "user_agent": sample.get("user_agent") or None,
    }
    request_json(
        "POST",
        f"{supabase_url}/rest/v1/experiment_sessions",
        secret_key,
        session_row,
        prefer="return=minimal",
    )
    existing_session_ids.add(session_id)
    existing_sessions.append({
        "session_id": session_id,
        "participant_identifier": session_row["participant_identifier"],
        "stimulus_set_id": session_row["stimulus_set_id"],
        "created_at": datetime.now().astimezone().isoformat(),
    })
    print(f"IMPORTED_SESSION session_id={session_id}")

if unrecoverable_sessions:
    raise RuntimeError(f"Questionnaire sessions are missing in Supabase: {unrecoverable_sessions}")

latest_session_by_participant_set = {}
for row in existing_sessions:
    key = (normalize(row["participant_identifier"]), row["stimulus_set_id"])
    previous = latest_session_by_participant_set.get(key)
    if previous is None or created_at_value(row) > created_at_value(previous):
        latest_session_by_participant_set[key] = row

to_import = []
skipped = []
skipped_older = []
active_session_ids = []
for session_id in session_ids:
    rows = by_session[session_id]
    if len(rows) != 60 or len({row["stimulus_id"] for row in rows}) != 60:
        raise RuntimeError(f"Session {session_id} is not a complete 60-photo export")

    sample = rows[0]
    key = (normalize(sample["participant_name"]), sample["stimulus_set_id"])
    latest_session = latest_session_by_participant_set.get(key)
    if latest_session is None:
        raise RuntimeError(f"No questionnaire session found for emergency export {session_id}")
    if latest_session["session_id"] != session_id:
        skipped_older.append(session_id)
        print(
            "SKIPPED_OLDER_SESSION "
            f"session_id={session_id} latest_session_id={latest_session['session_id']} "
            f"latest_created_at={latest_session['created_at']}"
        )
        continue

    active_session_ids.append(session_id)
    existing_count = existing_counts[session_id]
    if existing_count == 0:
        to_import.append(session_id)
    elif existing_count == 60:
        skipped.append(session_id)
    else:
        raise RuntimeError(
            f"Session {session_id} already has {existing_count} response rows; manual review required"
        )

insert_url = f"{supabase_url}/rest/v1/experiment_responses"
for session_id in to_import:
    request_json("POST", insert_url, secret_key, by_session[session_id], prefer="return=minimal")
    print(f"IMPORTED session_id={session_id} rows={len(by_session[session_id])}")

verify_rows = request_json("GET", responses_url, secret_key) or []
verify_counts = Counter(row["session_id"] for row in verify_rows)
invalid = {
    session_id: verify_counts[session_id]
    for session_id in active_session_ids
    if verify_counts[session_id] != 60
}
if invalid:
    raise RuntimeError(f"Post-import verification failed: {invalid}")

verified_rows = sum(verify_counts[session_id] for session_id in active_session_ids)
print(f"VERIFIED sessions={len(active_session_ids)} rows={verified_rows}")
print(
    f"IMPORTED_SESSIONS={len(to_import)} "
    f"SKIPPED_ALREADY_PRESENT={len(skipped)} "
    f"SKIPPED_OLDER_SESSION={len(skipped_older)}"
)
