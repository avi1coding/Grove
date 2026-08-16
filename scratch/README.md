# Tests

No API key needed — `mock.mjs` is a stand-in OpenAI-compatible endpoint, so the
whole pipeline runs offline and for free.

```bash
node scratch/mock.mjs &                     # mock model server on :8799
PORT=3111 GROVE_DATA_DIR=/tmp/grove-test \
  LLM_API_KEY=test LLM_BASE_URL=http://localhost:8799/v1 \
  node server/index.js &                    # app under test on :3111

node scratch/e2e.mjs        # 30 assertions — the full learner arc
node scratch/regress.mjs    # 19 assertions — audit regressions
```
