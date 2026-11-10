const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { fixture } = require('./helpers/shared-report-server.cjs');
test('published task and parent metadata reaches readers and developer mode; foreign links and secrets are discarded', async t => {
  const f = await fixture(t), issueUrl = 'https://jira.example.test/browse/SHOP-112';
  const snapshot = { title: 'SHOP-112 · Оплата картой', issueUrl, taskInfo: { issueUrl, summary: 'Оплата картой', token: 'never-publish', parent: { issueUrl: 'https://jira.example.test/browse/SHOP-100', summary: 'Оформление заказа', typeName: 'Функция', token: 'never-publish' } }, sections: [{ id: 's', title: 'Проверки', columns: [{ id: 'check', label: 'Проверка' }], rows: [{ id: 'r', number: '1', status: 'НЕ ОК', cells: { check: { text: 'Ошибка оплаты' } } }] }] };
  const { data: { publication } } = await f.json('', { method: 'POST', body: { snapshot, files: [], publishKey: crypto.randomBytes(32).toString('base64url') } });
  assert(publication);
  for (const token of [publication.readToken, publication.replyToken]) {
    const { data: { report } } = await f.json('/' + publication.id, { token });
    assert.equal(report.taskInfo.summary, 'Оплата картой');
    assert.equal(report.taskInfo.parent.summary, 'Оформление заказа');
    assert(!JSON.stringify(report).includes('never-publish'));
  }
});
