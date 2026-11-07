const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function completeLogin(target, fragment) {
  let submit, assigned, loginBody;
  const element = () => ({ value: '', hidden: false, classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, focus() {}, addEventListener() {} });
  const elements = Object.fromEntries(['loginForm','loginEmail','loginPassword','loginSubmit','loginError','togglePassword'].map(id => [id, element()]));
  elements.loginEmail.value = 'author@example.test'; elements.loginPassword.value = 'local-test-only';
  elements.loginForm.addEventListener = (name, handler) => { if (name === 'submit') submit = handler; };
  const context = { document: { querySelector: selector => elements[selector.slice(1)] }, URLSearchParams,
    location: { search: '?callbackUrl=' + encodeURIComponent(target), hash: fragment, assign: value => { assigned = value; } },
    addEventListener() {},
    async fetch(url, options) {
      if (url === '/api/auth/csrf') return { json: async () => ({ csrfToken: 'fixture-csrf' }) };
      loginBody = JSON.parse(options.body);
      return { ok: true, json: async () => ({ callbackUrl: target }) };
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../login.js'), 'utf8'), context);
  await submit({ preventDefault() {} });
  return { assigned, loginBody, password: elements.loginPassword.value };
}

test('corporate login keeps the report capability in the browser and returns to its exact link', async () => {
  const route = '/shared-report/' + '1'.repeat(32), token = '#' + 'a'.repeat(43);
  const result = await completeLogin(route, token);
  assert.equal(result.assigned, route + token);
  assert.equal(result.loginBody.callbackUrl, route);
  assert.ok(!JSON.stringify(result.loginBody).includes(token));
  assert.equal(result.password, '');
});

test('report fragments are not carried to unrelated pages or accepted in an invalid format', async () => {
  assert.equal((await completeLogin('/', '#' + 'a'.repeat(43))).assigned, '/');
  const route = '/shared-report/' + '1'.repeat(32);
  assert.equal((await completeLogin(route, '#invalid')).assigned, route);
});
