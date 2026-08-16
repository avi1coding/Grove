import express from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs/promises';
import { config, hasFeatherlessKey, ROOT, UPLOAD_DIR } from './config.js';
import { ensureDirs, createSession, saveSession, loadSession, deleteSession, withSession, publicView, logEvent, newId } from './store.js';
import { ingestFile, ingestUrl } from './ingest.js';
import { CATALOGUE } from './sources.js';
import { chunkText } from './chunk.js';
import { buildIndex, retrieve } from './embed.js';
import { buildTree, expandNode, runGapDetection, queryFor, carryProgress } from './pipeline/tree.js';
import { buildNodeQuiz, buildBossQuiz, hintFor, microLesson } from './pipeline/quiz.js';
import { gradeQuiz, applyNodeResult, applyBossResult, bossState, treeComplete, dueReviews } from './pipeline/grade.js';
import { getCallLog } from './featherless.js';
import { rateLimit, concurrencyLimit } from './rate-limit.js';

await ensureDirs();

const app = express();

// Access log — so a request that hangs is visible instead of silent.
app.use((req, res, next) => {
  if (req.path.startsWith('/api') && req.path !== '/api/calls') {
    const started = Date.now();
    // Session ids are bearer credentials; log the shape of the route, not the id.
    const safe = req.path.replace(/\/s_[a-f0-9]{12}/g, '/:session');
    console.log(`→ ${req.method} ${safe}`);
    res.on('finish', () => console.log(`← ${res.statusCode} ${safe} ${Date.now() - started}ms`));
  }
  next();
});

app.use(express.json({ limit: '8mb' }));
// No caching of the app shell — a stale app.js is indistinguishable from a bug.
app.set('etag', false);
app.use(
  express.static(path.join(ROOT, 'public'), {
    etag: false,
    lastModified: false,
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-store, must-revalidate'),
  }),
);

// Behind a proxy (Render/Railway/Fly) the client IP arrives in x-forwarded-for.
app.set('trust proxy', 1);

// Everything gets a broad cap; the model-backed routes get a tight one and are
// serialised, because those are the ones that spend API credits.
app.use('/api', rateLimit({ name: 'all', windowMs: 60_000, max: 120 }));

const spendy = [
  '/api/session/:id/build',
  '/api/session/:id/node/:nodeId/expand',
  '/api/session/:id/node/:nodeId/quiz',
  '/api/session/:id/node/:nodeId/review-quiz',
  '/api/session/:id/node/:nodeId/micro-lesson',
  '/api/session/:id/quiz/:quizId/hint',
  '/api/session/:id/quiz/:quizId/submit',
  '/api/session/:id/boss/quiz',
  '/api/session/:id/sources',
];
app.post(spendy, rateLimit({ name: 'llm', windowMs: 10 * 60_000, max: 100 }), concurrencyLimit(4));

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 40 * 1024 * 1024, files: 20 },
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Strip answer keys before a quiz goes over the wire. */
function clientQuiz(quiz) {
  return {
    id: quiz.id,
    kind: quiz.kind,
    nodeId: quiz.nodeId,
    attempt: quiz.attempt,
    difficulty: quiz.difficulty,
    meta: quiz.meta,
    questions: quiz.questions.map((q) => ({
      id: q.id,
      type: q.type,
      prompt: q.prompt,
      options: q.type === 'mcq' ? q.options : undefined,
      difficulty: q.difficulty,
      synthesis: Boolean(q.synthesis),
      sources: [...new Set(q.citations.map((c) => c.sourceName))],
    })),
  };
}

/* ------------------------------------------------------------- meta ------ */

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    featherlessKey: hasFeatherlessKey(),
    models: {
      big: config.featherless.bigModel,
      small: config.featherless.smallModel,
      vision: config.featherless.visionModel || null,
    },
    embeddings: config.embeddings.provider,
  });
});

app.get('/api/calls', (_req, res) => res.json({ calls: getCallLog() }));

/** Every source type the UI can offer. */
app.get('/api/catalogue', (_req, res) => res.json({ catalogue: CATALOGUE }));

/* ---------------------------------------------------------- sessions ----- */

app.post('/api/session', wrap(async (req, res) => {
  const session = createSession(req.body?.name);
  await saveSession(session);
  res.json(publicView(session));
}));

/** Rename a space. */
app.post('/api/session/:id/name', wrap(async (req, res) => {
  const out = await withSession(req.params.id, async (session) => {
    session.name = String(req.body?.name || '').slice(0, 80);
    return publicView(session);
  });
  res.json(out);
}));

/** Delete a space and everything in it. */
app.delete('/api/session/:id', wrap(async (req, res) => {
  await loadSession(req.params.id);          // 404s if it isn't there
  await deleteSession(req.params.id);
  res.json({ deleted: req.params.id });
}));

