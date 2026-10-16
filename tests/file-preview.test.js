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


test('readable Unicode preserves JSON formatting, duplicate keys and exact numbers', () => {
  const source = String.raw`{ "name": "\u041a\u0432\u0430\u0440\u0442\u0438\u0440\u044b", "emoji": "\uD83D\uDE80", "id": 9007199254740993, "price": 2.5000, "name": "\u0041" }`;
  const expected = '{ "name": "Квартиры", "emoji": "🚀", "id": 9007199254740993, "price": 2.5000, "name": "A" }';
  assert.equal(preview.readableText(source), expected);
  assert.deepEqual(JSON.parse(preview.readableText(source)), JSON.parse(source));
  assert.equal(preview.decode(file(source, 'response.json')).text, source);
});

test('literal backslashes, JSON delimiters and controls remain escaped', () => {
  const source = String.raw`{"literal":"\\u0410","unicode":"\u0410","mixed":"\\\u0411","quote":"\u0022","slash":"\u005c","newline":"\u000a","tab":"\u0009","control":"\u007f","path":"\/upload\/file"}`;
  const expected = String.raw`{"literal":"\\u0410","unicode":"А","mixed":"\\Б","quote":"\u0022","slash":"\u005c","newline":"\u000a","tab":"\u0009","control":"\u007f","path":"\/upload\/file"}`;
  assert.equal(preview.readableText(source), expected);
  assert.deepEqual(JSON.parse(preview.readableText(source)), JSON.parse(source));
  assert.equal(preview.readableText(String.raw`\u005cu0410`), String.raw`\u005cu0410`);
});

test('invalid escapes and lone surrogates survive; valid pairs and JSON lines are readable', () => {
  const invalid = String.raw`\u041G \u123 \u \U0410 \uD83D! \ude80 \uDE80\uD83D`;
  assert.equal(preview.readableText(invalid), invalid);
  const lines = String.raw`{"text":"\u043f\u0440\u0438\u0432\u0435\u0442"}` + '\r\n' + String.raw`{"text":"\ud83d\ude80"}`;
  assert.equal(preview.readableText(lines), '{"text":"привет"}\r\n{"text":"🚀"}');
  assert.equal(preview.readableText('Обычный текст'), 'Обычный текст');
  assert.equal(preview.readableText(''), '');
});


test('JSON formatting follows nested objects and arrays, including empty containers', () => {
  const source = '{"product":{"name":"Квартира","flags":[true,false,null,{},[]],"count":2}}';
  const expected = [
    '{', '  "product": {', '    "name": "Квартира",', '    "flags": [',
    '      true,', '      false,', '      null,', '      {},', '      []',
    '    ],', '    "count": 2', '  }', '}',
  ].join('\n');
  assert.equal(preview.formatJson(source), expected);
  assert.equal(preview.formatJson(expected), expected);
  assert.deepEqual(JSON.parse(expected), JSON.parse(source));
  assert.equal(preview.formatJson(' \r\n[ { }, [ ], 1 ]\t'), '[\n  {},\n  [],\n  1\n]');
  assert.equal(preview.formatJson('{ }'), '{}');
});

test('formatting preserves number tokens, duplicate keys, key order and string contents', () => {
  const source = String.raw`{"10":9007199254740993,"2":2.5000,"duplicate":1,"duplicate":-0,"exp":1e+003,"text":"{ [ ] } , : \" \\ \n \u0410"}`;
  const expected = String.raw`{
  "10": 9007199254740993,
  "2": 2.5000,
  "duplicate": 1,
  "duplicate": -0,
  "exp": 1e+003,
  "text": "{ [ ] } , : \" \\ \n \u0410"
}`;
  assert.equal(preview.formatJson(source), expected);
  assert.deepEqual(JSON.parse(expected), JSON.parse(source));
  assert.match(preview.formatJson(preview.readableText(source)), /\\n А/);
});

test('invalid JSON and other file syntax retain original whitespace', () => {
  for (const source of ['', '  обычный текст\r\n', '<x>text</x>', 'return { value: 1 };', '{"a":1,}', '[01]', '{"x":"unterminated}', '{"a":1} trailing', '{"a":1}\n{"b":2}', '  "scalar" ', String.raw`{"x":"\uZZZZ"}`]) {
    assert.equal(preview.formatJson(source), source);
  }
});

test('formatting falls back for excessive depth or output expansion', () => {
  const deep = '['.repeat(65) + '0' + ']'.repeat(65);
  assert.equal(preview.formatJson(deep), deep);
  const expanding = '['.repeat(64) + '0,'.repeat(70000) + '0' + ']'.repeat(64);
  assert.equal(preview.formatJson(expanding), expanding);
});


test('readable code fixes Cyrillic escapes and reversible Windows mojibake without changing JSON tokens', () => {
  const source = String.raw`{"text":"\u041f\u0440\u0438\u0432\u0435\u0442","n":9007199254740993,"n":2.5000,"literal":"\\u0410","control":"\n"}`;
  const readable = preview.readableCode(source);
  assert.match(readable, /"text": "Привет"/);
  assert.match(readable, /9007199254740993/); assert.match(readable, /2\.5000/);
  assert.equal((readable.match(/"n":/g) || []).length, 2);
  assert.match(readable, /"literal": "\\\\u0410"/); assert.match(readable, /"control": "\\n"/);
  assert.deepEqual(JSON.parse(readable), JSON.parse(source));
  const damaged = new TextDecoder('windows-1251').decode(new TextEncoder().encode('Привет, Москва'));
  assert.equal(preview.readableCode(`POST /api HTTP/1.1\n\n{"text":"${damaged}"}`), 'POST /api HTTP/1.1\n\n{"text":"Привет, Москва"}');
  assert.equal(preview.readableCode(readable), readable);
});
test('readable code preserves escaped programming syntax, literal escapes and unrecoverable text', () => {
  for (const source of [String.raw`const name = '\u0027\u0060\u005c'; const re = /\u002e\u005b/;`,
    String.raw`const text = "\u2028\u2029";`, String.raw`{"literal":"\\u0410","invalid":"\uZZZZ","surrogate":"\uD800"}`,
    'Привет, мир! Ελληνικά 日本語', 'Р�Р� ??', '<img src=x onerror=alert(1)>']) {
    assert.equal(preview.readableCode(source), source);
  }
});
test('switching readable and source views preserves edits to both buffers', () => {
  const source = String.raw`{"text":"\u0410"}`;
  const views = preview.textViews(source, preview.readableCode);
  const readable = views.value(true);
  views.update(true, readable.replace('А', 'Б'));
  assert.equal(views.hasEdits(), true);
  assert.equal(views.value(false), source);
  assert.match(views.value(true), /Б/);
  views.update(false, source.replace('0410', '0412'));
  assert.match(views.value(false), /0412/);
  assert.match(views.value(true), /Б/, 'Source edits must not discard edits in the readable view');
});
test('source edits refresh an unedited readable view', () => {
  const views = preview.textViews(String.raw`{"text":"\u0410"}`, preview.readableCode);
  views.update(false, String.raw`{"text":"\u0412"}`);
  assert.match(views.value(true), /В/);
});
