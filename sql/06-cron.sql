-- 小事打卡 · 第 6 步：每分钟的到点提醒定时任务
-- 前置：01~03 已跑过（03 里的 enqueue_due_reminders 支持无身份调用）
-- 作用：不再依赖「有人打开 app」才补提醒，到点会自己写进通知表。

begin;

-- Supabase 自带 pg_cron 扩展，启用一次即可
create extension if not exists pg_cron;

-- 先清掉同名任务，避免重复跑两遍
do $$
begin
  if exists (select 1 from cron.job where jobname = 'checkin_reminders') then
    perform cron.unschedule('checkin_reminders');
  end if;
end $$;

-- 每分钟一次。cron 任务以 postgres 身份跑，没有 JWT，
-- 函数里会走「处理所有组」的分支。
select cron.schedule(
  'checkin_reminders',
  '* * * * *',
  $$select public.enqueue_due_reminders();$$
);

commit;

-- 自检（跑完单独执行这两句）：
-- select jobname, schedule, active from cron.job where jobname = 'checkin_reminders';
-- select status, return_message, start_time from cron.job_run_details order by start_time desc limit 5;
