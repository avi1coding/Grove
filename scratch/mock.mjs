// Mock Featherless-compatible endpoint: replies per pipeline stage.
import http from 'node:http';

const parseChunks = (text) => {
  const out = [];
  const re = /\[([^\]\s]+)\] \(source: ([^)]*)\)\n([\s\S]*?)(?=\n\n---\n\n\[|\n*$)/g;
  let m;
  while ((m = re.exec(text))) out.push({ id: m[1], source: m[2], text: m[3].trim() });
  return out;
};

const words = (t, n) => t.split(/\s+/).slice(0, n).join(' ');

http
  .createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const payload = JSON.parse(body);
      const sys = payload.messages.find((m) => m.role === 'system')?.content || '';
      const user = payload.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
      let content;

      if (sys.includes('with no other material')) {
        content = JSON.stringify({ missing_context: false, what_is_missing: 'none', reason: 'self-contained' });
      } else if (sys.includes('check quiz questions against a source excerpt')) {
        content = JSON.stringify({
          your_answer: '1',
          matches_marked_answer: true,
          supported_by_excerpt: true,
          self_contained: true,
          reason: 'stated verbatim',
        });
      } else if (sys.includes('judge whether a set of source excerpts')) {
        content = JSON.stringify({ verdict: 'sufficient', missing: '', suggestion: '' });
      } else if (sys.includes('grade a short free-text answer')) {
        content = JSON.stringify({ correct: true, note: 'matches the reference' });
      } else if (sys.includes('curriculum architect') && user.includes('"topic"')) {
        content = JSON.stringify({
          topic: { title: 'Photosynthesis', summary: 'How plants convert light to chemical energy.' },
          subtopics: Array.from({ length: 6 }, (_, i) => ({
            title: `Subtopic ${i + 1}`,
            summary: `Covers part ${i + 1}.`,
            key_concepts: ['chlorophyll', 'ATP', 'stroma'],
            evidence_chunk_ids: [],
          })),
        });
      } else if (sys.includes('curriculum architect')) {
        content = JSON.stringify({
          subtopics: Array.from({ length: 4 }, (_, i) => ({
            title: `Leaf ${i + 1}`,
            summary: `Deep part ${i + 1}.`,
            key_concepts: ['thylakoid'],
          })),
        });
      } else if (sys.includes('quiz questions strictly from provided source excerpts')) {
        const chunks = parseChunks(user);
        const n = Number(user.match(/Write (\d+) question/)?.[1] || 5);
        const qs = Array.from({ length: n }, (_, i) => {
          const c = chunks[i % chunks.length];
          const snippet = words(c.text, 14);
          return {
            concept: `concept ${i}`,
            type: 'mcq',
            prompt: `Question ${Math.random().toString(36).slice(2, 7)} about ${words(c.text, 4)}?`,
            options: ['right answer', 'wrong 1', 'wrong 2', 'wrong 3'],
            answer_index: 0,
            difficulty: 2,
            explanation: 'Stated in the snippet.',
            citations: [{ chunk_id: c.id, snippet }],
          };
        });
        content = JSON.stringify({ questions: qs });
      } else {
        content = 'A short generated text response for hints or micro-lessons.';
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }], usage: { total_tokens: 123 } }));
    });
  })
  .listen(8799, () => console.log('mock up on 8799'));
