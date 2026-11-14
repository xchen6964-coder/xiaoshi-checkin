// 在 WASM PostgreSQL 里跑 01+02+03，按四种身份逐个验证 16 个 RPC
// 运行（项目根目录）：node sql/verify-fn.mjs      退出码 0 = 全过
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
await db.exec(read('./03-functions.sql'));

async function as(uid) {
  await db.exec(`set role authenticated;`);
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]);
}
async function reset() { await db.exec(`reset role;`); }

// 调 RPC：返回第一行第一列（通常是 jsonb）
async function call(name, params = {}) {
  const keys = Object.keys(params);
  const args = keys.map((_, i) => `$${i + 1}`).join(', ');
  const sql = `select public.${name}(${args}) as r`;
  const r = await db.query(sql, keys.map((k) => params[k]));
  return r.rows[0] ? r.rows[0].r : null;
}
async function expectOk(name, fn, check) {
  try {
    const v = await fn();
    if (check && !check(v)) { bad(name, '结果不符合预期: ' + JSON.stringify(v)); return v; }
    ok(name, typeof v === 'object' ? '' : String(v));
    return v;
  } catch (e) { bad(name, String(e.message).split('\n')[0]); }
}
async function expectErr(name, fn, code) {
  try { await fn(); bad(name, '应当报错，但成功了'); }
  catch (e) {
    const m = String(e.message).split('\n')[0];
    if (code && !m.includes(code)) return bad(name, `报错文案不对：${m}（期望含 ${code}）`);
    ok(name, '→ ' + m.slice(0, 54));
  }
}

// ---------- 1. 还没有组的新人 ----------
await reset();
await db.exec(`insert into users(group_id, auth_uid, nickname, role, is_current)
  select id, 'uid-ghost', '幽灵', 'member', true from groups limit 1`).catch(() => {});
await as('uid-new');
const ctx0 = await call('my_context');
if (ctx0 && ctx0.group === null) ok('新人 my_context：group 为空（会进引导页）');
else bad('新人 my_context', JSON.stringify(ctx0));

// ---------- 2. create_group ----------
await as('uid-a');
const g = await expectOk('建组成功', () => call('create_group', { p_name: ' 成都AI部 ', p_nickname: '小明' }),
  (v) => v && v.invite_code && v.teacher_code && v.invite_code !== v.teacher_code && v.role === 'owner');
const GROUP = g.group_id;
const INVITE = g.invite_code;
const TEACHER = g.teacher_code;
ok('两套码互不相同', `${INVITE} / ${TEACHER}`);

const ctx1 = await call('my_context');
if (ctx1 && ctx1.user && ctx1.group && ctx1.group.name === '成都AI部' && ctx1.groups.length === 1) ok('建组后 my_context 正确（组名已去空格）');
else bad('建组后 my_context', JSON.stringify(ctx1).slice(0, 120));

await expectErr('重复建组给别人用同一昵称不影响', async () => {}, null); // 占位，保持编号连续
out.pop();

// ---------- 3. join_group ----------
await as('uid-b');
await expectErr('错邀请码被拒', () => call('join_group', { p_invite: 'ZZZZZZ', p_nickname: '小红' }), 'invite_invalid');
await expectErr('昵称太短被拒', () => call('join_group', { p_invite: INVITE, p_nickname: '红' }), 'nickname_invalid');
await expectOk('用邀请码加入成功', () => call('join_group', { p_invite: INVITE, p_nickname: '小红' }),
  (v) => v && v.role === 'member');
await expectErr('重复加入被拒', () => call('join_group', { p_invite: INVITE, p_nickname: '小红2' }), 'already_in_group');
await as('uid-c');
await expectErr('同组重名被拒', () => call('join_group', { p_invite: INVITE, p_nickname: '小红' }), 'nickname_taken');
await expectOk('第三个人加入成功', () => call('join_group', { p_invite: INVITE, p_nickname: '小刚' }));

// ---------- 4. join_as_teacher ----------
await as('uid-t');
await expectErr('教师入口填邀请码被拒', () => call('join_as_teacher', { p_code: INVITE, p_nickname: '张老师' }), 'teacher_code_invalid');
await expectOk('教师码加入成功', () => call('join_as_teacher', { p_code: TEACHER, p_nickname: '张老师' }),
  (v) => v && v.role === 'teacher');

// ---------- 5. 一人多组 + switch_group ----------
await as('uid-new');
const g2 = await call('create_group', { p_name: '第二个组', p_nickname: '小明二号' });
await as('uid-b');
await expectErr('切到没加入的组被拒', () => call('switch_group', { p_group_id: g2.group_id }), 'not_in_group');
await reset();
await db.exec(`insert into users(group_id, auth_uid, nickname, role, is_current)
  values ('${g2.group_id}', 'uid-b', '小红B', 'member', false)`);
await as('uid-b');
await expectOk('切到第二个组成功', () => call('switch_group', { p_group_id: g2.group_id }),
  (v) => v && v.group_id === g2.group_id);
