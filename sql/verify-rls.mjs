// 在 WASM PostgreSQL 里跑 01-schema + 02-rls，用假 JWT 扮演不同身份验证权限
// 运行（项目根目录）：node sql/verify-rls.mjs      退出码 0 = 全过
// 说明：本地模拟了 PostgREST 的 request.jwt.claims，因此策略里读 jwt_uid() 的行为与线上一致。
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (n) => fs.readFileSync(fileURLToPath(new URL(n, import.meta.url)), 'utf8');
const db = new PGlite();
const out = [];
const ok = (n, extra = '') => out.push(`PASS  ${n}${extra ? '  ' + extra : ''}`);
const bad = (n, e) => out.push(`FAIL  ${n}  ${e}`);

await db.exec(read('./01-schema.sql'));
await db.exec(`create role anon; create role authenticated;`);
await db.exec(read('./02-rls.sql'));

// ---------- 造数据（以 postgres 身份，绕过 RLS） ----------
const G1 = '11111111-1111-1111-1111-111111111111';
const G2 = '22222222-2222-2222-2222-222222222222';
const U1 = 'aaaaaaaa-0000-0000-0000-000000000001'; // 站长 uid-a
const U2 = 'aaaaaaaa-0000-0000-0000-000000000002'; // 成员 uid-b
const U3 = 'aaaaaaaa-0000-0000-0000-000000000003'; // 成员 uid-c
const U4 = 'aaaaaaaa-0000-0000-0000-000000000004'; // 教师 uid-t
const U5 = 'aaaaaaaa-0000-0000-0000-000000000005'; // 另一组站长 uid-z
const T1 = 'bbbbbbbb-0000-0000-0000-000000000001';
const C2 = 'cccccccc-0000-0000-0000-000000000002'; // U2 的打卡

await db.exec(`
insert into groups(id,name,invite_code,teacher_code,owner_id) values
 ('${G1}','成都AI部','ABC123','TCH123','${U1}'),
 ('${G2}','别的组','XYZ789',null,'${U5}');
insert into users(id,group_id,auth_uid,nickname,role,is_current) values
 ('${U1}','${G1}','uid-a','小明','owner',true),
 ('${U2}','${G1}','uid-b','小红','member',true),
 ('${U3}','${G1}','uid-c','小刚','member',true),
 ('${U4}','${G1}','uid-t','张老师','teacher',true),
 ('${U5}','${G2}','uid-z','外组人','owner',true);
insert into tasks(id,group_id,title,deadline_time,position) values
 ('${T1}','${G1}','早起','08:30',1);
insert into checkins(id,group_id,user_id,task_id,date,status,note) values
 ('${C2}','${G1}','${U2}','${T1}','2026-11-14','on_time','我起了');
insert into notifications(id,group_id,user_id,kind,title) values
 ('dddddddd-0000-0000-0000-000000000001','${G1}','${U2}','manual','给你的'),
 ('dddddddd-0000-0000-0000-000000000002','${G1}',null,'manual','全组公告');
`);

// ---------- 身份切换 ----------
async function as(uid) {
  await db.exec(`set role authenticated;`);
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]);
}
async function asAnon() {
  await db.exec(`set role anon;`);
}
async function asOwner() {
  await db.exec(`reset role;`);
}

async function rows(sql) {
  const r = await db.query(sql);
  return r.rows;
}
async function expectCount(name, sql, n) {
  try {
    const r = await rows(sql);
    if (r.length === n) ok(name, `= ${r.length} 行`);
    else bad(name, `期望 ${n} 行，实际 ${r.length} 行`);
  } catch (e) { bad(name, String(e.message).split('\n')[0]); }
}
async function expectErr(name, sql) {
  try { await db.exec(sql); bad(name, '应当被拒绝，但执行成功了'); }
  catch (e) { ok(name, '→ ' + String(e.message).split('\n')[0].slice(0, 58)); }
}

// 1. 未登录：连表都读不到（fail closed）
await asAnon();
await expectErr('anon 读 users 被拒', `select id from users limit 1`);

