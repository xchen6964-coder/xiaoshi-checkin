-- 小事打卡 · 第 5 步：注册即确认（不依赖控制台那个开关）
-- 背景：Dashboard 里 Confirm email 的位置改过几版，找不到也没关系 ——
--       在数据库层把「邮箱已确认」直接写上，效果一样，而且以后新建项目也能一键复现。
-- 代价：邮箱不再验证真实性。这与「邮箱 + 密码自助注册」的取舍一致，见 docs/21。

begin;

-- 新用户插入 auth.users 时，立刻补上确认时间。
-- 必须 security definer：插入动作是以 supabase_auth_admin 身份跑的，它没有权限改自己的表。
create or replace function public.auto_confirm_signup() returns trigger
language plpgsql security definer set search_path = auth, public, pg_temp
as $$
begin
  if new.email_confirmed_at is null then
    update auth.users
       set email_confirmed_at = now(),
           updated_at = now()
     where id = new.id;
  end if;
  return null;
end $$;

drop trigger if exists auto_confirm_signup on auth.users;
create trigger auto_confirm_signup
  after insert on auth.users
  for each row execute function public.auto_confirm_signup();

-- 回填：刚才注册但卡在「未确认」的账号（包括你刚试的那一个）
update auth.users
   set email_confirmed_at = now(),
       updated_at = now()
 where email_confirmed_at is null
   and email is not null;

commit;

-- 自检：应看到 0 行未确认
-- select count(*) from auth.users where email_confirmed_at is null;
