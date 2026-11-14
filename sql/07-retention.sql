-- 小事打卡 · 第 7 步：90 天前的照片自动清理
--
-- 为什么要这一步：免费版照片空间只有 1 GB。照片按 150 KB/张、9 人每天 2–3 张算，
-- 大约 8–10 个月满；满了以后是「上传直接失败」，不是变慢。
--
-- 为什么不能用纯 SQL 删：数据库里删 attachments 行，Storage 里的文件还在（S3 上的实体），
-- 空间照样占着。必须调 Storage 的删除接口，而这个接口要 service key。
-- 所以做法是：service key 存进 Supabase Vault → 函数从 Vault 取 → pg_net 发 HTTP 请求 → 再删数据库行。
--
-- 执行顺序：
--   ① 先单独跑一次下面这句（把密钥换成你自己的，跑完不要留在编辑器里）：
--      select vault.create_secret('粘贴你的 sb_secret_... 或 service_role 那个 JWT', 'service_role_key', '清理 90 天前照片用');
--   ② 再整份跑本文件。
--
-- 安全说明：本函数 revoke 掉了 anon / authenticated 的调用权限，只有 SQL Editor 和 cron（postgres 身份）能跑。
-- 密钥只存在 Vault 里，不会出现在前端，也不会进到任何表字段。

begin;

-- pg_net：让数据库能发 HTTP 请求
create extension if not exists pg_net;

-- 每次清理的记录，方便回头看「到底跑没跑、删了多少」
create table if not exists purge_log (
  id       bigserial primary key,
  ran_at   timestamptz not null default now(),
  keep_days int not null,
  photos   int not null,
  requests int not null,
  note     text
);

create or replace function public.purge_old_photos(p_days int default 90, p_max int default 200)
returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare
  c_base text := 'https://mtkuieogemgpdvacphhs.supabase.co';
  v_key  text;
  r      record;
  n_photos int := 0;
  n_req    int := 0;
begin
  select decrypted_secret into v_key
    from vault.decrypted_secrets
   where name = 'service_role_key'
   limit 1;

  if v_key is null or v_key = '' then
    raise exception 'missing_service_role_key_in_vault';
  end if;

  for r in
    select a.id, a.path, a.thumb_path
      from attachments a
      join checkins c on c.id = a.checkin_id
     where c.date < public.today_cn() - p_days
     order by c.date
     limit p_max
  loop
    -- 单个对象删除，不用 body，pg_net 的 http_delete 够用
    perform net.http_delete(
      c_base || '/storage/v1/object/shared/' || r.path,
      '{}'::jsonb,
      jsonb_build_object('Authorization', 'Bearer ' || v_key, 'apikey', v_key)
    );
    n_req := n_req + 1;

    if r.thumb_path is not null and r.thumb_path <> '' then
      perform net.http_delete(
        c_base || '/storage/v1/object/shared/' || r.thumb_path,
        '{}'::jsonb,
        jsonb_build_object('Authorization', 'Bearer ' || v_key, 'apikey', v_key)
      );
      n_req := n_req + 1;
    end if;

    -- 文件删完再删行；打卡文字记录不受影响
    delete from attachments where id = r.id;
    n_photos := n_photos + 1;
  end loop;

  insert into purge_log(keep_days, photos, requests)
  values (p_days, n_photos, n_req);

  return jsonb_build_object('keep_days', p_days, 'photos', n_photos, 'requests', n_req);
end $$;

-- 只有 postgres（SQL Editor / cron）能调，前端和普通用户都调不了
revoke all on function public.purge_old_photos(int, int) from public, anon, authenticated;

-- 每天北京时间 04:10 跑一次（cron 用 UTC，20:10 UTC = 04:10 次日 CST）
do $$
begin
  if exists (select 1 from cron.job where jobname = 'purge_old_photos') then
    perform cron.unschedule('purge_old_photos');
  end if;
end $$;

select cron.schedule(
  'purge_old_photos',
  '10 20 * * *',
  $$select public.purge_old_photos(90, 200);$$
);

commit;

-- 自检（单独执行）：
-- select jobname, schedule, active from cron.job where jobname = 'purge_old_photos';
-- select * from purge_log order by ran_at desc limit 10;
-- 手动先跑一次看看（不等到凌晨）：
-- select public.purge_old_photos(90, 200);
-- 还剩多少照片、占多少字节：
-- select count(*) as photos, pg_size_pretty(sum(bytes)::bigint) as total from attachments;
