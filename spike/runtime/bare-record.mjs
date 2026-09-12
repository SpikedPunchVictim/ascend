// Arm A: bare Node cold start. No CLI framework.
import { recordOne } from './work.mjs';

recordOne(process.argv[2], {
  type: 'review-completed',
  properties: { stage: 'implementation', verdict: 'approved' },
  recordedAt: '2026-09-11T00:00:00.000Z',
});
