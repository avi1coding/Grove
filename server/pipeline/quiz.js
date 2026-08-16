import { config } from '../config.js';
import { chatJson, chat } from '../featherless.js';
import { retrieve } from '../embed.js';
import { newId } from '../store.js';
import { renderContext, queryFor } from './tree.js';
import { verifyQuestion } from './verify.js';

/**
 * Stage 3: grounded quiz authoring with a verify-or-regenerate loop.
 *
 * Nothing reaches the learner until a second model has confirmed it against the
 * exact chunk it was written from.
 */

const AUTHOR_SYSTEM = `You write quiz questions strictly from provided source excerpts.

Absolute rules:
- Every question must be answerable using ONLY the excerpts given. No outside knowledge.
- Every question cites the chunk id it came from and quotes a VERBATIM snippet (8-40 words) copied character-for-character from that chunk. Do not paraphrase the snippet.
- The correct answer must be explicitly stated or directly entailed by the cited snippet.
- The three wrong options must be clearly wrong according to the excerpt — plausible, but refutable from the text.
- Never write "all of the above", "none of the above", or questions about the document itself ("what does the slide say").
- Output strict JSON only.`;

function difficultyWord(d) {
  return d <= 1 ? 'recall' : d === 2 ? 'application' : 'analysis / multi-step reasoning';
}

async function authorQuestions({
  count,
  context,
  topicLine,
  focusConcepts = [],
  avoid = [],
  rejected = [],
  difficulty = 2,
  synthesis = false,
  allowShort = false,
}) {
  const focusLine = focusConcepts.length
    ? `\nWeight these concepts heavily — the learner got them wrong last time: ${focusConcepts.join(', ')}.`
    : '';
  const avoidLine = avoid.length
    ? `\nDo NOT repeat or lightly reword any of these previously asked questions:\n${avoid.map((a) => `- ${a}`).join('\n')}`
    : '';
  const rejectLine = rejected.length
    ? `\nA verifier rejected your previous attempts for these reasons — do not repeat these mistakes:\n${rejected.map((r) => `- ${r}`).join('\n')}`
    : '';
  const synthLine = synthesis
    ? `\nThese must be CROSS-SOURCE SYNTHESIS questions: each one connects a concept from one source to a concept from a DIFFERENT source, and cites one snippet from each (two citations, two different sources).`
    : '';

  const data = await chatJson({
    role: 'big',
    stage: synthesis ? 'quiz:author-synthesis' : 'quiz:author',
    temperature: 0.55,
    maxTokens: 3200,
    messages: [
      { role: 'system', content: AUTHOR_SYSTEM },
      {
        role: 'user',
        content: `${topicLine}

SOURCE EXCERPTS:

${context}

Write ${count} question(s) at the "${difficultyWord(difficulty)}" level.${focusLine}${synthLine}${avoidLine}${rejectLine}

JSON shape:
{
  "questions": [
    {
      "concept": "the single concept tested",
      "type": "mcq"${allowShort ? ' | "short"' : ''},
      "prompt": "the question",
      "options": ["A", "B", "C", "D"],${allowShort ? '\n      "answer": "for short type only: the expected answer in <=15 words",' : ''}
      "answer_index": 0,
      "difficulty": ${difficulty},
      "explanation": "why the answer is right, in one sentence, referring to the snippet",
      "citations": [ { "chunk_id": "exact id from above", "snippet": "verbatim quote copied from that chunk" } ]
    }
  ]
}`,
      },
    ],
  });

  const raw = Array.isArray(data.questions) ? data.questions : [];
  return raw.map((q) => ({
    id: newId('q_'),
    concept: String(q.concept || '').trim(),
    type: q.type === 'short' && allowShort ? 'short' : 'mcq',
    prompt: String(q.prompt || '').trim(),
    options: Array.isArray(q.options) ? q.options.map(String) : [],
    answerIndex: Number.isInteger(q.answer_index) ? q.answer_index : Number(q.answer_index),
    answer: q.answer ? String(q.answer) : undefined,
    difficulty: Math.min(3, Math.max(1, Number(q.difficulty) || difficulty)),
    explanation: String(q.explanation || '').trim(),
    citations: (Array.isArray(q.citations) ? q.citations : []).map((c) => ({
      chunkId: String(c.chunk_id || c.chunkId || ''),
      snippet: String(c.snippet || '').trim(),
    })),
  }));
}

/**
 * Author -> verify -> regenerate until `count` questions survive.
 * Returns { questions, rejections, rounds }.
 */
