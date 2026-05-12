create or replace view public.experiment_report_minimal as
select
  participant_id as participant_id,
  concat(screen_width, 'x', screen_height) as screen_size,
  stimulus_id as stimulus_id,
  answer as answer,
  case
    when answer = 'Y' then nullif(memory_text, '')
    else null
  end as memory_answer,
  reaction_time_ms as reaction_time_ms
from public.experiment_responses;
