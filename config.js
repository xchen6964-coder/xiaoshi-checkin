/* 云端公开配置：这两条都是给浏览器用的公开值，可以放在前端。
 * 权限由数据库的行级策略决定，不靠这把钥匙保密。
 * 千万不要把 secret key（sb_secret_…）写进任何前端文件。
 *
 * supabaseUrl 用「同源反代」地址：浏览器只请求本站的 /sb/*，由 server.js 转发到 Supabase。
 * 这样手机在国内移动网络下也能用，不需要代理（Supabase 域名在国内经常连不上）。
 * 用 file:// 直接打开本地文件时没有反代，自动退回直连，只影响本地调试。
 */
(function () {
  var DIRECT = 'https://mtkuieogemgpdvacphhs.supabase.co';
  var base = DIRECT;
  try {
    if (location.protocol === 'http:' || location.protocol === 'https:') base = location.origin + '/sb';
  } catch (e) { /* 保持直连 */ }

  window.APP_CONFIG = {
    supabaseUrl: base,
    supabaseKey: 'sb_publishable_QBzcGeWwShrZFZlrCq0KmQ_85oe3uWK'
  };
})();