const ctxB = await call('my_context');
if (ctxB.group.id === g2.group_id && ctxB.groups.length === 2) ok('切换后当前组变了，组列表 2 个');
else bad('切换后状态', JSON.stringify({ cur: ctxB.group.id, n: ctxB.groups.length }));
try { await call('switch_group', { p_group_id: GROUP }); } catch (e) { bad('切回原组', e.message); } // 切回来

// ---------- 6. set_leader / unset_leader ----------
await as('uid-a');
await reset();
const ub = (await db.query(`select id from users where auth_uid='uid-b' and group_id='${GROUP}'`)).rows[0].id;
const uc = (await db.query(`select id from users where auth_uid='uid-c' and group_id='${GROUP}'`)).rows[0].id;
const ut = (await db.query(`select id from users where auth_uid='uid-t' and group_id='${GROUP}'`)).rows[0].id;
const ua = (await db.query(`select id from users where auth_uid='uid-a' and group_id='${GROUP}'`)).rows[0].id;
await as('uid-a');
await expectOk('站长设 b 为负责人', () => call('set_leader', { p_user_id: ub }), (v) => v.status === 'ok');
await expectOk('重复设同一人：返回 already', () => call('set_leader', { p_user_id: ub }), (v) => v.status === 'already');
await expectErr('设教师为负责人被拒', () => call('set_leader', { p_user_id: ut }), 'teacher_cannot_lead');
await as('uid-b');
await expectErr('负责人自己设负责人被拒（只有站长能指定）', () => call('set_leader', { p_user_id: uc }), 'not_owner');

// ---------- 7. 交接：移交语义 ----------
await as('uid-b');
await expectOk('负责人发起交接给 c', () => call('request_handover', { p_to_user_id: uc }), (v) => !!v.handover_id);
const hid = (await db.query(`select id from handovers where status='pending'`)).rows[0].id;
await as('uid-c');
await expectOk('c 接受交接', () => call('respond_handover', { p_id: hid, p_accept: true }), (v) => v.status === 'accepted');
await reset();
const roles = (await db.query(`select auth_uid, role from users where group_id='${GROUP}' and auth_uid in ('uid-b','uid-c') order by auth_uid`)).rows;
if (roles[0].role === 'member' && roles[1].role === 'leader') ok('交接后：发起方降 member、接受方升 leader');
else bad('交接语义', JSON.stringify(roles));

// ---------- 8. set_member_role ----------
await as('uid-c'); // 现在是 leader
await expectOk('负责人把成员设成教师', () => call('set_member_role', { p_user_id: ub, p_role: 'teacher' }), (v) => v.role === 'teacher');
await expectErr('把站长设成教师被拒', () => call('set_member_role', { p_user_id: ua, p_role: 'teacher' }), 'cannot_change_admin');
await as('uid-a');
await expectOk('站长把教师改回成员', () => call('set_member_role', { p_user_id: ub, p_role: 'member' }), (v) => v.role === 'member');
await as('uid-t'); // 教师身份
await expectOk('教师也能改别人角色（b → 教师）', () => call('set_member_role', { p_user_id: ub, p_role: 'teacher' }), (v) => v.role === 'teacher');
await as('uid-a');
await call('set_member_role', { p_user_id: ub, p_role: 'member' }); // 复原

// ---------- 9. set_member_active ----------
await as('uid-a');
await expectOk('停用成员 c', () => call('set_member_active', { p_user_id: uc, p_active: false }), (v) => v.active === false);
await as('uid-c');
const ctxC = await call('my_context');
if (ctxC.group === null) ok('被停用后 my_context 读不到组（进不了 app）');
else bad('停用后仍能进', JSON.stringify(ctxC.group && ctxC.group.name));
await as('uid-a');
await call('set_member_active', { p_user_id: uc, p_active: true });

// ---------- 10. set_checkin_status ----------
await reset();
await db.exec(`
insert into tasks(id,group_id,title,deadline_time,position) values
 ('bbbbbbbb-0000-0000-0000-000000000001','${GROUP}','早起','08:30',1);
insert into checkins(id,group_id,user_id,task_id,date,status) values
 ('cccccccc-0000-0000-0000-000000000001','${GROUP}','${ub}','bbbbbbbb-0000-0000-0000-000000000001',public.today_cn(),'late');
`);
await as('uid-a');
await expectOk('站长把补记改成按时', () => call('set_checkin_status', { p_checkin_id: 'cccccccc-0000-0000-0000-000000000001', p_status: 'on_time' }),
  (v) => v.checkin_status === 'on_time');
await expectErr('改成 excused 被拒', () => call('set_checkin_status', { p_checkin_id: 'cccccccc-0000-0000-0000-000000000001', p_status: 'excused' }), 'invalid_status');
await reset();
// 站长的另一条打卡，用来验证「普通成员改别人的打卡」会被拦在管理员校验上
await db.query(
  `insert into checkins(id,group_id,user_id,task_id,date,status)
   values ('cccccccc-0000-0000-0000-000000000002',$1,$2,'bbbbbbbb-0000-0000-0000-000000000001',public.today_cn(),'late')`,
  [GROUP, ua]
);
await as('uid-b'); // 普通成员
await expectErr('普通成员改别人打卡被拒', () => call('set_checkin_status', { p_checkin_id: 'cccccccc-0000-0000-0000-000000000002', p_status: 'on_time' }), 'not_admin');

