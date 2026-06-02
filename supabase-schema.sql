create table if not exists public.experiment_sessions (
  session_id uuid primary key,
  created_at timestamptz not null default now(),
  participant_id uuid not null,
  participant_identifier text not null,
  participant_age integer not null check (participant_age between 1 and 120),
  participant_gender text not null,
  institution text not null,
  screen_width integer not null,
  screen_height integer not null,
  viewport_width integer not null,
  viewport_height integer not null,
  device_pixel_ratio numeric not null,
  stimulus_set_id text not null,
  questionnaire_answers jsonb not null,
  user_agent text
);

alter table public.experiment_sessions enable row level security;

grant insert on public.experiment_sessions to anon;

drop policy if exists "anonymous participants can insert sessions" on public.experiment_sessions;
create policy "anonymous participants can insert sessions"
on public.experiment_sessions
for insert
to anon
with check (true);

create index if not exists experiment_sessions_created_at_idx
on public.experiment_sessions (created_at);

create table if not exists public.experiment_responses (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  session_id uuid not null,
  participant_id uuid not null,
  participant_name text not null,
  participant_age integer not null check (participant_age between 1 and 120),
  participant_gender text not null,
  screen_width integer not null,
  screen_height integer not null,
  viewport_width integer not null,
  viewport_height integer not null,
  device_pixel_ratio numeric not null,
  stimulus_set_id text not null,
  stimulus_id text not null,
  stimulus_order integer not null,
  stimulus_type text not null check (stimulus_type in ('number', 'image')),
  stimulus_value text,
  answer text not null check (answer in ('Y', 'N')),
  recognized boolean,
  memory_text text,
  reaction_time_ms integer check (reaction_time_ms is null or reaction_time_ms >= 0),
  shown_at timestamptz not null,
  user_agent text
);

alter table public.experiment_responses enable row level security;

grant insert on public.experiment_responses to anon;

drop policy if exists "anonymous participants can insert responses" on public.experiment_responses;
create policy "anonymous participants can insert responses"
on public.experiment_responses
for insert
to anon
with check (true);

create index if not exists experiment_responses_session_idx
on public.experiment_responses (session_id, stimulus_order);

create unique index if not exists experiment_responses_session_order_unique_idx
on public.experiment_responses (session_id, stimulus_order);

create index if not exists experiment_responses_created_at_idx
on public.experiment_responses (created_at);
