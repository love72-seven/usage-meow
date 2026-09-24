(function (root) {
  function maskEmail(email, reveal = false) {
    if (!email) return '未提供邮箱';
    if (reveal) return email;
    const at = email.lastIndexOf('@');
    return at > 0 ? `${email[0]}***${email.slice(at)}` : '已隐藏账号';
  }

  function todayUsage(usage, now = new Date()) {
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const bucket = usage?.daily?.find((row) => row.date === today);
    // An absent date is not evidence of zero use; official date boundaries can differ.
    return { date: today, tokens: bucket?.tokens ?? null };
  }

  function durationLabel(minutes) {
    if (typeof minutes !== 'number' || minutes <= 0) return '未知窗口';
    if (minutes % 1440 === 0) return `${minutes / 1440} 天窗口`;
    if (minutes % 60 === 0) return `${minutes / 60} 小时窗口`;
    return `${minutes} 分钟窗口`;
  }

  function quotaView(window, now = Date.now()) {
    const used = typeof window?.usedPercent === 'number' && Number.isFinite(window.usedPercent) ? Math.max(0, Math.min(100, window.usedPercent)) : null;
    const resetMs = typeof window?.resetsAt === 'number' ? window.resetsAt * 1000 : NaN;
    const validReset = Number.isFinite(resetMs) && !Number.isNaN(new Date(resetMs).getTime());
    return { remaining: used === null ? null : 100 - used, label: durationLabel(window?.durationMins),
      resetMs: validReset ? resetMs : null, expired: validReset && resetMs <= now };
  }

  const api = { maskEmail, todayUsage, durationLabel, quotaView };
  if (typeof module !== 'undefined') module.exports = api;
  else root.accountModel = api;
})(globalThis);