// 2. 普通成员：只看得到本组
await as('uid-b');
await expectCount('成员只看到本组 4 个人', `select id from users`, 4);
await expectCount('成员看不到另一组的人', `select id from users where id = '${U5}'`, 0);
await expectCount('成员只看到本组这一个组', `select id from groups`, 1);
await expectCount('成员看到本组打卡', `select id from checkins`, 1);
await expectCount('成员读不到别的组的打卡', `select id from checkins where group_id = '${G2}'`, 0);

// 3. 改自己 vs 改别人
await expectCount('改自己昵称：命中 1 行', `with u as (update users set nickname='小红2' where id='${U2}' returning id) select id from u`, 1);
await expectCount('改别人昵称：命中 0 行', `with u as (update users set nickname='被改' where id='${U1}' returning id) select id from u`, 0);
await expectErr('把自己升级成站长：被列级权限拦住', `update users set role='owner' where id='${U2}'`);

// 4. 建任务：成员不行，站长行
await expectErr('成员建任务被拒', `insert into tasks(group_id,title,deadline_time) values ('${G1}','成员偷偷建','09:00')`);
await as('uid-a');
await expectCount('站长建任务成功', `with t as (insert into tasks(group_id,title,deadline_time) values ('${G1}','站长建的','09:00') returning id) select id from t`, 1);
await expectErr('站长往别的组建任务被拒', `insert into tasks(group_id,title,deadline_time) values ('${G2}','跨组建','09:00')`);

// 5. 打卡：教师不能打，不能替别人打
await as('uid-t');
await expectErr('教师打卡被拒', `insert into checkins(group_id,user_id,date,status,title) values ('${G1}','${U4}','2026-11-14','on_time','教师打卡')`);
await as('uid-b');
await expectErr('替别人打卡被拒', `insert into checkins(group_id,user_id,date,status,title) values ('${G1}','${U3}','2026-11-14','on_time','冒名')`);
await expectCount('给自己加一条自定义小事成功', `with c as (insert into checkins(group_id,user_id,date,status,title) values ('${G1}','${U2}','2026-11-14','on_time','自己加的') returning id) select id from c`, 1);

// 6. 删打卡：自己的行，别人的不行，管理员行
await as('uid-c');
await expectCount('删别人的打卡：命中 0 行', `with d as (delete from checkins where id='${C2}' returning id) select id from d`, 0);
await as('uid-a');
await expectCount('站长删成员打卡：命中 1 行', `with d as (delete from checkins where id='${C2}' returning id) select id from d`, 1);

// 7. 通知：只看自己的 + 全组公告；已读只能改自己的
await as('uid-b');
await expectCount('成员看到自己的通知 + 全组公告', `select id from notifications`, 2);
await expectCount('标记自己的通知已读：1 行', `with n as (update notifications set read_at=now() where id='dddddddd-0000-0000-0000-000000000001' returning id) select id from n`, 1);
await expectCount('改全组公告的已读：0 行', `with n as (update notifications set read_at=now() where id='dddddddd-0000-0000-0000-000000000002' returning id) select id from n`, 0);

// 8. 附件跟随打卡：本组看得到，外组看不到
await asOwner();
await db.exec(`insert into attachments(checkin_id,path) select id,'u/1.jpg' from checkins where user_id='${U2}' limit 1`);
await as('uid-b');
await expectCount('成员看得到本组照片记录', `select id from attachments`, 1);
await as('uid-z');
await expectCount('外组看不到别人组的照片记录', `select id from attachments`, 0);

// 9. 组设置：管理员能改，成员不能
await as('uid-b');
await expectCount('成员改组设置：0 行', `with g as (update groups set wecom_webhook='x' where id='${G1}' returning id) select id from g`, 0);
await as('uid-a');
await expectCount('站长改组设置：1 行', `with g as (update groups set wecom_webhook='https://example.com/hook' where id='${G1}' returning id) select id from g`, 1);

// 10. 站长那行谁都删不掉（含站长自己）
await expectCount('站长删自己：0 行', `with d as (delete from users where id='${U1}' returning id) select id from d`, 0);

await db.close();
console.log(out.join('\n'));
const fails = out.filter((l) => l.startsWith('FAIL')).length;
console.log(`\n合计 ${out.length} 项，失败 ${fails} 项`);
process.exit(fails ? 1 : 0);
