/* 云端适配层：把 app.js 用惯的那套调用（database / storage / auth）转到 Supabase
 *
 * 为什么要有这一层：app.js 里有几百处 cloud.database.from(...) 这类调用，直接换 SDK
 * 要改几百行，风险极大。这里保持同样的形状，app.js 只需要改初始化那 3 行。
 *
 * 形状约定（与原来 WorkBuddy SDK 一致）：
 *   database.from(t).select(cols).eq(k,v).in(k,arr).gte(k,v).lte(k,v).order(k,{ascending}).limit(n)
 *   database.from(t).insert(obj) / .update(obj) / .delete()      -> 都返回 { data, error }
 *   database.rpc(name, params)                                    -> { data, error }
 *   storage.sharedPath(uid, p) / upload / download / remove / createSignedUrls
 *   auth.signInWithPassword / signUp / getSession / signOut / resetPasswordForEmail
 *
 * 注意：createSignedUrls 返回的 data 是 [{ path, signedUrl, error }]，与原来一致。
 */
(function () {
  if (!window.supabase || !window.supabase.createClient) {
    console.error('[adapter] supabase-js 没加载成功，请检查 vendor/supabase.js');
    return;
  }

  const BUCKET = 'shared';   // 照片与头像都放这个私有桶，靠 signed URL 访问

  function createClient(opts) {
    const cfg = opts || {};
    if (!cfg.url || !cfg.key) throw new Error('缺少 supabaseUrl / supabaseKey');

    /* 走同源反代时，平台 Edge 会动 Authorization 头（实测：同一次登录拿到的 JWT
       回传后连 Auth 自己都验不过签名）→ 改成用自定义头 x-sb-auth 携带，
       由 server.js 还原成 Authorization 再转给 Supabase。直连时这个包装等于没做事。 */
    const wrappedFetch = function (input, init) {
      try {
        const req = input instanceof Request ? input : new Request(input, init);
        const h = new Headers(req.headers);
        const auth = h.get('authorization');
        if (!auth) return fetch(req);
        h.delete('authorization');
        h.set('x-sb-auth', auth);
        return fetch(new Request(req, { headers: h }));
      } catch (e) {
        return fetch(input, init);
      }
    };

    const sb = window.supabase.createClient(cfg.url, cfg.key, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
      global: { fetch: wrappedFetch }
    });

    // cfg.url 形如 https://站点/sb 时，把 Supabase 返回的绝对地址改写成同源地址
    const proxyBase = /\/sb$/.test(String(cfg.url)) ? String(cfg.url) : '';
    const proxyOrigin = (function () {
      if (!proxyBase) return '';
      try { return new URL(proxyBase).origin; } catch (e) { return ''; }
    })();
    function rewrite(u) {
      if (!u || !proxyBase) return u;
      try {
        const x = new URL(u);
        if (proxyOrigin && x.origin === proxyOrigin) return u;   // 已经是本站
        return proxyBase + x.pathname + x.search;
      } catch (e) { return u; }
    }

    /* ---------------- database ---------------- */
    function from(table) {
      let op = 'select';
      let cols = '*';
      let payload = null;
      let returning = false;
      let limitN = null;
      const filters = [];
      const orders = [];

      const q = {
        select(c) { if (op === 'select') cols = (c || '*'); else returning = true; return q; },
        insert(obj) { op = 'insert'; payload = obj; return q; },
        update(obj) { op = 'update'; payload = obj; return q; },
        delete() { op = 'delete'; return q; },
        eq(k, v) { filters.push(['eq', k, v]); return q; },
        in(k, arr) { filters.push(['in', k, arr]); return q; },
        gte(k, v) { filters.push(['gte', k, v]); return q; },
        lte(k, v) { filters.push(['lte', k, v]); return q; },
        order(k, o) { orders.push([k, o || {}]); return q; },
        limit(n) { limitN = n; return q; },
        then(onOk, onErr) { return run().then(onOk, onErr); },
        catch(onErr) { return run().catch(onErr); }
      };

      async function run() {
        let b = sb.from(table);
        if (op === 'select') {
          b = b.select(cols);
        } else if (op === 'insert') {
          b = b.insert(payload);
          if (returning) b = b.select();
        } else if (op === 'update') {
          b = b.update(payload);
          if (returning) b = b.select();
        } else if (op === 'delete') {
          b = b.delete();
          if (returning) b = b.select();
        }
        for (const f of filters) {
          if (f[0] === 'eq') b = b.eq(f[1], f[2]);
          else if (f[0] === 'in') b = b.in(f[1], f[2]);
          else if (f[0] === 'gte') b = b.gte(f[1], f[2]);
          else b = b.lte(f[1], f[2]);
        }
        for (const o of orders) b = b.order(o[0], o[1]);
        if (limitN != null) b = b.limit(limitN);

        const { data, error } = await b;
        return { data: data === undefined ? null : data, error: error || null };
      }

      return q;
    }

    async function rpc(name, params) {
      const { data, error } = await sb.rpc(name, params || undefined);
      return { data: data === undefined ? null : data, error: error || null };
    }

    /* ---------------- storage ---------------- */
    // 统一前缀：shared/<账号>/... 变成 桶 shared 里的 <账号>/...
    function sharedPath(uid, p) {
      return String(uid) + '/' + String(p).replace(/^\/+/, '');
    }

    const storage = {
      sharedPath,
      async upload(path, blob, o) {
        const opt = o || {};
        const { data, error } = await sb.storage.from(BUCKET).upload(path, blob, {
          contentType: opt.contentType || 'application/octet-stream',
          cacheControl: opt.cacheControl || '3600',
          upsert: true
        });
        return { data, error: error || null };
      },
      async download(path) {
        const { data, error } = await sb.storage.from(BUCKET).download(path);
        if (error) throw error;
        return data;
      },
      async remove(paths) {
        const { data, error } = await sb.storage.from(BUCKET).remove(paths);
        return { data, error: error || null };
      },
      async createSignedUrls(paths, ttl) {
        if (!paths || !paths.length) return { data: [], error: null };
        const { data, error } = await sb.storage.from(BUCKET).createSignedUrls(paths, ttl || 3600);
        // 走同源反代时，Supabase 回的仍是它自己的绝对地址，手机上加载会失败，这里改回本站。
        return { data: (data || []).map((x) => Object.assign({}, x, { signedUrl: rewrite(x.signedUrl) })), error: error || null };
      }
    };

    /* ---------------- auth ---------------- */
    const auth = {
      async getSession() {
        const { data, error } = await sb.auth.getSession();
        return { data: data ? data.session : null, error: error || null };
      },
      async signUp(p) {
        const { data, error } = await sb.auth.signUp({ email: p.email, password: p.password });
        // data.session 为空 = 项目还开着「邮箱确认」，见 docs/21
        return { data: data ? data.session : null, error: error || null };
      },
      async signInWithPassword(p) {
        const { data, error } = await sb.auth.signInWithPassword({ email: p.email, password: p.password });
        return { data: data ? data.session : null, error: error || null };
      },
      async signOut() {
        return sb.auth.signOut();
      },
      async resetPasswordForEmail(email) {
        const { data, error } = await sb.auth.resetPasswordForEmail(email);
        return { data, error: error || null };
      }
    };

    return { database: { from, rpc }, storage, auth, raw: sb };
  }

  window.SupabaseAdapter = { createClient };
})();
