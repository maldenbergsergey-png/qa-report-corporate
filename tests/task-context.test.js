const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Context = require('../task-context');
const File = require('../report-file');
const History = require('../history-content');
const backend = fs.existsSync(require('node:path').join(__dirname, '../agent/jira-task-context.js')) ? '../agent/jira-task-context' : '../jira-task-context';
const { executeTaskContext } = require(backend);
const baseUrl = 'https://jira.example.test/team';
const item = (key, summary = key, typeName = 'Задача') => ({ issueUrl: `${baseUrl}/browse/${key}`, key, summary, typeName, projectKey: key.replace(/-\d+$/, '') });
const taskInfo = () => ({ ...item('SHOP-112', 'Оплата картой'), parent: item('SHOP-100', 'Оформление заказа', 'История'), ancestors: [item('SHOP-10', 'Покупки', 'Эпик')] });
const raw = (key, parent, epic) => ({ key, fields: { summary: `Название ${key}`, project: { key: 'SHOP' }, issuetype: { name: key === 'SHOP-10' ? 'Эпик' : 'История' }, ...(parent ? { parent: { key: parent } } : {}), customfield_10014: epic } });

test('task identity includes tracker, instance and base path; parent labels use actual types', () => {
  const value = Context.normalize(taskInfo(), `${baseUrl}/browse/SHOP-112?query=ignored`);
  assert.equal(Context.label(value), 'SHOP-112 · Оплата картой');
  assert.equal(value.parent.typeName, 'История');
  assert.equal(value.ancestors[0].key, 'SHOP-10');
  for (const url of ['https://other.test/browse/SHOP-112', 'https://jira.example.test/browse/SHOP-112', `${baseUrl}/browse/SHOP-113`, 'SHOP-112']) assert.equal(Context.normalize(value, url), null);
});
test('portable metadata strips credentials, foreign parent links, cycles and invalid URLs', () => {
  const value = { ...taskInfo(), token: 'secret', ancestors: [item('SHOP-112'), item('SHOP-100'), item('SHOP-10')], parentSource: 'manual' };
  const normalized = Context.normalize(value, value.issueUrl);
  assert(!JSON.stringify(normalized).includes('secret'));
  assert.equal(normalized.ancestors.length, 1);
  for (const issueUrl of ['javascript:alert(1)', 'https://user:secret@jira.example.test/team/browse/SHOP-100', 'https://other.test/browse/SHOP-100']) {
    assert.equal(Context.normalize({ ...value, parent: { ...value.parent, issueUrl } }, value.issueUrl).parent, null);
  }
  assert.equal(Context.normalize({ ...value, parent: null, parentSource: 'manual' }, value.issueUrl).parentSource, 'manual');
});
test('task metadata survives portable and cloud projection; old records retain their history dates', () => {
  const document = { schemaVersion: 3, issueUrl: `${baseUrl}/browse/SHOP-112`, taskInfo: taskInfo(), environment: 'Stage', overallStatus: 'НЕ ОК', intro: '', numberingMode: 'section', sections: [{ id: 'section', title: 'Проверки', columns: [{ id: 'check', title: 'Проверка' }], rows: [{ id: 'row', status: 'OK', cells: { check: 'Оплата' } }] }] };
  assert.deepEqual(File.documentFields(document).taskInfo, Context.normalize(taskInfo(), document.issueUrl));
  assert.equal(File.documentFields({ ...document, issueUrl: `${baseUrl}/browse/SHOP-113` }).taskInfo, undefined);
  const old = { ...document }; delete old.taskInfo;
  assert.equal(History.contentFingerprint(old), History.contentFingerprint({ ...old, taskInfo: null }));
  assert.notEqual(History.contentFingerprint(old), History.contentFingerprint(document));
});
test('Jira resolves closest story before epic and discovers the Epic Link field by schema', async () => {
  const calls = [];
  const request = async (_c, route) => {
    calls.push(route);
    if (route.endsWith('/field')) return [{ id: 'customfield_10014', name: 'Локализованное поле', schema: { custom: 'com.pyxis.greenhopper.jira:gh-epic-link' } }];
    const key = route.match(/issue\/([^?]+)/)[1];
    return { 'SHOP-112': raw('SHOP-112', 'SHOP-100', 'SHOP-10'), 'SHOP-100': raw('SHOP-100', null, 'SHOP-10'), 'SHOP-10': raw('SHOP-10') }[key];
  };
  const result = await executeTaskContext({ baseUrl }, 'issue-details', { issueKey: 'shop-112' }, request);
  assert.equal(result.task.parent.key, 'SHOP-100'); assert.equal(result.task.ancestors[0].key, 'SHOP-10');
  assert(calls.every(route => !route.includes('description')));
});
test('Jira standalone task has no parent and unavailable ancestors produce an explicit warning', async () => {
  const request = async (_c, route) => { if (route.endsWith('/field')) return []; return raw('SHOP-112'); };
  const value = await executeTaskContext({ baseUrl }, 'issue-details', { issueKey: 'SHOP-112' }, request);
  assert.equal(value.task.parent, null);
  const unavailable = await executeTaskContext({ baseUrl, type: 'cloud' }, 'issue-details', { issueKey: 'SHOP-112' }, async (_c, route) => {
    if (route.includes('/SHOP-112?')) return raw('SHOP-112', 'SHOP-100'); throw Object.assign(new Error('Forbidden'), { status: 403 });
  });
  assert(unavailable.warnings.length); assert.equal(unavailable.task.parent, null);
});
test('Jira rejects invalid keys before any network request', async () => {
  for (const issueKey of ['SHOP-1 OR project=OTHER', '../SHOP-1', 'https://other.test/browse/SHOP-1']) {
    await assert.rejects(executeTaskContext({ baseUrl }, 'issue-details', { issueKey }, () => assert.fail('Must not request')), /ключ/);
  }
});
test('Jira Cloud children use enhanced search and follow page tokens', async () => {
  let page = 0;
  const value = await executeTaskContext({ baseUrl, type: 'cloud' }, 'issue-children', { issueKey: 'SHOP-100' }, async (_c, route, options) => {
    if (route.includes('/issue/SHOP-100')) return raw('SHOP-100');
    assert.equal(route, '/rest/api/3/search/jql');
    const body = JSON.parse(options.body); assert.match(body.jql, /^parent = SHOP-100/);
    if (!page++) return { issues: [raw('SHOP-112')], nextPageToken: 'page2' };
    assert.equal(body.nextPageToken, 'page2'); return { issues: [raw('SHOP-118')], isLast: true };
  });
  assert.deepEqual(value.tasks.map(task => task.key), ['SHOP-112', 'SHOP-118']);
});
test('Jira Data Center child selection includes subtasks and epic members, and paginates completely', async () => {
  let page = 0;
  const value = await executeTaskContext({ baseUrl }, 'issue-children', { issueKey: 'SHOP-100' }, async (_c, route) => {
    if (route.endsWith('/field')) return [{ id: 'customfield_10014', schema: { custom: 'com.pyxis.greenhopper.jira:gh-epic-link' } }];
    if (route.includes('/issue/')) return raw('SHOP-100');
    const url = new URL(route, baseUrl); assert.match(url.searchParams.get('jql'), /cf\[10014\] = SHOP-100/);
    assert.equal(url.searchParams.get('startAt'), String(page));
    return { issues: [raw(page++ ? 'SHOP-118' : 'SHOP-112')], total: 2 };
  });
  assert.equal(value.tasks.length, 2);
});


test('clearing task metadata in the document overrides a stale history summary', () => {
  const info = taskInfo();
  assert.equal(Context.forReport({ issueUrl: info.issueUrl, taskInfo: info, document: { issueUrl: "", taskInfo: null } }), null);
  assert.equal(Context.forReport({ issueUrl: info.issueUrl, taskInfo: info, document: { issueUrl: info.issueUrl, taskInfo: null } }), null);
});
