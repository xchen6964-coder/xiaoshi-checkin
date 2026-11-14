-- 小事打卡 · 第 3 步：16 个业务函数（前端直接 rpc 调用的全部入口）
-- 前置：01-schema.sql、02-rls.sql
-- 全部 security definer：函数内绕过 RLS，所以每个入口自己校验身份与归属。
-- 报错文案与前端 app.js 里的 map 一一对应（invite_invalid / nickname_taken 等），改文案会让前端提示变空白。

begin;

-- ============ 通用小工具 ============

-- 6 位十六进制码；p_col 指定检查哪一列，两套码互不碰撞
create or replace function public.gen_unique_code(p_kind text) returns text
language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare c text; n int := 0;
begin
  loop
    c := upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6));
    n := n + 1;
    if p_kind = 'invite' then
      exit when not exists (select 1 from groups where invite_code = c or teacher_code = c);
    else
      exit when not exists (select 1 from groups where teacher_code = c or invite_code = c);
    end if;
    if n > 50 then raise exception 'code_generation_failed'; end if;
  end loop;
  return c;
end $$;

create or replace function public.assert_nickname(p_nick text) returns text
language plpgsql immutable
as $$
declare v text := btrim(coalesce(p_nick, ''));
begin
  if length(v) < 2 or length(v) > 12 then raise exception 'nickname_invalid'; end if;
  return v;
end $$;

-- 今天（按上海时间划天，与产品口径一致）
create or replace function public.today_cn() returns date
language sql stable
as $$ select (now() at time zone 'Asia/Shanghai')::date $$;

-- ============ 1. my_context ============
create or replace function public.my_context() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare uid text := public.jwt_uid();
        u users%rowtype;
begin
  if uid is null then raise exception 'not_authenticated'; end if;

  select * into u from users
   where auth_uid = uid and is_current and active
   limit 1;

  return jsonb_build_object(
    'user', case when u.id is null then null else to_jsonb(u) end,
    'group', (
      select to_jsonb(g) from groups g where g.id = u.group_id
    ),
    'groups', coalesce((
      select jsonb_agg(jsonb_build_object(
               'group_id', x.group_id,
               'group_name', x.name,
               'role', x.role,
               'invite_code', x.invite_code,
               'is_current', x.is_current
             ) order by x.created_at)
        from (
          select m.group_id, m.role, m.is_current, m.created_at, g.name, g.invite_code
            from users m join groups g on g.id = m.group_id
           where m.auth_uid = uid and m.active
        ) x
    ), '[]'::jsonb)
  );
end $$;

-- ============ 2. create_group ============
create or replace function public.create_group(p_name text, p_nickname text) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare uid text := public.jwt_uid();
        v_nick text;
        gid uuid := gen_random_uuid();
        nid uuid := gen_random_uuid();
        v_invite text;
        v_teacher text;
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  v_nick := public.assert_nickname(p_nickname);
  if coalesce(btrim(p_name), '') = '' then raise exception 'name_invalid'; end if;

  v_invite := public.gen_unique_code('invite');
  v_teacher := public.gen_unique_code('teacher');

  insert into groups(id, name, invite_code, teacher_code, owner_id)
  values (gid, btrim(p_name), v_invite, v_teacher, nid);

  update users set is_current = false where auth_uid = uid;

  insert into users(id, group_id, auth_uid, nickname, role, is_current)
  values (nid, gid, uid, v_nick, 'owner', true);

  update groups set leader_id = nid where id = gid;

  return jsonb_build_object('group_id', gid, 'invite_code', v_invite, 'teacher_code', v_teacher, 'role', 'owner');
end $$;

-- ============ 3/4. 加入（成员码 / 教师码） ============
create or replace function public.join_group_impl(p_invite text, p_nickname text, p_teacher boolean) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare uid text := public.jwt_uid();
        v_nick text;
        g groups%rowtype;
        gid uuid;
        v_role user_role := case when p_teacher then 'teacher'::user_role else 'member'::user_role end;
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  v_nick := public.assert_nickname(p_nickname);

  if p_teacher then
    select * into g from groups where teacher_code = upper(btrim(p_invite));
    if g.id is null then raise exception 'teacher_code_invalid'; end if;
  else
    select * into g from groups where invite_code = upper(btrim(p_invite));
    if g.id is null then raise exception 'invite_invalid'; end if;
  end if;
  gid := g.id;

  if exists (select 1 from users where auth_uid = uid and group_id = gid) then
    raise exception 'already_in_group';
  end if;
  if exists (select 1 from users where group_id = gid and nickname = v_nick) then
    raise exception 'nickname_taken';
  end if;

  update users set is_current = false where auth_uid = uid;

  insert into users(group_id, auth_uid, nickname, role, is_current)
  values (gid, uid, v_nick, v_role, true);

  return jsonb_build_object('group_id', gid, 'role', v_role);
