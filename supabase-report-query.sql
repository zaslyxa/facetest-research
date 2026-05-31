select
  participant_name as "ID испытуемого",
  concat(screen_width, 'x', screen_height) as "Размер экрана",
  stimulus_id as "ID стимула",
  answer as "Y/N",
  reaction_time_ms as "Время реакции, мс"
from public.experiment_responses
order by created_at, session_id, stimulus_order;
