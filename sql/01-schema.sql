-- 小事打卡 · 表结构（目标库第 1 步：只建表、约束、索引，不含 RLS 与业务函数）
-- 依据：docs/PRD.md §6（表定义）+ app.js 实际读写字段 + .workbuddy/memory 里 11-09 的教师角色改动
-- 目标库：任何 PostgreSQL 14+（Supabase / CloudBase PG 通用）
-- 执行：psql -f 01-schema.sql   或用 Supabase SQL Editor 整段粘贴

begin;

-- ---------- 枚举 ----------
do $$ begin
  create type user_role as enum ('owner', 'leader', 'teacher', 'member');
exception when duplicate_object then null; end $$;

do $$ begin
  create type checkin_status as enum ('on_time', 'late', 'excused');
exception when duplicate_object then null; end $$;

do $$ begin
  create type handover_status as enum ('pending', 'accepted', 'declined', 'expired');
exception when duplicate_object then null; end $$;

do $$ begin
  create type notif_kind as enum ('task_reminder', 'manual', 'handover', 'system');
exception when duplicate_object then null; end $$;

do $$ begin
  create type notif_channel as enum ('inapp', 'wecom');
exception when duplicate_object then null; end $$;

-- ---------- 组 ----------
create table if not exists groups (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,
  invite_code        text not null unique,
  teacher_code       text unique,                      -- 11-09 新增，与邀请码分开命名空间
  owner_id           uuid not null,
  leader_id          uuid,                             -- 多负责人后只记最早那位，前端不读
  allow_member_custom boolean not null default true,
  custom_deadline    time not null default '23:59',
  wecom_webhook      text,
  timezone           text not null default 'Asia/Shanghai',
  llm_model          text,                             -- v0.5 后废弃，保留
  created_at         timestamptz not null default now()
);

-- ---------- 成员 ----------
create table if not exists users (
  id         uuid primary key default gen_random_uuid(),
  group_id   uuid not null references groups(id) on delete cascade,
  auth_uid   text not null,                            -- 平台身份，对应 auth.uid()
  nickname   text not null,
  role       user_role not null default 'member',
  pin_hash   text,                                     -- 保留，v0.5 不用
  avatar_url text,
  is_current boolean not null default false,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  unique (group_id, auth_uid),                          -- 一人可多组
  unique (group_id, nickname)                            -- 组内昵称唯一
);

create index if not exists users_auth_uid_idx on users (auth_uid);
create index if not exists users_group_active_idx on users (group_id, active);
create unique index if not exists users_one_current_idx on users (auth_uid) where is_current;

-- ---------- 固定任务 ----------
create table if not exists tasks (
  id              uuid primary key default gen_random_uuid(),
  group_id        uuid not null references groups(id) on delete cascade,
  title           text not null check (char_length(title) <= 20),
  emoji           text,
  deadline_time   time not null,
  reminder_offset int not null default 0 check (reminder_offset between 0 and 240),  -- 0 = 不提醒
  position        int not null default 0,
  archived        boolean not null default false,
  created_by      uuid,
  created_at      timestamptz not null default now()
);

create index if not exists tasks_group_order_idx on tasks (group_id, archived, position);

-- ---------- 打卡记录 ----------
create table if not exists checkins (
  id         uuid primary key default gen_random_uuid(),
  group_id   uuid not null references groups(id) on delete cascade,
  user_id    uuid not null references users(id) on delete cascade,
  task_id    uuid references tasks(id) on delete cascade,   -- 空 = 成员自定义小事
  title      text,                                          -- 自定义小事的文字；固定任务存标题快照
  date       date not null,
  status     checkin_status not null default 'on_time',
  done_at    timestamptz not null default now(),
  note       text check (note is null or char_length(note) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  -- 同一人同一天同一任务只能一条；自定义小事 task_id 为 null，PG 视为互不相等，可多条
  unique (user_id, task_id, date)
);

create index if not exists checkins_group_date_idx on checkins (group_id, date);
create index if not exists checkins_user_date_idx on checkins (user_id, date);

-- ---------- 照片 ----------
create table if not exists attachments (
  id         uuid primary key default gen_random_uuid(),
  checkin_id uuid not null references checkins(id) on delete cascade,
  path       text not null,
  width      int,
  height     int,
  bytes      int,
  created_at timestamptz not null default now()
);

create index if not exists attachments_checkin_idx on attachments (checkin_id);

-- ---------- 点赞 ----------
create table if not exists likes (
  id         uuid primary key default gen_random_uuid(),
  checkin_id uuid not null references checkins(id) on delete cascade,
  user_id    uuid not null,
  created_at timestamptz not null default now(),
  unique (checkin_id, user_id)
);

create index if not exists likes_user_idx on likes (user_id);

-- ---------- 交接记录 ----------
create table if not exists handovers (
  id            uuid primary key default gen_random_uuid(),
  group_id      uuid not null references groups(id) on delete cascade,
  from_user_id  uuid not null,
  to_user_id    uuid not null,
  status        handover_status not null default 'pending',
  created_at    timestamptz not null default now(),
  responded_at  timestamptz
);

create index if not exists handovers_pending_idx on handovers (group_id, status);

-- ---------- 通知 ----------
create table if not exists notifications (
  id         uuid primary key default gen_random_uuid(),
  group_id   uuid not null references groups(id) on delete cascade,
  user_id    uuid,                                     -- 空 = 全组
  kind       notif_kind not null,
  title      text,
  body       text,
  task_id    uuid references tasks(id) on delete cascade,
  channel    notif_channel not null default 'inapp',
  read_at    timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists notifications_user_idx on notifications (user_id, created_at desc);
create index if not exists notifications_group_idx on notifications (group_id, created_at desc);

-- 同一条定时提醒，一个任务对一个人一天只发一次（按 Asia/Shanghai 划天）
create unique index if not exists notifications_dedup_idx
  on notifications (task_id, user_id, kind, ((created_at at time zone 'Asia/Shanghai')::date));

-- ---------- 总结存档 ----------
create table if not exists summaries (
  id          uuid primary key default gen_random_uuid(),
  group_id    uuid not null references groups(id) on delete cascade,
  range_start date not null,
  range_end   date not null,
  metrics     jsonb not null default '{}'::jsonb,
  llm_text    text,
  created_by  uuid,
  created_at  timestamptz not null default now()
);

-- ---------- 外部模型配置（v0.5 后废弃，保留表） ----------
create table if not exists group_secrets (
  group_id   uuid primary key references groups(id) on delete cascade,
  ext_name   text,
  ext_base   text,
  ext_model  text,
  ext_key    text,
  updated_at timestamptz not null default now()
);

commit;
