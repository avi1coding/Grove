import { config } from '../config.js';
import { chatJson } from '../featherless.js';
import { retrieve } from '../embed.js';

/**
 * Stage 2 of the pipeline: extract a completable topic tree from the corpus,
 * then score how well the corpus actually covers each subtopic (gap detection).
 *
 * Depth is capped at 2 on purpose: root -> subtopic -> sub-subtopic. Nothing
 * deeper, so the tree stays finishable.
 */

/** Spread a character budget evenly across sources so no upload dominates. */
export function sampleCorpus(chunks, budget = 24_000) {
  const bySource = new Map();
  for (const c of chunks) {
    if (!bySource.has(c.sourceId)) bySource.set(c.sourceId, []);
    bySource.get(c.sourceId).push(c);
  }
  const per = Math.floor(budget / Math.max(1, bySource.size));
  const picked = [];
  for (const list of bySource.values()) {
    let used = 0;
    // Even stride through the document rather than just the opening pages.
    const stride = Math.max(1, Math.floor(list.length / Math.ceil(per / config.pipeline.chunkChars)));
    for (let i = 0; i < list.length && used < per; i += stride) {
      picked.push(list[i]);
      used += list[i].text.length;
    }
  }
  picked.sort((a, b) => (a.sourceId === b.sourceId ? a.index - b.index : a.sourceId < b.sourceId ? -1 : 1));
  return picked;
}

export function renderContext(items) {
  return items
    .map(
      ({ chunk }) =>
        `[${chunk.id}] (source: ${chunk.sourceName}${chunk.sourceKind ? `, ${chunk.sourceKind}` : ''})\n${chunk.text}`,
    )
    .join('\n\n---\n\n');
}

const TREE_SYSTEM = `You are a curriculum architect. You read a learner's own uploaded study materials and turn them into a small, completable skill tree.

Hard rules:
- Only use topics that the provided material actually covers. Never invent topics from general knowledge.
- Subtopics must be disjoint, concrete, and quizzable — not vague buckets like "Introduction" or "Miscellaneous".
- Output strict JSON only.`;

/** Build the root topic + 5-7 level-1 subtopics. */
export async function buildTree(session) {
  const sample = sampleCorpus(session.chunks);
  const context = renderContext(sample.map((chunk) => ({ chunk })));
  const sourceList = session.sources
    .filter((s) => !s.error)
    .map((s) => `- ${s.name} (${s.kind})`)
    .join('\n');

  const data = await chatJson({
    role: 'big',
    stage: 'tree:extract',
    temperature: 0.2,
    maxTokens: 2600,
    messages: [
      { role: 'system', content: TREE_SYSTEM },
      {
        role: 'user',
        content: `The learner uploaded these sources:
${sourceList}

Excerpts from the material:

${context}

Produce ONE overarching topic that honestly describes what this material teaches, plus 5 to 7 subtopics that together cover it.

JSON shape:
{
  "topic": { "title": "...", "summary": "1-2 sentences on what mastering this means" },
  "subtopics": [
    {
      "title": "short, specific",
      "summary": "1 sentence",
      "key_concepts": ["3-6 concrete terms/skills this subtopic quizzes"],
      "evidence_chunk_ids": ["chunk ids from above that support this subtopic"]
    }
  ]
}`,
      },
    ],
  });

  const topic = data.topic || {};
  const subs = Array.isArray(data.subtopics) ? data.subtopics.slice(0, 7) : [];
  if (subs.length < 3) throw new Error('Not enough material to build a tree — add more sources.');

  const root = {
    id: 'root',
    depth: 0,
    parentId: null,
    title: String(topic.title || 'Your topic').trim(),
    summary: String(topic.summary || '').trim(),
    keyConcepts: [],
    children: [],
  };

  const nodes = { root };
  subs.forEach((s, i) => {
    const id = `n${i + 1}`;
    nodes[id] = {
      id,
      depth: 1,
      parentId: 'root',
      title: String(s.title || `Subtopic ${i + 1}`).trim(),
      summary: String(s.summary || '').trim(),
      keyConcepts: (Array.isArray(s.key_concepts) ? s.key_concepts : []).map(String).slice(0, 6),
      children: [],
      expanded: false,
      expandable: true,
    };
    root.children.push(id);
  });

  return { root: 'root', nodes };
}