end $$;

create or replace function public.join_group(p_invite text, p_nickname text) returns jsonb
language sql volatile security definer set search_path = public, pg_temp
as $$ select public.join_group_impl(p_invite, p_nickname, false) $$;

create or replace function public.join_as_teacher(p_code text, p_nickname text) returns jsonb
language sql volatile security definer set search_path = public, pg_temp
as $$ select public.join_group_impl(p_code, p_nickname, true) $$;

-- ============ 5. switch_group ============
create or replace function public.switch_group(p_group_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare uid text := public.jwt_uid();
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  if not exists (select 1 from users where auth_uid = uid and group_id = p_group_id and active) then
    raise exception 'not_in_group';
  end if;
  -- 必须分两步：users 上有「每个 auth_uid 只能有一行 is_current」的部分唯一索引，
  -- 一条 UPDATE 里把旧行关掉、新行打开会中途撞索引。先全关，再开目标行。
  update users set is_current = false where auth_uid = uid and is_current;
  update users set is_current = true where auth_uid = uid and group_id = p_group_id and active;
  return jsonb_build_object('group_id', p_group_id);
end $$;

-- ============ 6/7. 负责人增删 ============
create or replace function public.set_leader(p_user_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare me users%rowtype; t users%rowtype;
begin
  select * into me from users where auth_uid = public.jwt_uid() and is_current and active limit 1;
  if me.id is null then raise exception 'not_authenticated'; end if;
  if me.role <> 'owner' then raise exception 'not_owner'; end if;

  select * into t from users where id = p_user_id and group_id = me.group_id;
  if t.id is null then raise exception 'user_not_found'; end if;
  if t.role = 'owner' then raise exception 'cannot_change_admin'; end if;
  if t.role = 'teacher' then raise exception 'teacher_cannot_lead'; end if;
  if t.role = 'leader' then return jsonb_build_object('status', 'already'); end if;
  if not t.active then raise exception 'user_inactive'; end if;

  update users set role = 'leader' where id = t.id;
  update groups set leader_id = coalesce(leader_id, t.id) where id = me.group_id;
  return jsonb_build_object('status', 'ok');
end $$;

create or replace function public.unset_leader(p_user_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare me users%rowtype; t users%rowtype; first_leader uuid;
begin
  select * into me from users where auth_uid = public.jwt_uid() and is_current and active limit 1;
  if me.id is null then raise exception 'not_authenticated'; end if;
  if me.role <> 'owner' then raise exception 'not_owner'; end if;

  select * into t from users where id = p_user_id and group_id = me.group_id;
  if t.id is null then raise exception 'user_not_found'; end if;
  if t.role <> 'leader' then raise exception 'not_leader'; end if;

  update users set role = 'member' where id = t.id;

  select id into first_leader from users
   where group_id = me.group_id and role = 'leader' and active
   order by created_at limit 1;
  update groups set leader_id = first_leader where id = me.group_id;
  return jsonb_build_object('status', 'ok');
end $$;

-- ============ 8. request_handover ============
create or replace function public.request_handover(p_to_user_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare me users%rowtype; t users%rowtype; hid uuid;
begin
  select * into me from users where auth_uid = public.jwt_uid() and is_current and active limit 1;
  if me.id is null then raise exception 'not_authenticated'; end if;
  if me.role <> 'leader' then raise exception 'not_leader'; end if;

  select * into t from users where id = p_to_user_id and group_id = me.group_id;
  if t.id is null then raise exception 'user_not_found'; end if;
  if t.role = 'teacher' then raise exception 'teacher_cannot_lead'; end if;
  if not t.active then raise exception 'user_inactive'; end if;

  -- 同一个人只留一条待处理
  update handovers set status = 'expired'
   where group_id = me.group_id and status = 'pending' and from_user_id = me.id;

  insert into handovers(group_id, from_user_id, to_user_id, status)
  values (me.group_id, me.id, t.id, 'pending')
  returning id into hid;

  return jsonb_build_object('handover_id', hid);
end $$;

-- ============ 9. respond_handover ============
-- 交接是「移交」语义：接受方升 leader，发起方降回 member，其他负责人不动
create or replace function public.respond_handover(p_id uuid, p_accept boolean) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare me users%rowtype; h handovers%rowtype;
begin
  select * into me from users where auth_uid = public.jwt_uid() and is_current and active limit 1;
  if me.id is null then raise exception 'not_authenticated'; end if;

  select * into h from handovers where id = p_id and status = 'pending';
  if h.id is null then raise exception 'handover_not_found'; end if;
  if h.to_user_id <> me.id then raise exception 'not_addressee'; end if;

  if not p_accept then
    update handovers set status = 'declined', responded_at = now() where id = h.id;
    return jsonb_build_object('status', 'declined');
  end if;

  update handovers set status = 'accepted', responded_at = now() where id = h.id;
  update users set role = 'leader' where id = h.to_user_id;
  update users set role = 'member' where id = h.from_user_id and role = 'leader';
  update groups set leader_id = h.to_user_id where id = h.group_id;
  return jsonb_build_object('status', 'accepted');
end $$;

-- ============ 10. set_member_role（成员 ↔ 教师） ============
create or replace function public.set_member_role(p_user_id uuid, p_role user_role) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare me users%rowtype; t users%rowtype;
begin
  select * into me from users where auth_uid = public.jwt_uid() and is_current and active limit 1;
  if me.id is null then raise exception 'not_authenticated'; end if;
  if me.role not in ('owner', 'leader', 'teacher') then raise exception 'not_admin'; end if;

  if p_role not in ('member', 'teacher') then raise exception 'invalid_role'; end if;

  select * into t from users where id = p_user_id and group_id = me.group_id;
  if t.id is null then raise exception 'user_not_found'; end if;
  if t.id = me.id then raise exception 'cannot_change_self'; end if;
  if t.role in ('owner', 'leader') then raise exception 'cannot_change_admin'; end if;

  update users set role = p_role where id = t.id;
  return jsonb_build_object('status', 'ok', 'role', p_role);
end $$;

-- ============ 11. set_member_active ============
create or replace function public.set_member_active(p_user_id uuid, p_active boolean) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare me users%rowtype; t users%rowtype;
begin
  select * into me from users where auth_uid = public.jwt_uid() and is_current and active limit 1;
  if me.id is null then raise exception 'not_authenticated'; end if;
  if me.role not in ('owner', 'leader', 'teacher') then raise exception 'not_admin'; end if;

  select * into t from users where id = p_user_id and group_id = me.group_id;
  if t.id is null then raise exception 'user_not_found'; end if;
  if t.role = 'owner' then raise exception 'cannot_change_admin'; end if;
  if t.id = me.id and not p_active then raise exception 'cannot_change_self'; end if;

  -- 只动 active。不要顺手把 is_current 关掉：关掉之后恢复时没人把它打开，
  -- 这个人再登录会「查不到身份」，等于永久踢出（本地测试抓到过）。
  update users set active = p_active where id = t.id;
  return jsonb_build_object('status', 'ok', 'active', p_active);
end $$;

-- ============ 12. set_checkin_status（补记 ↔ 按时） ============
create or replace function public.set_checkin_status(p_checkin_id uuid, p_status checkin_status) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare me users%rowtype; c checkins%rowtype;
begin
  select * into me from users where auth_uid = public.jwt_uid() and is_current and active limit 1;
  if me.id is null then raise exception 'not_authenticated'; end if;
  if me.role not in ('owner', 'leader', 'teacher') then raise exception 'not_admin'; end if;
  if p_status not in ('on_time', 'late') then raise exception 'invalid_status'; end if;

  select * into c from checkins where id = p_checkin_id and group_id = me.group_id;
  if c.id is null then raise exception 'checkin_not_found'; end if;
  if c.user_id = me.id then raise exception 'checkin_not_updatable'; end if;
  if c.task_id is null then raise exception 'checkin_not_updatable'; end if;
  if c.status not in ('on_time', 'late') then raise exception 'checkin_not_updatable'; end if;

  update checkins set status = p_status, updated_at = now() where id = c.id;
  return jsonb_build_object('status', 'ok', 'checkin_status', p_status);
end $$;

-- ============ 13. set_excused_today ============
create or replace function public.set_excused_today(p_user_id uuid, p_on boolean) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare me users%rowtype; t users%rowtype; d date := public.today_cn(); n int := 0; r int;
begin
  select * into me from users where auth_uid = public.jwt_uid() and is_current and active limit 1;
  if me.id is null then raise exception 'not_authenticated'; end if;
  if me.role not in ('owner', 'leader', 'teacher') then raise exception 'not_admin'; end if;

  select * into t from users where id = p_user_id and group_id = me.group_id;
  if t.id is null then raise exception 'user_not_found'; end if;

  if p_on then
    insert into checkins(group_id, user_id, task_id, title, date, status)
    select me.group_id, t.id, tk.id, tk.title, d, 'excused'
      from tasks tk
     where tk.group_id = me.group_id and not tk.archived
       and not exists (
         select 1 from checkins c
          where c.user_id = t.id and c.date = d
            and (c.task_id = tk.id or (c.task_id is null and c.status <> 'excused'))
       );
    get diagnostics n = row_count;
  else
    delete from checkins where user_id = t.id and date = d and status = 'excused';
    get diagnostics n = row_count;
  end if;

  return jsonb_build_object('affected', n);
end $$;

-- ============ 14/15. 重生成两套码 ============
create or replace function public.regenerate_invite() returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare me users%rowtype; c text;
begin
  select * into me from users where auth_uid = public.jwt_uid() and is_current and active limit 1;
  if me.id is null then raise exception 'not_authenticated'; end if;
  if me.role <> 'owner' then raise exception 'not_owner'; end if;
  c := public.gen_unique_code('invite');
  update groups set invite_code = c where id = me.group_id;
  return jsonb_build_object('invite_code', c);
end $$;

create or replace function public.regenerate_teacher_code() returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare me users%rowtype; c text;
begin
  select * into me from users where auth_uid = public.jwt_uid() and is_current and active limit 1;
  if me.id is null then raise exception 'not_authenticated'; end if;
  if me.role <> 'owner' then raise exception 'not_owner'; end if;
  c := public.gen_unique_code('teacher');
  update groups set teacher_code = c where id = me.group_id;
  return jsonb_build_object('teacher_code', c);
end $$;

-- ============ 16. enqueue_due_reminders ============
-- 两种调用方式：
--   ① 前端打开通知面板时调（带 JWT）→ 只处理自己所在的组
--   ② pg_cron 每分钟调（无 JWT）  → 处理所有组，见 06-cron.sql
-- 同一任务同一人当天只发一条（靠 notifications 的唯一索引兜底）。
create or replace function public.enqueue_due_reminders() returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare uid text := public.jwt_uid();
        v_group uuid;
        d date := public.today_cn();
        t_time time := (now() at time zone 'Asia/Shanghai')::time;
        n int := 0;
begin
  if uid is not null then
    v_group := public.my_group();
    -- 登录了但不在任何组（刚注册还没进组）：什么都不做，避免顺手替所有组生成提醒
    if v_group is null then return jsonb_build_object('enqueued', 0); end if;
  end if;

  insert into notifications(group_id, user_id, kind, title, body, task_id, channel)
  select tk.group_id, u.id, 'task_reminder',
         coalesce(tk.emoji || ' ', '') || tk.title || ' 快到点了',
         '截止 ' || to_char(tk.deadline_time, 'HH24:MI') || '，还没打卡',
         tk.id, 'inapp'
    from tasks tk
    join users u on u.group_id = tk.group_id and u.active and u.role <> 'teacher'
   where (v_group is null or tk.group_id = v_group)
     and not tk.archived
     and tk.reminder_offset > 0
     and t_time >= (tk.deadline_time - make_interval(mins => tk.reminder_offset))
     and t_time <= tk.deadline_time
     and not exists (
       select 1 from checkins c
        where c.user_id = u.id and c.task_id = tk.id and c.date = d
     )
  on conflict do nothing;

  get diagnostics n = row_count;
  return jsonb_build_object('enqueued', n);
end $$;

-- ============ 授权 ============
grant execute on function
  public.my_context(),
  public.create_group(text, text),
  public.join_group(text, text),
  public.join_as_teacher(text, text),
  public.switch_group(uuid),
  public.set_leader(uuid),
  public.unset_leader(uuid),
  public.request_handover(uuid),
  public.respond_handover(uuid, boolean),
  public.set_member_role(uuid, user_role),
  public.set_member_active(uuid, boolean),
  public.set_checkin_status(uuid, checkin_status),
  public.set_excused_today(uuid, boolean),
  public.regenerate_invite(),
  public.regenerate_teacher_code(),
  public.enqueue_due_reminders()
to authenticated;

revoke execute on function public.join_group_impl(text, text, boolean) from public, anon, authenticated;
revoke execute on function public.gen_unique_code(text) from public, anon, authenticated;

commit;