app.get('/api/session/:id', wrap(async (req, res) => {
  const session = await loadSession(req.params.id);
  res.json({ ...publicView(session), bossUnlocked: treeComplete(session), dueReviews: dueReviews(session) });
}));

/** Every mutating response carries the same shape the GET route does. */
const fullView = (session) => ({
  ...publicView(session),
  bossUnlocked: treeComplete(session),
  dueReviews: dueReviews(session),
});

/* ------------------------------------------- stage 1: ingest + embed ----- */

app.post(
  '/api/session/:id/sources',
  upload.array('files'),
  wrap(async (req, res) => {
    const urls = []
      .concat(req.body?.urls || [])
      .flatMap((u) => String(u).split(/[\s,]+/))
      .map((u) => u.trim())
      .filter(Boolean);
    const pastedText = String(req.body?.text || '').trim();
    const files = req.files || [];

    // Validate the session before doing any fetching or parsing work.
    await loadSession(req.params.id);

    if (!urls.length && !pastedText && !files.length) {
      return res.status(400).json({ error: 'Nothing to ingest — paste text, add a link, or attach a file.' });
    }

    const ingested = [];
    const failures = [];

    if (pastedText) {
      ingested.push({
        kind: 'text',
        name: String(req.body?.textName || 'Pasted notes').slice(0, 120),
        text: pastedText,
        meta: {},
      });
    }

    for (const url of urls) {
      try {
        const result = await ingestUrl(url);
        if (result.multi) ingested.push(...result.multi);
        else ingested.push(result);
      } catch (err) {
        failures.push({ name: url, error: String(err.message || err) });
      }
    }

    for (const file of files) {
      try {
        ingested.push(await ingestFile(file));
      } catch (err) {
        failures.push({ name: file.originalname, error: String(err.message || err) });
      } finally {
        fs.unlink(file.path).catch(() => {});
      }
    }

    const out = await withSession(req.params.id, async (session) => {
      for (const item of ingested) {
        const sourceId = newId('src_');
        const chunks = chunkText(item.text, {
          sourceId,
          sourceName: item.name,
          sourceKind: item.kind,
        });
        session.sources.push({
          id: sourceId,
          kind: item.kind,
          name: item.name,
          chars: item.text.length,
          chunkCount: chunks.length,
          meta: item.meta,
          addedAt: new Date().toISOString(),
        });
        session.chunks.push(...chunks);
        logEvent(session, 'ingest', { source: item.name, kind: item.kind, chunks: chunks.length });
      }
      for (const f of failures) session.sources.push({ id: newId('src_'), kind: 'failed', name: f.name, error: f.error, chars: 0, chunkCount: 0, meta: {} });

      // Re-index the whole corpus; IDF has to see every document.
      session.index = await buildIndex(session.chunks);
      logEvent(session, 'index', { chunks: session.chunks.length, provider: session.index.provider });
      return fullView(session);
    });

    res.json({ ...out, failures });
  }),
);

/* ------------------------------------ stage 2: tree + gap detection ------ */

app.post('/api/session/:id/build', wrap(async (req, res) => {
  const out = await withSession(req.params.id, async (session) => {
    if (!session.chunks.length) throw Object.assign(new Error('Add some study material first.'), { status: 400 });

    // Rebuilding re-shapes the map, but finished subtopics stay finished.
    const previousTree = session.tree;
    const previousProgress = session.progress;

    session.tree = await buildTree(session);
    const { progress: kept, count: keptCount } = carryProgress(previousTree, previousProgress, session.tree);

    session.progress = {};
    session.gaps = [];
    for (const id of session.tree.nodes.root.children) {
      session.progress[id] = kept[id] || { state: 'available', attempts: 0, askedPrompts: [] };
    }
    session.carriedOver = keptCount;
    await runGapDetection(session, session.tree.nodes.root.children);
    logEvent(session, 'tree', {
      topic: session.tree.nodes.root.title,
      subtopics: session.tree.nodes.root.children.length,
      gaps: session.gaps.length,
      carriedOver: keptCount,
    });
    bossState(session);
    return fullView(session);
  });
  res.json(out);
}));

app.post('/api/session/:id/node/:nodeId/expand', wrap(async (req, res) => {
  const out = await withSession(req.params.id, async (session) => {
    const node = session.tree?.nodes?.[req.params.nodeId];
    if (!node) throw Object.assign(new Error('Node not found'), { status: 404 });
    if (node.expanded && node.children.length) return fullView(session);
    const children = await expandNode(session, node);
    for (const c of children) session.progress[c.id] ||= { state: 'available', attempts: 0, askedPrompts: [] };
    // The parent is now completed via its children, not its own quiz.
    if (session.progress[node.id]?.state !== 'mastered') session.progress[node.id] = { ...(session.progress[node.id] || {}), state: 'split' };
    await runGapDetection(session, children.map((c) => c.id));
    logEvent(session, 'expand', { node: node.title, children: children.length });
    return fullView(session);
  });
  res.json(out);
}));