/** Split one level-1 subtopic into its own 4-6 children (the depth cap). */
export async function expandNode(session, node) {
  if (node.depth !== 1) throw Object.assign(new Error('Only level-1 subtopics can be expanded'), { status: 400 });

  const hits = await retrieve(session.index, session.chunks, queryFor(node), 12);
  const context = renderContext(hits);

  const siblings = node.children.length
    ? ''
    : Object.values(session.tree.nodes)
        .filter((n) => n.depth === 1 && n.id !== node.id)
        .map((n) => `- ${n.title}`)
        .join('\n');

  const data = await chatJson({
    role: 'big',
    stage: 'tree:expand',
    temperature: 0.2,
    maxTokens: 1800,
    messages: [
      { role: 'system', content: TREE_SYSTEM },
      {
        role: 'user',
        content: `Parent topic: "${session.tree.nodes.root.title}"
Subtopic to break down: "${node.title}" — ${node.summary}
Key concepts already associated: ${node.keyConcepts.join(', ') || '(none)'}

These are the sibling subtopics; do NOT duplicate their ground:
${siblings || '(none)'}

Relevant excerpts from the learner's material:

${context}

Break "${node.title}" into 4 to 6 sub-subtopics. This is the deepest level — each one must be directly quizzable from the material above.

JSON shape:
{ "subtopics": [ { "title": "...", "summary": "...", "key_concepts": ["..."] } ] }`,
      },
    ],
  });

  const subs = (Array.isArray(data.subtopics) ? data.subtopics : []).slice(0, 6);
  if (!subs.length) throw new Error(`Could not break "${node.title}" down any further.`);

  node.children = [];
  subs.forEach((s, i) => {
    const id = `${node.id}.${i + 1}`;
    session.tree.nodes[id] = {
      id,
      depth: 2,
      parentId: node.id,
      title: String(s.title || `Part ${i + 1}`).trim(),
      summary: String(s.summary || '').trim(),
      keyConcepts: (Array.isArray(s.key_concepts) ? s.key_concepts : []).map(String).slice(0, 6),
      children: [],
      expanded: false,
      expandable: false,
    };
    node.children.push(id);
  });
  node.expanded = true;
  return node.children.map((id) => session.tree.nodes[id]);
}

export function queryFor(node) {
  return [node.title, node.summary, ...(node.keyConcepts || [])].filter(Boolean).join('. ');
}

/**
 * Gap detection. Retrieval score gives a cheap coverage signal; anything
 * borderline gets a second opinion from the small model, which also says what
 * the learner should go add.
 */
export async function assessCoverage(session, node) {
  const hits = await retrieve(session.index, session.chunks, queryFor(node), 6);
  const top = hits.slice(0, 5);
  const meanTop = top.length ? top.reduce((a, h) => a + h.score, 0) / top.length : 0;
  const sourceCount = new Set(top.map((h) => h.chunk.sourceId)).size;
  const volume = Math.min(1, top.filter((h) => h.score > 0.12).length / 4);
  const coverage = Number((0.6 * Math.min(1, meanTop / 0.45) + 0.25 * volume + 0.15 * Math.min(1, sourceCount / 2)).toFixed(3));

  const floor = config.pipeline.gapCoverageFloor;
  const node_ = { coverage, sourceCount, chunkIds: top.map((h) => h.chunk.id) };

  if (coverage > floor * 1.7) {
    return { ...node_, weak: false, verdict: 'sufficient' };
  }

  let verdict = coverage < floor ? 'insufficient' : 'partial';
  let missing = '';
  try {
    const judged = await chatJson({
      role: 'small',
      stage: 'gap:judge',
      temperature: 0,
      maxTokens: 400,
      messages: [
        {
          role: 'system',
          content:
            'You judge whether a set of source excerpts is enough to teach and quiz a subtopic. Be strict. JSON only.',
        },
        {
          role: 'user',
          content: `Subtopic: "${node.title}" — ${node.summary}
Key concepts: ${node.keyConcepts.join(', ') || '(none)'}

Excerpts available:
${renderContext(top) || '(nothing relevant was retrieved)'}

Could a learner be fairly quizzed on this subtopic using ONLY these excerpts?
JSON: { "verdict": "sufficient" | "partial" | "insufficient", "missing": "one sentence naming what is absent", "suggestion": "one sentence on what specific material to upload" }`,
        },
      ],
    });
    if (['sufficient', 'partial', 'insufficient'].includes(judged.verdict)) verdict = judged.verdict;
    missing = String(judged.missing || '').trim();
    node_.suggestion = String(judged.suggestion || '').trim();
  } catch {
    node_.suggestion = `Upload material that covers ${node.keyConcepts.slice(0, 3).join(', ') || node.title} in more depth.`;
  }

  return {
    ...node_,
    weak: verdict !== 'sufficient',
    verdict,
    missing,
    suggestion: node_.suggestion,
  };
}

