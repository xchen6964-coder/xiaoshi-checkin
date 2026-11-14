/* 云端公开配置：这两条都是给浏览器用的公开值，可以放在前端。
 * 权限由数据库的行级策略决定，不靠这把钥匙保密。
 * 千万不要把 secret key（sb_secret_…）写进任何前端文件。
 */
window.APP_CONFIG = {
  supabaseUrl: "https://mtkuieogemgpdvacphhs.supabase.co",
  supabaseKey: "sb_publishable_QBzcGeWwShrZFZlrCq0KmQ_85oe3uWK"
};