async function generateVerified(opts) {
  const { chunkMap, count } = opts;
  const accepted = [];
  const rejections = [];
  let rounds = 0;

  const seenPrompts = new Set((opts.avoid || []).map((a) => a.toLowerCase()));

  while (accepted.length < count && rounds < config.pipeline.verifyRounds) {
    rounds++;
    const need = count - accepted.length;
    const batch = await authorQuestions({
      ...opts,
      // Over-author a little so one rejection doesn't cost a whole round.
      count: Math.min(need + (rounds === 1 ? 1 : 2), 10),
      avoid: [...(opts.avoid || []), ...accepted.map((q) => q.prompt)],
      rejected: rejections.slice(-6).map((r) => r.reasons.join('; ')),
    });

    const fresh = batch.filter((q) => {
      const key = q.prompt.toLowerCase();
      if (!key || seenPrompts.has(key)) return false;
      seenPrompts.add(key);
      return true;
    });

    const verdicts = await Promise.all(
      fresh.map(async (q) => {
        try {
          return { q, v: await verifyQuestion(q, chunkMap) };
        } catch (err) {
          // Distinguish "the model says unsupported" from "the model was unreachable".
          return { q, v: { ok: false, stage: 'error', transport: true, reasons: [String(err.message || err)] } };
        }
      }),
    );

    for (const { q, v } of verdicts) {
      if (accepted.length >= count) break;
      if (v.ok) {
        // Attach the human-readable citation now that we know it holds up.
        q.citations = q.citations.map((c) => {
          const chunk = chunkMap.get(c.chunkId);
          return { ...c, sourceName: chunk.sourceName, sourceKind: chunk.sourceKind };
        });
        q.verified = { by: config.featherless.smallModel, reason: v.verdict?.reason || 'entailed by cited chunk' };
        accepted.push(q);
      } else {
        rejections.push({ prompt: q.prompt, stage: v.stage, reasons: v.reasons });
      }
    }
  }

  return { questions: accepted.slice(0, count), rejections, rounds };
}

/* ------------------------------------------------------------ node quiz -- */

export async function buildNodeQuiz(session, node) {
  const prog = session.progress[node.id] || {};
  const attempt = (prog.attempts || 0) + 1;
  const missed = prog.missedConcepts || [];
  const asked = prog.askedPrompts || [];

  // Adaptive: later attempts get harder and lean on what was missed.
  const lastScore = prog.lastScore ?? 0;
  let difficulty = 2;
  if (attempt > 1) difficulty = lastScore >= 4 ? 3 : lastScore <= 2 ? 1 : 2;

  const hits = await retrieve(session.index, session.chunks, queryFor(node), config.pipeline.retrieveK);
  if (!hits.length) throw Object.assign(new Error('No source material matches this subtopic.'), { status: 422 });

  // On a retry, pull extra chunks aimed squarely at the missed concepts.
  let context = hits;
  if (missed.length) {
    const extra = await retrieve(session.index, session.chunks, missed.join('. '), 4, {
      excludeIds: hits.map((h) => h.chunk.id),
    });
    context = [...hits, ...extra];
  }

  const chunkMap = new Map(context.map((h) => [h.chunk.id, h.chunk]));
  const { questions, rejections, rounds } = await generateVerified({
    count: config.pipeline.quizSize,
    context: renderContext(context),
    chunkMap,
    topicLine: `Main topic: "${session.tree.nodes.root.title}"
Subtopic being quizzed: "${node.title}" — ${node.summary}
Key concepts: ${node.keyConcepts.join(', ') || '(derive from the excerpts)'}`,
    focusConcepts: missed,
    avoid: asked,
    difficulty,
  });

  // A short quiz can never be passed (passMark is a fixed 5), so refuse to
  // serve one rather than handing the learner an unwinnable node.
  if (questions.length < config.pipeline.quizSize) {
    const why = rejections.some((r) => r.stage === 'error')
      ? `The verifier could not be reached (${rejections.find((r) => r.stage === 'error').reasons[0]}).`
      : `Only ${questions.length} of ${config.pipeline.quizSize} questions survived verification against your sources — this subtopic is a gap, add material on it.`;
    throw Object.assign(new Error(`Could not build a quiz for "${node.title}". ${why}`), { status: 422 });
  }

  return {
    id: newId('quiz_'),
    kind: 'node',
    nodeId: node.id,
    attempt,
    difficulty,
    questions,
    createdAt: new Date().toISOString(),
    meta: {
      rounds,
      rejected: rejections.length,
      rejections: rejections.slice(0, 8),
      chunksConsidered: context.length,
      adaptive: attempt > 1 ? { focusedOn: missed, difficulty } : null,
    },
  };
}

/* ------------------------------------------------------------ boss quiz -- */

