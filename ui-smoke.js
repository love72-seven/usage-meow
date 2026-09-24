const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const settle = () => new Promise((resolve) => setTimeout(resolve, 180));

async function runUiSmoke(window, { output, fixtureMode }) {
  await new Promise((resolve, reject) => {
    window.webContents.once('did-finish-load', resolve);
    window.webContents.once('did-fail-load', (_, code, message) => reject(new Error(message)));
  });
  const evaluate = (fn, ...args) => window.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
  const result = await evaluate(() => new Promise((resolve, reject) => {
    const deadline = Date.now() + 135000;
    const timer = setInterval(() => {
      const { loaded, accountsLoaded } = document.body.dataset;
      if (loaded && accountsLoaded) {
        clearInterval(timer);
        resolve({ usage: loaded, accounts: accountsLoaded });
      } else if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error('Data loading timeout'));
      }
    }, 100);
  }));
  if (output) await fs.mkdir(output, { recursive: true });
  const capture = async (name) => {
    if (!output) return;
    await window.webContents.capturePage(undefined, { stayHidden: true });
    await settle();
    const screenshot = await window.webContents.capturePage(undefined, { stayHidden: true });
    await fs.writeFile(path.join(output, name + '.png'), screenshot.toPNG());
  };
  const openView = async (view) => {
    await evaluate((name) => {
      document.querySelector('#tab-' + name).click();
      document.querySelector('#' + name + '-view').scrollTop = 0;
    }, view);
    await settle();
  };

  result.interactions = await evaluate((useFixture) => {
    const select = (selector) => document.querySelector(selector);
    const checks = {};
    select('#tab-usage').click();
    checks.sourceVisible = !select('#usage-sourcebar').hidden && select('#usage-source').options.length > 0;
    checks.pricingVisible = Boolean(select('#pricing-status').textContent) && Boolean(select('#sync-pricing'));
    const rowsBefore = select('#recent-rows').children.length;
    select('#show-all-records').click();
    checks.expandRecords = select('#recent-rows').children.length >= rowsBefore;
    select('#show-all-records').click();
    checks.restoreRecords = select('#recent-rows').children.length === rowsBefore;
    select('#tab-models').click();
    checks.modelNavigation = !select('#models-view').hidden && select('#usage-view').hidden && select('#refresh-label').textContent === '刷新用量';
    select('#model-search').value = '__no_such_model__';
    select('#model-search').dispatchEvent(new Event('input'));
    checks.searchEmpty = select('#model-rows .empty-cell')?.textContent.includes('没有匹配');
    select('#model-search').value = '';
    select('#model-search').dispatchEvent(new Event('input'));
    if (useFixture) {
      checks.restoreModels = select('#model-rows').children.length === 36;
      select('#agent-filter').value = 'pi';
      select('#agent-filter').dispatchEvent(new Event('change'));
      checks.agentFilter = select('#model-rows').children.length === 12;
      select('#agent-filter').value = '';
      select('#agent-filter').dispatchEvent(new Event('change'));
    }
    select('#tab-accounts').click();
    checks.sourceHiddenForAccounts = select('#usage-sourcebar').hidden;
    checks.accountNavigation = !select('#accounts-view').hidden && select('#models-view').hidden && select('#refresh-label').textContent === '刷新账号';
    if (useFixture) {
      checks.identityMasked = select('#account-email').textContent.includes('***');
      select('#toggle-identity').click();
      checks.identityRevealed = select('#account-email').textContent === 'demo@example.test';
      select('#toggle-identity').click();
      document.querySelectorAll('.profile-button')[1].click();
      checks.signedOut = select('#account-today').textContent === '—' && select('#account-email').textContent === '此配置尚未登录';
      document.querySelectorAll('.profile-button')[0].click();
      checks.accountRestored = select('#account-today').textContent === '123,456';
    }
    checks.oneVisiblePage = [...document.querySelectorAll('.view-scroll')].filter((view) => !view.hidden).length === 1;
    return checks;
  }, fixtureMode);
  assert.ok(Object.values(result.interactions).every(Boolean), JSON.stringify(result.interactions));

  await openView('usage');
  result.refresh = await evaluate((useFixture) => new Promise((resolve, reject) => {
    const cost = document.querySelector('#today-cost').textContent;
    document.querySelector('#refresh').click();
    const deadline = Date.now() + 125000;
    const timer = setInterval(() => {
      if (!document.querySelector('#refresh').disabled) {
        clearInterval(timer);
        const next = document.querySelector('#today-cost').textContent;
        resolve({ success: document.body.dataset.loaded === 'success', changed: !useFixture || cost !== next });
      } else if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error('Manual refresh timeout'));
      }
    }, 100);
  }), fixtureMode);
  assert.ok(result.refresh.success && result.refresh.changed, JSON.stringify(result.refresh));

  await openView('agents');
  result.agentPages = await evaluate(async () => {
    const deadline = Date.now() + 10000;
    while (document.querySelectorAll('.agent-card').length !== 18) {
      if (Date.now() > deadline) throw new Error('Agent settings did not load');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return { count: document.querySelectorAll('.agent-card').length,
      zcode: Boolean(document.querySelector('[data-agent="zcode"]')),
      noSourcebar: document.querySelector('#usage-sourcebar').hidden };
  });
  assert.ok(result.agentPages.zcode && result.agentPages.noSourcebar);
  await openView('prices');
  result.priceSearch = await evaluate(async () => {
    const provider = document.querySelector('#price-provider');
    provider.value = 'zai';
    provider.dispatchEvent(new Event('change'));
    const search = document.querySelector('#price-search');
    search.value = 'glm-5.3';
    search.dispatchEvent(new Event('input'));
    const deadline = Date.now() + 10000;
    while (true) {
      const rows = [...document.querySelectorAll('#price-rows tr')];
      if (rows.length && rows.every((row) => row.cells.length === 6 && row.cells[0].textContent === 'Z.ai 国际版' && row.cells[1].textContent.toLowerCase().includes('glm-5.3'))) {
        rows[0].querySelector('button').click();
        return { count: rows.length, selected: document.querySelector('#binding-choice').textContent.includes('glm-5.3'),
          syncLabel: document.querySelector('#refresh-label').textContent === '同步价格' };
      }
      if (Date.now() > deadline) throw new Error('Provider and model filter failed');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });
  assert.ok(result.priceSearch.selected && result.priceSearch.syncLabel);

  if (fixtureMode) {
    result.binding = await evaluate(async () => {
      const dropdown = document.querySelector('#binding-model');
      dropdown.selectedIndex = 1;
      dropdown.dispatchEvent(new Event('change'));
      const target = JSON.parse(dropdown.value);
      document.querySelector('#apply-price-binding').click();
      const deadline = Date.now() + 15000;
      while (!document.querySelector('#prices-message').textContent.includes('设置已保存')) {
        if (Date.now() > deadline) throw new Error('Binding did not complete: ' + document.querySelector('#prices-message').textContent);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const refs = await window.ccusage.priceReferences();
      return { saved: refs.value.bindings.some((binding) => binding.agent === target.agent && binding.model === target.model && binding.key === 'zai/glm-5.3'),
        refreshed: document.body.dataset.loaded === 'success' };
    });
    assert.ok(result.binding.saved && result.binding.refreshed);
  }

  if (!fixtureMode && process.env.USAGE_MEOW_TEST_PRICING === '1') {
    result.pricing = await evaluate(async () => {
      await window.ccusage.syncPricing();
      const status = await window.ccusage.pricingStatus();
      await new Promise((resolve, reject) => {
        const deadline = Date.now() + 125000;
        const timer = setInterval(() => {
          if (!document.querySelector('#refresh').disabled) { clearInterval(timer); resolve(); }
          else if (Date.now() > deadline) { clearInterval(timer); reject(new Error('Repricing timed out')); }
        }, 100);
      });
      const cached = await window.ccusage.cached();
      return { origin: status.origin, error: status.error, modelCount: status.modelCount, sources: status.sources,
        revisionApplied: cached.pricing?.revision === status.revision,
        missingSol: cached.data.totals?.unpricedModels?.includes('gpt-6-sol') || false,
        label: document.querySelector('#pricing-status').textContent };
    });
    assert.ok(result.pricing.revisionApplied && !result.pricing.missingSol && result.pricing.modelCount > 0, JSON.stringify(result.pricing));
  }

  if (!fixtureMode && process.env.USAGE_MEOW_TEST_SOURCE_SWITCH === '1' && output) {
    result.sourceSwitches = await evaluate(async () => {
      const dropdown = document.querySelector('#usage-source');
      const original = dropdown.value;
      const choices = [...dropdown.options].map((option) => option.value);
      const measurements = [];
      for (const home of [...choices.slice(0, 2), original]) {
        dropdown.value = home;
        dropdown.dispatchEvent(new Event('change'));
        await new Promise((resolve, reject) => {
          const deadline = Date.now() + 125000;
          const timer = setInterval(() => {
            if (!document.querySelector('#refresh').disabled) {
              clearInterval(timer);
              resolve();
            } else if (Date.now() > deadline) {
              clearInterval(timer);
              reject(new Error('Source switch timeout'));
            }
          }, 100);
        });
        const cached = await window.ccusage.cached();
        const expected = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
          .format(window.usageModel.summarize(cached.data).today.cost);
        measurements.push({ home, cost: document.querySelector('#today-cost').textContent,
          correct: cached.source.home === home && document.querySelector('#today-cost').textContent === expected });
      }
      return measurements;
    });
    assert.ok(result.sourceSwitches.every((measurement) => measurement.correct), JSON.stringify(result.sourceSwitches));
  }

  result.layouts = [];
  const checkLayout = async (scenario) => {
    for (const view of ['usage', 'models', 'agents', 'prices', 'accounts']) {
      await openView(view);
      const measurement = await evaluate((name) => {
        const get = (selector) => document.querySelector(selector);
        const box = (selector) => get(selector).getBoundingClientRect();
        const available = navigator.windowControlsOverlay.getTitlebarAreaRect();
        const header = box('.app-header');
        const toolbar = box('.view-toolbar');
        const sidebar = box('.sidebar');
        const scroll = get('#' + name + '-view');
        const topbar = box('.topbar');
        const refresh = box('#refresh');
        const viewBounds = scroll.getBoundingClientRect();
        // A long-content probe ensures scroll invariants are checked even on empty accounts.
        const probe = document.createElement('div');
        probe.style.height = '1200px';
        probe.setAttribute('aria-hidden', 'true');
        scroll.append(probe);
        scroll.scrollTop = scroll.scrollHeight;
        const afterHeader = box('.app-header');
        const afterToolbar = box('.view-toolbar');
        const afterSidebar = box('.sidebar');
        const checks = {
          nativeOverlay: navigator.windowControlsOverlay.visible,
          headerAtTop: Math.abs(header.top) <= 1,
          titlebarMatchesOverlay: Math.abs(header.height - available.height) <= 1,
          safeTitlebarWidth: topbar.right <= available.x + available.width + 1,
          controlsSeparated: refresh.top >= header.bottom && refresh.bottom <= toolbar.bottom + 1,
          contentsBelowToolbar: viewBounds.top >= toolbar.bottom - 1,
          bodyDoesNotScroll: window.scrollY === 0 && document.scrollingElement.scrollTop === 0,
          documentFits: document.documentElement.scrollWidth <= innerWidth,
          viewFits: scroll.scrollWidth <= scroll.clientWidth + 1,
          contentScrolled: scroll.scrollTop > 0,
          headerStayedFixed: afterHeader.top === header.top && afterHeader.bottom === header.bottom,
          toolbarStayedFixed: afterToolbar.top === toolbar.top,
          navStayedFixed: afterSidebar.top === sidebar.top,
          dragRegion: getComputedStyle(get('.topbar')).webkitAppRegion === 'drag',
          toolbarInteractive: getComputedStyle(get('.toolbar')).webkitAppRegion === 'no-drag',
          oneHeading: document.querySelectorAll('h1').length === 1,
        };
        probe.remove();
        scroll.scrollTop = 0;
        return { checks, viewport: { width: innerWidth, height: innerHeight }, titlebarHeight: header.height };
      }, view);
      result.layouts.push({ scenario, view, ...measurement });
      assert.ok(Object.values(measurement.checks).every(Boolean), JSON.stringify({ scenario, view, ...measurement }));
    }
  };

  await checkLayout('1180x820');
  for (const view of ['usage', 'models', 'agents', 'prices', 'accounts']) {
    await openView(view);
    await capture(view);
  }
  window.setSize(920, 650);
  await settle();
  await checkLayout('920x650');
  await openView('usage');
  await capture('compact');
  for (const zoom of [1.25, 1.5]) {
    window.webContents.setZoomFactor(zoom);
    await settle();
    await checkLayout(`920x650-zoom-${zoom}`);
  }
  window.webContents.setZoomFactor(1);
  window.maximize();
  await settle();
  result.maximized = window.isMaximized();
  await checkLayout('maximized');
  window.unmaximize();
  window.setSize(1180, 820);
  await settle();
  result.ok = result.usage === 'success' && result.accounts === 'success';
  if (output) await fs.writeFile(path.join(output, 'smoke.json'), JSON.stringify(result, null, 2));
  return result;
}

module.exports = { runUiSmoke };