app.get('/api/session/:id/node/:nodeId/sources', wrap(async (req, res) => {
  const session = await loadSession(req.params.id);
  const node = session.tree?.nodes?.[req.params.nodeId];
  if (!node) return res.status(404).json({ error: 'Node not found' });
  const hits = await retrieve(session.index, session.chunks, queryFor(node), 6);
  res.json({
    node: { id: node.id, title: node.title, summary: node.summary, keyConcepts: node.keyConcepts, coverage: node.coverage, gap: node.gap },
    chunks: hits.map((h) => ({ id: h.chunk.id, score: Number(h.score.toFixed(3)), sourceName: h.chunk.sourceName, sourceKind: h.chunk.sourceKind, text: h.chunk.text })),
  });
}));

/* ------------------------------------- stage 3: quizzes (verified) ------- */

app.post('/api/session/:id/node/:nodeId/quiz', wrap(async (req, res) => {
  const out = await withSession(req.params.id, async (session) => {
    const node = session.tree?.nodes?.[req.params.nodeId];
    if (!node) throw Object.assign(new Error('Node not found'), { status: 404 });

    const prog = session.progress[node.id] || {};
    if (prog.remediation?.required && !prog.remediation.satisfied) {
      throw Object.assign(
        new Error('Review the snippets you missed before retrying this subtopic.'),
        { status: 409 },
      );
    }
    if (node.children?.length) {
      throw Object.assign(new Error('This subtopic is split — quiz its sub-subtopics instead.'), { status: 400 });
    }

    const quiz = await buildNodeQuiz(session, node);
    session.quizzes[quiz.id] = quiz;
    logEvent(session, 'quiz', { node: node.title, attempt: quiz.attempt, verified: quiz.questions.length, rejected: quiz.meta.rejected });
    return clientQuiz(quiz);
  });
  res.json(out);
}));

app.post('/api/session/:id/quiz/:quizId/submit', wrap(async (req, res) => {
  const out = await withSession(req.params.id, async (session) => {
    const quiz = session.quizzes[req.params.quizId];
    if (!quiz) throw Object.assign(new Error('Quiz not found'), { status: 404 });
    if (quiz.submitted) throw Object.assign(new Error('This quiz was already submitted.'), { status: 409 });

    // Re-check the gate at submit time: a quiz held open from before a failed
    // attempt must not be usable to skip the review.
    if (quiz.kind === 'node') {
      const gate = session.progress[quiz.nodeId]?.remediation;
      if (gate?.required && !gate.satisfied && quiz.id !== session.progress[quiz.nodeId]?.lastQuizId) {
        throw Object.assign(new Error('Review the snippets you missed before submitting another attempt.'), { status: 409 });
      }
    }

    const graded = await gradeQuiz(session, quiz, req.body?.answers || {});
    quiz.submitted = true;

    if (quiz.kind === 'boss') {
      const { passed, need } = applyBossResult(session, quiz, graded);
      logEvent(session, 'boss-result', { score: graded.score, total: graded.total, passed });
      return {
        kind: 'boss',
        passed,
        needed: need,
        ...graded,
        boss: session.boss,
        state: publicView(session),
      };
    }

    const node = session.tree?.nodes?.[quiz.nodeId];
    if (!node) {
      throw Object.assign(
        new Error('That quiz belongs to a previous tree — rebuild changed the topics. Start a new quiz.'),
        { status: 409 },
      );
    }
    const { passed, prog } = applyNodeResult(session, node, quiz, graded);
    bossState(session);
    logEvent(session, 'result', { node: node.title, score: graded.score, passed });

    return {
      kind: 'node',
      passed,
      needed: config.pipeline.passMark,
      ...graded,
      remediation: prog.remediation,
      missedConcepts: prog.missedConcepts || [],
      bossUnlocked: treeComplete(session),
      state: publicView(session),
    };
  });
  res.json(out);
}));

app.post('/api/session/:id/quiz/:quizId/hint', wrap(async (req, res) => {
  const session = await loadSession(req.params.id);
  const quiz = session.quizzes[req.params.quizId];
  if (!quiz) return res.status(404).json({ error: 'Quiz not found' });
  res.json({ hint: await hintFor(session, quiz, req.body?.questionId) });
}));

/* ------------------------------------------- remediation gate + SRS ------ */

