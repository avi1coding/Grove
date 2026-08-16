import { config } from '../config.js';
import { chatJson } from '../featherless.js';

/** MCQ is graded deterministically; short answers go to the small fast model. */
async function gradeShort(question, given) {
  const answer = String(given || '').trim();
  if (!answer) return { correct: false, note: 'no answer given' };
  const verdict = await chatJson({
    role: 'small',
    stage: 'grade:short',
    temperature: 0,
    maxTokens: 260,
    messages: [
      {
        role: 'system',
        content:
          'You grade a short free-text answer against a reference answer and the source snippet it came from. Accept correct answers phrased differently; reject vague, missing, or contradictory ones. JSON only.',
      },
      {
        role: 'user',
        content: `Question: ${question.prompt}
Reference answer: ${question.answer}
Source snippet: "${question.citations[0]?.snippet || ''}"
Learner's answer: ${answer}

JSON: { "correct": true|false, "note": "one short sentence of feedback" }`,
      },
    ],
  });
  return { correct: verdict.correct === true, note: String(verdict.note || '').trim() };
}

/**
 * Grade a whole submission.
 * @param {object} quiz server-side quiz (with answer keys)
 * @param {Record<string, number|string>} answers questionId -> option index or text
 */
export async function gradeQuiz(session, quiz, answers) {
  const results = await Promise.all(
    quiz.questions.map(async (q) => {
      const given = answers?.[q.id];
      let correct = false;
      let note = '';
      if (q.type === 'short') {
        const r = await gradeShort(q, given);
        correct = r.correct;
        note = r.note;
      } else if (given == null || given === '') {
        correct = false;          // blank is wrong, not "option A"
        note = 'no answer given';
      } else {
        correct = Number(given) === q.answerIndex;
      }
      return {
        questionId: q.id,
        concept: q.concept,
        prompt: q.prompt,
        type: q.type,
        given: given ?? null,
        correct,
        note,
        correctAnswer: q.type === 'short' ? q.answer : q.answerIndex,
        options: q.options,
        explanation: q.explanation,
        difficulty: q.difficulty,
        synthesis: Boolean(q.synthesis),
        citations: q.citations.map((c) => ({
          chunkId: c.chunkId,
          snippet: c.snippet,
          sourceName: c.sourceName,
          sourceKind: c.sourceKind,
        })),
        verified: q.verified || null,
      };
    }),
  );

  const score = results.filter((r) => r.correct).length;
  return { score, total: results.length, results };
}

/** A level-1 node counts as done if it passed itself, or all its children passed. */
export function nodeMastered(session, nodeId) {
  const node = session.tree?.nodes?.[nodeId];
  if (!node) return false;
  const prog = session.progress[nodeId];
  if (prog?.state === 'mastered') return true;
  if (node.children?.length) return node.children.every((c) => nodeMastered(session, c));
  return false;
}

export function treeComplete(session) {
  const root = session.tree?.nodes?.root;
  if (!root) return false;
  return root.children.length > 0 && root.children.every((id) => nodeMastered(session, id));
}

function scheduleReview(prog) {
  const level = Math.min((prog.srs?.level ?? -1) + 1, config.srsIntervals.length - 1);
  const days = config.srsIntervals[level];
  const due = new Date(Date.now() + days * 86_400_000).toISOString();
  return { level, dueAt: due, intervalDays: days, history: [...(prog.srs?.history || []), new Date().toISOString()] };
}

/** Apply a graded node quiz to the session's progress state. */
export function applyNodeResult(session, node, quiz, graded) {
  const prog = (session.progress[node.id] ||= { state: 'available', attempts: 0, askedPrompts: [] });
  prog.attempts = quiz.attempt;
  prog.lastScore = graded.score;
  prog.best = Math.max(prog.best || 0, graded.score);
  prog.askedPrompts = [...(prog.askedPrompts || []), ...quiz.questions.map((q) => q.prompt)].slice(-40);
  prog.lastQuizId = quiz.id;
  prog.lastAt = new Date().toISOString();

  const passed = graded.score >= config.pipeline.passMark && graded.total >= config.pipeline.passMark;

  if (passed) {
    prog.state = 'mastered';
    prog.masteredAt = new Date().toISOString();
    prog.missedConcepts = [];
    prog.remediation = null;
    prog.srs = scheduleReview(prog);
  } else {
    const missed = graded.results.filter((r) => !r.correct);
    prog.state = 'needs_review';
    prog.missedConcepts = [...new Set(missed.map((r) => r.concept).filter(Boolean))];
    prog.remediation = {
      required: true,
      satisfied: false,
      snippets: missed.flatMap((r) =>
        r.citations.map((c) => ({
          chunkId: c.chunkId,
          snippet: c.snippet,
          sourceName: c.sourceName,
          concept: r.concept,
        })),
      ),
      microLesson: null,
    };
  }

  return { passed, prog };
}

export function bossState(session) {
  const unlocked = treeComplete(session);
  session.boss ||= { unlocked: false, passed: false, attempts: 0, best: 0, askedPrompts: [], missedConcepts: [] };
  session.boss.unlocked = unlocked;
  return session.boss;
}

export function applyBossResult(session, quiz, graded) {
  const boss = bossState(session);
  boss.attempts = quiz.attempt;
  boss.lastScore = graded.score;
  boss.best = Math.max(boss.best || 0, graded.score);
  boss.askedPrompts = [...(boss.askedPrompts || []), ...quiz.questions.map((q) => q.prompt)].slice(-60);
  boss.lastAt = new Date().toISOString();

  const need = Math.ceil(graded.total * config.pipeline.bossPassRatio);
  const passed = graded.score >= need;
  boss.needed = need;

  if (passed) {
    boss.passed = true;
    boss.passedAt = new Date().toISOString();
    boss.missedConcepts = [];
    boss.remediation = null;
    boss.srs = scheduleReview(boss);
    // Clearing the boss pulls the whole tree forward for one consolidating
    // review rather than leaving each node on its own drifting schedule.
    for (const id of Object.keys(session.progress)) {
      const p = session.progress[id];
      if (p.state === 'mastered') p.srs = scheduleReview(p);
    }
  } else {
    const missed = graded.results.filter((r) => !r.correct);
    boss.missedConcepts = [...new Set(missed.map((r) => r.concept).filter(Boolean))];
    boss.remediation = {
      required: true,
      satisfied: false,
      snippets: missed.flatMap((r) =>
        r.citations.map((c) => ({ chunkId: c.chunkId, snippet: c.snippet, sourceName: c.sourceName, concept: r.concept })),
      ),
    };
  }
  return { passed, need, boss };
}

/** Everything whose spaced-repetition review has come due. */
export function dueReviews(session, now = Date.now()) {
  const out = [];
  for (const [id, p] of Object.entries(session.progress)) {
    if (p.state === 'mastered' && p.srs?.dueAt && new Date(p.srs.dueAt).getTime() <= now) {
      out.push({
        nodeId: id,
        title: session.tree?.nodes?.[id]?.title || id,
        dueAt: p.srs.dueAt,
        level: p.srs.level,
      });
    }
  }
  if (session.boss?.passed && session.boss.srs?.dueAt && new Date(session.boss.srs.dueAt).getTime() <= now) {
    out.push({
      nodeId: 'root',
      kind: 'boss',                       // the client must send this to /boss/quiz, not /review-quiz
      title: `${session.tree?.nodes?.root?.title || 'Topic'} (boss)`,
      dueAt: session.boss.srs.dueAt,
      level: session.boss.srs.level,
    });
  }
  return out;
}
