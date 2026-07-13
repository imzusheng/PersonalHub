import { describe, expect, it } from 'vitest';
import { TaskStore } from '../../../src/core/domain/task-store.js';

describe('TaskStore persistence restore', () => {
  it('restores the original task identity and terminal state', () => {
    const store = new TaskStore();
    store.restore({
      taskId: 'persisted-task-id', capability: 'image.describe', pluginId: 'vision.mock',
      input: { imageUrl: 'file://test.png' }, status: 'succeeded', output: { description: 'done' }, error: null,
      createdAt: '2026-07-13T00:00:00.000Z', updatedAt: '2026-07-13T00:01:00.000Z',
    });
    expect(store.findById('persisted-task-id')).toMatchObject({ status: 'succeeded', output: { description: 'done' } });
  });
});
