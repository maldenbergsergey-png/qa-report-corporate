const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../app.js'), 'utf8');
function harness(seenRelease) {
  const dot = { hidden: true }, labels = [];
  const ctx = vm.createContext({ seenRelease,
    window: { QaReportReleases: [{ version: '0.16.0', date: '2026-10-01', changes: { fixes: ['First'] } }] },
    document: { getElementById: () => dot }, whatsNewButton: { setAttribute: (key, value) => labels.push(value) },
  });
  for (const name of ['shortHashFromString', 'latestReleaseReceipt', 'updateReleaseIndicator']) {
    const start = source.indexOf(`function ${name}(`);
    vm.runInContext(source.slice(start, source.indexOf('\n}', start) + 2), ctx);
  }
  return { ctx, dot, labels };
}
test('same-day additions reappear as unread without changing the application version', () => {
  const { ctx, dot } = harness('0.16.0');
  ctx.updateReleaseIndicator(); assert.equal(dot.hidden, false, 'previous version-only receipt upgrades safely');
  ctx.seenRelease = ctx.latestReleaseReceipt();
  ctx.updateReleaseIndicator(); assert.equal(dot.hidden, true);
  ctx.window.QaReportReleases[0].changes.fixes.push('Second');
  ctx.updateReleaseIndicator(); assert.equal(dot.hidden, false);
  assert.equal(ctx.window.QaReportReleases[0].version, '0.16.0');
});
test('empty release data leaves the indicator hidden', () => {
  const { ctx, dot } = harness(''); ctx.window.QaReportReleases = [];
  ctx.updateReleaseIndicator(); assert.equal(dot.hidden, true);
});
