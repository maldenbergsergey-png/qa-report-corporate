const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Docker contains the report-sharing runtime and every asset loaded by the shared page', () => {
  const root = path.resolve(__dirname, '..');
  const sources = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8').split('\n')
    .filter(line => /^COPY\s/.test(line)).flatMap(line => line.trim().split(/\s+/)
      .slice(1).filter(word => !word.startsWith('--')).slice(0, -1));
  const page = fs.readFileSync(path.join(root, 'shared-report.html'), 'utf8');
  const required = new Set(['shared-report.html', 'report-sharing.js', 'report-storage.js', 'shared-comment-editor.js']);
  for (const [, asset] of page.matchAll(/(?:src|href)="\/([^"?#]+)(?:\?[^"#]*)?"/g)) required.add(asset);
  for (const file of required) {
    assert.ok(fs.existsSync(path.join(root, file)), `Missing report-sharing file: ${file}`);
    assert.ok(sources.some(source => source === file ||
      (fs.existsSync(path.join(root, source)) && fs.statSync(path.join(root, source)).isDirectory() &&
        file.startsWith(source.replace(/\/$/, '') + '/'))), `Report-sharing file absent from Docker image: ${file}`);
  }
});
