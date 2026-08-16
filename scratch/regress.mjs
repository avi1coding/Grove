const B='http://localhost:3111';
const ok=(l,c,x='')=>console.log(`${c?'PASS':'FAIL'}  ${l}${x?' — '+x:''}`);
const j=async(p,o={})=>{const r=await fetch(B+p,o);let d={};try{d=await r.json()}catch{};return {status:r.status,d}};
const post=(p,body)=>j(p,{method:'POST',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});

const ROOT='/Users/kevalmehta/Hackathon Projects/Grove/server/';

// ---- SSRF guard --------------------------------------------------------
const {assertPublicUrl}=await import(ROOT+'safe-fetch.js');
for (const [label,url] of [
  ['localhost','http://localhost:3000/api/health'],
  ['127.0.0.1','http://127.0.0.1:22/'],
  ['cloud metadata','http://169.254.169.254/latest/meta-data/'],
  ['private 10.x','http://10.0.0.5/'],
  ['private 192.168','http://192.168.1.1/admin'],
  ['ipv6 loopback','http://[::1]:3000/'],
  ['file scheme','file:///etc/passwd'],
  ['ipv4-mapped','http://[::ffff:127.0.0.1]/'],
]) {
  let blocked=false, msg='';
  try { await assertPublicUrl(url) } catch(e){ blocked=true; msg=e.message }
  ok(`SSRF blocked: ${label}`, blocked, msg.slice(0,44));
}
let pub=true; try { await assertPublicUrl('https://en.wikipedia.org/wiki/Photosynthesis') } catch { pub=false }
ok('SSRF allows a real public URL', pub);

// ---- chunker -----------------------------------------------------------
const {chunkText}=await import(ROOT+'chunk.js');
const long='word '.repeat(1200);
const ch=chunkText(long,{sourceId:'s1',sourceName:'x',sourceKind:'text'});
const texts=ch.map(c=>c.text);
ok('no duplicate chunks from an oversized unit', new Set(texts).size===texts.length, `${ch.length} chunks`);
const src='Alpha beta gamma. Delta epsilon zeta. Eta theta iota.';
const ch2=chunkText(src,{sourceId:'s2',sourceName:'y',sourceKind:'text'});
ok('chunk spans map back to the source', ch2.every(c=>src.slice(c.start,c.end)===c.text));

// ---- grading -----------------------------------------------------------
const {gradeQuiz}=await import(ROOT+'pipeline/grade.js');
const quiz={questions:[{id:'q1',type:'mcq',options:['a','b','c','d'],answerIndex:0,citations:[],concept:'c',prompt:'p'}]};
const blank=await gradeQuiz({},quiz,{});
ok('blank MCQ answer is not counted as option A', blank.score===0, `score ${blank.score}`);
const right=await gradeQuiz({},quiz,{q1:0});
ok('correct MCQ still scores', right.score===1);

// ---- zip bomb ----------------------------------------------------------
const zlib=await import('node:zlib');
const {readZipEntries}=await import(ROOT+'zip.js');
const huge=Buffer.alloc(60*1024*1024,0);            // 60MB of zeros
const comp=zlib.deflateRawSync(huge);
const name=Buffer.from('bomb.xml');
const lh=Buffer.alloc(30); lh.writeUInt32LE(0x04034b50,0); lh.writeUInt16LE(8,8); lh.writeUInt32LE(comp.length,18); lh.writeUInt32LE(huge.length,22); lh.writeUInt16LE(name.length,26);
const local=Buffer.concat([lh,name,comp]);
const cd=Buffer.alloc(46); cd.writeUInt32LE(0x02014b50,0); cd.writeUInt16LE(8,10); cd.writeUInt32LE(comp.length,20); cd.writeUInt32LE(huge.length,24); cd.writeUInt16LE(name.length,28); cd.writeUInt32LE(0,42);
const cdFull=Buffer.concat([cd,name]);
const eo=Buffer.alloc(22); eo.writeUInt32LE(0x06054b50,0); eo.writeUInt16LE(1,8); eo.writeUInt16LE(1,10); eo.writeUInt32LE(cdFull.length,12); eo.writeUInt32LE(local.length,16);
const zip=Buffer.concat([local,cdFull,eo]);
let bombStopped=false, bombMsg='';
try { readZipEntries(zip,()=>true) } catch(e){ bombStopped=true; bombMsg=e.message }
ok('zip bomb refused', bombStopped, bombMsg.slice(0,50));

// ---- route behaviour ---------------------------------------------------
const s=(await post('/api/session')).d;
const form=new FormData();
form.append('text','Photosynthesis occurs in the chloroplast. RuBisCO fixes carbon dioxide in the stroma. Light reactions split water in the thylakoid membrane. '.repeat(12));
await fetch(`${B}/api/session/${s.id}/sources`,{method:'POST',body:form});
const built=(await post(`/api/session/${s.id}/build`)).d;
ok('build response carries dueReviews', Array.isArray(built.dueReviews));
const leaf=built.tree.nodes.root.children[0];

const bad=await post(`/api/session/s_000000000000/build`);
ok('unknown session is 404 not 500', bad.status===404, `got ${bad.status}`);

const rq=await post(`/api/session/${s.id}/node/${leaf}/review-quiz`);
ok('review-quiz refuses an unmastered node', rq.status===409, `${rq.status} ${rq.d.error||''}`.slice(0,60));

// two quizzes open at once, fail one, the stale one must not be submittable
const q1=(await post(`/api/session/${s.id}/node/${leaf}/quiz`)).d;
const q2=(await post(`/api/session/${s.id}/node/${leaf}/quiz`)).d;
const wrong=Object.fromEntries(q2.questions.map(q=>[q.id,1]));
await post(`/api/session/${s.id}/quiz/${q2.id}/submit`,{answers:wrong});
const stale=await post(`/api/session/${s.id}/quiz/${q1.id}/submit`,{answers:wrong});
ok('stale quiz cannot bypass the remediation gate', stale.status===409, `${stale.status} ${stale.d.error||''}`.slice(0,58));

// a quiz orphaned by a rebuild
const q3=(await post(`/api/session/${s.id}/node/${leaf}/quiz`)).d;
await post(`/api/session/${s.id}/build`);
const orphan=await post(`/api/session/${s.id}/quiz/${q3?.id}/submit`,{answers:{}});
ok('quiz orphaned by rebuild is rejected cleanly', orphan.status===409||orphan.status===404, `${orphan.status} ${orphan.d.error||''}`.slice(0,58));
