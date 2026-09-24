(() => {
  const $ = (selector) => document.querySelector(selector);
  const { maskEmail, todayUsage, quotaView } = window.accountModel;
  const format = (value) => value == null ? '—' : new Intl.NumberFormat('zh-CN').format(value);
  const dateTime = (value) => value ? new Date(value).toLocaleString('zh-CN') : '尚未查询';
  let snapshot = { profiles: [], results: [], history: [] };
  let selectedId = null;
  let reveal = false;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function identity(account) {
    if (!account) return '未登录';
    if (account.type === 'chatgpt') return maskEmail(account.email, reveal);
    return account.type === 'apiKey' ? 'API Key 登录' : account.type;
  }

  function renderProfiles() {
    const container = $('#profile-list');
    container.replaceChildren();
    $('#profile-count').textContent = `${snapshot.profiles.length} / 8`;
    $('#device-name').textContent = snapshot.device || '本机';
    $('#account-binary').textContent = `Codex 程序：${snapshot.binary || '未检测到'}`;
    $('#account-binary').title = snapshot.binary || '';
    for (const profile of snapshot.profiles) {
      const result = snapshot.results?.find((entry) => entry.profileId === profile.id);
      const button = element('button', `profile-button${profile.id === selectedId ? ' selected' : ''}`);
      button.type = 'button';
      button.setAttribute('aria-pressed', String(profile.id === selectedId));
      button.append(element('strong', null, profile.name));
      const account = result?.account || (!result ? profile.lastIdentity : null);
      button.append(element('span', 'profile-email', result?.status === 'error' ? '查询失败 · 可重试' : account ? identity(account) : result ? '未登录' : '等待验证'));
      button.append(element('span', 'profile-source', 'Codex · 本机配置'));
      button.addEventListener('click', () => {
        selectedId = profile.id;
        renderProfiles();
        renderDetails();
        busy(Boolean(window.accountsLoading));
      });
      container.append(button);
    }
  }

  function renderDetails() {
    const profile = snapshot.profiles.find((entry) => entry.id === selectedId);
    $('#account-details').hidden = !profile;
    if (!profile) return;
    const result = snapshot.results?.find((entry) => entry.profileId === selectedId);
    const account = result ? result.account : profile.lastIdentity;
    $('#account-email').textContent = account ? identity(account) : result?.status === 'signed-out' ? '此配置尚未登录' : '等待账号信息';
    $('#account-plan').textContent = account ? `${account.type === 'chatgpt' ? 'ChatGPT' : account.type} · ${account.planType || '套餐未知'}` : '通过所选配置读取，不修改登录';
    $('#profile-path').textContent = profile.home;
    $('#profile-path').title = profile.home;
    $('#profile-name').value = profile.name;
    $('#remove-profile').disabled = snapshot.profiles.length <= 1;
    $('#account-status').className = `status-pill ${result?.status === 'connected' ? 'connected' : ''}`;
    $('#account-status').textContent = !result ? '等待验证 · 上次信息仅供参考' : ({ connected: '已读取登录状态', 'signed-out': '未登录', unsupported: '此登录方式暂不支持官方汇总', error: '未验证' })[result.status];
    $('#account-checked').textContent = `最近验证：${dateTime(result?.checkedAt || profile.lastCheckedAt)}`;
    $('#toggle-identity').textContent = reveal ? '隐藏账号' : '显示账号';
    $('#toggle-identity').setAttribute('aria-pressed', String(reveal));
    const error = result?.error || (result?.status === 'signed-out' ? '请在使用此配置的 Codex 客户端登录，然后刷新。' : result?.status === 'unsupported' ? 'API Key 等登录方式不提供这里的 ChatGPT 账号日统计；本机日志仍可在“本机用量”查看。' : '');
    $('#account-error').hidden = !error;
    $('#account-error').textContent = error;
    const today = todayUsage(result?.usage);
    $('#account-today').textContent = format(today.tokens);
    $('#account-today-note').textContent = today.tokens == null ? '官方尚未返回今天的记录，不代表 0' : `${today.date} · 按官方日期匹配`;
    $('#account-lifetime').textContent = format(result?.usage?.summary?.lifetimeTokens);
    renderQuotas(result);
    renderDaily(result);
    renderHistory(profile.id);
  }

  function renderQuotas(result) {
    const container = $('#quota-list');
    container.replaceChildren();
    if (result?.errors?.limits) container.append(element('p', 'inline-error', result.errors.limits));
    let windowCount = 0;
    for (const bucket of result?.limits || []) {
      const group = element('div', 'quota-group');
      group.append(element('h3', null, bucket.name));
      if (bucket.reached) group.append(element('p', 'inline-error', '官方返回限制状态，请以 Codex 客户端提示为准。'));
      for (const window of bucket.windows) {
        windowCount++;
        const view = quotaView(window);
        const line = element('div', 'quota-label');
        line.append(element('span', null, view.label), element('strong', null, view.remaining == null ? '暂不可用' : `剩余 ${format(view.remaining)}%`));
        group.append(line);
        if (view.remaining !== null) {
          const meter = element('progress', view.remaining <= 10 ? 'quota-meter low' : 'quota-meter');
          meter.max = 100;
          meter.value = view.remaining;
          meter.setAttribute('aria-label', `${bucket.name} ${view.label}剩余`);
          group.append(meter);
        }
        group.append(element('p', 'quota-reset', view.resetMs == null ? '未返回重置时间' : view.expired ? '已到返回的重置时间，请刷新确认；不推定额度恢复' : `重置于 ${dateTime(view.resetMs)}`));
      }
      container.append(group);
    }
    if (!windowCount) container.append(element('p', 'empty-message', result ? '暂无可显示的额度窗口' : '正在查询官方额度…'));
  }

  function renderDaily(result) {
    const body = $('#account-daily');
    body.replaceChildren();
    for (const bucket of (result?.usage?.daily || []).slice(0, 14)) {
      const row = body.insertRow();
      row.insertCell().textContent = bucket.date;
      row.insertCell().textContent = format(bucket.tokens);
    }
    if (!body.children.length) {
      const cell = body.insertRow().insertCell();
      cell.colSpan = 2;
      cell.className = 'empty-cell';
      cell.textContent = result?.errors?.usage || (result ? '官方暂无每日记录（不代表用量为 0）' : '正在查询…');
    }
  }

  function renderHistory(profileId) {
    const history = snapshot.history.filter((event) => event.profileId === profileId);
    $('#history-count').textContent = `(${history.length})`;
    $('#account-history').replaceChildren(...history.map((event) => element('p', 'history-entry', `${dateTime(event.at)} · ${identity(event.before)} → ${identity(event.after)}`)));
    if (!history.length) $('#account-history').append(element('p', 'empty-message', '尚未观察到登录信息变化'));
  }

  function applySnapshot(value) {
    snapshot = { ...value, results: value.results || [], history: value.history || [] };
    if (!snapshot.profiles.some((entry) => entry.id === selectedId)) selectedId = snapshot.profiles[0]?.id;
    renderProfiles();
    renderDetails();
  }

  function busy(value) {
    window.accountsLoading = value;
    window.updateViewStatus?.();
    for (const id of ['add-profile', 'choose-codex', 'rename-profile']) $(`#${id}`).disabled = value;
    $('#remove-profile').disabled = value || snapshot.profiles.length <= 1;
  }

  window.loadAccounts = async () => {
    if (window.accountsLoading) return;
    busy(true);
    window.updateViewStatus?.('accounts', '正在查询…');
    $('#account-notice').textContent = '正在读取登录状态与官方用量，界面仍可切换…';
    delete document.body.dataset.accountsLoaded;
    try {
      const response = await window.accounts.load();
      if (!response.ok) throw new Error(response.error);
      applySnapshot(response.value);
      const failures = snapshot.results.filter((result) => result.status === 'error').length;
      const partial = snapshot.results.filter((result) => result.errors?.usage || result.errors?.limits).length;
      $('#account-notice').textContent = snapshot.warning || (failures ? `${failures} 个配置查询失败，请刷新重试。` : partial ? `${partial} 个配置的部分官方数据暂不可用，请查看下方提示。` : '按登录来源查看，多个配置的官方统计不重复相加。');
      window.updateViewStatus?.('accounts', failures || partial ? '部分数据暂不可用' : `${new Date(snapshot.fetchedAt).toLocaleTimeString('zh-CN')} 更新`);
      document.body.dataset.accountsLoaded = failures || partial ? 'partial' : 'success';
    } catch (error) {
      applySnapshot({ ...snapshot, results: snapshot.profiles.map((profile) => ({ profileId: profile.id, status: 'error', error: '本次连接失败，请重试。' })) });
      $('#account-notice').textContent = error.message;
      document.body.dataset.accountsLoaded = 'error';
      window.updateViewStatus?.('accounts', '查询失败，请重试');
    } finally { busy(false); }
  };

  async function mutate(action) {
    if (window.accountsLoading) return;
    busy(true);
    let reload = false;
    try {
      const response = await action();
      if (!response.ok) throw new Error(response.error);
      if (response.value) { applySnapshot(response.value); reload = true; }
    } catch (error) { $('#account-notice').textContent = error.message; }
    finally { busy(false); }
    if (reload) await window.loadAccounts();
  }

  $('#toggle-identity').addEventListener('click', () => { reveal = !reveal; renderProfiles(); renderDetails(); busy(Boolean(window.accountsLoading)); });
  $('#add-profile').addEventListener('click', () => mutate(() => window.accounts.add()));
  $('#choose-codex').addEventListener('click', () => mutate(() => window.accounts.chooseBinary()));
  $('#rename-profile').addEventListener('click', () => mutate(() => window.accounts.rename(selectedId, $('#profile-name').value)));
  $('#remove-profile').addEventListener('click', () => mutate(() => window.accounts.remove(selectedId)));

  (async () => {
    try {
      const response = await window.accounts.settings();
      if (response.ok) applySnapshot(response.value);
    } catch { $('#account-notice').textContent = '本机配置暂不可用，正在重试…'; }
    await window.loadAccounts();
  })();
  setInterval(window.loadAccounts, 5 * 60 * 1000);
})();
