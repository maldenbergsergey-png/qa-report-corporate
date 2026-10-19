(async () => {
  const A = window.QaReportAttachments, O = window.QaReportImportOptions;
  const output = document.getElementById('results'), results=[];
  const assert = (condition,message) => { if (!condition) throw new Error(message); };
  const test = async (name,run) => { try { await run(); results.push(`PASS ${name}`); } catch(error) { results.push(`FAIL ${name}: ${error.message}`); } };
  const policy = (mode='reference',images=true) => ({mode,images,overrides:new Map()});
  const files=[{id:'1',filename:'old.png',mimeType:'image/png',content:'https://jira.example/old.png'},
    {id:'2',filename:'log.txt',mimeType:'text/plain',content:'https://jira.example/log.txt'}];
  const markup='Description !intro.png! [docs|https://example.com/docs]\nh2. Checks\n||Номер||Проверка||ФР||Статус||\n|3|Text !old.png|thumbnail! [^log.txt] [docs|https://example.com/docs]|Old !old.png!|Failed|\n|8|Other !old.png!|Previous|Passed|';
  const fixture=(attachments=[])=>window.QaReportJiraImport.parseJiraMarkup(markup,attachments);
  const html=doc=>doc.intro+doc.sections.flatMap(s=>s.rows.flatMap(r=>Object.values(r.cells))).join('');
  await test('markup image exclusion removes wrappers, keeps text, document links and other files',async()=>{
    const doc=fixture(),before=JSON.stringify(doc); let loads=0;
    const result=await A.localize(doc,{policy:policy('reference',false),load:()=>loads++});
    assert(!/jira-image-placeholder|<img|old.png|intro.png/.test(html(result.document)),'image left behind');
    assert(/jira-file-placeholder/.test(html(result.document)),'file reference lost');
    assert(/https:\/\/example.com\/docs/.test(html(result.document)),'ordinary link lost');
    assert(html(result.document).includes('Text'),'text lost'); assert(loads===0,'unexpected download');
    assert(JSON.stringify(doc)===before,'source changed');
  });
  await test('omitting every attachment also clears plain-markup references',async()=>{
    const result=await A.localize(fixture(),{policy:policy('omit'),load:()=>{throw Error('must not download');}});
    assert(!/jira-(image|file)-placeholder|old.png|intro.png|log.txt/.test(html(result.document)),'reference left behind');
    assert(html(result.document).includes('https://example.com/docs'),'text link removed');
  });
  await test('individual file selection affects its occurrence, with one download for shared files',async()=>{
    const doc=fixture(files); doc.intro=''; const p=policy('download'),parts=A.entries(doc,files,p);
    p.overrides.set(A.scopeKey('file',parts[0],0),'omit'); let loads=[];
    const result=await A.localize(doc,{attachments:files,policy:p,sourceIssueUrl:'https://jira.example/browse/QA-1',
      load:async file=>{loads.push(file.id);return new Blob(['test'],{type:file.mimeType});}});
    assert(loads.length===2 && new Set(loads).size===2,'duplicate/unnecessary download');
    const first=result.document.sections[0].rows[0];
    assert(!first.cells[doc.sections[0].columns[0].id].includes('old.png'),'excluded occurrence retained');
    assert(first.cells[doc.sections[0].columns[1].id].includes('old.png'),'shared occurrence removed');
    assert(!result.errors.length,'download failed');
  });
  await test('row, column and file overrides resolve predictably; images-off overrides all of them',()=>{
    const doc=fixture(files),p=policy('reference'),part=A.entries(doc,files,p)[1],item=part.items[0];
    p.overrides.set(A.scopeKey('section',part),'omit'); assert(A.modeFor(part,item,0,p)==='omit','section');
    p.overrides.set(A.scopeKey('column',part),'download'); assert(A.modeFor(part,item,0,p)==='download','column');
    p.overrides.set(A.scopeKey('row',part),'reference'); assert(A.modeFor(part,item,0,p)==='reference','row');
    p.overrides.set(A.scopeKey('file',part,0),'download'); assert(A.modeFor(part,item,0,p)==='download','file');
    p.images=false; assert(A.modeFor(part,item,0,p)==='omit','image policy');
  });
  await test('filter and clear precede attachment downloads; retained file errors preserve references',async()=>{
    const doc=fixture(files),s=O.create(doc); s.statuses=new Set(['НЕ ОК']); O.preset(doc,s,'retest');
    const selected=O.build(doc,s); selected.intro=''; const p=policy('download',false); let loads=[];
    const result=await A.localize(selected,{attachments:files,policy:p,sourceIssueUrl:'https://jira.example/browse/QA-1',
      load:async file=>{loads.push(file.id);throw Error('Fixture failure');}});
    assert(loads.join(',')==='2','downloaded excluded image or row');
    assert(result.errors.length===1,'missing error');
    assert(html(result.document).includes('jira-attachment-reference'),'failed download lost reference');
    assert(!html(result.document).includes('Previous'),'filtered row retained');
  });
  await test('turning images back on restores untouched source; preview matches final exclusions',async()=>{
    const doc=fixture(),p=policy('reference',false);
    assert(!html(A.removeExcluded(doc,[],p)).includes('old.png'),'preview contains excluded image');
    p.images=true; assert(html(A.removeExcluded(doc,[],p)).includes('old.png'),'source image not restored');
    const result=await A.localize(doc,{policy:p});
    assert(html(result.document)===html(A.removeExcluded(doc,[],p)),'preview differs');
  });
  await test('embedded assets respect download, reference, omission and failure without a remote attachment identity',async()=>{
    const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
    const file={id:'embedded-1',filename:'inline.png',mimeType:'image/png',embedded:true,content:'https://jira.example/browse/QA-1#comment-1'};
    const doc=window.QaReportJiraImport.parseJiraMarkup('||Проверка||ФР||\n|Image !inline.png!|Text|',[file]);
    let loads=0;
    const options={attachments:[file],sourceIssueUrl:'https://jira.example/browse/QA-1',load:async()=>{loads++;return new Blob([Uint8Array.from(atob(image.split(',')[1]),c=>c.charCodeAt(0))],{type:'image/png'});}};
    const downloaded=await A.localize(doc,{...options,policy:policy('download')});
    assert(downloaded.loaded===1 && !downloaded.errors.length && loads===1,'embedded download failed');
    assert(html(downloaded.document).includes(image),'embedded bytes lost');
    assert(!html(downloaded.document).includes('data-jira-'),'embedded asset gained a false source identity');
    const linked=await A.localize(doc,{...options,policy:policy('reference')});
    assert(html(linked.document).includes(file.content) && !html(linked.document).includes('data:image'),'reference did not point to source comment');
    assert(!html(linked.document).includes('data-jira-') && loads===1,'reference tried to fetch a nonexistent remote attachment');
    const omitted=await A.localize(doc,{...options,policy:policy('download',false)});
    assert(!html(omitted.document).includes('inline.png') && loads===1,'images-off retained embedded asset');
    const failed=await A.localize(doc,{...options,policy:policy('download'),load:()=>{throw Error('fixture');}});
    assert(failed.errors.length===1 && html(failed.document).includes(file.content),'failure lost the source comment');
    const foreign=await A.localize(doc,{...options,attachments:[{...file,content:'javascript:alert(1)'}],policy:policy('reference')});
    assert(!html(foreign.document).includes('href='),'unsafe embedded source link');
  });
  output.textContent=results.join('\n')+`\n${results.filter(x=>x.startsWith('PASS')).length}/${results.length} passed`;
  document.title=results.some(x=>x.startsWith('FAIL'))?'FAIL Import regression':'PASS Import regression';
})();