app.post('/api/session/:id/node/:nodeId/micro-lesson', wrap(async (req, res) => {
  const out = await withSession(req.params.id, async (session) => {
    const node = session.tree?.nodes?.[req.params.nodeId];
    if (!node) throw Object.assign(new Error('Node not found'), { status: 404 });
    const prog = session.progress[node.id] || {};
    const rem = prog.remediation;
    if (!rem?.required) throw Object.assign(new Error('Nothing to review here.'), { status: 400 });
    if (rem.microLesson) return { lesson: rem.microLesson, cached: true };

    const chunkById = new Map(session.chunks.map((c) => [c.id, c]));
    const snippets = [...new Set(rem.snippets.map((s) => s.chunkId))]
      .map((id) => chunkById.get(id))
      .filter(Boolean)
      .slice(0, 5)
      .map((c) => ({ sourceName: c.sourceName, text: c.text }));

    const lesson = await microLesson(session, node, prog.missedConcepts || [], snippets);
    rem.microLesson = lesson;
    logEvent(session, 'micro-lesson', { node: node.title });
    return { lesson, cached: false };
  });
  res.json(out);
}));

/** The gate: acknowledge the review before a retry is allowed. */
app.post('/api/session/:id/node/:nodeId/review-done', wrap(async (req, res) => {
  const out = await withSession(req.params.id, async (session) => {
    const prog = session.progress[req.params.nodeId];
    if (!prog?.remediation?.required) throw Object.assign(new Error('No review pending.'), { status: 400 });
    prog.remediation.satisfied = true;
    prog.state = 'available';
    logEvent(session, 'review-done', { node: session.tree.nodes[req.params.nodeId]?.title });
    return fullView(session);
  });
  res.json(out);
}));

app.get('/api/session/:id/reviews', wrap(async (req, res) => {
  const session = await loadSession(req.params.id);
  res.json({ due: dueReviews(session) });
}));

/** Re-open a mastered node for its spaced-repetition review. */
app.post('/api/session/:id/node/:nodeId/review-quiz', wrap(async (req, res) => {
  const out = await withSession(req.params.id, async (session) => {
    const node = session.tree?.nodes?.[req.params.nodeId];
    if (!node) throw Object.assign(new Error('Node not found'), { status: 404 });
    // This route exists for spaced repetition of an already-mastered node. It
    // must not become a way around the remediation gate or the split rule.
    const prog = session.progress[node.id] || {};
    if (prog.state !== 'mastered') {
      throw Object.assign(new Error('Only a mastered subtopic can be reviewed.'), { status: 409 });
    }
    if (node.children?.length) {
      throw Object.assign(new Error('This subtopic is split — review its sub-subtopics instead.'), { status: 400 });
    }
    const quiz = await buildNodeQuiz(session, node);
    quiz.review = true;
    session.quizzes[quiz.id] = quiz;
    logEvent(session, 'srs-quiz', { node: node.title });
    return clientQuiz(quiz);
  });
  res.json(out);
}));

/* ------------------------------------------------------------- boss ------ */

app.post('/api/session/:id/boss/quiz', wrap(async (req, res) => {
  const out = await withSession(req.params.id, async (session) => {
    if (!treeComplete(session)) {
      throw Object.assign(new Error('Light up every subtopic first.'), { status: 409 });
    }
    const boss = bossState(session);
    if (boss.remediation?.required && !boss.remediation.satisfied) {
      throw Object.assign(new Error('Review your missed snippets before retrying the boss.'), { status: 409 });
    }
    const quiz = await buildBossQuiz(session);
    session.quizzes[quiz.id] = quiz;
    logEvent(session, 'boss-quiz', { questions: quiz.questions.length, synthesis: quiz.meta.synthesisCount, rejected: quiz.meta.rejected });
    return clientQuiz(quiz);
  });
  res.json(out);
}));

app.post('/api/session/:id/boss/review-done', wrap(async (req, res) => {
  const out = await withSession(req.params.id, async (session) => {
    if (!session.boss?.remediation?.required) throw Object.assign(new Error('No review pending.'), { status: 400 });
    session.boss.remediation.satisfied = true;
    return fullView(session);
  });
  res.json(out);
}));

/* ----------------------------------------------------------- errors ------ */

// eslint-disable-next-line no-unused-vars -- express needs the 4-arg shape
app.use((err, _req, res, _next) => {
  // Multer signals its own limits with a code rather than a status.
  const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : err.code?.startsWith?.('LIMIT_') ? 400 : 500);
  if (status >= 500) console.error(err);
  const message =
    status >= 500
      ? 'Something went wrong on the server.'   // never leak internals or paths
      : String(err.message || err);
  res.status(status).json({ error: message });
});

app.listen(config.port, () => {
  console.log(`\n  Grove running at http://localhost:${config.port}`);
  console.log(`  big model:   ${config.featherless.bigModel}`);
  console.log(`  small model: ${config.featherless.smallModel}`);
  console.log(`  embeddings:  ${config.embeddings.provider}`);
  if (!hasFeatherlessKey()) console.log(`  ⚠ FEATHERLESS_API_KEY is not set — copy .env.example to .env\n`);
  else console.log('');
});

export default app;