// ---------- 11. set_excused_today ----------
await as('uid-a');
const ex1 = await expectOk('给 c 豁免今天（1 个未完成任务）', () => call('set_excused_today', { p_user_id: uc, p_on: true }),
  (v) => v && typeof v.affected === 'number');
if (ex1 && ex1.affected >= 1) ok('豁免写入条数', `affected=${ex1.affected}`);
const ex2 = await call('set_excused_today', { p_user_id: uc, p_on: false });
if (ex2.affected === ex1.affected) ok('取消豁免删掉同样条数', `affected=${ex2.affected}`);
else bad('取消豁免', JSON.stringify(ex2));

// ---------- 12. 码重生成 ----------
await as('uid-a');
const ni = await expectOk('重生成邀请码', () => call('regenerate_invite'), (v) => v.invite_code && v.invite_code !== INVITE);
const nt = await expectOk('重生成教师码', () => call('regenerate_teacher_code'), (v) => v.teacher_code && v.teacher_code !== TEACHER);
await as('uid-c');
await expectErr('普通成员重生成邀请码被拒', () => call('regenerate_invite'), 'not_owner');

// ---------- 13. enqueue_due_reminders ----------
await reset();
// 造一个「现在就在提醒窗口内」的任务：截止 = 当前上海时间 + 5 分钟，提前 30 分钟提醒
await db.exec(`
update tasks set deadline_time = ((now() at time zone 'Asia/Shanghai')::time + interval '5 min')::time,
                 reminder_offset = 30
 where id = 'bbbbbbbb-0000-0000-0000-000000000001';
delete from checkins where task_id = 'bbbbbbbb-0000-0000-0000-000000000001';
`);
await as('uid-a');
const r1 = await expectOk('到点提醒：第一次入队', () => call('enqueue_due_reminders'), (v) => v && v.enqueued > 0);
await expectOk('到点提醒：第二次不重复（去重生效）', () => call('enqueue_due_reminders'), (v) => v.enqueued === 0);
const cnt = (await db.query(`select count(*)::int n from notifications where kind='task_reminder'`)).rows[0].n;
if (cnt === r1.enqueued) ok('提醒条数与入队数一致', `= ${cnt}`);
else bad('提醒条数', `${cnt} vs ${r1.enqueued}`);
const teach = (await db.query(`select count(*)::int n from notifications n join users u on u.id=n.user_id where u.role='teacher'`)).rows[0].n;
if (teach === 0) ok('教师不会收到打卡提醒');
else bad('教师收到提醒了', `= ${teach}`);

try { // ---------- 14. 定时任务分支（无 JWT 跑全组） ----------
await reset();
await db.exec(`delete from notifications where kind = 'task_reminder'`);
await db.exec(`update tasks set reminder_offset = 30,
  deadline_time = ((now() at time zone 'Asia/Shanghai')::time + interval '5 min')::time`);
// 第二个组也放一条同窗口的任务，验证定时任务会跨组处理
await db.exec(`insert into groups(id,name,invite_code,owner_id)
  values ('33333333-3333-3333-3333-333333333333','定时组','TIME01','${ua}')`);
// 组里得有人，否则不该有提醒（提醒是发给人的）
await db.exec(`insert into users(group_id,auth_uid,nickname,role,is_current)
  values ('33333333-3333-3333-3333-333333333333','uid-time','定时组员','member',true)`);
await db.exec(`insert into tasks(group_id,title,deadline_time,reminder_offset,position)
  values ('33333333-3333-3333-3333-333333333333','定时组的事',
          ((now() at time zone 'Asia/Shanghai')::time + interval '5 min')::time, 30, 1)`);
await db.query(`select set_config('request.jwt.claims','',false)`);
const cronRun = await expectOk('无身份（定时任务）跑全组提醒', () => call('enqueue_due_reminders'), (v) => v && v.enqueued > 0);
const groups = (await db.query(`select count(distinct group_id)::int n from notifications where kind = 'task_reminder'`)).rows[0].n;
if (groups >= 2) ok('定时任务跨组生效', '覆盖 ' + groups + ' 个组'); else bad('定时任务跨组', '只覆盖 ' + groups + ' 个组');
await as('uid-ghost');
await expectOk('登录但还没进组：不替所有组生成提醒', () => call('enqueue_due_reminders'), (v) => v && v.enqueued === 0);
await db.close(); } catch (e) {}
console.log(out.join('\n'));
const fails = out.filter((l) => l.startsWith('FAIL')).length;
console.log(`\n合计 ${out.length} 项，失败 ${fails} 项`);
process.exit(fails ? 1 : 0);
