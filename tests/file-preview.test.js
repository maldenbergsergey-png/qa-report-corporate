const test = require('node:test');
const assert = require('node:assert/strict');
const preview = require('../file-preview');
const file = (bytes, name = 'response.xml', type = 'application/octet-stream', header = type) => ({
  name, type, dataUrl: `data:${header};base64,${Buffer.from(bytes).toString('base64')}`,
});

test('XML, JSON, logs, source files and text MIME types work with missing or generic MIME metadata', () => {
  for (const name of ['response.XML', 'schema.xsd', 'data.json', 'server.log', 'data.csv', 'test.yaml', 'file.md', 'test.py', '.env', 'Dockerfile']) {
    assert.equal(preview.decode(file('Привет\r\n<item/>', name)).text, 'Привет\r\n<item/>');
  }
  for (const type of ['text/plain; charset=utf-8', 'application/problem+json', 'application/soap+xml']) {
    assert.equal(preview.decode(file('Текст', 'attachment', type)).text, 'Текст');
  }
});

test('markup is returned unchanged, including HTML scripts and external XML entities', () => {
  const text = '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY ext SYSTEM "https://example.test/private">]><x>&ext;<script>alert(1)</script></x>';
  assert.equal(preview.decode(file(text)).text, text);
  assert.equal(preview.decode(file('<img src=x onerror=alert(1)>', 'page.html', 'text/html')).text, '<img src=x onerror=alert(1)>');
});

test('BOM, XML declarations, MIME charsets and legacy Cyrillic are decoded correctly', () => {
  const cp1251 = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]);
  const declaration = Buffer.from('<?xml version="1.0" encoding="windows-1251"?><x>');
  assert.equal(preview.decode(file(Buffer.concat([declaration, cp1251, Buffer.from('</x>')]))).text, declaration.toString() + 'Привет</x>');
  assert.equal(preview.decode(file(cp1251, 'server.log')).text, 'Привет');
  assert.equal(preview.decode(file(cp1251, 'a.txt', 'text/plain', 'text/plain;charset=windows-1251')).text, 'Привет');
  for (const [encoding, bom] of [['utf-16le', [255, 254]], ['utf-16be', [254, 255]]]) {
    const bytes = Buffer.from('<?xml version="1.0"?><x>Привет</x>', 'utf16le');
    if (encoding === 'utf-16be') bytes.swap16();
    for (const prefix of [Buffer.from(bom), Buffer.alloc(0)]) {
      const decoded = preview.decode(file(Buffer.concat([prefix, bytes])));
      assert.equal(decoded.encoding, encoding);
      assert.equal(decoded.text, '<?xml version="1.0"?><x>Привет</x>');
    }
  }
  const utf8 = Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from('Текст')]);
  assert.equal(preview.decode(file(utf8)).text, 'Текст');
});

test('manual encoding overrides metadata, and unsupported encodings allow recovery', () => {
  const wrongDeclaration = file('<?xml version="1.0" encoding="invalid-charset"?><x>Текст</x>');
  assert.throws(() => preview.decode(wrongDeclaration), /другую кодировку/);
  assert.match(preview.decode(wrongDeclaration, 'utf-8').text, /Текст/);
  const bytes = Buffer.from([0xe9]);
  assert.equal(preview.decode(file(bytes, 'test.txt'), 'windows-1252').text, 'é');
  assert.throws(() => preview.decode(file(bytes, 'test.txt'), 'utf-8'), /кодировке/);
});

test('empty files are supported; binary content, corruption and remote URLs are rejected', () => {
  assert.equal(preview.decode(file('')).text, '');
  assert.throws(() => preview.decode(file([0, 1, 2, 3], 'binary.txt')), /двоичные/);
  assert.throws(() => preview.decode(file('binary', 'archive.zip')), /формата/);
  for (const dataUrl of ['https://example.test/file.xml', 'blob:https://example.test/file', 'javascript:alert(1)']) {
    assert.throws(() => preview.decode({ name: 'a.xml', dataUrl }), /сохранённых в браузере/);
  }
  for (const dataUrl of ['data:text/plain;base64,!!', 'data:text/plain;base64,A', 'data:text/plain;base64,===']) {
    assert.throws(() => preview.decode({ name: 'a.txt', dataUrl }), /повреждены/);
  }
});

test('preview limit uses actual bytes and accepts the exact boundary', () => {
  const bytes = Buffer.alloc(preview.MAX_BYTES, 0x61);
  assert.equal(preview.decode({ ...file(bytes, 'large.log'), size: 1 }).size, preview.MAX_BYTES);
  assert.throws(() => preview.decode({ ...file(Buffer.alloc(preview.MAX_BYTES + 1, 0x61)), size: 1 }), /до 2 МБ/);
  assert.throws(() => preview.decode(file(Buffer.alloc(preview.MAX_BYTES + 3, 0x61))), /до 2 МБ/);
});
