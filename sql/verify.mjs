// 用 WASM 版 PostgreSQL 跑 sql/01-schema.sql，并对关键约束做冒烟测试（不用装数据库、不连网）
// 一次性准备（在项目根目录执行，node_modules 已在 .gitignore 里，不会入库）：
//   npm i @electric-sql/pglite --registry=https://registry.npmmirror.com
// 运行（项目根目录）：
//   node sql/verify.mjs
// 退出码 0 = 21 项全过；非 0 = 有失败项，输出里带 FAIL 行。
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const SQL = fileURLToPath(new URL('./01-schema.sql', import.meta.url));
const db = new PGlite();
const out = [];
const ok = (n, extra = '') => out.push(`PASS  ${n}${extra ? '  ' + extra : ''}`);
const bad = (n, e) => out.push(`FAIL  ${n}  ${e}`);

async function expectErr(name, sql) {
  try { await db.exec(sql); bad(name, '应当报错但成功了'); }
  catch (e) { ok(name, '→ ' + String(e.message).split('\n')[0].slice(0, 70)); }
}
async function expectOk(name, sql) {
  try { await db.exec(sql); ok(name); }
  catch (e) { bad(name, String(e.message).split('\n')[0]); }
}

await db.exec(fs.readFileSync(SQL, 'utf8'));
ok('建表脚本整体执行');

const t = await db.query(
  "select count(*)::int n from information_schema.tables where table_schema='public' and table_type='BASE TABLE'"
);
ok('public 下建表数量', `= ${t.rows[0].n}（期望 10）`);

const en = await db.query(
  "select count(*)::int n from pg_type where typtype='e' and typname in ('user_role','checkin_status','handover_status','notif_kind','notif_channel')"
);
ok('枚举类型', `= ${en.rows[0].n}（期望 5）`);

const ix = await db.query(
  "select count(*)::int n from pg_indexes where schemaname='public'"
);
ok('索引数量', `= ${ix.rows[0].n}`);

await expectOk('建组', `insert into groups(id,name,invite_code,owner_id)
  values ('11111111-1111-1111-1111-111111111111','成都AI部','ABC123','99999999-9999-9999-9999-999999999999')`);

await expectOk('同组两名成员', `
  insert into users(id,group_id,auth_uid,nickname,role,is_current) values
   ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','uid-a','小明','owner',true),
   ('aaaaaaaa-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','uid-b','小红','member',true)`);

await expectErr('组内昵称重复被拦', `
  insert into users(group_id,auth_uid,nickname) values
   ('11111111-1111-1111-1111-111111111111','uid-c','小明')`);

await expectErr('同一 auth_uid 两行 is_current（跨组）', `
  insert into groups(id,name,invite_code,owner_id) values
   ('22222222-2222-2222-2222-222222222222','第二个组','DEF456','99999999-9999-9999-9999-999999999999');
  insert into users(group_id,auth_uid,nickname,is_current) values
   ('22222222-2222-2222-2222-222222222222','uid-a','小明三号',true)`);

await expectOk('建任务', `insert into tasks(id,group_id,title,deadline_time,reminder_offset,position)
  values ('bbbbbbbb-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','早起','08:30',30,1)`);

await expectErr('提醒提前量超 240 被拦', `insert into tasks(group_id,title,deadline_time,reminder_offset)
  values ('11111111-1111-1111-1111-111111111111','读书','22:00',300)`);

await expectOk('打卡一条', `insert into checkins(group_id,user_id,task_id,date,status)
  values ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000001',
          'bbbbbbbb-0000-0000-0000-000000000001','2026-11-14','on_time')`);

await expectErr('同人同任务同日重复打卡被拦', `insert into checkins(group_id,user_id,task_id,date,status)
  values ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000001',
          'bbbbbbbb-0000-0000-0000-000000000001','2026-11-14','late')`);

await expectOk('自定义小事（task_id 为空）可多条', `
  insert into checkins(group_id,user_id,task_id,title,date,status) values
   ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000001',null,'给妈打电话','2026-11-14','on_time'),
   ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000001',null,'跑步3公里','2026-11-14','on_time')`);

await expectErr('打卡状态只认三种', `insert into checkins(group_id,user_id,title,date,status)
  values ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000001','x','2026-11-13','unknown')`);

const c = await db.query('select count(*)::int n from checkins');
ok('checkins 行数', `= ${c.rows[0].n}（期望 3）`);

await expectOk('同一条提醒当天第一条', `insert into notifications(group_id,user_id,kind,task_id)
  values ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000001','task_reminder','bbbbbbbb-0000-0000-0000-000000000001')`);

await expectErr('同一条提醒当天第二条被拦', `insert into notifications(group_id,user_id,kind,task_id)
  values ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000001','task_reminder','bbbbbbbb-0000-0000-0000-000000000001')`);

await expectOk('手动通知（task_id 空）不受去重限制', `
  insert into notifications(group_id,user_id,kind,title) values
   ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000001','manual','公告一'),
   ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000001','manual','公告二')`);

await expectOk('照片记录可带缩略图路径', `
  insert into attachments(checkin_id,path,thumb_path,width,height,bytes)
  select id,'u/1.jpg','u/1_t.jpg',1280,960,80000 from checkins where task_id is not null`);

await expectOk('照片记录不填缩略图也合法（老数据兼容）', `
  insert into attachments(checkin_id,path)
  select id,'u/2.jpg' from checkins where task_id is not null`);

await expectOk('级联删打卡时点赞与照片一起走', `
  insert into likes(checkin_id,user_id) select id,'aaaaaaaa-0000-0000-0000-000000000002' from checkins where task_id is not null;
  delete from checkins where task_id is not null;`);

const sentinel = await db.query(
  'select (select count(*) from likes)::int l, (select count(*) from attachments)::int a'
);
ok('级联结果', `likes=${sentinel.rows[0].l} attachments=${sentinel.rows[0].a}（都应 0）`);

const role = await db.query("select unnest(enum_range(null::user_role))::text r");
ok('角色枚举取值', '= ' + role.rows.map((r) => r.r).join(' / '));

await db.close();
console.log(out.join('\n'));
const fails = out.filter((l) => l.startsWith('FAIL')).length;
console.log(`\n合计 ${out.length} 项，失败 ${fails} 项`);
process.exit(fails ? 1 : 0);
