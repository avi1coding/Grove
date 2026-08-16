const B = 'http://localhost:3111';
const j = async (path, opts = {}) => {
  const res = await fetch(B + path, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${JSON.stringify(data)}`);
  return data;
};
const ok = (label, cond, extra = '') => console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);

const corpus = `Photosynthesis is the process by which green plants convert light energy into chemical energy stored in glucose. It occurs in the chloroplast, an organelle containing the pigment chlorophyll.
The light-dependent reactions take place in the thylakoid membranes. Water is split in a process called photolysis, releasing oxygen as a by-product and supplying electrons to photosystem II.
ATP and NADPH produced in the light reactions power the Calvin cycle, which happens in the stroma. The Calvin cycle fixes carbon dioxide using the enzyme RuBisCO.
Three molecules of carbon dioxide entering the Calvin cycle yield one molecule of glyceraldehyde-3-phosphate. Six turns of the cycle are needed to produce one glucose molecule.
Factors limiting the rate of photosynthesis include light intensity, carbon dioxide concentration and temperature. At low light intensity, light is the limiting factor.
C4 plants such as maize concentrate carbon dioxide in bundle sheath cells, reducing photorespiration in hot, dry climates. CAM plants open their stomata at night instead.`.repeat(3);

const health = await j('/api/health');
ok('health', health.ok, `embeddings=${health.embeddings}`);

const session = await j('/api/session', { method: 'POST' });
ok('session created', /^s_/.test(session.id));

const form = new FormData();
form.append('text', corpus);
form.append('textName', 'Bio notes');
form.append('files', new Blob([corpus], { type: 'text/plain' }), 'notes2.txt');
const ing = await j(`/api/session/${session.id}/sources`, { method: 'POST', body: form });
ok('ingest text + file', ing.chunkCount > 3, `${ing.chunkCount} chunks, ${ing.sources.length} sources`);

const built = await j(`/api/session/${session.id}/build`, { method: 'POST' });
const level1 = built.tree.nodes.root.children;
ok('tree built', level1.length >= 5 && level1.length <= 7, `${level1.length} subtopics, root="${built.tree.nodes.root.title}"`);
ok('depth cap = 1 before expand', Object.values(built.tree.nodes).every((n) => n.depth <= 1));

const drawer = await j(`/api/session/${session.id}/node/${level1[0]}/sources`);
ok('node source retrieval', drawer.chunks.length > 0, `top score ${drawer.chunks[0]?.score}`);

// Expand one node to level 2 and confirm the cap holds.
const expanded = await j(`/api/session/${session.id}/node/${level1[0]}/expand`, { method: 'POST' });
const kids = expanded.tree.nodes[level1[0]].children;
ok('expand -> level 2', kids.length >= 4, `${kids.length} children`);
ok('depth never exceeds 2', Object.values(expanded.tree.nodes).every((n) => n.depth <= 2));
ok('level-2 nodes not expandable', kids.every((k) => expanded.tree.nodes[k].expandable === false));

// Quizzing a split node must be refused.
let refused = false;
try { await j(`/api/session/${session.id}/node/${level1[0]}/quiz`, { method: 'POST' }); } catch { refused = true; }
ok('split node cannot be quizzed directly', refused);

// Fail a quiz, verify the review gate.
const quizNode = kids[0];
const q1 = await j(`/api/session/${session.id}/node/${quizNode}/quiz`, { method: 'POST' });
ok('quiz generated', q1.questions.length === 5, `attempt ${q1.attempt}, ${q1.meta.rejected} rejected, ${q1.meta.rounds} round(s)`);
ok('answer keys not leaked', !JSON.stringify(q1).includes('answerIndex') && !JSON.stringify(q1).includes('citations'));

const wrong = Object.fromEntries(q1.questions.map((q) => [q.id, 1]));
const r1 = await j(`/api/session/${session.id}/quiz/${q1.id}/submit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answers: wrong }) });
ok('failed quiz scored 0', r1.score === 0 && r1.passed === false);
ok('results carry citations', r1.results.every((r) => r.citations.length && r.citations[0].snippet));
ok('remediation required', r1.remediation?.required === true && r1.remediation.satisfied === false);

