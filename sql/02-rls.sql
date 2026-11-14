-- 小事打卡 · 第 2 步：身份助手、显式授权、行级权限策略
-- 前置：先跑 01-schema.sql
-- 目标：新项目关掉了「自动暴露新表」，所以这里必须显式 grant；RLS 全部打开，没写策略的表默认锁死。

begin;

-- ============ 身份助手 ============
-- 不直接用 auth.uid()，改读 PostgREST 注入的 JWT claims：
-- 这样本地 WASM PostgreSQL 也能跑同一套策略做测试，不必装 Supabase。
create or replace function public.jwt_uid() returns text
language plpgsql stable
as $$
declare raw text;
begin
  raw := current_setting('request.jwt.claims', true);
  if raw is null or raw = '' then return null; end if;
  return raw::jsonb ->> 'sub';
exception when others then
  return null;
end $$;

-- 以下四个都是 security definer：内部读 users 表时绕过 RLS，
-- 否则「users 的策略又去查 users」会无限递归。search_path 钉死防注入。
create or replace function public.my_user_id() returns uuid
language sql stable security definer set search_path = public, pg_temp
as $$
  select u.id from users u
   where u.auth_uid = public.jwt_uid() and u.is_current and u.active
   limit 1
$$;

create or replace function public.my_group() returns uuid
language sql stable security definer set search_path = public, pg_temp
as $$
  select u.group_id from users u
   where u.auth_uid = public.jwt_uid() and u.is_current and u.active
   limit 1
$$;

create or replace function public.my_role() returns user_role
language sql stable security definer set search_path = public, pg_temp
as $$
  select u.role from users u
   where u.auth_uid = public.jwt_uid() and u.is_current and u.active
   limit 1
$$;

-- 管理权：站长 / 负责人 / 教师（11-09 加的角色）
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(
    (select u.role in ('owner', 'leader', 'teacher')
       from users u
      where u.auth_uid = public.jwt_uid() and u.is_current and u.active
      limit 1), false)
$$;