/** Run coverage over a set of nodes and write the gap list onto the session. */
export async function runGapDetection(session, nodeIds) {
  const gaps = [];
  for (const id of nodeIds) {
    const node = session.tree.nodes[id];
    if (!node) continue;
    const cov = await assessCoverage(session, node);
    node.coverage = cov.coverage;
    node.evidenceChunkIds = cov.chunkIds;
    node.gap = cov.weak
      ? { verdict: cov.verdict, missing: cov.missing, suggestion: cov.suggestion }
      : null;
    if (cov.weak) {
      gaps.push({
        nodeId: id,
        title: node.title,
        coverage: cov.coverage,
        verdict: cov.verdict,
        missing: cov.missing,
        suggestion: cov.suggestion,
      });
    }
  }
  // Keep gaps for other branches, replace the ones we just re-scored.
  const stale = new Set(nodeIds);
  session.gaps = [...(session.gaps || []).filter((g) => !stale.has(g.nodeId)), ...gaps];
  return gaps;
}

/**
 * Carry finished work across a rebuild.
 *
 * Adding material re-extracts the tree, so node ids are meaningless between
 * builds — a subtopic you mastered might come back as n4 instead of n2, or with
 * slightly different wording. Match on the title instead, and move the progress
 * across so nobody has to re-earn a node they already passed.
 */
const normTitle = (t) =>
  String(t || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function titleSimilarity(a, b) {
  const A = new Set(normTitle(a).split(' ').filter(Boolean));
  const B = new Set(normTitle(b).split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / new Set([...A, ...B]).size;   // Jaccard
}

export function carryProgress(oldTree, oldProgress, newTree) {
  const carried = {};
  if (!oldTree || !oldProgress) return { progress: carried, count: 0 };

  // Only finished work is worth moving; a half-attempt is not.
  const finished = Object.entries(oldProgress)
    .filter(([id, p]) => p?.state === 'mastered' && oldTree.nodes[id])
    .map(([id, p]) => ({ title: oldTree.nodes[id].title, prog: p }));
  if (!finished.length) return { progress: carried, count: 0 };

  const used = new Set();
  for (const node of Object.values(newTree.nodes)) {
    if (node.id === 'root') continue;
    let best = null;
    let bestScore = 0;
    for (const cand of finished) {
      if (used.has(cand)) continue;
      const exact = normTitle(cand.title) === normTitle(node.title);
      const score = exact ? 1 : titleSimilarity(cand.title, node.title);
      if (score > bestScore) {
        bestScore = score;
        best = cand;
      }
    }
    // 0.6 Jaccard is a rewording of the same subtopic; below that it is a
    // different subtopic and must be earned again.
    if (best && bestScore >= 0.6) {
      used.add(best);
      carried[node.id] = { ...best.prog, carriedFrom: best.title };
    }
  }

  return { progress: carried, count: Object.keys(carried).length };
}