let gated = false;
try { await j(`/api/session/${session.id}/node/${quizNode}/quiz`, { method: 'POST' }); } catch (e) { gated = /Review the snippets/.test(e.message); }
ok('retry gated until review', gated);

const lesson = await j(`/api/session/${session.id}/node/${quizNode}/micro-lesson`, { method: 'POST' });
ok('micro-lesson generated', lesson.lesson.length > 10);

await j(`/api/session/${session.id}/node/${quizNode}/review-done`, { method: 'POST' });
const q2 = await j(`/api/session/${session.id}/node/${quizNode}/quiz`, { method: 'POST' });
ok('retry allowed after review', q2.attempt === 2, `difficulty ${q2.difficulty}`);
ok('retry has different questions', !q2.questions.some((q) => q1.questions.some((p) => p.prompt === q.prompt)));

const hint = await j(`/api/session/${session.id}/quiz/${q2.id}/hint`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ questionId: q2.questions[0].id }) });
ok('hint from small model', hint.hint.length > 5);

// Now pass everything.
const answerAll = (quiz) => Object.fromEntries(quiz.questions.map((q) => [q.id, q.type === 'short' ? 'right answer' : 0]));
const r2 = await j(`/api/session/${session.id}/quiz/${q2.id}/submit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answers: answerAll(q2) }) });
ok('5/5 lights the node', r2.passed && r2.score === 5);
ok('spaced repetition scheduled', Boolean(r2.state.progress[quizNode].srs?.dueAt), r2.state.progress[quizNode].srs?.dueAt);

let bossLocked = false;
try { await j(`/api/session/${session.id}/boss/quiz`, { method: 'POST' }); } catch (e) { bossLocked = /Light up every subtopic/.test(e.message); }
ok('boss locked until tree complete', bossLocked);

// Clear every remaining leaf.
const state = await j(`/api/session/${session.id}`);
const leaves = Object.values(state.tree.nodes).filter((n) => n.depth > 0 && !n.children.length).map((n) => n.id);
for (const leaf of leaves) {
  if (state.progress[leaf]?.state === 'mastered') continue;
  const q = await j(`/api/session/${session.id}/node/${leaf}/quiz`, { method: 'POST' });
  await j(`/api/session/${session.id}/quiz/${q.id}/submit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answers: answerAll(q) }) });
}
const after = await j(`/api/session/${session.id}`);
ok('tree complete unlocks boss', after.bossUnlocked === true, `${leaves.length} leaves cleared`);

const boss = await j(`/api/session/${session.id}/boss/quiz`, { method: 'POST' });
ok('boss size 15-20', boss.questions.length >= 15 && boss.questions.length <= 20, `${boss.questions.length} questions`);
ok('boss has cross-source synthesis', boss.meta.synthesisCount >= 3, `${boss.meta.synthesisCount} synthesis, ${boss.meta.sourceCount} sources`);

const br = await j(`/api/session/${session.id}/quiz/${boss.id}/submit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answers: answerAll(boss) }) });
ok('boss passed', br.passed === true, `${br.score}/${br.total}, needed ${br.needed}`);
ok('boss schedules spaced review', Boolean(br.boss.srs?.dueAt));

const calls = await j('/api/calls');
const roles = calls.calls.reduce((a, c) => ((a[c.role] = (a[c.role] || 0) + 1), a), {});
ok('routed across both models', roles.big > 0 && roles.small > 0, JSON.stringify(roles));
const stages = [...new Set(calls.calls.map((c) => c.stage))];
ok('verification stage ran', stages.includes('quiz:verify'), stages.join(', '));
