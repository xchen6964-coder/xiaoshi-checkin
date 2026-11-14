-- 小事打卡 · 第 4 步：照片桶与访问策略
-- 前置：01~03 已跑过。Supabase 的 storage 有自己的 RLS，不建策略的话上传和读取都会失败。
-- 桶名 shared：私有桶，浏览器拿到的是 1 小时有效的签名链接，不是公开 URL。

-- 建桶（已存在就跳过）。5 MB 上限，只收图片。
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('shared', 'shared', false, 5242880, array['image/jpeg', 'image/png'])
on conflict (id) do update
  set public = false,
      file_size_limit = 5242880,
      allowed_mime_types = array['image/jpeg', 'image/png'];

-- 读：组里任何人都能看照片（打卡墙要展示别人的图）
drop policy if exists shared_read on storage.objects;
create policy shared_read on storage.objects for select to authenticated
  using (bucket_id = 'shared');

-- 写：只能往自己的目录里放（路径第一段是账号 uid，见 vendor/cloud-adapter.js 的 sharedPath）
drop policy if exists shared_insert_own on storage.objects;
create policy shared_insert_own on storage.objects for insert to authenticated
  with check (bucket_id = 'shared' and (storage.foldername(name))[1] = public.jwt_uid());

-- 改：同上，只动自己的
drop policy if exists shared_update_own on storage.objects;
create policy shared_update_own on storage.objects for update to authenticated
  using (bucket_id = 'shared' and (storage.foldername(name))[1] = public.jwt_uid())
  with check (bucket_id = 'shared' and (storage.foldername(name))[1] = public.jwt_uid());

-- 删：只删自己的。别人删打卡时留下的文件不在这里清（管理员删打卡只删数据库行），
-- 由后续「90 天清理」统一收尾。
drop policy if exists shared_delete_own on storage.objects;
create policy shared_delete_own on storage.objects for delete to authenticated
  using (bucket_id = 'shared' and (storage.foldername(name))[1] = public.jwt_uid());