create or replace function public.checkin_in_my_group(cid uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (
    select 1 from checkins c
     where c.id = cid and c.group_id = public.my_group()
  )
$$;

create or replace function public.checkin_is_mine(cid uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (
    select 1 from checkins c
     where c.id = cid and c.user_id = public.my_user_id()
  )
$$;

-- ============ 显式授权 ============
grant usage on schema public to anon, authenticated;

grant select, insert, delete on
  groups, users, tasks, checkins, attachments, likes, handovers, notifications, summaries
  to authenticated;

-- 列级收窄：update 一律按列给，绝不给整表 update。
-- 原因（本地实测踩过）：整表 update 会盖掉列级限制，成员就能把自己 role 改成 owner 升权。
grant update (nickname, avatar_url)                                        on users         to authenticated;
grant update (note, updated_at)                                            on checkins      to authenticated;
grant update (read_at)                                                     on notifications to authenticated;
grant update (allow_member_custom, custom_deadline, wecom_webhook)         on groups        to authenticated;
grant update (title, emoji, deadline_time, reminder_offset, position, archived) on tasks    to authenticated;

-- group_secrets 故意不给任何权限：前端从不读写，只留 service_role。
revoke all on group_secrets from anon, authenticated;

-- ============ 打开 RLS ============
alter table groups        enable row level security;
alter table users         enable row level security;
alter table tasks         enable row level security;
alter table checkins      enable row level security;
alter table attachments   enable row level security;
alter table likes         enable row level security;
alter table handovers     enable row level security;
alter table notifications enable row level security;
alter table summaries     enable row level security;
alter table group_secrets enable row level security;

-- ============ 策略 ============

-- groups：本组可见；管理员可改组设置
drop policy if exists groups_select on groups;
create policy groups_select on groups for select to authenticated
  using (id = public.my_group());

drop policy if exists groups_update on groups;
create policy groups_update on groups for update to authenticated
  using (id = public.my_group() and public.is_admin())
  with check (id = public.my_group() and public.is_admin());

-- users：本组互相可见；只能改自己，且只能改昵称/头像（靠列级 grant 收口）
drop policy if exists users_select on users;
create policy users_select on users for select to authenticated
  using (group_id = public.my_group());

drop policy if exists users_update_self on users;
create policy users_update_self on users for update to authenticated
  using (id = public.my_user_id())
  with check (id = public.my_user_id());

-- 移除成员是管理员直接删行；站长那行谁都删不得
drop policy if exists users_delete on users;
create policy users_delete on users for delete to authenticated
  using (public.is_admin() and group_id = public.my_group() and role <> 'owner' and id <> public.my_user_id());

-- tasks：全组可读；管理员增删改
drop policy if exists tasks_select on tasks;
create policy tasks_select on tasks for select to authenticated
  using (group_id = public.my_group());

drop policy if exists tasks_insert on tasks;
create policy tasks_insert on tasks for insert to authenticated
  with check (group_id = public.my_group() and public.is_admin());

drop policy if exists tasks_update on tasks;
create policy tasks_update on tasks for update to authenticated
  using (group_id = public.my_group() and public.is_admin())
  with check (group_id = public.my_group() and public.is_admin());

drop policy if exists tasks_delete on tasks;
create policy tasks_delete on tasks for delete to authenticated
  using (group_id = public.my_group() and public.is_admin());

-- checkins：全组可读；只能给自己打卡（教师不打卡）；删自己的或管理员删
drop policy if exists checkins_select on checkins;
create policy checkins_select on checkins for select to authenticated
  using (group_id = public.my_group());

drop policy if exists checkins_insert on checkins;
create policy checkins_insert on checkins for insert to authenticated
  with check (
    group_id = public.my_group()
    and user_id = public.my_user_id()
    and coalesce(public.my_role(), 'member') <> 'teacher'
    and status <> 'excused'                                   -- 豁免只能管理员给
    and (task_id is null or exists (                         -- 不能挂到别组的任务上
      select 1 from tasks t where t.id = checkins.task_id and t.group_id = public.my_group()
    ))
  );

drop policy if exists checkins_update on checkins;
create policy checkins_update on checkins for update to authenticated
  using (user_id = public.my_user_id())
  with check (user_id = public.my_user_id());

drop policy if exists checkins_delete on checkins;
create policy checkins_delete on checkins for delete to authenticated
  using (user_id = public.my_user_id() or public.is_admin());

-- attachments：跟随打卡的可见性
drop policy if exists attachments_select on attachments;
create policy attachments_select on attachments for select to authenticated
  using (public.checkin_in_my_group(checkin_id));

drop policy if exists attachments_insert on attachments;
create policy attachments_insert on attachments for insert to authenticated
  with check (public.checkin_is_mine(checkin_id));

drop policy if exists attachments_delete on attachments;
create policy attachments_delete on attachments for delete to authenticated
  using (public.checkin_is_mine(checkin_id) or public.is_admin());

-- likes：全组可见；只能点自己的
drop policy if exists likes_select on likes;
create policy likes_select on likes for select to authenticated
  using (public.checkin_in_my_group(checkin_id));

drop policy if exists likes_insert on likes;
create policy likes_insert on likes for insert to authenticated
  with check (user_id = public.my_user_id() and public.checkin_in_my_group(checkin_id));

drop policy if exists likes_delete on likes;
create policy likes_delete on likes for delete to authenticated
  using (user_id = public.my_user_id());

-- handovers：全组可读；发起与响应都走函数；删成员时管理员清残留
drop policy if exists handovers_select on handovers;
create policy handovers_select on handovers for select to authenticated
  using (group_id = public.my_group());

drop policy if exists handovers_delete on handovers;
create policy handovers_delete on handovers for delete to authenticated
  using (group_id = public.my_group() and public.is_admin());

-- notifications：全组广播(user_id 为空) + 自己的；已读只能改自己的
drop policy if exists notifications_select on notifications;
create policy notifications_select on notifications for select to authenticated
  using (group_id = public.my_group() and (user_id is null or user_id = public.my_user_id() or public.is_admin()));

drop policy if exists notifications_update on notifications;
create policy notifications_update on notifications for update to authenticated
  using (user_id = public.my_user_id())
  with check (user_id = public.my_user_id());

-- summaries：全组可读，写入口在函数里
drop policy if exists summaries_select on summaries;
create policy summaries_select on summaries for select to authenticated
  using (group_id = public.my_group());

commit;
