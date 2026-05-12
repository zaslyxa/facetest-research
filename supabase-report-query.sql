select
  created_at,
  session_id,
  participant_id,
  participant_name,
  participant_age,
  participant_gender,
  screen_width,
  screen_height,
  viewport_width,
  viewport_height,
  device_pixel_ratio,
  stimulus_set_id,
  stimulus_order,
  stimulus_id,
  stimulus_type,
  stimulus_value,
  answer,
  recognized,
  memory_text,
  reaction_time_ms,
  shown_at
from public.experiment_responses
order by created_at, session_id, stimulus_order;