export async function buildBossQuiz(session) {
  const root = session.tree.nodes.root;
  const level1 = root.children.map((id) => session.tree.nodes[id]);
  const total = Math.min(
    config.pipeline.bossMax,
    Math.max(config.pipeline.bossMin, level1.length * 3),
  );
  const prevAttempts = session.boss?.attempts || 0;
  const missed = session.boss?.missedConcepts || [];

  // Gather a broad context: top chunks per level-1 subtopic.
  const perNode = Math.max(3, Math.ceil(24 / level1.length));
  const gathered = [];
  const seen = new Set();
  for (const n of level1) {
    const hits = await retrieve(session.index, session.chunks, queryFor(n), perNode);
    for (const h of hits) {
      if (seen.has(h.chunk.id)) continue;
      seen.add(h.chunk.id);
      gathered.push(h);
    }
  }
  const chunkMap = new Map(gathered.map((h) => [h.chunk.id, h.chunk]));
  const context = renderContext(gathered);

  const sourceCount = new Set(gathered.map((h) => h.chunk.sourceId)).size;
  const synthCount = sourceCount > 1 ? Math.min(5, Math.max(3, Math.round(total * 0.25))) : 0;
  const coreCount = total - synthCount;

  const askedBefore = session.boss?.askedPrompts || [];
  const difficulty = prevAttempts === 0 ? 2 : 3;

  const core = await generateVerified({
    count: coreCount,
    context,
    chunkMap,
    topicLine: `Boss quiz for the mastered topic "${root.title}" — ${root.summary}
Subtopics the learner has already lit up: ${level1.map((n) => n.title).join('; ')}
Spread the questions across those subtopics; do not concentrate on one.`,
    focusConcepts: missed,
    avoid: askedBefore,
    difficulty,
    allowShort: true,
  });

  let synth = { questions: [], rejections: [], rounds: 0 };
  if (synthCount > 0) {
    synth = await generateVerified({
      count: synthCount,
      context,
      chunkMap,
      topicLine: `Boss quiz (synthesis section) for "${root.title}".
The learner uploaded ${sourceCount} different sources. These questions must connect them.`,
      avoid: [...askedBefore, ...core.questions.map((q) => q.prompt)],
      difficulty: 3,
      synthesis: true,
    });
    // Only label it synthesis if it really cites two different sources.
    synth.questions.forEach((q) => {
      const sources = new Set(q.citations.map((c) => c.sourceId || c.sourceName));
      q.synthesis = sources.size > 1;
    });
  }

  const questions = [...core.questions, ...synth.questions];
  if (questions.length < Math.min(config.pipeline.bossMin, total)) {
    throw Object.assign(
      new Error(`Only ${questions.length} boss questions survived verification — your sources may be too thin.`),
      { status: 422 },
    );
  }

  return {
    id: newId('quiz_'),
    kind: 'boss',
    nodeId: 'root',
    attempt: prevAttempts + 1,
    difficulty,
    questions,
    createdAt: new Date().toISOString(),
    meta: {
      rounds: core.rounds + synth.rounds,
      rejected: core.rejections.length + synth.rejections.length,
      rejections: [...core.rejections, ...synth.rejections].slice(0, 8),
      synthesisCount: synth.questions.length,
      sourceCount,
      passNeeded: Math.ceil(questions.length * config.pipeline.bossPassRatio),
    },
  };
}

/* ------------------------------------------------------- helper features -- */

export async function hintFor(session, quiz, questionId) {
  const q = quiz.questions.find((x) => x.id === questionId);
  if (!q) throw Object.assign(new Error('Question not found'), { status: 404 });
  const chunk = session.chunks.find((c) => c.id === q.citations[0]?.chunkId);
  const text = await chat({
    role: 'small',
    stage: 'hint',
    temperature: 0.4,
    maxTokens: 160,
    messages: [
      {
        role: 'system',
        content:
          'You give one short nudge that helps a learner reason toward the answer. Never state the answer or name the correct option. One or two sentences.',
      },
      {
        role: 'user',
        content: `Source excerpt:\n${chunk?.text || q.citations[0]?.snippet || ''}\n\nQuestion: ${q.prompt}\n\nGive the nudge.`,
      },
    ],
  });
  return String(text).trim();
}

export async function microLesson(session, node, missedConcepts, snippets) {
  const body = await chat({
    role: 'big',
    stage: 'micro-lesson',
    temperature: 0.4,
    maxTokens: 900,
    messages: [
      {
        role: 'system',
        content: `You write a 150-250 word micro-lesson covering ONLY the concepts the learner just missed. Teach strictly from the excerpts provided — never add outside facts. Plain markdown, no headings above ###, no preamble.`,
      },
      {
        role: 'user',
        content: `Subtopic: "${node.title}"
Concepts the learner missed: ${missedConcepts.join(', ') || node.keyConcepts.join(', ')}

Excerpts they should have learned this from:
${snippets.map((s, i) => `(${i + 1}) [${s.sourceName}] ${s.text}`).join('\n\n')}

Write the micro-lesson, then end with one line starting "Watch for:" naming the trap they fell into.`,
      },
    ],
  });
  return String(body).trim();
}
