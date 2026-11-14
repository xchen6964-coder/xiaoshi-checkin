/* 小事打卡 · 前端主逻辑
   M2：登录、建组/加入、今日、进度、管理、我的
   照片与定时提醒在下一步接入 */

(function () {
  const cfg = window.APP_CONFIG || {};
  // 2026-11-14 起接自己的 Supabase：vendor/cloud-adapter.js 负责把下面这套调用转到 Supabase
  const sdk = window.SupabaseAdapter;
  const cloud = sdk ? sdk.createClient({ url: cfg.supabaseUrl, key: cfg.supabaseKey }) : null;

  function withTimeout(promise, ms, label) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error((label || 'request') + '_timeout')), ms))
    ]);
  }

  const app = document.getElementById('app');
  const sheetEl = document.getElementById('sheet');
  const sheetTitle = document.getElementById('sheet-title');
  const sheetBody = document.getElementById('sheet-body');
  const toastEl = document.getElementById('toast');

  const state = {
    session: null,
    me: null,
    group: null,
    groups: [],
    tasks: [],
    members: [],
    todayCheckins: [],
    weekCheckins: [],
    attachments: {},
    notifications: [],
    likes: [],
    handovers: [],
    myCheckins: [],
    inactive: [],
    allUsers: [],
    teachers: [],
    avatarUrls: {},
    loadError: '',
    wallTab: 'today',
    unread: 0,
    pendingPhotos: [],
    view: 'today',
    pendingOtp: null,
    resetTicket: null,
    otpTimer: null,
    otpLeft: 0
  };

  /* ---------- 工具 ---------- */
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  const todayStr = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  const nowHM = () => new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Shanghai', hour12: false }).slice(0, 5);
  const parseHM = (t) => String(t || '').slice(0, 5);

  function fmtDateCn(d) {
    const dt = new Date(d + 'T00:00:00+08:00');
    const w = '日一二三四五六'[dt.getDay()];
    return `${dt.getMonth() + 1}月${dt.getDate()}日 周${w}`;
  }

  function toast(msg, ms = 2200) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { toastEl.hidden = true; }, ms);
  }

  function initials(name) {
    return esc(String(name || '?').slice(0, 1));
  }

  function avatarInner(name, path) {
    const url = path ? (state.avatarUrls[path] || '') : '';
    return url ? `<img src="${url}" alt="">` : initials(name);
  }

  function openSheet(title, html) {
    sheetTitle.textContent = title;
    sheetBody.innerHTML = html;
    sheetEl.hidden = false;
  }
  function closeSheet() {
    sheetEl.hidden = true;
    sheetBody.innerHTML = '';
  }

  /* ---------- 外观主题 ---------- */
  const THEME_KEY = 'xs-theme';

  function currentTheme() {
    try { return localStorage.getItem(THEME_KEY) === 'paper' ? 'paper' : 'fresh'; } catch (e) { return 'fresh'; }
  }

  function applyTheme(name) {
    const t = name === 'paper' ? 'paper' : 'fresh';
    if (t === 'paper') document.documentElement.dataset.theme = 'paper';
    else delete document.documentElement.dataset.theme;
    try { localStorage.setItem(THEME_KEY, t); } catch (e) { /* 隐私模式下存不了，只影响本次 */ }
  }

  function openThemeSheet() {
    const cur = currentTheme();
    openSheet('外观', `
      <p class="hint" style="margin-top:0">只换配色与圆角，布局和功能都不变。设置只存在这台设备上，换手机要重新选。</p>
      <button class="theme-opt ${cur === 'fresh' ? 'on' : ''}" data-act="pick-theme" data-theme="fresh">
        <span class="sw sw-fresh"></span>
        <span class="tx"><b>清爽卡片</b><span>冷白底 · 青绿主色</span></span>
        <span class="tick">✓</span>
      </button>
      <button class="theme-opt ${cur === 'paper' ? 'on' : ''}" data-act="pick-theme" data-theme="paper">
        <span class="sw sw-paper"></span>
        <span class="tx"><b>纸质手账</b><span>米黄纸底 · 印章红</span></span>
        <span class="tick">✓</span>
      </button>
    `);
  }

  /* ---------- 改昵称 ---------- */
  function openNicknameSheet() {
    openSheet('改昵称', `
      <div class="field">
        <label>组里的人都看到这个名字，最多 12 个字</label>
        <input class="input" id="nk-input" maxlength="12" value="${esc(state.me.nickname)}">
      </div>
      <button class="btn block" data-act="save-nickname">保存</button>
    `);
    const el = document.getElementById('nk-input');
    if (el) { el.focus(); el.select(); }
  }

  async function saveNickname() {
    const el = document.getElementById('nk-input');
    const v = (el ? el.value : '').trim();
    if (!v) { toast('昵称不能为空'); return; }
    if (v === state.me.nickname) { closeSheet(); return; }
    const { data, error } = await cloud.database.from('users').update({ nickname: v }).eq('id', state.me.id).select();
    if (error || !data || !data.length) { toast(error ? (error.message || '保存失败') : '保存失败，可能没有权限'); return; }
    state.me = Object.assign({}, state.me, { nickname: v });
    closeSheet();
    await refresh();
    toast('昵称已改');
  }

  /* ---------- 启动 ---------- */
  async function boot() {
    applyTheme(currentTheme());
    if (!cloud) return renderFatal('核心脚本没加载成功，可能是网络被挡了');
    try {
      const { data: session } = await withTimeout(cloud.auth.getSession(), 10000, 'session');
      if (!session) return renderLogin();
      state.session = session;
      await enterApp();
    } catch (err) {
      console.error('[boot]', err);
      const timedOut = err && /timeout/.test(err.message || '');
      renderLogin(timedOut ? '连不上服务器，检查一下网络再刷新' : '打开失败，请刷新重试');
    }
  }

  function renderFatal(msg) {
    app.innerHTML = `
      <div class="gate">
        <div class="brand-mark">小</div>
        <h1>打不开</h1>
        <p class="sub">${esc(msg)}</p>
        <button class="btn block" onclick="location.reload()">重新加载</button>
        <p class="hint">一直这样就把这句话发给我：脚本没加载成功。</p>
      </div>`;
  }

  async function enterApp() {
    let res;
    try {
      res = await withTimeout(cloud.database.rpc('my_context'), 12000, 'context');
    } catch (err) {
      console.error('[context]', err);
      return renderLogin('读取身份超时，刷新再试');
    }
    const { data, error } = res;
    if (error) {
      console.error('[context]', error);
      return renderLogin('读取身份失败：' + (error.message || '未知错误'));
    }
    if (!data || !data.group) return renderOnboarding();
    state.me = data.user;
    state.group = data.group;
    state.groups = data.groups || [];
    state.view = 'today';
    await loadAll();
    renderShell();
  }

  async function switchGroup(groupId) {
    if (!groupId || (state.group && groupId === state.group.id)) {
      closeSheet();
      return;
    }
    const { error } = await cloud.database.rpc('switch_group', { p_group_id: groupId });
    if (error) { toast(error.message || '切换失败'); return; }
    closeSheet();
    await enterApp();
    toast('已切换');
  }

  function openGroupsSheet() {
    const list = state.groups || [];
    const rows = list.map((g) => `
      <div class="list-row" data-act="switch-group" data-group="${g.group_id}" style="cursor:pointer">
        <div>
          <div>${esc(g.group_name)}${g.is_current ? ' <span class="chip">当前</span>' : ''}</div>
          <div class="label">${roleLabel(g.role)} · 邀请码 ${esc(g.invite_code)}</div>
        </div>
        <span class="val">${g.is_current ? '' : '切换 ›'}</span>
      </div>`).join('');
    openSheet('我的组', `
      ${rows || '<p class="rail-empty">还没有组。</p>'}
      <div class="row-2" style="margin-top:14px">
        <button class="btn ghost" data-act="new-group" style="flex:1">创建新组</button>
        <button class="btn ghost" data-act="join-group" style="flex:1">用邀请码加入</button>
      </div>
      <p class="hint" style="margin-top:10px">一个人可以待在多个组，切过去就是那个组的身份和数据，互不影响。</p>
    `);
  }

  async function loadAll() {
    const gid = state.group.id;
    const day = todayStr();
    const [tasksRes, membersRes, inactiveRes, todayRes, weekRes] = await Promise.all([
      cloud.database.from('tasks').select('*').eq('group_id', gid).eq('archived', false).order('position', { ascending: true }),
      cloud.database.from('users').select('id,nickname,role,active,created_at,avatar_url').eq('group_id', gid).eq('active', true).order('created_at', { ascending: true }),
      cloud.database.from('users').select('id,nickname,role,avatar_url').eq('group_id', gid).eq('active', false).order('created_at', { ascending: false }).limit(50),
      cloud.database.from('checkins').select('*').eq('group_id', gid).eq('date', day),
      cloud.database.from('checkins').select('*').eq('group_id', gid).gte('date', weekStart()).order('done_at', { ascending: false })
    ]);
    const failed = [tasksRes, membersRes, inactiveRes, todayRes, weekRes].filter((r) => r && r.error);
    state.loadError = failed.length ? (failed[0].error.message || '数据没读出来') : '';
    if (failed.length) console.error('[loadAll]', failed.map((r) => r.error));
    state.tasks = tasksRes.data || [];
    const activeUsers = membersRes.data || [];
    state.allUsers = activeUsers;
    state.members = activeUsers.filter((m) => m.role !== 'teacher');
    state.teachers = activeUsers.filter((m) => m.role === 'teacher');
    state.inactive = inactiveRes.data || [];
    state.todayCheckins = todayRes.data || [];
    state.weekCheckins = weekRes.data || [];
    const ids = state.weekCheckins.map((c) => c.id);
    if (ids.length) {
      const { data: likesData, error: likesErr } = await cloud.database.from('likes').select('*').in('checkin_id', ids);
      if (likesErr) console.error('[likes]', likesErr);
      state.likes = likesData || [];
    } else {
      state.likes = [];
    }
    await loadAttachmentUrls([...state.todayCheckins, ...state.weekCheckins]);
    const { data: hData, error: hErr } = await cloud.database.from('handovers').select('*').eq('group_id', gid).eq('status', 'pending');
    if (hErr) console.error('[handovers]', hErr);
    state.handovers = hData || [];
    const { data: mineData, error: mineErr } = await cloud.database.from('checkins').select('date,status').eq('group_id', gid).eq('user_id', state.me.id);
    if (mineErr) console.error('[mycheckins]', mineErr);
    state.myCheckins = mineData || [];
    await loadAvatarUrls();
    await refreshNotifications();
  }

  async function loadAvatarUrls() {
    state.avatarUrls = {};
    const paths = [...new Set((state.allUsers || []).map((m) => m.avatar_url).filter(Boolean))];
    if (!paths.length) return;
    try {
      const res = await cloud.storage.createSignedUrls(paths, 3600);
      const arr = Array.isArray(res && res.data) ? res.data : ((res && res.data && res.data.data) || []);
      arr.forEach((x) => {
        const key = x.path || x.name;
        if (key) state.avatarUrls[key] = x.signedUrl || x.signed_url || x.url || '';
      });
    } catch (err) {
      console.error('[avatar-url]', err);
    }
  }

  async function refreshNotifications() {
    try {
      await cloud.database.rpc('enqueue_due_reminders');
    } catch (err) {
      console.error('[reminder]', err);
    }
    const { data } = await cloud.database
      .from('notifications')
      .select('*')
      .eq('group_id', state.group.id)
      .order('created_at', { ascending: false })
      .limit(20);
    state.notifications = data || [];
    state.unread = state.notifications.filter((n) => !n.read_at).length;
  }

  async function loadAttachmentUrls(checkins) {
    state.attachments = {};
    const ids = [...new Set((checkins || []).map((c) => c.id))];
    if (!ids.length) return;
    const { data, error } = await cloud.database
      .from('attachments')
      .select('id,checkin_id,path,thumb_path,width,height')
      .in('checkin_id', ids);
    if (error || !data || !data.length) return;

    const urlMap = {};
    try {
      const paths = [];
      data.forEach((r) => { paths.push(r.path); if (r.thumb_path) paths.push(r.thumb_path); });
      const res = await cloud.storage.createSignedUrls(paths, 3600);
      const arr = Array.isArray(res && res.data) ? res.data : ((res && res.data && res.data.data) || []);
      arr.forEach((x) => {
        const key = x.path || x.name;
        if (key) urlMap[key] = x.signedUrl || x.signed_url || x.url || '';
      });
    } catch (err) {
      console.error('[signed-url]', err);
    }
    data.forEach((r) => {
      (state.attachments[r.checkin_id] = state.attachments[r.checkin_id] || []).push({
        ...r,
        url: urlMap[r.path] || '',
        thumbUrl: (r.thumb_path && urlMap[r.thumb_path]) || ''
      });
    });
  }

  function weekStart() {
    const now = new Date();
    const day = now.getDay() || 7;
    const d = new Date(now.getTime() - (day - 1) * 86400000);
    return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  }

  const isAdmin = () => state.me && (state.me.role === 'owner' || state.me.role === 'leader' || state.me.role === 'teacher');
  const isTeacher = () => state.me && state.me.role === 'teacher';

  /* ---------- 登录 ---------- */
  function renderLogin(errMsg) {
    state.view = 'login';
    document.body.dataset.view = 'login';
    app.innerHTML = `
      <div class="gate">
        <div class="brand-mark">小</div>
        <h1>小事打卡社区</h1>
        <p class="sub">到点交，交没交大家都看得见。</p>

        <div class="field">
          <label for="account">邮箱</label>
          <input id="account" class="input" type="email" maxlength="64" placeholder="name@example.com" autocomplete="email">
        </div>
        <div class="field">
          <label for="password">密码</label>
          <input id="password" class="input" type="password" maxlength="64" placeholder="至少 6 位，自己记住" autocomplete="current-password">
        </div>
        <button class="btn block" id="do-auth">进入</button>
        <div class="error" id="gate-error">${errMsg ? esc(errMsg) : ''}</div>
        <p class="hint">第一次来就是注册：填邮箱和密码点「进入」即可，之后用同一组邮箱密码回来。<br>忘了密码找站长重置。</p>
        <div class="gate-foot">这个站只服务一个熟人小组。进来之后还要邀请码才能进组。</div>
      </div>`;

    const submit = () => doEmailAuth();
    document.getElementById('do-auth').addEventListener('click', submit);
    ['account', 'password'].forEach((id) => {
      document.getElementById(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    });
  }

  // 邮箱 + 密码：先当老用户登录，失败了再当新用户注册。两条都失败才是真的进不去。
  async function doEmailAuth() {
    const err = document.getElementById('gate-error');
    const account = document.getElementById('account');
    const password = document.getElementById('password');
    if (!err || !account || !password) return;
    const email = account.value.trim().toLowerCase();
    const pwd = password.value;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { err.textContent = '请输入正确的邮箱地址'; return; }
    if (pwd.length < 6) { err.textContent = '密码至少 6 位'; return; }
    err.textContent = '';
    const btn = document.getElementById('do-auth');
    const fail = (msg) => { if (btn) { btn.disabled = false; btn.textContent = '进入'; } err.textContent = msg; };
    if (btn) { btn.disabled = true; btn.textContent = '进入中…'; }

    const login = await cloud.auth.signInWithPassword({ email, password: pwd });
    if (!login.error && login.data && login.data.user) {
      state.session = login.data;
      await enterApp();
      return;
    }

    const reg = await cloud.auth.signUp({ email, password: pwd });
    if (reg.error) {
      const m = String(reg.error.message || '').toLowerCase();
      if (m.includes('already') || m.includes('registered')) {
        return fail('这个邮箱已经注册过，密码不对。忘了密码找站长重置。');
      }
      return fail(reg.error.message || '进不去，稍后再试');
    }
    if (!reg.data || !reg.data.session) {
      return fail('账号建好了，但还差邮箱确认这一步。请站长在 Supabase 的 Auth → Providers → Email 里关掉 Confirm email。');
    }
    state.session = reg.data;
    await enterApp();
  }

  /* ---------- 建组 / 加入 ---------- */
  function renderOnboarding(initial) {
    state.view = 'onboarding';
    document.body.dataset.view = 'onboarding';
    const back = state.groups.length
      ? `<button class="btn ghost block" id="ob-back" style="margin-top:10px">返回 ${esc(state.group ? state.group.name : '')}</button>`
      : '';
    app.innerHTML = `
      <div class="gate">
        <button class="gate-back" id="ob-logout" type="button">← 返回登录</button>
        <div class="brand-mark">小</div>
        <h1>先选一下</h1>
        <p class="sub">你要开一个新组，还是加入别人的组？</p>

        <div class="seg" id="ob-seg">
          <button data-mode="create">创建新组</button>
          <button data-mode="join">用邀请码加入</button>
          <button data-mode="teacher">教师加入</button>
        </div>

        <div id="ob-fields"></div>
        <div class="error" id="ob-error"></div>
        <button class="btn block" id="ob-submit">创建并进入</button>
        <p class="hint" id="ob-hint">你会成为这个组的站长，拥有全部权限。</p>
        ${back}
      </div>`;

    let mode = initial === 'join' ? 'join' : 'create';
    const fields = document.getElementById('ob-fields');
    const submit = document.getElementById('ob-submit');
    const hint = document.getElementById('ob-hint');

    function paint() {
      document.querySelectorAll('#ob-seg button').forEach((x) => x.classList.toggle('on', x.dataset.mode === mode));
      fields.innerHTML = mode === 'create' ? `
        <div class="field">
          <label for="ob-name">组名</label>
          <input id="ob-name" class="input" maxlength="20" placeholder="例如：星一 1011 班">
        </div>
        <div class="field">
          <label for="ob-nick">你的昵称</label>
          <input id="ob-nick" class="input" maxlength="12" placeholder="组内唯一，2–12 个字">
        </div>` : mode === 'teacher' ? `
        <div class="field">
          <label for="ob-invite">教师码</label>
          <input id="ob-invite" class="input" maxlength="6" placeholder="向站长索取" style="text-transform:uppercase">
        </div>
        <div class="field">
          <label for="ob-nick">你的昵称</label>
          <input id="ob-nick" class="input" maxlength="12" placeholder="组内唯一，2–12 个字">
        </div>` : `
        <div class="field">
          <label for="ob-invite">邀请码</label>
          <input id="ob-invite" class="input" maxlength="6" placeholder="6 位字母或数字" style="text-transform:uppercase">
        </div>
        <div class="field">
          <label for="ob-nick">你的昵称</label>
          <input id="ob-nick" class="input" maxlength="12" placeholder="组内唯一，2–12 个字">
        </div>`;
      submit.textContent = mode === 'create' ? '创建并进入' : mode === 'teacher' ? '以教师身份加入' : '加入';
      hint.textContent = mode === 'create'
        ? (state.groups.length ? '你会成为新组的站长，建好后自动切过去，原来的组还在。' : '你会成为这个组的站长，拥有全部权限。')
        : mode === 'teacher'
          ? '教师码由站长提供。进来能管任务、看全组打卡，但不用打卡，也不计入统计。'
          : '昵称在组内不能重复。老师请改用「教师加入」。';
      document.getElementById('ob-error').textContent = '';
    }

    document.querySelectorAll('#ob-seg button').forEach((b) => {
      b.addEventListener('click', () => {
        mode = b.dataset.mode;
        paint();
      });
    });
    paint();

    const backBtn = document.getElementById('ob-back');
    if (backBtn) backBtn.addEventListener('click', () => enterApp());

    const outBtn = document.getElementById('ob-logout');
    if (outBtn) outBtn.addEventListener('click', () => logout('pwd'));

    submit.addEventListener('click', async () => {
      const err = document.getElementById('ob-error');
      const nick = document.getElementById('ob-nick').value.trim();
      if (nick.length < 2) { err.textContent = '昵称至少 2 个字'; return; }
      submit.disabled = true;
      submit.textContent = '处理中…';
      let res;
      if (mode === 'create') {
        const name = document.getElementById('ob-name').value.trim();
        res = await cloud.database.rpc('create_group', { p_name: name, p_nickname: nick });
      } else if (mode === 'teacher') {
        const code = document.getElementById('ob-invite').value.trim().toUpperCase();
        if (code.length !== 6) { submit.disabled = false; submit.textContent = '以教师身份加入'; err.textContent = '教师码是 6 位'; return; }
        res = await cloud.database.rpc('join_as_teacher', { p_code: code, p_nickname: nick });
      } else {
        const invite = document.getElementById('ob-invite').value.trim().toUpperCase();
        if (invite.length !== 6) { submit.disabled = false; submit.textContent = '加入'; err.textContent = '邀请码是 6 位'; return; }
        res = await cloud.database.rpc('join_group', { p_invite: invite, p_nickname: nick });
      }
      if (res.error) {
        submit.disabled = false;
        submit.textContent = mode === 'create' ? '创建并进入' : mode === 'teacher' ? '以教师身份加入' : '加入';
        const map = {
          invite_invalid: '邀请码不对，或这个组不存在',
          teacher_code_invalid: '这个不是教师码，找站长要教师码（成员码在「用邀请码加入」里填）',
          nickname_taken: '这个昵称已被占用。老成员请返回登录，用原来的手机号或邮箱进来，不要重新加入',
          nickname_invalid: '昵称要 2–12 个字',
          already_in_group: '你已经在组里了'
        };
        err.textContent = map[res.error.message] || res.error.message || '操作失败';
        return;
      }
      await enterApp();
    });
  }

  /* ---------- 主框架 ---------- */
  const NAV_ICONS = {
    today: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="5.5"/><circle cx="10" cy="10" r="1.8" class="fill"/></svg>',
    wall: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="4" y="5" width="12" height="10" rx="2"/><path d="M7 8h6M7 11h4"/></svg>',
    progress: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 6h10M5 10h10M5 14h10"/><circle cx="7" cy="6" r="1" class="fill"/><circle cx="12" cy="10" r="1" class="fill"/><circle cx="9" cy="14" r="1" class="fill"/></svg>',
    me: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="7" r="3"/><path d="M4.5 16c.8-3 2.7-4.5 5.5-4.5s4.7 1.5 5.5 4.5"/></svg>',
    admin: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="3"/><path d="M10 3.5v2M10 14.5v2M3.5 10h2M14.5 10h2M5.4 5.4l1.4 1.4M13.2 13.2l1.4 1.4M14.6 5.4l-1.4 1.4M6.8 13.2l-1.4 1.4"/></svg>',
    report: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 15V9M10 15V5M15 15v-3"/><path d="M3.5 16.5h13"/></svg>',
    members: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="7" cy="6.8" r="2.6"/><path d="M2.6 15.4c.5-2.6 2.2-4 4.4-4s3.9 1.4 4.4 4"/><path d="M13.4 5.1a2.5 2.5 0 0 1 0 4.8"/><path d="M14.8 11.6c1.6.4 2.7 1.7 3 3.8"/></svg>'
  };

  const NAV = [
    { key: 'today', label: '今日', icon: NAV_ICONS.today },
    { key: 'wall', label: '打卡墙', icon: NAV_ICONS.wall },
    { key: 'progress', label: '进度', icon: NAV_ICONS.progress },
    { key: 'members', label: '成员', icon: NAV_ICONS.members },
    { key: 'me', label: '我的', icon: NAV_ICONS.me }
  ];

  function railHTML() {
    const members = state.members;
    const tasks = state.tasks;
    const checks = state.todayCheckins;
    const allDone = (m) => tasks.length > 0 && tasks.every((t) => checks.some((c) => c.user_id === m.id && c.task_id === t.id));
    const doneCount = members.filter(allDone).length;
    const missing = members.filter((m) => !allDone(m));

    const deadlineRows = tasks.length
      ? tasks.slice().sort((a, b) => parseHM(a.deadline_time).localeCompare(parseHM(b.deadline_time))).map((t) => {
          const n = checks.filter((c) => c.task_id === t.id).length;
          return `<div class="rail-row">
            <div><div>${esc(t.title)}</div><div class="r-sub">${parseHM(t.deadline_time)} 截止</div></div>
            <div class="r-sub">${n}/${members.length}</div>
          </div>`;
        }).join('')
      : '<p class="rail-empty">还没有任务。设一条，今天就能开始。</p>';

    return `
      <div class="rail">
        <div class="card">
          <h3>今天</h3>
          <div class="rail-big"><b>${doneCount}/${members.length}</b><span>人全部完成</span></div>
          ${missing.length
            ? `<p class="rail-empty">还差：${missing.map((m) => esc(m.nickname)).join('、')}</p>`
            : `<p class="rail-empty">${tasks.length ? '都做完了。' : '等第一条任务。'}</p>`}
        </div>

        <div class="card">
          <h3>截止顺序</h3>
          ${deadlineRows}
        </div>

        <div class="card">
          <h3>邀请成员</h3>
          <div class="invite" style="margin-top:0">
            <code>${esc(state.group.invite_code)}</code>
            <button class="btn ghost small" data-act="copy-invite">复制</button>
          </div>
          <p class="rail-empty" style="margin-top:10px">对方登录后选「用邀请码加入」。</p>
        </div>
      </div>`;
  }

  function renderShell() {
    document.body.dataset.view = state.view;
    const nav = NAV.concat(isAdmin() ? [
      { key: 'admin', label: '管理', icon: NAV_ICONS.admin },
      { key: 'report', label: '报告', icon: NAV_ICONS.report }
    ] : []);
    app.innerHTML = `
      <div class="shell">
        <nav class="tabbar">
          <div class="side-brand">
            <div class="brand-mark">小</div>
            <div class="sb-text"><b>小事打卡社区</b><span>${esc(state.group.name)}</span></div>
          </div>
          <div class="nav-links">
            ${nav.map((n) => `<a href="#/${n.key}" data-nav="${n.key}" class="${state.view === n.key ? 'on' : ''}"><span class="ico">${n.icon}</span>${n.label}</a>`).join('')}
          </div>
          <div class="side-foot">
            <div class="avatar">${avatarInner(state.me.nickname, state.me.avatar_url)}</div>
            <div><b>${esc(state.me.nickname)}</b><span>${roleLabel(state.me.role)}</span></div>
          </div>
        </nav>
        <main class="main" id="view"></main>
        <aside class="side">${railHTML()}</aside>
      </div>`;

    document.querySelectorAll('[data-nav]').forEach((a) => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        state.view = a.dataset.nav;
        history.replaceState(null, '', `#/${state.view}`);
        renderShell();
      });
    });

    paintView();
  }

  function roleLabel(r) {
    return r === 'owner' ? '站长' : r === 'leader' ? '负责人' : r === 'teacher' ? '教师' : '成员';
  }

  function viewHeading(mark, eyebrow, title) {
    return `<div class="view-heading">
      <div class="view-mark" aria-hidden="true">${mark}</div>
      <div><div class="day">${eyebrow}</div><h1>${title}</h1></div>
    </div>`;
  }

  function paintView() {
    const view = document.getElementById('view');
    if (!view) return;
    if (state.view === 'wall') renderWall(view);
    else if (state.view === 'progress') renderProgress(view);
    else if (state.view === 'members') renderMembers(view);
    else if (state.view === 'me') renderMe(view);
    else if (state.view === 'admin') renderAdmin(view);
    else if (state.view === 'report') renderReport(view);
    else renderToday(view);
    if (state.loadError) view.insertAdjacentHTML('afterbegin', loadFailHTML());
  }

  function loadFailHTML() {
    return `<div class="load-fail">
      <div class="lf-text">
        <b>数据没读出来</b>
        <div class="lf-msg">${esc(state.loadError)}</div>
      </div>
      <button class="btn ghost small" data-act="retry-load">重试</button>
    </div>`;
  }

  /* ---------- 今日 ---------- */
  const myToday = () => state.todayCheckins.filter((c) => c.user_id === state.me.id);
  const findCheckin = (taskId) => myToday().find((c) => c.task_id === taskId);
  const customToday = () => myToday().filter((c) => !c.task_id);

  function deadlineState(task) {
    const dl = parseHM(task.deadline_time);
    const now = nowHM();
    const diff = minutesBetween(now, dl);
    if (diff >= 60) return { text: `${dl} 截止`, cls: '' };
    if (diff > 10) return { text: `${dl} 截止 · 剩 ${diff} 分钟`, cls: 'due' };
    if (diff >= 0) return { text: `${dl} 截止 · 剩 ${diff} 分钟`, cls: 'due' };
    return { text: `${dl} 已截止，可补记`, cls: 'late' };
  }

  function minutesBetween(a, b) {
    const [ah, am] = a.split(':').map(Number);
    const [bh, bm] = b.split(':').map(Number);
    return (bh * 60 + bm) - (ah * 60 + am);
  }

  function dateOffset(days) {
    const d = new Date(Date.now() + days * 86400000);
    return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  }

  function dateAdd(iso, days) {
    const d = new Date(iso + 'T00:00:00+08:00');
    d.setDate(d.getDate() + days);
    return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  }

  // 昨天同一时刻之前的打卡条数；昨天不在本周范围内（周一）时返回 null
  function prevSameTimeCount() {
    const yKey = dateOffset(-1);
    if (yKey < weekStart()) return null;
    const nowStr = nowHM();
    return state.weekCheckins.filter((c) => c.task_id && c.date === yKey && timeOf(c.done_at) <= nowStr).length;
  }

  function compareChip(todayCount) {
    const y = prevSameTimeCount();
    if (y === null || (!todayCount && !y)) return '';
    const diff = todayCount - y;
    const cls = diff > 0 ? '' : diff < 0 ? ' warn' : ' plain';
    const txt = diff === 0 ? '与昨日此刻持平' : `${diff > 0 ? '+' : ''}${diff} 较昨日此刻`;
    return `<span class="chip${cls}">${txt}</span>`;
  }

  function renderToday(root) {
    root.className = 'today-view';
    const teacher = isTeacher();
    const done = myToday().length;
    const total = state.tasks.length;
    const ratio = total ? done / total : 0;
    const C = 2 * Math.PI * 40;

    // 全组进度：按人算「今天所有任务都交齐」，不是按条数
    const taskCheckins = state.todayCheckins.filter((c) => c.task_id);
    const fullDone = total ? state.members.filter((m) => {
      const mine = new Set(taskCheckins.filter((c) => c.user_id === m.id).map((c) => c.task_id));
      return mine.size >= total;
    }).length : 0;
    const gap = state.members.length - fullDone;

    // 教师不打卡：环改成全组交齐比例，不显示「我的完成度」
    const ringNum = teacher ? `${fullDone}/${state.members.length}` : `${done}/${total}`;
    const ringLabel = teacher ? '人交齐' : '已完成';
    const ringRatio = teacher ? (state.members.length ? fullDone / state.members.length : 0) : ratio;

    const todayCount = taskCheckins.length;
    const cmpHTML = compareChip(todayCount);

    root.innerHTML = `
      <div class="topbar today-topbar">
        <div class="today-heading">
          <div class="today-mark" aria-hidden="true">小</div>
          <div>
            <div class="day">${fmtDateCn(todayStr())} · ${esc(state.group.name)}</div>
            <h1>今天的小事</h1>
          </div>
        </div>
        <div class="topbar-actions">
          <button class="bell" data-act="open-notifs" aria-label="通知">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></svg>
            ${state.unread ? `<i>${state.unread > 9 ? '9+' : state.unread}</i>` : ''}
          </button>
          <div class="avatar">${avatarInner(state.me.nickname, state.me.avatar_url)}</div>
        </div>
      </div>

      <div class="card hero today-summary">
        <div class="ring">
          <svg width="96" height="96" viewBox="0 0 96 96">
            <circle cx="48" cy="48" r="40" fill="none" style="stroke:var(--ring-track)" stroke-width="9"/>
            <circle cx="48" cy="48" r="40" fill="none" style="stroke:var(--brand)" stroke-width="9" stroke-linecap="round"
              stroke-dasharray="${(C * ringRatio).toFixed(1)} ${C.toFixed(1)}"/>
          </svg>
          <div class="num"><b>${ringNum}</b><span>${ringLabel}</span></div>
        </div>
        <div class="hero-side">
          <div class="line1">全组今天 ${todayCount} 条打卡</div>
          <div class="line2">${total === 0 ? `${state.members.length} 人在组` : gap === 0 ? '全员已交齐' : `还差 ${gap} 人交齐`}</div>
          <div class="hero-chips">
            ${cmpHTML}
            ${state.group.allow_member_custom ? '' : '<span class="chip plain">自定义已关闭</span>'}
          </div>
          ${total === 0 ? '' : `<button class="hero-link" data-act="open-progress">${gap > 0 ? '看谁还没交 ›' : '看全部 ›'}</button>`}
        </div>
      </div>

      <div class="card today-tasks ${total === 0 ? 'grow' : ''}">
        <div class="card-head">
          <h2>今天的任务</h2>
          <span class="meta">${total} 项</span>
        </div>
        ${total === 0 ? `
          <div class="empty-lg">
            <div class="e-ico">◎</div>
            <b>今天还没有任务</b>
            <p>${isAdmin() ? '设一条带截止时间的任务，比如「早起 08:30」。成员到点前提交，谁没交一眼看到。' : '负责人正在设置任务，过一会儿刷新看看。'}</p>
            ${isAdmin() ? '<button class="btn" data-act="go-admin">去添加任务</button>' : ''}
          </div>` : state.tasks.map((t, index) => {
            const c = teacher ? null : findCheckin(t.id);
            const ds = deadlineState(t);
            const ids = new Set(taskCheckins.filter((x) => x.task_id === t.id).map((x) => x.user_id));
            const dotsHTML = state.members.length <= 8
              ? `<div class="t-dots">
                  <span class="dots">${state.members.map((m) => `<i class="${ids.has(m.id) ? 'on' : ''}"></i>`).join('')}</span>
                  <span class="dot-n">${ids.size}/${state.members.length} 人</span>
                </div>`
              : `<span class="t-count">${ids.size}/${state.members.length}</span>`;
            return `
            <div class="task tone-${index % 3} ${c ? 'done' : ''}">
              <div class="t-icon">${esc(t.emoji || '·')}</div>
              <div class="t-main">
                <div class="t-title">${esc(t.title)} ${c && c.status === 'late' ? '<span class="chip warn" style="height:18px;font-size:10px">补记</span>' : ''}</div>
                <div class="t-sub ${c ? 'late' : ds.cls}">${c ? `已打卡 ${timeOf(c.done_at)}` : ds.text}</div>
              </div>
              ${dotsHTML}
              ${teacher ? `<span class="t-count sub">${parseHM(t.deadline_time)}</span>` : `<button class="check ${c ? 'on' : ''}" data-act="toggle-task" data-task="${t.id}" data-checkin="${c ? c.id : ''}" aria-label="${c ? '取消打卡' : '打卡'}">
                <svg width="15" height="15" viewBox="0 0 16 16"><path d="M3 8.5l3.2 3.2L13 5" fill="none" style="stroke:var(--on-brand)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </button>`}
            </div>`;
          }).join('')}
        ${state.group.allow_member_custom && !teacher ? `<button class="add-row" data-act="open-custom">＋ 加一件小事</button>` : ''}
      </div>

      ${customToday().length ? `
      <div class="card">
        <div class="card-head"><h2>今天自己加的</h2><span class="meta">${customToday().length} 条</span></div>
        ${customToday().map((c) => `
          <div class="task tone-blue done">
            <div class="t-icon">✎</div>
            <div class="t-main">
              <div class="t-title">${esc(c.title || '小事')}</div>
              <div class="t-sub late">${timeOf(c.done_at)}</div>
            </div>
            <button class="check on" data-act="toggle-task" data-task="" data-checkin="${c.id}">
              <svg width="15" height="15" viewBox="0 0 16 16"><path d="M3 8.5l3.2 3.2L13 5" fill="none" style="stroke:var(--on-brand)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
          </div>`).join('')}
      </div>` : ''}

      <div class="card today-week">
        <div class="card-head"><h2>本周</h2><span class="meta">全组打卡条数</span></div>
        <div class="week">
          ${(() => {
            const start = weekStart();
            const labels = ['一', '二', '三', '四', '五', '六', '日'];
            const days = labels.map((lb, i) => {
              const d = new Date(start + 'T00:00:00+08:00');
              d.setDate(d.getDate() + i);
              const key = d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
              return { key, lb, n: state.weekCheckins.filter((c) => c.date === key).length };
            });
            const max = Math.max(1, ...days.map((x) => x.n));
            const today = todayStr();
            return days.map((x) => {
              const h = x.n ? 8 + Math.round(62 * x.n / max) : 4;
              return `
              <div class="week-col">
                <div class="week-track">
                  <div class="week-num ${x.key === today ? 'now' : ''}">${x.n || ''}</div>
                  <div class="week-bar ${x.n ? 'has' : ''} ${x.key === today ? 'today' : ''}" style="height:${h}px"></div>
                </div>
                <div class="week-day ${x.key === today ? 'now' : ''}">${x.lb}</div>
              </div>`;
            }).join('');
          })()}
        </div>
      </div>

      ${state.weekCheckins.length ? `
      <div class="card today-recent">
        <div class="card-head"><h2>最近打卡</h2><span class="meta">全组 · ${state.weekCheckins.length} 条</span></div>
        ${state.weekCheckins.slice(0, 6).map((c) => {
          const who = ((state.allUsers || []).find((m) => m.id === c.user_id) || {}).nickname || '成员';
          const task = c.task_id ? (state.tasks.find((t) => t.id === c.task_id) || {}).title : '';
          const d = new Date(c.done_at);
          const isToday = c.date === todayStr();
          return `<div class="feed-row">
            <div class="feed-main">
              <div><b>${esc(who)}</b> ${esc(task || c.title || '小事')}</div>
              ${c.note ? `<div class="feed-note">${esc(c.note)}</div>` : ''}
            </div>
            ${(() => {
              const ph = (state.attachments[c.id] || [])[0];
              if (!ph || !ph.url) return '';
              return `<img class="feed-shot" src="${ph.thumbUrl || ph.url}" data-act="view-photo" data-src="${ph.url}" alt="">`;
            })()}
            <span class="feed-time">${isToday ? timeOf(c.done_at) : `${d.getMonth() + 1}/${d.getDate()}`}</span>
          </div>`;
        }).join('')}
      </div>` : ''}

    `;
  }

  function timeOf(ts) {
    if (!ts) return '';
    return new Date(ts).toLocaleTimeString('en-GB', { timeZone: 'Asia/Shanghai', hour12: false }).slice(0, 5);
  }

  /* ---------- 打卡 ---------- */
  function openCheckinSheet(taskId) {
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task) return;
    state.pendingPhotos = [];
    openSheet(task.title, `
      <div class="field">
        <label>今天做了什么（选填，最多 200 字）</label>
        <textarea class="input" id="ck-note" maxlength="200" placeholder="写一句，别人在墙上能看到"></textarea>
      </div>
      <div class="field">
        <label>照片（最多 3 张，自动压缩）</label>
        <div class="shots" id="ck-shots"></div>
        <input type="file" id="ck-file" accept="image/*" multiple hidden>
      </div>
      <p class="hint" id="ck-hint" style="margin:0 0 14px">文字和照片至少一样。</p>
      <button class="btn block" data-act="submit-checkin" data-task="${taskId}">提交打卡</button>
    `);
    paintShots();
    const input = document.getElementById('ck-file');
    input.addEventListener('change', async (e) => {
      const files = [...(e.target.files || [])].slice(0, 3 - state.pendingPhotos.length);
      for (const f of files) {
        if (state.pendingPhotos.length >= 3) break;
        if (!f.type.startsWith('image/')) { toast('只支持图片'); continue; }
        try {
          const blob = await compressImage(f);
          state.pendingPhotos.push({ blob, url: URL.createObjectURL(blob), w: blob.width || 0 });
        } catch (err) {
          toast('这张图读不了，换一张试试');
        }
      }
      input.value = '';
      paintShots();
    });
    setTimeout(() => document.getElementById('ck-note') && document.getElementById('ck-note').focus(), 120);
  }

  function paintShots() {
    const box = document.getElementById('ck-shots');
    if (!box) return;
    const photos = state.pendingPhotos || [];
    box.innerHTML = photos.map((p, i) => `
      <div class="shot-wrap">
        <img class="shot" src="${p.url}" alt="">
        <button class="shot-del" data-act="del-photo" data-i="${i}" aria-label="移除">✕</button>
      </div>`).join('')
      + (photos.length < 3 ? `<label class="shot-add" for="ck-file">＋</label>` : '');
  }

  async function compressImage(file, maxEdge = 1280, quality = 0.72) {
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch (e) {
      bitmap = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = URL.createObjectURL(file);
      });
    }
    const w0 = bitmap.width, h0 = bitmap.height;
    const scale = Math.min(1, maxEdge / Math.max(w0, h0));
    const w = Math.round(w0 * scale), h = Math.round(h0 * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality));
    if (bitmap.close) bitmap.close();
    if (!blob) throw new Error('compress failed');
    blob.width = w; blob.height = h;
    return blob;
  }

  // 列表里只显示 40px / 104px 的图，却一直拉原图 —— 单独存一张 400px 缩略图，列表用它、点开仍看原图。
  async function thumbBlob(blob, maxEdge = 400, quality = 0.7) {
    let bitmap;
    try {
      bitmap = await createImageBitmap(blob);
    } catch (e) {
      bitmap = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = URL.createObjectURL(blob);
      });
    }
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale), h = Math.round(bitmap.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
    const out = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality));
    if (bitmap.close) bitmap.close();
    if (!out) throw new Error('thumb failed');
    return out;
  }

  // 上传原图后补一张缩略图；缩略图失败不算整条失败，列表退回原图即可
  async function uploadThumb(path, blob) {
    try {
      const tb = await thumbBlob(blob);
      const tp = path.replace(/\.jpg$/, '_t.jpg');
      const up = await cloud.storage.upload(tp, tb, { contentType: 'image/jpeg', cacheControl: '3600' });
      if (up && up.error) throw up.error;
      return tp;
    } catch (err) {
      console.error('[thumb]', err);
      return null;
    }
  }

  async function uploadPhotos(checkinId) {
    const photos = (state.pendingPhotos || []).slice(0, 3);
    if (!photos.length) return { uploaded: 0, failed: 0 };
    const uid = (state.session && state.session.user && state.session.user.id) || state.me.auth_uid;
    let uploaded = 0, failed = 0;
    for (let i = 0; i < photos.length; i++) {
      const p = photos[i];
      try {
        const path = cloud.storage.sharedPath(uid, `checkins/${todayStr()}/${checkinId}/${i + 1}.jpg`);
        const up = await cloud.storage.upload(path, p.blob, { contentType: 'image/jpeg', cacheControl: '3600' });
        if (up && up.error) throw up.error;
        const thumbPath = await uploadThumb(path, p.blob);
        const { error } = await cloud.database.from('attachments').insert({
          checkin_id: checkinId,
          path,
          thumb_path: thumbPath,
          width: p.blob.width || null,
          height: p.blob.height || null,
          bytes: p.blob.size || null
        });
        if (error) throw error;
        uploaded += 1;
      } catch (err) {
        console.error('[upload]', err);
        failed += 1;
      }
    }
    return { uploaded, failed };
  }

  async function submitCheckin(taskId) {
    if (isTeacher()) { toast('教师不需要打卡'); return; }
    const task = state.tasks.find((t) => t.id === taskId);
    const noteEl = document.getElementById('ck-note');
    const note = noteEl ? noteEl.value.trim() : '';
    const photos = state.pendingPhotos || [];
    if (!note && !photos.length) { toast('写一句，或者传张照片'); return; }

    const dl = parseHM(task.deadline_time);
    const late = nowHM() > dl;
    const btn = document.querySelector('[data-act="submit-checkin"]');
    if (btn) { btn.disabled = true; btn.textContent = photos.length ? '上传中…' : '提交中…'; }

    const { data, error } = await cloud.database.from('checkins').insert({
      group_id: state.group.id,
      user_id: state.me.id,
      task_id: taskId,
      date: todayStr(),
      status: late ? 'late' : 'on_time',
      note: note || null
    }).select();

    if (error || !data || !data.length) {
      if (btn) { btn.disabled = false; btn.textContent = '提交打卡'; }
      toast(error && error.code === '23505' ? '这条已经打过卡了' : ((error && error.message) || '提交失败'));
      return;
    }

    const res = await uploadPhotos(data[0].id);
    state.pendingPhotos = [];
    closeSheet();
    await refresh();
    if (res.failed) toast(`打卡记下了，但有 ${res.failed} 张照片没传上`);
    else toast(late ? '已记下，标注为补记' : '打卡完成');
  }

  async function openNotifications() {
    const rows = state.notifications || [];
    const incoming = (state.handovers || []).filter((h) => h.to_user_id === state.me.id);
    const ask = incoming.map((h) => `
      <div class="handover-ask">
        <div><b>${esc(memberName(h.from_user_id))} 想把负责人交给你</b></div>
        <div class="label">接受后你会管理任务、提醒和导出，24 小时内有效。</div>
        <div class="row-2" style="margin-top:10px">
          <button class="btn" data-act="respond-handover" data-h="${h.id}" data-accept="1" style="flex:1">接受</button>
          <button class="btn ghost" data-act="respond-handover" data-h="${h.id}" data-accept="0" style="flex:1">拒绝</button>
        </div>
      </div>`).join('');
    openSheet('通知', ask + (rows.length ? rows.map((n) => `
      <div class="notif-row">
        <span class="notif-dot ${n.read_at ? 'read' : ''}"></span>
        <div class="feed-main">
          <div><b>${esc(n.title)}</b></div>
          ${n.body ? `<div class="feed-note">${esc(n.body)}</div>` : ''}
        </div>
        <span class="feed-time">${timeOf(n.created_at)}</span>
      </div>`).join('') : '<div class="empty"><b>没有新通知</b>临近截止会自动提醒你。</div>'));

    if (state.unread) {
      const unreadIds = rows.filter((n) => !n.read_at).map((n) => n.id);
      const { error } = await cloud.database.from('notifications')
        .update({ read_at: new Date().toISOString() })
        .in('id', unreadIds);
      if (!error) {
        state.notifications = rows.map((n) => ({ ...n, read_at: n.read_at || new Date().toISOString() }));
        state.unread = 0;
        const bell = document.querySelector('.bell i');
        if (bell) bell.remove();
      }
    }
  }

  function openPhoto(src) {
    if (!src) return;
    openSheet('照片', `<img src="${src}" style="width:100%;border-radius:12px;display:block" alt="">`);
  }

  function openCustomSheet() {
    openSheet('加一件小事', `
      <div class="field">
        <label>做了什么</label>
        <input class="input" id="cs-title" maxlength="30" placeholder="例如：帮同事修了电脑">
      </div>
      <button class="btn block" data-act="submit-custom">记下来</button>
    `);
    setTimeout(() => { const el = document.getElementById('cs-title'); if (el) el.focus(); }, 120);
  }

  async function submitCustom() {
    if (isTeacher()) { toast('教师不需要打卡'); return; }
    const el = document.getElementById('cs-title');
    const title = el ? el.value.trim() : '';
    if (!title) { toast('写点什么再提交'); return; }
    const dl = (state.group.custom_deadline || '23:59').slice(0, 5);
    const late = nowHM() > dl;
    const { error } = await cloud.database.from('checkins').insert({
      group_id: state.group.id,
      user_id: state.me.id,
      task_id: null,
      title,
      date: todayStr(),
      status: late ? 'late' : 'on_time'
    });
    if (error) { toast(error.message || '提交失败'); return; }
    closeSheet();
    await refresh();
    toast(late ? '已记下，超过默认截止，标为补记' : '已记下');
  }

  async function toggleTask(taskId, checkinId) {
    if (isTeacher()) { toast('教师不需要打卡'); return; }
    if (!checkinId) return openCheckinSheet(taskId);
    return openEditSheet(checkinId);
  }

  function openEditSheet(checkinId) {
    const c = myToday().find((x) => x.id === checkinId);
    if (!c) return;
    const atts = state.attachments[checkinId] || [];
    state.edit = {
      id: checkinId,
      note: c.note || '',
      keep: atts.map((a) => ({ id: a.id, path: a.path, url: a.url, removed: false })),
      newPhotos: []
    };
    openSheet('编辑打卡', `
      <div class="field">
        <label>文字（≤200 字）</label>
        <textarea class="input" id="ed-note" maxlength="200">${esc(state.edit.note)}</textarea>
      </div>
      <div class="field">
        <label>照片（最多 3 张，可增删）</label>
        <div class="shots" id="ed-shots"></div>
        <input type="file" id="ed-file" accept="image/*" multiple hidden>
      </div>
      <div class="row-2" style="margin-bottom:12px">
        <button class="btn" data-act="save-edit" style="flex:1">保存修改</button>
        <button class="btn ghost danger" data-act="del-checkin" data-checkin="${checkinId}" style="flex:1">删除整条</button>
      </div>
    `);
    paintEditShots();
    const input = document.getElementById('ed-file');
    input.addEventListener('change', async (e) => {
      const files = [...(e.target.files || [])];
      for (const f of files) {
        const total = state.edit.keep.filter((k) => !k.removed).length + state.edit.newPhotos.length;
        if (total >= 3) { toast('最多 3 张'); break; }
        if (!f.type.startsWith('image/')) continue;
        try {
          const blob = await compressImage(f);
          state.edit.newPhotos.push({ blob, url: URL.createObjectURL(blob) });
        } catch (err) { toast('这张图读不了'); }
      }
      input.value = '';
      paintEditShots();
    });
  }

  function paintEditShots() {
    const box = document.getElementById('ed-shots');
    if (!box || !state.edit) return;
    const kept = state.edit.keep.map((k, i) => ({ ...k, i })).filter((k) => !k.removed);
    const used = kept.length + state.edit.newPhotos.length;
    box.innerHTML = kept.map((k) => `
      <div class="shot-wrap">
        <img class="shot" src="${k.url}" alt="">
        <button class="shot-del" data-act="ed-del-keep" data-i="${k.i}" aria-label="移除">✕</button>
      </div>`).join('')
      + state.edit.newPhotos.map((p, i) => `
      <div class="shot-wrap">
        <img class="shot" src="${p.url}" alt="">
        <button class="shot-del" data-act="ed-del-new" data-i="${i}" aria-label="移除">✕</button>
      </div>`).join('')
      + (used < 3 ? `<label class="shot-add" for="ed-file">＋</label>` : '');
  }

  async function saveEdit() {
    const noteEl = document.getElementById('ed-note');
    const note = noteEl ? noteEl.value.trim() : '';
    const e = state.edit;
    if (!e) return;
    const btn = document.querySelector('[data-act="save-edit"]');
    if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
    const { data, error } = await cloud.database.from('checkins')
      .update({ note: note || null, updated_at: new Date().toISOString() })
      .eq('id', e.id).select();
    if (error || !data || !data.length) {
      if (btn) { btn.disabled = false; btn.textContent = '保存修改'; }
      toast((error && error.message) || '保存失败');
      return;
    }
    let failed = 0;
    for (const k of e.keep.filter((k) => k.removed)) {
      try {
        await cloud.database.from('attachments').delete().eq('id', k.id);
        cloud.storage.remove([k.path]).catch(() => {});
      } catch (err) { failed += 1; }
    }
    const keptCount = e.keep.filter((k) => !k.removed).length;
    const uid = (state.session && state.session.user && state.session.user.id) || state.me.auth_uid;
    for (let i = 0; i < e.newPhotos.length; i++) {
      try {
        const p = e.newPhotos[i];
        const path = cloud.storage.sharedPath(uid, `checkins/${todayStr()}/${e.id}/${Date.now()}-${i + 1}.jpg`);
        const up = await cloud.storage.upload(path, p.blob, { contentType: 'image/jpeg', cacheControl: '3600' });
        if (up && up.error) throw up.error;
        const thumbPath = await uploadThumb(path, p.blob);
        const r = await cloud.database.from('attachments').insert({
          checkin_id: e.id, path, thumb_path: thumbPath, width: p.blob.width || null, height: p.blob.height || null, bytes: p.blob.size || null
        });
        if (r.error) throw r.error;
      } catch (err) { console.error('[edit-upload]', err); failed += 1; }
    }
    state.edit = null;
    closeSheet();
    await refresh();
    toast(failed ? `已保存，但有 ${failed} 张照片没处理成功` : '已更新');
  }

  async function deleteCheckin(checkinId) {
    if (!confirm('删除这条打卡？不可恢复。')) return;
    const paths = (state.attachments[checkinId] || []).map((a) => a.path);
    const { data, error } = await cloud.database.from('checkins').delete().eq('id', checkinId).select();
    if (error || !data || !data.length) { toast('删除失败'); return; }
    if (paths.length) cloud.storage.remove(paths).catch(() => {});
    state.edit = null;
    closeSheet();
    await refresh();
    toast('已删除');
  }

  async function refresh() {
    await loadAll();
    renderShell();
  }

  /* 按 40 个一批删，避免 in(...) 的 URL 过长被拒 */
  async function delIn(table, col, values) {
    for (let i = 0; i < values.length; i += 40) {
      const { error } = await cloud.database.from(table).delete().in(col, values.slice(i, i + 40));
      if (error) console.error('[delIn]', table, error);
    }
  }

  async function deleteMember(userId) {
    const m = (state.allUsers || []).find((x) => x.id === userId) || state.inactive.find((x) => x.id === userId);
    if (!m) return;
    if (!isAdmin()) { toast('只有负责人能删人'); return; }
    if (userId === state.me.id) { toast('不能删自己'); return; }
    const ok = confirm(`确定删除「${m.nickname}」？\n\n他的打卡、照片、点赞、交接记录会一起删掉，无法恢复。\n只是暂时不让他打卡的话，用「停用」更合适。`);
    if (!ok) return;

    const btn = document.querySelector('[data-act="del-member"]');
    if (btn) { btn.disabled = true; btn.textContent = '删除中…'; }

    const { data: rows, error: qErr } = await cloud.database
      .from('checkins').select('id').eq('group_id', state.group.id).eq('user_id', userId);
    if (qErr) {
      if (btn) { btn.disabled = false; btn.textContent = '删除此人'; }
      toast('读取他的打卡失败：' + (qErr.message || ''));
      return;
    }
    const ids = (rows || []).map((r) => r.id);

    if (ids.length) {
      for (let i = 0; i < ids.length; i += 40) {
        const chunk = ids.slice(i, i + 40);
        const { data: atts } = await cloud.database.from('attachments').select('id,path').in('checkin_id', chunk);
        const paths = (atts || []).map((a) => a.path).filter(Boolean);
        if (atts && atts.length) await cloud.database.from('attachments').delete().in('checkin_id', chunk);
        if (paths.length) cloud.storage.remove(paths).catch(() => {});
        await cloud.database.from('likes').delete().in('checkin_id', chunk);
      }
      await cloud.database.from('likes').delete().eq('user_id', userId);
      await delIn('checkins', 'id', ids);
    } else {
      await cloud.database.from('likes').delete().eq('user_id', userId);
    }

    await cloud.database.from('handovers').delete().eq('from_user_id', userId);
    await cloud.database.from('handovers').delete().eq('to_user_id', userId);

    const { data: del, error } = await cloud.database.from('users').delete().eq('id', userId).select();
    if (error || !del || !del.length) {
      await refresh();
      toast('打卡和照片已清掉，但删成员这步没成功：' + ((error && error.message) || '权限不足'));
      return;
    }
    closeSheet();
    await refresh();
    toast('已删除 ' + m.nickname);
  }

  async function retryLoad() {
    await refresh();
    toast(state.loadError ? '还是读不出来，稍后再点一次' : '已恢复');
  }

  /* ---------- 打卡墙 ---------- */
  const memberName = (id) => ((state.allUsers || []).find((m) => m.id === id) || {}).nickname || '成员';
  const taskName = (id) => (state.tasks.find((t) => t.id === id) || {}).title || '';
  const noteTitle = (c) => c.title || taskName(c.task_id) || '小事';
  const likeCount = (cid) => (state.likes || []).filter((l) => l.checkin_id === cid).length;
  const likedByMe = (cid) => (state.likes || []).some((l) => l.checkin_id === cid && l.user_id === state.me.id);

  function noteHTML(c) {
    const photo = (state.attachments[c.id] || [])[0];
    return `
      <div class="note" data-act="open-post" data-checkin="${c.id}">
        ${photo && photo.url ? `<img class="note-img" src="${photo.thumbUrl || photo.url}" alt="">` : ''}
        <div class="n-title">${esc(noteTitle(c))}</div>
        ${c.note ? `<div class="n-body">${esc(c.note)}</div>` : ''}
        <div class="n-foot">
          <span class="n-who">${esc(memberName(c.user_id))} · ${timeOf(c.done_at)}</span>
          <button class="like ${likedByMe(c.id) ? 'on' : ''}" data-act="toggle-like" data-checkin="${c.id}">♡ ${likeCount(c.id)}</button>
        </div>
      </div>`;
  }

  function renderWall(root) {
    root.className = 'memphis-view wall-view';
    const hasPhoto = (c) => (state.attachments[c.id] || []).length > 0;
    const pool = state.wallTab === 'today'
      ? state.weekCheckins.filter((c) => c.date === todayStr())
      : state.weekCheckins;
    const items = pool.filter((c) => c.note || !c.task_id || hasPhoto(c))
      .sort((a, b) => String(b.done_at || '').localeCompare(String(a.done_at || '')));
    const doneSet = new Set(state.todayCheckins.map((c) => c.user_id));

    let body = state.wallTab === 'today'
      ? '<div class="card"><div class="empty"><b>今天还没有内容</b>打卡时写一句或传张照片，就会贴到这里。</div></div>'
      : '<div class="card"><div class="empty"><b>这周还没有内容</b>打卡时写一句或传张照片，就会贴到这里。</div></div>';

    if (items.length) {
      if (state.wallTab === 'today') {
        body = `<div class="wall">${items.map(noteHTML).join('')}</div>`;
      } else {
        const byDay = {};
        items.forEach((c) => { (byDay[c.date] = byDay[c.date] || []).push(c); });
        body = Object.keys(byDay).sort().reverse().map((d) => `
          <div class="wall-day">${fmtDateCn(d)}</div>
          <div class="wall">${byDay[d].map(noteHTML).join('')}</div>`).join('');
      }
    }

    root.innerHTML = `
      <div class="topbar">
        ${viewHeading('墙', state.wallTab === 'today' ? fmtDateCn(todayStr()) : '本周', '打卡墙')}
        <div class="avatar">${avatarInner(state.me.nickname, state.me.avatar_url)}</div>
      </div>
      <div class="seg">
        <button data-act="wall-tab" data-tab="today" class="${state.wallTab === 'today' ? 'on' : ''}">今天</button>
        <button data-act="wall-tab" data-tab="week" class="${state.wallTab === 'week' ? 'on' : ''}">本周</button>
      </div>
      ${(() => {
        const posted = doneSet.size;
        const totalM = state.members.length;
        const txt = posted === 0 ? '今天还没人打卡' : posted >= totalM ? `今天 ${totalM} 人都打了卡` : `今天 ${posted}/${totalM} 人已打卡 · 还差 ${totalM - posted} 人`;
        return `<div class="wall-gap">${txt}</div>`;
      })()}
      <div class="strip">
        ${state.members.map((m) => `<span class="strip-p ${doneSet.has(m.id) ? 'on' : ''}" title="${esc(m.nickname)}">${avatarInner(m.nickname, m.avatar_url)}</span>`).join('')}
      </div>
      ${body}
    `;
  }

  async function setCheckinStatus(checkinId, status) {
    const { error } = await cloud.database.rpc('set_checkin_status', { p_checkin_id: checkinId, p_status: status });
    if (error) { toast(error.message || '改不了这条'); return; }
    closeSheet();
    await refresh();
    toast(status === 'on_time' ? '已改为按时' : '已改回补记');
  }

  async function toggleLike(checkinId) {
    if (!state.me) return;
    const mine = (state.likes || []).find((l) => l.checkin_id === checkinId && l.user_id === state.me.id);
    if (mine) {
      const { error } = await cloud.database.from('likes').delete().eq('id', mine.id);
      if (error) { toast(error.message || '取消失败'); return; }
      state.likes = state.likes.filter((l) => l.id !== mine.id);
    } else {
      const { data, error } = await cloud.database.from('likes').insert({ checkin_id: checkinId, user_id: state.me.id }).select();
      if (error || !data || !data.length) { toast((error && error.message) || '点赞失败'); return; }
      state.likes = [...(state.likes || []), data[0]];
    }
    if (!sheetEl.hidden) openPostSheet(checkinId);
    else if (state.view === 'wall') renderWall(document.getElementById('view'));
  }

  function openPostSheet(checkinId) {
    const c = [...state.weekCheckins, ...state.todayCheckins].find((x) => x.id === checkinId);
    if (!c) return;
    const photos = (state.attachments[c.id] || []).filter((p) => p.url);
    const names = (state.likes || []).filter((l) => l.checkin_id === c.id).map((l) => memberName(l.user_id));
    const mine = c.user_id === state.me.id;
    openSheet(noteTitle(c), `
      ${photos.length ? `<div class="post-photos">${photos.map((p) => `<img src="${p.url}" alt="">`).join('')}</div>` : ''}
      ${c.note ? `<div class="post-body">${esc(c.note)}</div>` : ''}
      <div class="post-meta">${esc(memberName(c.user_id))} · ${fmtDateCn(c.date)} ${timeOf(c.done_at)}${c.status === 'late' ? ' · 补记' : ''}</div>
      <div class="post-likes">${names.length ? '♡ ' + names.map(esc).join('、') : '还没有人点赞'}</div>
      <button class="btn ghost block" data-act="toggle-like" data-checkin="${c.id}">${likedByMe(c.id) ? '取消点赞' : '♡ 点赞'}</button>
      ${isAdmin() && c.task_id && (c.status === 'on_time' || c.status === 'late') ? `<button class="btn ghost block" data-act="set-checkin-status" data-checkin="${c.id}" data-status="${c.status === 'late' ? 'on_time' : 'late'}" style="margin-top:8px">${c.status === 'late' ? '改为按时' : '改回补记'}</button>` : ''}
      ${mine ? `<button class="btn ghost block" data-act="del-checkin" data-checkin="${c.id}" style="margin-top:8px">取消这条打卡</button>` : ''}
    `);
  }

  async function delCheckin(checkinId) {
    if (!confirm('取消这条打卡？记录会被删除。')) return;
    const { data, error } = await cloud.database.from('checkins').delete().eq('id', checkinId).select();
    if (error || !data || !data.length) { toast('删除失败，可能不是你的记录'); return; }
    closeSheet();
    await refresh();
    toast('已取消');
  }

  /* ---------- 进度 ---------- */
  function renderProgress(root) {
    root.className = 'memphis-view progress-view';
    const tasks = state.tasks;
    const members = state.members;
    const cell = (uid, tid) => {
      const c = state.todayCheckins.find((x) => x.user_id === uid && x.task_id === tid);
      if (!c) return '<span class="dot-mark">·</span>';
      if (c.status === 'excused') return '<span class="dot-mark ex">免</span>';
      if (c.status === 'late') return '<span class="dot-mark late">补</span>';
      return '<span class="dot-mark ok">✓</span>';
    };
    const doneCount = members.filter((m) => tasks.length && tasks.every((t) => state.todayCheckins.some((c) => c.user_id === m.id && c.task_id === t.id))).length;
    const taskDone = (tid) => state.todayCheckins.filter((c) => c.task_id === tid).length;
    const userDone = (uid) => state.todayCheckins.filter((c) => c.user_id === uid && c.task_id).length;
    const cmp = compareChip(state.todayCheckins.filter((c) => c.task_id).length);
    const gap = members.length - doneCount;

    root.innerHTML = `
      <div class="topbar">
        ${viewHeading('进', fmtDateCn(todayStr()), '今日进度')}
        <button class="btn ghost small" data-act="copy-progress">复制</button>
      </div>

      <div class="card">
        <div class="card-head">
          <h2>${tasks.length === 0 ? `${members.length} 人在组` : gap === 0 ? '全员已交齐' : `还差 ${gap} 人交齐`}</h2>
          <span class="meta">${doneCount}/${members.length} 人 · ${tasks.length} 项</span>
        </div>
        ${cmp ? `<div class="chips-line">${cmp}</div>` : ''}
        ${tasks.length === 0 ? `<div class="empty"><b>还没有任务</b>去管理里加一条。</div>` : `
        <div class="tbl-wrap">
          <table class="matrix">
            <thead><tr><th>成员</th>${tasks.map((t) => `<th>${esc(t.title)}<br><span class="th-dl">${parseHM(t.deadline_time)}</span><br><span class="th-n">${taskDone(t.id)}/${members.length}</span></th>`).join('')}<th>完成</th></tr></thead>
            <tbody>
              ${members.map((m) => `
                <tr>
                  <td><span class="name"><span class="avatar" style="width:24px;height:24px;font-size:11px">${avatarInner(m.nickname, m.avatar_url)}</span>${esc(m.nickname)}</span></td>
                  ${tasks.map((t) => `<td>${cell(m.id, t.id)}</td>`).join('')}
                  <td class="td-n">${userDone(m.id)}/${tasks.length}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>`}
      </div>

      ${isAdmin() ? `
      <div class="card">
        <div class="card-head"><h2>催一下</h2></div>
        <p class="hint" style="margin-top:0">一键提醒还没做完的人。站内通知已经可用，企业微信群机器人等你在设置里填了地址才会发。</p>
        <button class="btn block" data-act="remind">提醒未完成的人</button>
      </div>` : ''}
    `;
  }

  function progressText() {
    const day = fmtDateCn(todayStr());
    const lines = [`【小事打卡 · ${day} 进度】`];
    state.tasks.forEach((t) => {
      const rows = state.members.map((m) => {
        const c = state.todayCheckins.find((x) => x.user_id === m.id && x.task_id === t.id);
        if (!c) return `○ ${m.nickname} 未打卡`;
        return `${c.status === 'late' ? '△' : '✓'} ${m.nickname} ${timeOf(c.done_at)}`;
      });
      lines.push('', `${t.title}（${parseHM(t.deadline_time)} 截止）  ${rows.filter((r) => r[0] !== '○').length}/${state.members.length}`);
      lines.push(...rows);
    });
    const missing = state.members.filter((m) => !state.tasks.every((t) => state.todayCheckins.some((c) => c.user_id === m.id && c.task_id === t.id)));
    if (missing.length) lines.push('', `未完成：${missing.map((m) => m.nickname).join('、')}`);
    return lines.join('\n');
  }

  async function copyProgress() {
    const text = progressText();
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制');
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      toast('已复制');
    }
  }

  async function remind() {
    const missing = state.members.filter((m) => !state.tasks.every((t) => state.todayCheckins.some((c) => c.user_id === m.id && c.task_id === t.id)));
    if (!missing.length) { toast('今天大家都做完了'); return; }
    const rows = missing.map((m) => ({
      group_id: state.group.id,
      user_id: m.id,
      kind: 'manual',
      title: '该打卡了',
      body: '负责人提醒你完成今天的打卡',
      channel: 'inapp',
      notify_date: todayStr()
    }));
    const { error } = await cloud.database.from('notifications').insert(rows);
    if (error) { toast(error.message || '发送失败'); return; }
    const pushed = pushWecom(missing);
    toast(pushed ? `已提醒 ${missing.length} 人，并同步到企微群` : `已提醒 ${missing.length} 人`);
  }

  // 浏览器直接发给企微机器人。no-cors 只能发不能读回执，
  // 所以这里只负责发出，不判断成败（配错 key 也看不出来，见管理页说明）
  function pushWecom(missing) {
    const hook = ((state.group && state.group.wecom_webhook) || '').trim();
    if (!hook) return false;
    const lines = [
      `**小事打卡 · ${state.group.name}**`,
      `> ${fmtDateCn(todayStr())} · 还差 ${missing.length} 人`,
      ''
    ];
    state.tasks.forEach((t) => {
      const done = state.todayCheckins.filter((c) => c.task_id === t.id).length;
      lines.push(`- ${t.title}：${done}/${state.members.length}`);
    });
    lines.push('', `未交：${missing.map((m) => m.nickname).join('、')}`);
    const link = location.origin + location.pathname + location.search;
    if (/^https?:/.test(link)) lines.push('', `[去打卡](${link})`);
    try {
      fetch(hook, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify({ msgtype: 'markdown', markdown: { content: lines.join('\n') } })
      }).catch(() => {});
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ---------- 成员 ---------- */
  function weekExpected() {
    const d = new Date(todayStr() + 'T00:00:00+08:00');
    const dow = (d.getDay() + 6) % 7;
    return state.tasks.length * (dow + 1);
  }

  function memberWeekDone(uid) {
    const ws = weekStart();
    const td = todayStr();
    return state.weekCheckins.filter((c) => c.user_id === uid && c.task_id && c.date >= ws && c.date <= td).length;
  }

  function memberOps(m) {
    const excused = state.todayCheckins.some((c) => c.user_id === m.id && c.status === 'excused');
    return [
      state.me.role === 'owner' && m.role === 'member' ? `<button class="btn ghost small" data-act="set-leader" data-user="${m.id}">设为负责人</button>` : '',
      state.me.role === 'owner' && m.role === 'leader' ? `<button class="btn ghost small" data-act="unset-leader" data-user="${m.id}">取消负责人</button>` : '',
      state.me.role === 'leader' && m.role === 'member' ? `<button class="btn ghost small" data-act="request-handover" data-user="${m.id}">交接给他</button>` : '',
      m.role === 'member' && excused ? `<button class="btn ghost small" data-act="excuse-today" data-user="${m.id}" data-on="0">取消豁免</button>` : '',
      (m.role === 'member' || m.role === 'teacher') ? `<button class="icon-btn" data-act="set-active" data-user="${m.id}" data-on="0" aria-label="停用">停</button>` : ''
    ].join('');
  }

  function renderMembers(root) {
    root.className = 'memphis-view members-view';
    const exp = weekExpected();
    const outHandover = (state.handovers || []).find((h) => h.from_user_id === state.me.id);
    const whoHandover = outHandover ? ((state.allUsers.find((x) => x.id === outHandover.to_user_id) || {}).nickname || '对方') : '';
    const people = [...state.members, ...(state.teachers || [])];
    const headMeta = state.teachers.length
      ? `${esc(state.group.name)} · ${state.members.length} 人 + 教师 ${state.teachers.length}`
      : `${esc(state.group.name)} · ${state.members.length} 人`;

    root.innerHTML = `
      <div class="topbar">${viewHeading('员', headMeta, '成员')}</div>

      <div class="card">
        <div class="card-head"><h2>在组的人</h2><span class="meta">${isAdmin() ? '点一行看他的打卡' : '本周完成数'}</span></div>
        ${people.map((m) => `
          <div class="list-row m-row">
            <div class="m-who" data-act="open-member" data-user="${m.id}">
              <span class="avatar" style="width:30px;height:30px;font-size:12px">${avatarInner(m.nickname, m.avatar_url)}</span>
              <div class="m-info">
                <div class="m-name">${esc(m.nickname)}<span class="chip ${m.role === 'member' ? 'plain' : ''}">${roleLabel(m.role)}</span></div>
                <div class="label">${m.role === 'teacher' ? '有管理权限 · 不打卡' : `本周 ${memberWeekDone(m.id)}/${exp}`}</div>
              </div>
            </div>
            <span class="m-ops">${memberOps(m)}</span>
          </div>`).join('') || '<div class="empty"><b>还没有成员</b>把邀请码发给对方。</div>'}
        ${whoHandover ? `<p class="hint" style="margin:12px 0 0">已向 ${esc(whoHandover)} 发出交接，等对方在通知里接受。24 小时内有效。</p>` : ''}
      </div>

      ${state.inactive.length ? `
      <div class="card">
        <div class="card-head"><h2>已停用</h2><span class="meta">${state.inactive.length} 人 · 历史保留</span></div>
        ${state.inactive.map((m) => `
          <div class="list-row">
            <div class="m-who" style="opacity:.6">
              <span class="avatar" style="width:30px;height:30px;font-size:12px">${avatarInner(m.nickname, m.avatar_url)}</span>
              <div class="m-info"><div class="m-name">${esc(m.nickname)}</div><div class="label">不占今天的名额</div></div>
            </div>
            <button class="btn ghost small" data-act="set-active" data-user="${m.id}" data-on="1">恢复</button>
          </div>`).join('')}
      </div>` : ''}
    `;
  }

  async function openMemberSheet(uid) {
    const m = (state.allUsers || []).find((x) => x.id === uid);
    if (!m) return;
    if (!isAdmin()) { toast('只有负责人能看别人的打卡'); return; }
    openSheet(`${m.nickname} 的打卡`, '<p class="hint" style="margin:0">正在读取…</p>');
    const { data, error } = await cloud.database
      .from('checkins')
      .select('date,status,done_at,task_id,note')
      .eq('group_id', state.group.id)
      .eq('user_id', uid)
      .order('done_at', { ascending: false })
      .limit(400);
    if (error) { sheetBody.innerHTML = `<p class="error" style="margin:0">${esc(error.message)}</p>`; return; }
    const list = data || [];

    const daySet = new Set(list.map((c) => c.date));
    const td = todayStr();
    let cur = new Date(td + 'T00:00:00+08:00');
    if (!daySet.has(td)) cur = new Date(cur.getTime() - 86400000);
    let streak = 0;
    while (streak < 1000 && daySet.has(cur.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }))) {
      streak += 1;
      cur = new Date(cur.getTime() - 86400000);
    }
    const total = list.length;
    const onTime = list.filter((c) => c.status === 'on_time').length;
    const rate = total ? Math.round((onTime / total) * 100) : 0;

    const ws = weekStart();
    const weekDates = Array.from({ length: 7 }, (_, i) => dateAdd(ws, i));
    const stCls = (c) => (!c ? 'off' : c.status === 'excused' ? 'ex' : c.status === 'late' ? 'lt' : 'ok');
    const grid = state.tasks.map((t) => `
      <div class="mg-row">
        <span class="mg-lab">${esc(t.title)}</span>
        <span class="mg-cells">${weekDates.map((d) => {
          const c = list.find((x) => x.task_id === t.id && x.date === d);
          return `<i class="mg-c ${stCls(c)}" title="${d}${c ? '' : ' 没打卡'}"></i>`;
        }).join('')}</span>
      </div>`).join('');

    const recent = list.filter((c) => c.task_id).slice(0, 6).map((c) => {
      const tn = taskName(c.task_id);
      return `
      <div class="list-row">
        <div><div>${c.date.slice(5)} ${timeOf(c.done_at)}</div><div class="label">${esc(tn || '已归档的任务')}</div></div>
        <span class="val">${c.status === 'on_time' ? '按时' : c.status === 'late' ? '补记' : '豁免'}</span>
      </div>`;
    }).join('');

    sheetBody.innerHTML = `
      <div class="m-kpis">
        <div class="m-kpi"><b>${streak}</b><span>连续天数</span></div>
        <div class="m-kpi"><b>${total}</b><span>总打卡</span></div>
        <div class="m-kpi"><b>${rate}%</b><span>按时率</span></div>
      </div>
      <div class="field"><label>本周 · 任务 × 七天</label></div>
      <div class="mg-wrap">${grid || '<p class="hint" style="margin:0">还没有任务。</p>'}</div>
      <div class="field" style="margin-top:16px"><label>最近打卡</label></div>
      ${recent || '<p class="hint" style="margin:0">还没有打卡记录。</p>'}
      <p class="hint" style="margin-top:14px">${m.role === 'teacher' ? '教师身份：有管理权限，不打卡，也不计入成员统计。' : '只能看，不能替别人打。'}</p>
      ${uid === state.me.id ? '' : `<div class="m-del">
        ${isAdmin() && m.role === 'member' ? `<button class="btn ghost block" data-act="set-role" data-user="${uid}" data-role="teacher" style="margin-bottom:8px">设为教师（不打卡，有管理权限）</button>` : ''}
        ${isAdmin() && m.role === 'teacher' ? `<button class="btn ghost block" data-act="set-role" data-user="${uid}" data-role="member" style="margin-bottom:8px">改回普通成员</button>` : ''}
        <button class="btn ghost danger block" data-act="del-member" data-user="${uid}">删除此人及其全部数据</button>
        <p class="hint" style="margin:8px 0 0">只是暂时不让打卡就用「停」，历史会留着。</p>
      </div>`}
    `;
  }

  /* ---------- 我的 ---------- */
  function renderMe(root) {
    root.className = 'memphis-view me-view';
    const mine = state.myCheckins || [];
    const daySet = new Set(mine.map((c) => c.date));
    const nowD = new Date(todayStr() + 'T00:00:00+08:00');
    const dow = (nowD.getDay() + 6) % 7;
    let cur = new Date(nowD.getTime());
    if (!daySet.has(todayStr())) cur = new Date(nowD.getTime() - 86400000);
    let streak = 0;
    while (streak < 1000 && daySet.has(cur.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }))) {
      streak += 1;
      cur = new Date(cur.getTime() - 86400000);
    }
    const total = mine.length;
    const onTimeCount = mine.filter((c) => c.status === 'on_time').length;
    const rate = total ? Math.round((onTimeCount / total) * 100) : null;

    const ws = weekStart();
    const thisWeek = mine.filter((c) => c.date >= ws && c.date <= todayStr()).length;
    const lastWeek = mine.filter((c) => c.date >= dateAdd(ws, -7) && c.date < ws).length;
    const wDiff = thisWeek - lastWeek;

    const cnt = {};
    mine.forEach((c) => { cnt[c.date] = (cnt[c.date] || 0) + 1; });
    const startMs = nowD.getTime() - (dow + 28) * 86400000;
    const heatCells = [];
    for (let i = 0; i < 35; i++) {
      const d = new Date(startMs + i * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
      const n = cnt[d] || 0;
      heatCells.push({ d, n, lvl: n >= 3 ? 3 : n === 2 ? 2 : n === 1 ? 1 : 0, future: i > 28 + dow });
    }

    root.innerHTML = `
      <div class="topbar">${viewHeading('我', esc(state.group.name), '我的')}</div>

      <div class="card me-card">
        <label class="me-avatar" for="me-avatar-file" title="点头像换一张">
          ${avatarInner(state.me.nickname, state.me.avatar_url)}
          <i class="me-avatar-edit">换</i>
        </label>
        <input type="file" id="me-avatar-file" accept="image/*" hidden>
        <div class="me-info">
          <b data-act="edit-nickname" class="me-name">${esc(state.me.nickname)}<i class="edit-pen">改</i></b>
          <span>${roleLabel(state.me.role)} · ${(state.me.created_at || '').slice(0, 10)} 加入</span>
        </div>
      </div>

      ${isTeacher() ? `
      <div class="card">
        <div class="card-head"><h2>教师身份</h2></div>
        <p class="hint" style="margin:0">你不参与打卡，也不计入成员统计。管理权限和负责人一样：管任务、看报告、催人、改成员。</p>
      </div>` : `
      <div class="card">
        <div class="kpis">
          <div class="kpi"><b>${streak}</b><span>连续天数</span></div>
          <div class="kpi"><b>${total}</b><span>总打卡</span></div>
          <div class="kpi"><b>${rate == null ? '—' : rate + '%'}</b><span>按时率</span></div>
          <div class="kpi"><b>${thisWeek}</b><span>本周 · ${wDiff === 0 ? '与上周持平' : `较上周 ${wDiff > 0 ? '+' : ''}${wDiff}`}</span></div>
        </div>
        <div class="heat">
          ${heatCells.map((x) => `<i class="heat-c h${x.lvl}${x.future ? ' fut' : ''}" title="${x.d}${x.n ? ' · ' + x.n + ' 条' : ' · 没打卡'}"></i>`).join('')}
        </div>
        <p class="hint" style="margin:10px 0 0">最近 5 周，${heatCells.filter((x) => x.n > 0).length} 天有打卡。颜色越深，当天打卡越多；灰色是没打卡。</p>
      </div>`}

      <div class="card">
        <div class="card-head"><h2>手机日历提醒</h2></div>
        <p class="hint" style="margin-top:0">导出后导入手机日历，每天到点由手机自己提醒，不用打开网页。改了任务要重新导入；删掉的任务不会自动从日历里消失，得自己在日历里删。</p>
        <button class="btn ghost block" data-act="export-ics">导出日历文件</button>
      </div>

      <div class="card">
        <div class="card-head"><h2>我的组</h2><span class="meta">${state.groups.length} 个</span></div>
        <div class="list-row" data-act="open-groups" style="cursor:pointer">
          <div>
            <div>${esc(state.group.name)}</div>
            <div class="label">当前 · ${roleLabel(state.me.role)}</div>
          </div>
          <span class="val">切换 ›</span>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>邀请成员</h2></div>
        <p class="hint" style="margin-top:0">把这个码发给对方，他登录后选「用邀请码加入」。</p>
        <div class="invite">
          <code>${esc(state.group.invite_code)}</code>
          <span style="display:flex;gap:6px;flex:none">
            <button class="btn ghost small" data-act="copy-invite">复制</button>
            ${state.me.role === 'owner' ? `<button class="btn ghost small" data-act="regen-invite">重新生成</button>` : ''}
          </span>
        </div>
      </div>

      <div class="card">
        <div class="list-row"><span class="label">通知</span><span class="val">站内已开${state.group.wecom_webhook ? ' · 企微已配' : ' · 企微未配'}</span></div>
        <div class="list-row" data-act="open-theme" style="cursor:pointer"><span class="label">外观</span><span class="val">${currentTheme() === 'paper' ? '纸质手账' : '清爽卡片'} ›</span></div>
      </div>

      ${isAdmin() ? `
      <div class="card">
        <div class="list-row" data-act="go-admin" style="cursor:pointer">
          <span>管理任务与成员</span><span class="val">›</span>
        </div>
        <div class="list-row" data-act="go-report" style="cursor:pointer">
          <span>报告与导出</span><span class="val">›</span>
        </div>
      </div>` : ''}

      <button class="btn ghost block" data-act="logout">退出登录</button>
    `;

    const fileEl = document.getElementById('me-avatar-file');
    if (fileEl) fileEl.addEventListener('change', onAvatarPick);
  }

  function exportIcs() {
    const tasks = (state.tasks || []).filter((t) => !t.archived);
    if (!tasks.length) { toast('还没有任务，先去管理里加一条'); return; }
    try {
      const ics = CheckinExport.buildIcs({
        groupName: state.group.name,
        today: todayStr(),
        baseUrl: location.origin + location.pathname + (location.search || ''),
        tasks
      });
      downloadBlob(new Blob([ics], { type: 'text/calendar;charset=utf-8' }), `小事打卡-${state.group.name}.ics`);
      toast('已导出，用手机打开导入日历');
    } catch (err) {
      console.error('[ics]', err);
      toast('导出失败：' + (err.message || '未知错误'));
    }
  }

  async function onAvatarPick(e) {
    const f = (e.target.files || [])[0];
    e.target.value = '';
    if (!f) return;
    if (!f.type.startsWith('image/')) { toast('只支持图片'); return; }
    toast('正在上传…');
    try {
      const blob = await compressImage(f, 256, 0.85);
      const uid = (state.session && state.session.user && state.session.user.id) || state.me.auth_uid;
      const path = cloud.storage.sharedPath(uid, `avatar/${Date.now()}.jpg`);
      const up = await cloud.storage.upload(path, blob, { contentType: 'image/jpeg', cacheControl: '3600' });
      if (up && up.error) throw up.error;
      const { data, error } = await cloud.database.from('users').update({ avatar_url: path }).eq('id', state.me.id).select();
      if (error || !data || !data.length) throw (error || new Error('保存失败'));
      state.me.avatar_url = path;
      await refresh();
      toast('头像已更新');
    } catch (err) {
      console.error('[avatar]', err);
      toast('换头像失败：' + (err.message || '未知错误'));
    }
  }

  /* ---------- 管理 ---------- */
  function renderAdmin(root) {
    root.className = 'memphis-view admin-view';
    if (!isAdmin()) { root.innerHTML = '<div class="card"><div class="empty"><b>没有权限</b>只有负责人和站长能进这里。</div></div>'; return; }
    root.innerHTML = `
      <div class="topbar">${viewHeading('管', '负责人 / 站长', '管理')}</div>

      <div class="card">
        <div class="card-head"><h2>任务与截止时间</h2><span class="meta">${state.tasks.length} 项</span></div>
        ${state.tasks.map((t, i) => `
          <div class="task tone-${i % 4}">
            <div class="t-icon">${esc(t.emoji || '·')}</div>
            <div class="t-main">
              <div class="t-title">${esc(t.title)}</div>
              <div class="t-sub">${parseHM(t.deadline_time)} 截止 · ${t.reminder_offset ? `提前 ${t.reminder_offset} 分钟提醒` : '不提醒'}</div>
            </div>
            <span style="display:flex;gap:6px;flex:none">
              <button class="icon-btn" data-act="move-task" data-task="${t.id}" data-dir="-1" ${i === 0 ? 'disabled' : ''} aria-label="上移">↑</button>
              <button class="icon-btn" data-act="move-task" data-task="${t.id}" data-dir="1" ${i === state.tasks.length - 1 ? 'disabled' : ''} aria-label="下移">↓</button>
              <button class="btn ghost small" data-act="edit-task" data-task="${t.id}">编辑</button>
              <button class="icon-btn" data-act="archive-task" data-task="${t.id}" aria-label="归档">✕</button>
            </span>
          </div>`).join('') || '<div class="empty"><b>还没有任务</b>在下面加一条。</div>'}
      </div>

      <div class="card">
        <div class="card-head"><h2>加一条任务</h2></div>
        <div class="field">
          <label for="nt-title">任务名</label>
          <input class="input" id="nt-title" maxlength="20" placeholder="例如 早起">
        </div>
        <div class="field">
          <label>图标 / 每天截止时间</label>
          <div class="row-2">
            <input class="input" id="nt-emoji" maxlength="2" placeholder="🌅" style="max-width:88px;text-align:center">
            <input class="input" id="nt-deadline" type="time" value="08:30">
          </div>
        </div>
        <div class="field">
          <label for="nt-offset">提前多久提醒</label>
          <div class="input-group">
            <input class="input" id="nt-offset" type="number" min="0" max="240" step="5" value="30">
            <span class="unit">分钟</span>
          </div>
          <div class="hint" style="margin-top:6px">填 0 = 不提醒，最多 240 分钟。提醒发到站内和企业微信群。</div>
        </div>
        <button class="btn block" data-act="add-task">添加</button>
      </div>

      <div class="card">
        <div class="card-head"><h2>邀请</h2><span class="meta">把对应的码发给对方</span></div>
        <div class="code-row">
          <div class="code-info">
            <div class="code-lab">成员码</div>
            <div class="code-hint">用这个加入，需要打卡</div>
          </div>
          <span class="code-box">
            <code>${esc(state.group.invite_code)}</code>
            <button class="btn ghost small" data-act="copy-invite">复制</button>
          </span>
        </div>
        <div class="code-row teacher">
          <div class="code-info">
            <div class="code-lab">教师码 <span class="chip">教师</span></div>
            <div class="code-hint">用这个加入：有管理权限，不打卡</div>
          </div>
          <span class="code-box">
            <code>${esc(state.group.teacher_code || '—')}</code>
            <button class="btn ghost small" data-act="copy-teacher">复制</button>
            ${state.me.role === 'owner' ? `<button class="icon-btn" data-act="regen-teacher-code" aria-label="换一个教师码">↻</button>` : ''}
          </span>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>组设置</h2></div>
        <div class="list-row">
          <div><div>允许成员自己加小事</div><div class="label">关掉后，成员只能做固定任务</div></div>
          <label class="switch" data-act="toggle-custom"><input type="checkbox" id="set-custom" ${state.group.allow_member_custom ? 'checked' : ''}><i></i></label>
        </div>
        <div class="list-row" style="margin-top:12px">
          <div><div>自定义小事默认截止</div><div class="label">超过这个时间记为补记</div></div>
          <input class="input" id="set-cd" type="time" value="${parseHM(state.group.custom_deadline || '23:59')}" style="width:108px;text-align:center;flex:none">
        </div>
        <div class="field" style="margin-top:14px">
          <label for="set-webhook">企业微信群机器人地址（填了之后，点「催一下」会同时发到群里）</label>
          <input class="input" id="set-webhook" placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=..." value="${esc(state.group.wecom_webhook || '')}">
        </div>
        <button class="btn ghost block" data-act="save-settings">保存设置</button>
      </div>

      <div class="card">
        <div class="card-head"><h2>手机日历提醒</h2></div>
        <p class="hint" style="margin-top:0">导出一份发到群里，成员各自点开加入手机日历，之后就由手机自己提醒。改了任务要重新发一次。</p>
        <button class="btn ghost block" data-act="export-ics">导出日历文件</button>
      </div>
    `;
  }

  async function addTask() {
    const title = document.getElementById('nt-title').value.trim();
    const emoji = document.getElementById('nt-emoji').value.trim();
    const deadline = document.getElementById('nt-deadline').value;
    const offset = Number(document.getElementById('nt-offset').value || 30);
    if (!title) { toast('任务名不能空'); return; }
    if (!deadline) { toast('设一个截止时间'); return; }
    const { error } = await cloud.database.from('tasks').insert({
      group_id: state.group.id,
      title,
      emoji: emoji || null,
      deadline_time: deadline,
      reminder_offset: offset,
      position: state.tasks.length,
      created_by: state.me.id
    });
    if (error) { toast(error.message || '添加失败'); return; }
    await refresh();
    toast('已添加');
  }

  function editTaskSheet(id) {
    const t = state.tasks.find((x) => x.id === id);
    if (!t) return;
    openSheet('编辑任务', `
      <div class="field">
        <label for="et-title">任务名</label>
        <input class="input" id="et-title" maxlength="20" value="${esc(t.title)}">
      </div>
      <div class="field">
        <label>图标 / 每天截止时间</label>
        <div class="row-2">
          <input class="input" id="et-emoji" maxlength="2" value="${esc(t.emoji || '')}" style="max-width:88px;text-align:center">
          <input class="input" id="et-deadline" type="time" value="${parseHM(t.deadline_time)}">
        </div>
      </div>
      <div class="field">
        <label for="et-offset">提前多久提醒</label>
        <div class="input-group">
          <input class="input" id="et-offset" type="number" min="0" max="240" step="5" value="${t.reminder_offset}">
          <span class="unit">分钟</span>
        </div>
        <div class="hint" style="margin-top:6px">填 0 = 不提醒</div>
      </div>
      <button class="btn block" data-act="save-task" data-task="${t.id}">保存</button>
    `);
  }

  async function saveTask(id) {
    const title = document.getElementById('et-title').value.trim();
    const emoji = document.getElementById('et-emoji').value.trim();
    const deadline = document.getElementById('et-deadline').value;
    const offset = Number(document.getElementById('et-offset').value || 0);
    if (!title) { toast('任务名不能空'); return; }
    if (!deadline) { toast('设一个截止时间'); return; }
    const btn = document.querySelector('[data-act="save-task"]');
    if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
    const { data, error } = await cloud.database.from('tasks').update({
      title,
      emoji: emoji || null,
      deadline_time: deadline,
      reminder_offset: Math.max(0, Math.min(240, offset))
    }).eq('id', id).select();
    if (error || !data || !data.length) {
      if (btn) { btn.disabled = false; btn.textContent = '保存'; }
      toast((error && error.message) || '保存失败');
      return;
    }
    closeSheet();
    await refresh();
    toast('已保存');
  }

  async function archiveTask(id) {
    if (!confirm('归档这条任务？历史记录会保留。')) return;
    const { data, error } = await cloud.database.from('tasks').update({ archived: true }).eq('id', id).select();
    if (error || !data || !data.length) { toast('归档失败'); return; }
    await refresh();
    toast('已归档');
  }

  async function toggleAllowCustom(val, box) {
    const { data, error } = await cloud.database.from('groups')
      .update({ allow_member_custom: val }).eq('id', state.group.id).select();
    if (error || !data || !data.length) {
      if (box) box.checked = !val;
      toast('没保存上：' + ((error && error.message) || '可能没有权限'));
      return;
    }
    state.group = data[0];
    toast(val ? '已允许成员自己加小事' : '已关闭，成员只能做固定任务');
  }

  async function regenTeacherCode() {
    if (!confirm('换一个新的教师码？旧码立即失效，已经进来的老师不受影响。')) return;
    const { data, error } = await cloud.database.rpc('regenerate_teacher_code');
    if (error) { toast(error.message || '换码失败'); return; }
    await refresh();
    toast('新教师码：' + ((data && data.teacher_code) || ''));
  }

  async function saveSettings() {
    const allow = document.getElementById('set-custom').checked;
    const webhook = document.getElementById('set-webhook').value.trim();
    const cd = document.getElementById('set-cd').value || '23:59';
    const { data, error } = await cloud.database.from('groups').update({
      allow_member_custom: allow,
      wecom_webhook: webhook || null,
      custom_deadline: cd
    }).eq('id', state.group.id).select();
    if (error || !data || !data.length) { toast(error ? (error.message || '保存失败') : '保存失败，可能没有权限'); return; }
    state.group = data[0];
    toast('已保存');
  }

  async function setLeader(userId) {
    const m = (state.allUsers || []).find((x) => x.id === userId);
    if (!confirm(`把 ${m ? m.nickname : '他'} 设为负责人？他会拿到管理权限，其他负责人不受影响。`)) return;
    const { error } = await cloud.database.rpc('set_leader', { p_user_id: userId });
    if (error) { toast(error.message || '设置失败'); return; }
    await enterApp();
    toast('已设为负责人');
  }

  async function unsetLeader(userId) {
    const m = (state.allUsers || []).find((x) => x.id === userId);
    if (!confirm(`取消 ${m ? m.nickname : '他'} 的负责人？他会变回普通成员，要重新打卡。`)) return;
    const { error } = await cloud.database.rpc('unset_leader', { p_user_id: userId });
    if (error) { toast(error.message || '取消失败'); return; }
    await enterApp();
    toast('已取消负责人');
  }

  async function moveTask(id, dir) {
    const list = state.tasks.slice();
    const i = list.findIndex((t) => t.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    for (let idx = 0; idx < list.length; idx++) {
      const { error } = await cloud.database.from('tasks').update({ position: idx }).eq('id', list[idx].id);
      if (error) { toast(error.message || '排序失败'); return; }
    }
    await refresh();
    toast('已调整顺序');
  }

  async function setRole(uid, role) {
    const m = (state.allUsers || []).find((x) => x.id === uid);
    if (!m) return;
    const toTeacher = role === 'teacher';
    const ok = confirm(toTeacher
      ? `把 ${m.nickname} 设为教师？\n\n他会拿到和负责人一样的管理权限（管任务、看报告、删成员），但不再需要打卡，也不计入任何统计。`
      : `把 ${m.nickname} 改回普通成员？\n\n他会重新需要打卡，并计入统计。`);
    if (!ok) return;
    const { error } = await cloud.database.rpc('set_member_role', { p_user_id: uid, p_role: role });
    if (error) { toast(error.message || '操作失败'); return; }
    closeSheet();
    await refresh();
    toast(toTeacher ? '已设为教师' : '已改回成员');
  }

  async function setMemberActive(userId, on) {
    const m = state.inactive.find((x) => x.id === userId)
      || (state.allUsers || []).find((x) => x.id === userId);
    if (!on && !confirm(`停用 ${m ? m.nickname : '该成员'}？他不能再打卡，历史记录保留。`)) return;
    const { error } = await cloud.database.rpc('set_member_active', { p_user_id: userId, p_active: on });
    if (error) { toast(error.message || '操作失败'); return; }
    await refresh();
    toast(on ? '已恢复' : '已停用');
  }

  async function regenInvite() {
    if (!confirm('重新生成邀请码？旧码立即失效，还没加入的人要用新码。')) return;
    const { data, error } = await cloud.database.rpc('regenerate_invite');
    if (error) { toast(error.message || '操作失败'); return; }
    await refresh();
    toast('新邀请码：' + ((data && data.invite_code) || ''));
  }

  async function excuseToday(userId, on) {
    const { data, error } = await cloud.database.rpc('set_excused_today', { p_user_id: userId, p_on: on });
    if (error) { toast(error.message || '操作失败'); return; }
    await refresh();
    const n = (data && data.affected) || 0;
    if (on && !n) toast('他今天已经打过卡，无需豁免');
    else toast(on ? '已豁免今天' : '已取消豁免');
  }

  async function requestHandover(userId) {
    const m = state.members.find((x) => x.id === userId);
    if (!m) return;
    if (!confirm(`把负责人交给 ${m.nickname}？需要对方点「接受」才生效，24 小时内有效。`)) return;
    const { error } = await cloud.database.rpc('request_handover', { p_to_user_id: userId });
    if (error) { toast(error.message || '发起失败'); return; }
    await refresh();
    toast('已发出，等对方接受');
  }

  async function respondHandover(id, accept) {
    if (accept && !confirm('接下负责人？接受后你会管理任务、提醒和导出。')) return;
    const { data, error } = await cloud.database.rpc('respond_handover', { p_id: id, p_accept: accept });
    if (error) { toast(error.message || '操作失败'); return; }
    if (data && data.ok === false) {
      closeSheet();
      await refresh();
      toast(data.reason === 'expired' ? '这个交接已经过期了' : '这个交接已经处理过了');
      return;
    }
    closeSheet();
    await enterApp();
    toast(accept ? '你已经是负责人' : '已拒绝这次交接');
  }

  async function logout() {
    await cloud.auth.signOut();
    state.me = null; state.group = null;
    renderLogin('');
  }


  /* ---------- 报告 ---------- */
  const libCache = {};
  function loadLib(globalName) {
    if (window[globalName]) return Promise.resolve();
    if (libCache[globalName]) return libCache[globalName];
    const src = globalName === 'XLSX' ? 'vendor/xlsx.full.min.js?v=7' : 'vendor/docx.umd.js?v=7';
    libCache[globalName] = new Promise((res, rej) => {
      const el = document.createElement('script');
      el.src = src;
      el.onload = () => res();
      el.onerror = () => rej(new Error('生成库加载失败'));
      document.head.appendChild(el);
    });
    return libCache[globalName];
  }

  function isoDaysAgo(n) {
    const d = new Date(Date.now() - n * 86400000);
    return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  }

  function reportState() {
    if (!state.report) {
      state.report = { range: '7', start: isoDaysAgo(6), end: isoDaysAgo(0), payload: null, summary: '', busy: false, error: '', detailAll: false };
    }
    return state.report;
  }

  function eachDate(start, end) {
    const out = [];
    const s = new Date(start + 'T00:00:00+08:00');
    const e = new Date(end + 'T00:00:00+08:00');
    for (let t = s.getTime(); t <= e.getTime(); t += 86400000) {
      out.push(new Date(t).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }));
    }
    return out;
  }

  function renderReport(root) {
    root.className = 'memphis-view report-view';
    if (!isAdmin()) { root.innerHTML = '<div class="card"><div class="empty"><b>没有权限</b>只有负责人和站长能看报告。</div></div>'; return; }
    const r = reportState();
    root.innerHTML = `
      <div class="topbar">${viewHeading('报', '负责人 / 站长', '报告')}</div>

      <div class="card">
        <div class="card-head"><h2>时间范围</h2><span class="meta">最长 92 天</span></div>
        <div class="seg" id="rp-seg" style="margin-bottom:14px">
          <button data-range="7" class="${r.range === '7' ? 'on' : ''}">最近 7 天</button>
          <button data-range="month" class="${r.range === 'month' ? 'on' : ''}">本月</button>
          <button data-range="custom" class="${r.range === 'custom' ? 'on' : ''}">自定义</button>
        </div>
        <div class="row-2" id="rp-dates" ${r.range === 'custom' ? '' : 'hidden'}>
          <input class="input" type="date" id="rp-start" value="${r.start}">
          <input class="input" type="date" id="rp-end" value="${r.end}">
        </div>
        <button class="btn block" data-act="run-report" ${r.busy ? 'disabled' : ''}>${r.busy ? '统计中…' : '生成报告'}</button>
        ${r.error ? `<div class="error">${esc(r.error)}</div>` : ''}
      </div>

      <div id="rp-body"></div>
    `;

    root.querySelectorAll('#rp-seg button').forEach((b) => {
      b.addEventListener('click', () => {
        r.range = b.dataset.range;
        if (r.range === '7') { r.start = isoDaysAgo(6); r.end = isoDaysAgo(0); }
        if (r.range === 'month') {
          const now = new Date();
          const first = new Date(now.getFullYear(), now.getMonth(), 1);
          r.start = first.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
          r.end = isoDaysAgo(0);
        }
        renderReport(root);
      });
    });

    paintReportBody();
  }

  function paintReportBody() {
    const box = document.getElementById('rp-body');
    if (!box) return;
    const r = reportState();
    if (!r.payload) {
      box.innerHTML = `<div class="card"><div class="empty-lg"><div class="e-ico">▦</div><b>还没有报告</b><p>选一个时间段，点「生成报告」。统计完可以导出 HTML、Word、CSV、Excel。</p></div></div>`;
      return;
    }
    const m = r.payload.metrics;
    const rows = r.payload.rows || [];
    const shown = r.detailAll ? rows : rows.slice(0, 30);
    const stText = (s) => ({ on_time: '按时', late: '补记', excused: '豁免' }[s] || s);
    box.innerHTML = `
      <div class="card">
        <div class="card-head"><h2>${esc(r.start)} ~ ${esc(r.end)}</h2><span class="meta">${m.days} 天 · ${m.members} 人</span></div>
        <div class="kpis">
          <div class="kpi"><b>${pctText(m.rateOnTime)}</b><span>按时率</span></div>
          <div class="kpi"><b>${pctText(m.rateDone)}</b><span>完成率</span></div>
          <div class="kpi"><b>${m.onTime}</b><span>按时条数</span></div>
          <div class="kpi"><b>${m.missing}</b><span>未完成</span></div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>总结</h2>
          <button class="btn ghost small" data-act="gen-summary" ${r.busy ? 'disabled' : ''}>${r.summary ? '重新生成' : (r.busy ? '生成中…' : '用模型写一段')}</button>
        </div>
        ${r.summary ? `<div class="summary-box">${esc(r.summary)}</div>${r.modelLabel ? `<p class="hint" style="margin-top:8px">由 ${esc(r.modelLabel)} 生成</p>` : ''}` : '<p class="rail-empty">不生成也能导出，只是文档里少一段文字总结。</p>'}
      </div>

      <div class="card">
        <div class="card-head"><h2>成员</h2></div>
        ${m.perMember.map((x) => `
          <div class="stat-row">
            <span class="stat-name">${esc(x.name)}</span>
            <span class="stat-bar"><i style="width:${Math.round((x.rate || 0) * 100)}%"></i></span>
            <span class="stat-val">${pctText(x.rate)}</span>
            <span class="stat-n">${x.done}/${x.expected}</span>
          </div>`).join('')}
      </div>

      <div class="card">
        <div class="card-head"><h2>任务</h2></div>
        ${m.perTask.map((x) => `
          <div class="stat-row">
            <span class="stat-name">${esc(x.title)}</span>
            <span class="stat-bar"><i style="width:${Math.round((x.rate || 0) * 100)}%"></i></span>
            <span class="stat-val">${pctText(x.rate)}</span>
            <span class="stat-n">${x.done}/${x.expected}</span>
          </div>`).join('')}
      </div>

      <div class="card">
        <div class="card-head"><h2>明细</h2><span class="meta">${rows.length} 条${r.detailAll || rows.length <= 30 ? '' : ` · 显示最近 30 条`}</span></div>
        ${rows.length ? `
        <div class="tbl-wrap">
          <table class="matrix detail-table">
            <thead><tr><th>日期</th><th>成员</th><th>任务</th><th>状态</th><th>时间</th><th>赞</th><th>照片</th></tr></thead>
            <tbody>
              ${shown.map((x) => `
                <tr>
                  <td>${esc(x.date.slice(5))}</td>
                  <td>${esc(x.nickname)}</td>
                  <td>${esc(x.task)}</td>
                  <td><span class="st ${x.status}">${stText(x.status)}</span></td>
                  <td>${esc(x.time || '')}</td>
                  <td>${x.likes || 0}</td>
                  <td>${x.photos || 0}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
        ${rows.length > 30 ? `<button class="btn ghost block" data-act="detail-all" style="margin-top:12px">${r.detailAll ? '收起到 30 条' : `显示全部 ${rows.length} 条`}</button>` : ''}
        ` : '<p class="rail-empty">这个区间还没有打卡记录。</p>'}
      </div>

      <div class="card">
        <div class="card-head"><h2>导出</h2><span class="meta">${r.payload.rows.length} 条明细</span></div>
        <div class="export-grid">
          <button class="btn ghost small" data-act="export" data-fmt="html">HTML</button>
          <button class="btn ghost small" data-act="export" data-fmt="docx">Word</button>
          <button class="btn ghost small" data-act="export" data-fmt="csv">CSV</button>
          <button class="btn ghost small" data-act="export" data-fmt="xlsx">Excel</button>
        </div>
        <p class="hint" style="margin-top:10px">全部在浏览器里生成，不上传服务器。带照片的 HTML 和 Word 会慢几秒。</p>
      </div>
    `;
  }

  function pctText(v) {
    if (v == null || !isFinite(v)) return '—';
    return (v * 100).toFixed(1) + '%';
  }

  async function runReport() {
    const r = reportState();
    const startEl = document.getElementById('rp-start');
    const endEl = document.getElementById('rp-end');
    if (r.range === 'custom' && startEl && endEl) {
      r.start = startEl.value || r.start;
      r.end = endEl.value || r.end;
    }
    if (!r.start || !r.end) { r.error = '选一个开始和结束日期'; return; }
    if (r.start > r.end) { r.error = '开始日期不能晚于结束日期'; return; }
    const span = Math.round((new Date(r.end) - new Date(r.start)) / 86400000) + 1;
    if (span > 92) { r.error = '一次最多统计 92 天'; return; }

    r.busy = true; r.error = ''; r.summary = ''; r.detailAll = false;
    renderReport(document.getElementById('view'));

    try {
      r.payload = await collectReport(r.start, r.end);
    } catch (err) {
      console.error('[report]', err);
      r.error = err.message || '统计失败';
      r.payload = null;
    }
    r.busy = false;
    renderReport(document.getElementById('view'));
  }

  async function collectReport(start, end) {
    const gid = state.group.id;
    const { data: checkins, error } = await withTimeout(cloud.database
      .from('checkins').select('*').eq('group_id', gid).gte('date', start).lte('date', end), 20000, 'report');
    if (error) throw new Error(error.message || '读取打卡失败');

    const rowsRaw = checkins || [];
    let atts = [];
    if (rowsRaw.length) {
      const ids = rowsRaw.map((c) => c.id);
      const res = await cloud.database.from('attachments').select('id,checkin_id,path').in('checkin_id', ids);
      atts = res.data || [];
    }
    const photoMap = {};
    atts.forEach((a) => { (photoMap[a.checkin_id] = photoMap[a.checkin_id] || []).push(a.path); });

    const likeMap = {};
    if (rowsRaw.length) {
      const lr = await cloud.database.from('likes').select('checkin_id').in('checkin_id', rowsRaw.map((c) => c.id));
      (lr.data || []).forEach((l) => { likeMap[l.checkin_id] = (likeMap[l.checkin_id] || 0) + 1; });
    }

    const days = eachDate(start, end);
    const tasks = state.tasks;
    const members = state.members;

    const key = (u, t, d) => `${u}|${t}|${d}`;
    const byKey = {};
    rowsRaw.forEach((c) => { byKey[key(c.user_id, c.task_id || 'custom', c.date)] = c; });

    const perMember = members.map((m) => {
      const joined = (m.created_at || '').slice(0, 10) || start;
      const active = days.filter((d) => d >= joined);
      let on = 0, late = 0, exc = 0;
      active.forEach((d) => tasks.forEach((t) => {
        const c = byKey[key(m.id, t.id, d)];
        if (!c) return;
        if (c.status === 'excused') exc += 1;
        else if (c.status === 'late') late += 1;
        else on += 1;
      }));
      const expected = active.length * tasks.length;
      const done = on + late;
      return { name: m.nickname, expected, done, late, excused: exc, missing: Math.max(0, expected - done - exc), rate: expected ? done / expected : null };
    });

    const daysCount = days.length;
    const perTask = tasks.map((t) => {
      let on = 0, late = 0, expected = 0;
      members.forEach((m) => {
        const joined = (m.created_at || '').slice(0, 10) || start;
        const active = days.filter((d) => d >= joined).length;
        expected += active;
        active && days.forEach((d) => {
          const c = byKey[key(m.id, t.id, d)];
          if (!c) return;
          if (c.status === 'late') late += 1;
          else if (c.status !== 'excused') on += 1;
        });
      });
      const done = on + late;
      return { title: t.title, deadline: parseHM(t.deadline_time), expected, done, rate: expected ? done / expected : null };
    });

    const expected = perMember.reduce((a, x) => a + x.expected, 0);
    const onTime = rowsRaw.filter((c) => c.status === 'on_time').length;
    const late = rowsRaw.filter((c) => c.status === 'late').length;
    const excused = rowsRaw.filter((c) => c.status === 'excused').length;
    const missing = Math.max(0, expected - onTime - late - excused);

    const taskTitle = (id) => (tasks.find((t) => t.id === id) || {}).title || '';
    const nameOf = (id) => (members.find((m) => m.id === id) || {}).nickname || '成员';

    const rows = rowsRaw
      .slice()
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
      .map((c) => ({
        date: c.date,
        nickname: nameOf(c.user_id),
        task: c.task_id ? taskTitle(c.task_id) : (c.title || '小事'),
        status: c.status,
        time: timeOf(c.done_at),
        note: c.note || '',
        likes: likeMap[c.id] || 0,
        photos: (photoMap[c.id] || []).length,
        paths: photoMap[c.id] || []
      }));

    return {
      meta: {
        groupName: state.group.name,
        rangeStart: start,
        rangeEnd: end,
        days: daysCount,
        members: members.length,
        tasks: tasks.length,
        generatedAt: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
      },
      metrics: { days: daysCount, members: members.length, expected, onTime, late, excused, missing, rateOnTime: expected ? onTime / expected : null, rateDone: expected ? (onTime + late) / expected : null, perMember, perTask },
      rows
    };
  }

  function factsForModel(p) {
    const m = p.metrics;
    const lines = [
      `小组：${p.meta.groupName}`,
      `区间：${p.meta.rangeStart} 至 ${p.meta.rangeEnd}，共 ${p.meta.days} 天`,
      `成员 ${p.meta.members} 人，任务 ${p.meta.tasks} 项`,
      `应完成 ${m.expected} 条，按时 ${m.onTime} 条，补记 ${m.late} 条，豁免 ${m.excused} 条，未完成 ${m.missing} 条`,
      `按时率 ${pctText(m.rateOnTime)}，完成率 ${pctText(m.rateDone)}`,
      '成员明细：' + m.perMember.map((x) => `${x.name} 应完成${x.expected}按时${x.done}未完成${x.missing}`).join('；'),
      '任务明细：' + m.perTask.map((x) => `${x.title} 完成率${pctText(x.rate)}`).join('；')
    ];
    return lines.join('\n');
  }

  const SUMMARY_SYSTEM_PROMPT = [
    '你是打卡小组的数据记录员。用户会给你一组已经算好的统计数字，你要把它写成一段给组内成员看的中文说明。',
    '',
    '口径（必须遵守，不要自己重算）：',
    '- 应完成 = 区间内每天的生效任务数 × 成员数 − 豁免数。',
    '- 按时率 = 按时数 ÷ 应完成；完成率 = (按时 + 补记) ÷ 应完成。',
    '- 「补记」只进完成率，不进按时率；「豁免」两边都不计。',
    '',
    '写作要求：',
    '1. 只用输入里出现的数字和人名，不推算、不补全、不编造。',
    '2. 先写整体：区间、成员与任务数、应完成条数、按时率、完成率。',
    '3. 再点出最需要留意的 1–2 处事实，例如某成员连续未完成、某项任务完成率偏低。',
    '4. 只陈述事实。禁止评价（如「态度不积极」「值得表扬」）、禁止排名、禁止比较谁比谁好、禁止鼓励或批评。',
    '5. 不用比喻、不用感叹号、不用「大家」「加油」这类口语。',
    '6. 分 2–3 句，总长 230 字以内，简体中文。',
    '7. 某项为 0 或缺失就直接略过，不要写「数据缺失」。',
    '8. 只输出这一段话本身，不要标题、不要列表符号、不要 Markdown。'
  ].join('\n');

  const FREE_MODEL_IDS = ['hy4free', 'hy3'];

  function pickFreeModel(list) {
    const usable = (list || []).filter((m) => m && m.disabled !== true && m.enabled !== false);
    for (const id of FREE_MODEL_IDS) {
      const hit = usable.find((m) => m.id === id);
      if (hit) return hit;
    }
    const zero = usable.find((m) => /x?0(\.0+)?\s*credits?/i.test(String(m.credits || '')));
    return zero || usable.find((m) => m.id === 'auto') || usable[0] || null;
  }

  function llmErrorText(err) {
    const code = (err && err.error && err.error.code) || '';
    if (String(code).indexOf('quota_') === 0) return '本月 AI 额度已用完。报告和导出照常可用，只是少这段文字。';
    if (String(code).indexOf('gateway_') === 0 || String(code).indexOf('model_') === 0) return '模型服务暂时不可用，过会儿再试，或直接导出。';
    if (String(code).indexOf('auth_') === 0) return 'AI 通道鉴权失败，需要重新开通云服务。';
    return (err && err.message) || '生成失败，可以直接导出';
  }

  async function generateSummary() {
    const r = reportState();
    if (!r.payload) return;
    r.busy = true; r.error = '';
    paintReportBody();
    try {
      const models = await cloud.llm.models.list();
      const list = Array.isArray(models) ? models : (models && models.data) || [];
      const model = pickFreeModel(list);
      if (!model) throw new Error('这个应用没有可用模型');
      r.modelLabel = model.name || model.id;
      let text = '';
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 90000);
      try {
        for await (const chunk of cloud.llm.chat.completions.create({
          model: model.id,
          messages: [
            { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
            { role: 'user', content: factsForModel(r.payload) }
          ],
          stream: true,
          signal: controller.signal
        })) {
          const d = chunk.choices[0] && chunk.choices[0].delta && chunk.choices[0].delta.content;
          if (d) text += d;
        }
      } catch (e) {
        if (e && e.name === 'AbortError') throw new Error('模型超过 90 秒没写完，已中断。可以重试，或直接导出。');
        throw e;
      } finally {
        clearTimeout(timer);
      }
      r.summary = text.trim() || '';
      if (!r.summary) throw new Error('模型没有返回内容');
    } catch (err) {
      console.error('[summary]', err);
      r.error = llmErrorText(err);
    }
    r.busy = false;
    paintReportBody();
  }

  async function thumbOf(path, maxEdge = 320) {
    const blob = await cloud.storage.download(path);
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
    const out = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.72));
    if (bmp.close) bmp.close();
    const buf = new Uint8Array(await out.arrayBuffer());
    const dataUrl = canvas.toDataURL('image/jpeg', 0.72);
    return { bytes: buf, width: w, height: h, dataUrl };
  }

  async function exportReport(fmt) {
    const r = reportState();
    if (!r.payload) return;
    const btn = document.querySelector(`[data-act="export"][data-fmt="${fmt}"]`);
    if (btn) { btn.disabled = true; btn.dataset.label = btn.textContent; btn.textContent = '准备中…'; }
    try {
      const data = Object.assign({}, r.payload, { summary: r.summary, photos: [] });

      if (fmt === 'html' || fmt === 'docx') {
        const picks = [];
        data.rows.forEach((row) => row.paths.forEach((p) => { if (picks.length < 6) picks.push({ path: p, caption: `${row.date} ${row.nickname} ${row.task}` }); }));
        for (const p of picks) {
          try {
            const t = await thumbOf(p.path);
            data.photos.push({ ...p, ...t });
          } catch (e) { /* 单张失败跳过 */ }
        }
      }

      const stamp = `${r.start}_${r.end}`;
      if (fmt === 'csv') {
        downloadBlob(new Blob([CheckinExport.buildCsv(data)], { type: 'text/csv;charset=utf-8' }), `打卡明细_${stamp}.csv`);
      } else if (fmt === 'html') {
        downloadBlob(new Blob([CheckinExport.buildHtml(data)], { type: 'text/html;charset=utf-8' }), `打卡总结_${stamp}.html`);
      } else if (fmt === 'xlsx') {
        await loadLib('XLSX');
        downloadBlob(CheckinExport.buildXlsx(data, window.XLSX), `打卡汇总_${stamp}.xlsx`);
      } else if (fmt === 'docx') {
        await loadLib('docx');
        downloadBlob(await CheckinExport.buildDocx(data, window.docx), `打卡总结_${stamp}.docx`);
      }
      toast('已开始下载');
    } catch (err) {
      console.error('[export]', err);
      toast((err && err.message) || '导出失败');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = btn.dataset.label || '导出'; }
    }
  }

  function downloadBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 8000);
  }

  /* ---------- 事件 ---------- */
  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    if (act === 'toggle-task') return toggleTask(el.dataset.task, el.dataset.checkin);
    if (act === 'retry-load') return retryLoad();
    if (act === 'open-member') return openMemberSheet(el.dataset.user);
    if (act === 'del-member') return deleteMember(el.dataset.user);
    if (act === 'submit-checkin') return submitCheckin(el.dataset.task);
    if (act === 'del-photo') { state.pendingPhotos.splice(Number(el.dataset.i), 1); return paintShots(); }
    if (act === 'view-photo') return openPhoto(el.dataset.src);
    if (act === 'wall-tab') { state.wallTab = el.dataset.tab; return renderWall(document.getElementById('view')); }
    if (act === 'open-post') return openPostSheet(el.dataset.checkin);
    if (act === 'toggle-like') return toggleLike(el.dataset.checkin);
    if (act === 'set-checkin-status') return setCheckinStatus(el.dataset.checkin, el.dataset.status);
    if (act === 'del-checkin') return delCheckin(el.dataset.checkin);
    if (act === 'save-edit') return saveEdit();
    if (act === 'ed-del-keep') { if (state.edit) { state.edit.keep[Number(el.dataset.i)].removed = true; paintEditShots(); } return; }
    if (act === 'ed-del-new') { if (state.edit) { state.edit.newPhotos.splice(Number(el.dataset.i), 1); paintEditShots(); } return; }
    if (act === 'open-notifs') return openNotifications();
    if (act === 'run-report') return runReport();
    if (act === 'detail-all') { const rr = reportState(); rr.detailAll = !rr.detailAll; return paintReportBody(); }
    if (act === 'gen-summary') return generateSummary();
    if (act === 'export') return exportReport(el.dataset.fmt);
    if (act === 'open-custom') return openCustomSheet();
    if (act === 'submit-custom') return submitCustom();
    if (act === 'copy-invite') return copyText(state.group.invite_code);
    if (act === 'copy-teacher') return copyText(state.group.teacher_code || '');
    if (act === 'export-ics') return exportIcs();
    if (act === 'copy-progress') return copyProgress();
    if (act === 'remind') return remind();
    if (act === 'add-task') return addTask();
    if (act === 'edit-task') return editTaskSheet(el.dataset.task);
    if (act === 'save-task') return saveTask(el.dataset.task);
    if (act === 'archive-task') return archiveTask(el.dataset.task);
    if (act === 'move-task') return moveTask(el.dataset.task, Number(el.dataset.dir));
    if (act === 'set-active') return setMemberActive(el.dataset.user, el.dataset.on === '1');
    if (act === 'set-role') return setRole(el.dataset.user, el.dataset.role);
    if (act === 'regen-invite') return regenInvite();
    if (act === 'excuse-today') return excuseToday(el.dataset.user, el.dataset.on === '1');
    if (act === 'save-settings') return saveSettings();
    if (act === 'toggle-custom') { const box = el.querySelector('input'); return toggleAllowCustom(box.checked, box); }
    if (act === 'regen-teacher-code') return regenTeacherCode();
    if (act === 'open-theme') return openThemeSheet();
    if (act === 'pick-theme') {
      applyTheme(el.dataset.theme || 'fresh');
      closeSheet();
      renderShell();
      return toast(currentTheme() === 'paper' ? '已换成纸质手账' : '已换成清爽卡片');
    }
    if (act === 'edit-nickname') return openNicknameSheet();
    if (act === 'save-nickname') return saveNickname();
    if (act === 'open-groups') return openGroupsSheet();
    if (act === 'switch-group') return switchGroup(el.dataset.group);
    if (act === 'new-group') { closeSheet(); return renderOnboarding('create'); }
    if (act === 'join-group') { closeSheet(); return renderOnboarding('join'); }
    if (act === 'set-leader') return setLeader(el.dataset.user);
    if (act === 'unset-leader') return unsetLeader(el.dataset.user);
    if (act === 'request-handover') return requestHandover(el.dataset.user);
    if (act === 'respond-handover') return respondHandover(el.dataset.h, el.dataset.accept === '1');
    if (act === 'go-admin') { state.view = 'admin'; history.replaceState(null, '', '#/admin'); return renderShell(); }
    if (act === 'go-report') { state.view = 'report'; history.replaceState(null, '', '#/report'); return renderShell(); }
    if (act === 'open-progress') { state.view = 'progress'; history.replaceState(null, '', '#/progress'); return renderShell(); }
    if (act === 'logout') return logout();
  });

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); toast('已复制'); }
    catch (err) { toast('复制失败，请长按选择'); }
  }

  document.getElementById('sheet-close').addEventListener('click', closeSheet);
  sheetEl.addEventListener('click', (e) => { if (e.target === sheetEl) closeSheet(); });
  window.addEventListener('hashchange', () => {
    const v = location.hash.replace('#/', '');
    if (v && v !== state.view && state.me) { state.view = v; renderShell(); }
  });

  /* ---------- 定时刷新 ---------- */
  setInterval(async () => {
    if (document.hidden || !state.me || !cloud) return;
    if (!sheetEl.hidden) return;
    const ae = document.activeElement;
    if (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) return;
    try {
      const y = window.scrollY;
      await loadAll();
      renderShell();
      window.scrollTo(0, y);
    } catch (err) {
      console.error('[poll]', err);
    }
  }, 15000);

  boot();
})();
