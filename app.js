/* 小事打卡 · 前端主逻辑
   M2：登录、建组/加入、今日、进度、管理、我的
   照片与定时提醒在下一步接入 */

(function () {
  const cfg = window.APP_CONFIG;
  const cloud = WorkBuddyCloud.createWorkBuddyCloud({
    endpoint: cfg.endpoint,
    oauthRelayBaseUrl: cfg.oauthRelayBaseUrl,
    publishableKey: cfg.publishableKey
  });

  const app = document.getElementById('app');
  const sheetEl = document.getElementById('sheet');
  const sheetTitle = document.getElementById('sheet-title');
  const sheetBody = document.getElementById('sheet-body');
  const toastEl = document.getElementById('toast');

  const state = {
    session: null,
    me: null,
    group: null,
    tasks: [],
    members: [],
    todayCheckins: [],
    weekCheckins: [],
    attachments: {},
    notifications: [],
    unread: 0,
    pendingPhotos: [],
    view: 'today',
    pendingOtp: null,
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

  function openSheet(title, html) {
    sheetTitle.textContent = title;
    sheetBody.innerHTML = html;
    sheetEl.hidden = false;
  }
  function closeSheet() {
    sheetEl.hidden = true;
    sheetBody.innerHTML = '';
  }

  /* ---------- 启动 ---------- */
  async function boot() {
    try {
      const { data: session } = await cloud.auth.getSession();
      if (!session) return renderLogin();
      state.session = session;
      await enterApp();
    } catch (err) {
      console.error('[boot]', err);
      renderLogin('打开失败，请刷新重试');
    }
  }

  async function enterApp() {
    const { data, error } = await cloud.database.rpc('my_context');
    if (error) {
      console.error('[context]', error);
      return renderLogin('读取身份失败：' + (error.message || '未知错误'));
    }
    if (!data) return renderOnboarding();
    state.me = data.user;
    state.group = data.group;
    state.view = 'today';
    await loadAll();
    renderShell();
  }

  async function loadAll() {
    const gid = state.group.id;
    const day = todayStr();
    const [tasksRes, membersRes, todayRes, weekRes] = await Promise.all([
      cloud.database.from('tasks').select('*').eq('group_id', gid).eq('archived', false).order('position', { ascending: true }),
      cloud.database.from('users').select('id,nickname,role,active,created_at').eq('group_id', gid).eq('active', true).order('created_at', { ascending: true }),
      cloud.database.from('checkins').select('*').eq('group_id', gid).eq('date', day),
      cloud.database.from('checkins').select('*').eq('group_id', gid).gte('date', weekStart()).order('done_at', { ascending: false })
    ]);
    state.tasks = tasksRes.data || [];
    state.members = membersRes.data || [];
    state.todayCheckins = todayRes.data || [];
    state.weekCheckins = weekRes.data || [];
    await loadAttachmentUrls([...state.todayCheckins, ...state.weekCheckins]);
    await refreshNotifications();
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
      .select('id,checkin_id,path,width,height')
      .in('checkin_id', ids);
    if (error || !data || !data.length) return;

    const urlMap = {};
    try {
      const res = await cloud.storage.createSignedUrls(data.map((r) => r.path), 3600);
      const arr = Array.isArray(res && res.data) ? res.data : ((res && res.data && res.data.data) || []);
      arr.forEach((x) => {
        const key = x.path || x.name;
        if (key) urlMap[key] = x.signedUrl || x.signed_url || x.url || '';
      });
    } catch (err) {
      console.error('[signed-url]', err);
    }
    data.forEach((r) => {
      (state.attachments[r.checkin_id] = state.attachments[r.checkin_id] || []).push({ ...r, url: urlMap[r.path] || '' });
    });
  }

  function weekStart() {
    const now = new Date();
    const day = now.getDay() || 7;
    const d = new Date(now.getTime() - (day - 1) * 86400000);
    return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  }

  const isAdmin = () => state.me && (state.me.role === 'owner' || state.me.role === 'leader');

  /* ---------- 登录 ---------- */
  function renderLogin(errMsg) {
    state.view = 'login';
    app.innerHTML = `
      <div class="gate">
        <div class="brand-mark">小</div>
        <h1>小事打卡</h1>
        <p class="sub">到点交，交没交大家都看得见。</p>

        <div class="seg" id="login-seg">
          <button class="on" data-kind="phone">手机号</button>
          <button data-kind="email">邮箱</button>
        </div>

        <div class="field">
          <label for="account" id="acc-label">手机号</label>
          <input id="account" class="input" type="tel" inputmode="numeric" maxlength="11" placeholder="11 位手机号" autocomplete="tel">
        </div>
        <div class="field">
          <label for="code">验证码</label>
          <div class="row-2">
            <input id="code" class="input" type="text" inputmode="numeric" maxlength="6" placeholder="6 位数字" autocomplete="one-time-code">
            <button class="btn ghost code" id="send-code">获取验证码</button>
          </div>
        </div>
        <div class="error" id="gate-error">${errMsg ? esc(errMsg) : ''}</div>
        <button class="btn block" id="do-login">登录</button>
        <p class="hint">第一次登录会自动创建账号，不需要密码。</p>
        <div class="gate-foot">
          这个站只服务一个熟人小组。登录后需要邀请码才能进组。
        </div>
      </div>`;

    let kind = 'phone';
    const acc = document.getElementById('account');
    document.querySelectorAll('#login-seg button').forEach((b) => {
      b.addEventListener('click', () => {
        kind = b.dataset.kind;
        document.querySelectorAll('#login-seg button').forEach((x) => x.classList.toggle('on', x === b));
        const label = document.getElementById('acc-label');
        if (kind === 'phone') {
          label.textContent = '手机号';
          acc.type = 'tel'; acc.inputMode = 'numeric'; acc.maxLength = 11;
          acc.placeholder = '11 位手机号'; acc.autocomplete = 'tel';
        } else {
          label.textContent = '邮箱';
          acc.type = 'email'; acc.inputMode = 'email'; acc.maxLength = 64;
          acc.placeholder = 'name@example.com'; acc.autocomplete = 'email';
        }
        acc.value = '';
        document.getElementById('gate-error').textContent = '';
      });
    });
    state.loginKind = () => kind;

    document.getElementById('send-code').addEventListener('click', () => sendCode(kind));
    document.getElementById('do-login').addEventListener('click', () => doLogin(kind));
    document.getElementById('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(kind); });
  }

  async function sendCode(kind) {
    const value = document.getElementById('account').value.trim();
    const err = document.getElementById('gate-error');
    const isPhone = kind === 'phone';
    if (isPhone && !/^1\d{10}$/.test(value)) { err.textContent = '请输入正确的 11 位手机号'; return; }
    if (!isPhone && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) { err.textContent = '请输入正确的邮箱地址'; return; }
    err.textContent = '';
    const btn = document.getElementById('send-code');
    btn.disabled = true;
    const payload = isPhone ? { phone: value } : { email: value };
    const { data, error } = await cloud.auth.sendOtp(payload);
    if (error) {
      btn.disabled = false;
      err.textContent = error.message || '验证码发送失败';
      return;
    }
    state.pendingOtp = { kind, value, verificationId: data.verificationId, isExistingUser: data.isExistingUser };
    let left = 60;
    btn.textContent = `${left}s`;
    clearInterval(state.otpTimer);
    state.otpTimer = setInterval(() => {
      left -= 1;
      if (left <= 0) {
        clearInterval(state.otpTimer);
        btn.disabled = false;
        btn.textContent = '重新获取';
      } else {
        btn.textContent = `${left}s`;
      }
    }, 1000);
    toast(isPhone ? '验证码已发送' : '验证码已发到邮箱');
  }

  async function doLogin(kind) {
    const err = document.getElementById('gate-error');
    const code = document.getElementById('code').value.trim();
    const pending = state.pendingOtp;
    if (!pending) { err.textContent = '请先获取验证码'; return; }
    if (!/^\d{4,8}$/.test(code)) { err.textContent = '请输入收到的验证码'; return; }
    const btn = document.getElementById('do-login');
    btn.disabled = true;
    btn.textContent = '登录中…';
    const payload = {
      verificationId: pending.verificationId,
      isExistingUser: pending.isExistingUser,
      token: code
    };
    if (pending.kind === 'phone') payload.phone = pending.value; else payload.email = pending.value;
    const { data, error } = await cloud.auth.verifyOtp(payload);
    if (error) {
      btn.disabled = false;
      btn.textContent = '登录';
      err.textContent = error.message || '验证码不对，或已过期';
      return;
    }
    state.session = data && data.user ? data : await cloud.auth.getSession().then((r) => r.data);
    clearInterval(state.otpTimer);
    state.pendingOtp = null;
    await enterApp();
  }

  /* ---------- 建组 / 加入 ---------- */
  function renderOnboarding() {
    state.view = 'onboarding';
    app.innerHTML = `
      <div class="gate">
        <div class="brand-mark">小</div>
        <h1>先选一下</h1>
        <p class="sub">你要开一个新组，还是加入别人的组？</p>

        <div class="seg">
          <button class="on" data-mode="create">创建新组</button>
          <button data-mode="join">用邀请码加入</button>
        </div>

        <div id="ob-fields"></div>
        <div class="error" id="ob-error"></div>
        <button class="btn block" id="ob-submit">创建并进入</button>
        <p class="hint" id="ob-hint">你会成为这个组的站长，拥有全部权限。</p>
      </div>`;

    let mode = 'create';
    const fields = document.getElementById('ob-fields');
    const submit = document.getElementById('ob-submit');
    const hint = document.getElementById('ob-hint');

    function paint() {
      fields.innerHTML = mode === 'create' ? `
        <div class="field">
          <label for="ob-name">组名</label>
          <input id="ob-name" class="input" maxlength="20" placeholder="例如：星一 1011 班">
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
      submit.textContent = mode === 'create' ? '创建并进入' : '加入';
      hint.textContent = mode === 'create' ? '你会成为这个组的站长，拥有全部权限。' : '昵称在组内不能重复。';
      document.getElementById('ob-error').textContent = '';
    }

    document.querySelectorAll('.seg button').forEach((b) => {
      b.addEventListener('click', () => {
        mode = b.dataset.mode;
        document.querySelectorAll('.seg button').forEach((x) => x.classList.toggle('on', x === b));
        paint();
      });
    });
    paint();

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
      } else {
        const invite = document.getElementById('ob-invite').value.trim().toUpperCase();
        if (invite.length !== 6) { submit.disabled = false; submit.textContent = '加入'; err.textContent = '邀请码是 6 位'; return; }
        res = await cloud.database.rpc('join_group', { p_invite: invite, p_nickname: nick });
      }
      if (res.error) {
        submit.disabled = false;
        submit.textContent = mode === 'create' ? '创建并进入' : '加入';
        const map = {
          invite_invalid: '邀请码不对，或这个组不存在',
          nickname_taken: '这个昵称已经有人用了，换一个',
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
  const NAV = [
    { key: 'today', label: '今日', icon: '◎' },
    { key: 'wall', label: '打卡墙', icon: '▤' },
    { key: 'progress', label: '进度', icon: '▦' },
    { key: 'me', label: '我的', icon: '☺' }
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
    const nav = NAV.concat(isAdmin() ? [{ key: 'admin', label: '管理', icon: '⚙' }] : []);
    app.innerHTML = `
      <div class="shell">
        <nav class="tabbar">
          <div class="side-brand">
            <div class="brand-mark">小</div>
            <div class="sb-text"><b>小事打卡</b><span>${esc(state.group.name)}</span></div>
          </div>
          <div class="nav-links">
            ${nav.map((n) => `<a href="#/${n.key}" data-nav="${n.key}" class="${state.view === n.key ? 'on' : ''}"><span class="ico">${n.icon}</span>${n.label}</a>`).join('')}
          </div>
          <div class="side-foot">
            <div class="avatar">${initials(state.me.nickname)}</div>
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
    return r === 'owner' ? '站长' : r === 'leader' ? '负责人' : '成员';
  }

  function paintView() {
    const view = document.getElementById('view');
    if (!view) return;
    if (state.view === 'today') return renderToday(view);
    if (state.view === 'wall') return renderWall(view);
    if (state.view === 'progress') return renderProgress(view);
    if (state.view === 'me') return renderMe(view);
    if (state.view === 'admin') return renderAdmin(view);
    renderToday(view);
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

  function renderToday(root) {
    const done = myToday().length;
    const total = state.tasks.length;
    const ratio = total ? done / total : 0;
    const C = 2 * Math.PI * 40;

    root.innerHTML = `
      <div class="topbar">
        <div>
          <div class="day">${fmtDateCn(todayStr())}</div>
          <h1>今天的小事</h1>
        </div>
        <div class="topbar-actions">
          <button class="bell" data-act="open-notifs" aria-label="通知">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></svg>
            ${state.unread ? `<i>${state.unread > 9 ? '9+' : state.unread}</i>` : ''}
          </button>
          <div class="avatar">${initials(state.me.nickname)}</div>
        </div>
      </div>

      <div class="card hero">
        <div class="ring">
          <svg width="96" height="96" viewBox="0 0 96 96">
            <circle cx="48" cy="48" r="40" fill="none" stroke="#E6EEF7" stroke-width="9"/>
            <circle cx="48" cy="48" r="40" fill="none" stroke="#12B5A5" stroke-width="9" stroke-linecap="round"
              stroke-dasharray="${(C * ratio).toFixed(1)} ${C.toFixed(1)}"/>
          </svg>
          <div class="num"><b>${done}/${total}</b><span>已完成</span></div>
        </div>
        <div class="hero-side">
          <div class="line1">全组今天 ${state.todayCheckins.filter((c) => c.task_id).length} 条打卡</div>
          <div class="line2">${state.members.length} 人在组</div>
          <span class="chip">${state.group.allow_member_custom ? '可以加自己的小事' : '自定义已关闭'}</span>
        </div>
      </div>

      <div class="card ${total === 0 ? 'grow' : ''}">
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
          </div>` : state.tasks.map((t) => {
            const c = findCheckin(t.id);
            const ds = deadlineState(t);
            return `
            <div class="task ${c ? 'done' : ''}">
              <div class="t-icon">${esc(t.emoji || '·')}</div>
              <div class="t-main">
                <div class="t-title">${esc(t.title)} ${c && c.status === 'late' ? '<span class="chip warn" style="height:18px;font-size:10px">补记</span>' : ''}</div>
                <div class="t-sub ${c ? 'late' : ds.cls}">${c ? `已打卡 ${timeOf(c.done_at)}` : ds.text}</div>
              </div>
              <span class="t-count">${state.todayCheckins.filter((x) => x.task_id === t.id).length}/${state.members.length}</span>
              <button class="check ${c ? 'on' : ''}" data-act="toggle-task" data-task="${t.id}" data-checkin="${c ? c.id : ''}" aria-label="${c ? '取消打卡' : '打卡'}">
                <svg width="15" height="15" viewBox="0 0 16 16"><path d="M3 8.5l3.2 3.2L13 5" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </button>
            </div>`;
          }).join('')}
        ${state.group.allow_member_custom ? `<button class="add-row" data-act="open-custom">＋ 加一件小事</button>` : ''}
      </div>

      ${customToday().length ? `
      <div class="card">
        <div class="card-head"><h2>今天自己加的</h2><span class="meta">${customToday().length} 条</span></div>
        ${customToday().map((c) => `
          <div class="task done">
            <div class="t-icon">✎</div>
            <div class="t-main">
              <div class="t-title">${esc(c.title || '小事')}</div>
              <div class="t-sub late">${timeOf(c.done_at)}</div>
            </div>
            <button class="check on" data-act="toggle-task" data-task="" data-checkin="${c.id}">
              <svg width="15" height="15" viewBox="0 0 16 16"><path d="M3 8.5l3.2 3.2L13 5" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
          </div>`).join('')}
      </div>` : ''}

      <div class="card">
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
            return days.map((x) => `
              <div class="week-col">
                <div class="week-bar ${x.n ? 'has' : ''} ${x.key === today ? 'today' : ''}" style="height:${6 + Math.round(46 * x.n / max)}px"></div>
                <div class="week-num">${x.n || ''}</div>
                <div class="week-day">${x.lb}</div>
              </div>`).join('');
          })()}
        </div>
      </div>

      ${state.weekCheckins.length ? `
      <div class="card">
        <div class="card-head"><h2>最近打卡</h2><span class="meta">全组 · ${state.weekCheckins.length} 条</span></div>
        ${state.weekCheckins.slice(0, 6).map((c) => {
          const who = (state.members.find((m) => m.id === c.user_id) || {}).nickname || '成员';
          const task = c.task_id ? (state.tasks.find((t) => t.id === c.task_id) || {}).title : '';
          const d = new Date(c.done_at);
          const isToday = c.date === todayStr();
          return `<div class="feed-row">
            <div class="feed-main">
              <div><b>${esc(who)}</b> ${esc(task || c.title || '小事')}</div>
              ${c.note ? `<div class="feed-note">${esc(c.note)}</div>` : ''}
            </div>
            ${(state.attachments[c.id] || []).length && state.attachments[c.id][0].url ? `<img class="feed-shot" src="${state.attachments[c.id][0].url}" data-act="view-photo" data-src="${state.attachments[c.id][0].url}" alt="">` : ''}
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

  async function compressImage(file, maxEdge = 1600, quality = 0.82) {
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
        const { error } = await cloud.database.from('attachments').insert({
          checkin_id: checkinId,
          path,
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
    openSheet('通知', rows.length ? rows.map((n) => `
      <div class="notif-row">
        <span class="notif-dot ${n.read_at ? 'read' : ''}"></span>
        <div class="feed-main">
          <div><b>${esc(n.title)}</b></div>
          ${n.body ? `<div class="feed-note">${esc(n.body)}</div>` : ''}
        </div>
        <span class="feed-time">${timeOf(n.created_at)}</span>
      </div>`).join('') : '<div class="empty"><b>没有新通知</b>临近截止会自动提醒你。</div>');

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
    const el = document.getElementById('cs-title');
    const title = el ? el.value.trim() : '';
    if (!title) { toast('写点什么再提交'); return; }
    const { error } = await cloud.database.from('checkins').insert({
      group_id: state.group.id,
      user_id: state.me.id,
      task_id: null,
      title,
      date: todayStr(),
      status: 'on_time'
    });
    if (error) { toast(error.message || '提交失败'); return; }
    closeSheet();
    await refresh();
    toast('已记下');
  }

  async function toggleTask(taskId, checkinId) {
    if (!checkinId) return openCheckinSheet(taskId);
    if (!confirm('取消这条打卡？记录会被删除。')) return;
    const { data, error } = await cloud.database.from('checkins').delete().eq('id', checkinId).select();
    if (error || !data || !data.length) { toast('删除失败，可能不是你的记录'); return; }
    await refresh();
    toast('已取消');
  }

  async function refresh() {
    await loadAll();
    renderShell();
  }

  /* ---------- 打卡墙 ---------- */
  function renderWall(root) {
    const hasPhoto = (c) => (state.attachments[c.id] || []).length > 0;
    const items = state.weekCheckins.filter((c) => c.note || !c.task_id || hasPhoto(c));
    const nameOf = (id) => (state.members.find((m) => m.id === id) || {}).nickname || '成员';
    const taskOf = (id) => (state.tasks.find((t) => t.id === id) || {}).title || '';

    root.innerHTML = `
      <div class="topbar">
        <div><div class="day">本周</div><h1>打卡墙</h1></div>
        <div class="avatar">${initials(state.me.nickname)}</div>
      </div>
      ${items.length === 0 ? `
        <div class="card"><div class="empty"><b>这周还没有内容</b>打卡时写一句或传张照片，就会贴到这里。</div></div>
      ` : `<div class="wall">${items.map((c) => `
        <div class="note">
          ${hasPhoto(c) && state.attachments[c.id][0].url ? `<img class="note-img" src="${state.attachments[c.id][0].url}" data-act="view-photo" data-src="${state.attachments[c.id][0].url}" alt="">` : ''}
          <div class="n-title">${esc(c.title || taskOf(c.task_id) || '小事')}</div>
          ${c.note ? `<div class="n-body">${esc(c.note)}</div>` : ''}
          <div class="n-foot"><span>${esc(nameOf(c.user_id))}</span><span>${timeOf(c.done_at)}</span></div>
        </div>`).join('')}</div>`}
    `;
  }

  /* ---------- 进度 ---------- */
  function renderProgress(root) {
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

    root.innerHTML = `
      <div class="topbar">
        <div><div class="day">${fmtDateCn(todayStr())}</div><h1>今日进度</h1></div>
        <button class="btn ghost small" data-act="copy-progress">复制</button>
      </div>

      <div class="card">
        <div class="card-head">
          <h2>全组 ${doneCount}/${members.length} 人做完</h2>
          <span class="meta">${tasks.length} 项任务</span>
        </div>
        ${tasks.length === 0 ? `<div class="empty"><b>还没有任务</b>去管理里加一条。</div>` : `
        <div class="tbl-wrap">
          <table class="matrix">
            <thead><tr><th>成员</th>${tasks.map((t) => `<th>${esc(t.title)}<br><span style="font-weight:400;font-size:10px">${parseHM(t.deadline_time)}</span></th>`).join('')}</tr></thead>
            <tbody>
              ${members.map((m) => `
                <tr>
                  <td><span class="name"><span class="avatar" style="width:24px;height:24px;font-size:11px">${initials(m.nickname)}</span>${esc(m.nickname)}</span></td>
                  ${tasks.map((t) => `<td>${cell(m.id, t.id)}</td>`).join('')}
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
    toast(`已提醒 ${missing.length} 人`);
  }

  /* ---------- 我的 ---------- */
  function renderMe(root) {
    const mine = state.weekCheckins.filter((c) => c.user_id === state.me.id);
    root.innerHTML = `
      <div class="topbar">
        <div><div class="day">${esc(state.group.name)}</div><h1>我的</h1></div>
        <div class="avatar">${initials(state.me.nickname)}</div>
      </div>

      <div class="card">
        <div class="list-row"><span class="label">昵称</span><span class="val">${esc(state.me.nickname)}</span></div>
        <div class="list-row"><span class="label">身份</span><span class="val">${roleLabel(state.me.role)}</span></div>
        <div class="list-row"><span class="label">本周打卡</span><span class="val">${mine.length} 条</span></div>
        <div class="list-row"><span class="label">加入时间</span><span class="val">${(state.me.created_at || '').slice(0, 10)}</span></div>
      </div>

      <div class="card">
        <div class="card-head"><h2>邀请成员</h2></div>
        <p class="hint" style="margin-top:0">把这个码发给对方，他登录后选「用邀请码加入」。</p>
        <div class="invite">
          <code>${esc(state.group.invite_code)}</code>
          <button class="btn ghost small" data-act="copy-invite">复制</button>
        </div>
      </div>

      <div class="card">
        <div class="list-row"><span class="label">通知</span><span class="val">站内已开${state.group.wecom_webhook ? ' · 企微已配' : ' · 企微未配'}</span></div>
        <div class="list-row"><span class="label">外观</span><span class="val">清爽卡片</span></div>
      </div>

      <button class="btn ghost block" data-act="logout">退出登录</button>
    `;
  }

  /* ---------- 管理 ---------- */
  function renderAdmin(root) {
    if (!isAdmin()) { root.innerHTML = '<div class="card"><div class="empty"><b>没有权限</b>只有负责人和站长能进这里。</div></div>'; return; }
    root.innerHTML = `
      <div class="topbar">
        <div><div class="day">负责人 / 站长</div><h1>管理</h1></div>
      </div>

      <div class="card">
        <div class="card-head"><h2>任务与截止时间</h2><span class="meta">${state.tasks.length} 项</span></div>
        ${state.tasks.map((t) => `
          <div class="task">
            <div class="t-icon">${esc(t.emoji || '·')}</div>
            <div class="t-main">
              <div class="t-title">${esc(t.title)}</div>
              <div class="t-sub">${parseHM(t.deadline_time)} 截止 · ${t.reminder_offset ? `提前 ${t.reminder_offset} 分钟提醒` : '不提醒'}</div>
            </div>
            <button class="btn ghost small" data-act="edit-task" data-task="${t.id}">编辑</button>
            <button class="icon-btn" data-act="archive-task" data-task="${t.id}" aria-label="归档">✕</button>
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
        <div class="card-head"><h2>组设置</h2></div>
        <div class="list-row">
          <div><div>允许成员自己加小事</div><div class="label">关掉后，成员只能做固定任务</div></div>
          <label class="switch"><input type="checkbox" id="set-custom" ${state.group.allow_member_custom ? 'checked' : ''}><i></i></label>
        </div>
        <div class="field" style="margin-top:14px">
          <label for="set-webhook">企业微信群机器人地址</label>
          <input class="input" id="set-webhook" placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=..." value="${esc(state.group.wecom_webhook || '')}">
        </div>
        <button class="btn ghost block" data-act="save-settings">保存设置</button>
      </div>

      <div class="card">
        <div class="card-head"><h2>成员</h2><span class="meta">${state.members.length} 人</span></div>
        ${state.members.map((m) => `
          <div class="list-row">
            <div style="display:flex;align-items:center;gap:10px">
              <span class="avatar" style="width:28px;height:28px;font-size:12px">${initials(m.nickname)}</span>
              <span>${esc(m.nickname)}</span>
              <span class="chip ${m.role === 'member' ? 'plain' : ''}">${roleLabel(m.role)}</span>
            </div>
            ${state.me.role === 'owner' && m.role === 'member' ? `<button class="btn ghost small" data-act="set-leader" data-user="${m.id}">设为负责人</button>` : ''}
          </div>`).join('')}
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

  async function saveSettings() {
    const allow = document.getElementById('set-custom').checked;
    const webhook = document.getElementById('set-webhook').value.trim();
    const { data, error } = await cloud.database.from('groups').update({
      allow_member_custom: allow,
      wecom_webhook: webhook || null
    }).eq('id', state.group.id).select();
    if (error || !data || !data.length) { toast(error ? (error.message || '保存失败') : '保存失败，可能没有权限'); return; }
    state.group = data[0];
    toast('已保存');
  }

  async function setLeader(userId) {
    if (!confirm('把负责人交给这个人？你作为站长仍然保留全部权限。')) return;
    const { error } = await cloud.database.rpc('set_leader', { p_user_id: userId });
    if (error) { toast(error.message || '设置失败'); return; }
    await enterApp();
    toast('已更换负责人');
  }

  async function logout() {
    await cloud.auth.signOut();
    state.me = null; state.group = null;
    renderLogin();
  }

  /* ---------- 事件 ---------- */
  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    if (act === 'toggle-task') return toggleTask(el.dataset.task, el.dataset.checkin);
    if (act === 'submit-checkin') return submitCheckin(el.dataset.task);
    if (act === 'del-photo') { state.pendingPhotos.splice(Number(el.dataset.i), 1); return paintShots(); }
    if (act === 'view-photo') return openPhoto(el.dataset.src);
    if (act === 'open-notifs') return openNotifications();
    if (act === 'open-custom') return openCustomSheet();
    if (act === 'submit-custom') return submitCustom();
    if (act === 'copy-invite') return copyText(state.group.invite_code);
    if (act === 'copy-progress') return copyProgress();
    if (act === 'remind') return remind();
    if (act === 'add-task') return addTask();
    if (act === 'edit-task') return editTaskSheet(el.dataset.task);
    if (act === 'save-task') return saveTask(el.dataset.task);
    if (act === 'archive-task') return archiveTask(el.dataset.task);
    if (act === 'save-settings') return saveSettings();
    if (act === 'set-leader') return setLeader(el.dataset.user);
    if (act === 'go-admin') { state.view = 'admin'; history.replaceState(null, '', '#/admin'); return renderShell(); }
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

  boot();
})();
