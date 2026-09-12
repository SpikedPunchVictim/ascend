// Arm B: the same work through oclif. Startup cost only; the body is trivial
// by construction so the measurement isolates the framework.
import { Command, Args } from '@oclif/core';
import { recordOne } from '../../../work.mjs';

export default class Record extends Command {
  static args = {
    dbPath: Args.string({ required: true }),
  };

  async run() {
    const { args } = await this.parse(Record);
    recordOne(args.dbPath, {
      type: 'review-completed',
      properties: { stage: 'implementation', verdict: 'approved' },
      recordedAt: '2026-09-11T00:00:00.000Z',
    });
  }
}
