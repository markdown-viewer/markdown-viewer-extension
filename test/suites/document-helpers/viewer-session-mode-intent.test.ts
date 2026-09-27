/**
 * The session's mode-intent rules.
 *
 * Pinned here because a click can arrive before the first document does: the
 * viewer wires its toolbar as soon as the markup exists (so the buttons are not
 * dead while the page boots), and the open that follows must not discard what
 * the user just asked for.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { createViewerSession } from '../../../src/core/viewer/viewer-session.ts';
import type { ViewerDocumentDescriptor } from '../../../src/core/viewer/viewer-session-contract.ts';

function markdownDoc(documentKey = 'file:///tmp/doc.md'): ViewerDocumentDescriptor {
  return {
    documentKey,
    displayName: documentKey.split('/').pop() ?? 'doc.md',
    format: 'markdown',
    sourceToggleSupported: true,
    containerMode: 'browser',
    embedded: false,
  };
}

function codeDoc(): ViewerDocumentDescriptor {
  return {
    documentKey: 'file:///tmp/notes.txt',
    displayName: 'notes.txt',
    format: 'code',
    language: 'plaintext',
    sourceToggleSupported: false,
    containerMode: 'browser',
    embedded: false,
  };
}

describe('viewer session mode intent', () => {
  it('honours a source toggle clicked before the first document', () => {
    const session = createViewerSession();

    session.dispatch({ type: 'toggle-mode-intent' });
    session.dispatch({ type: 'open-document', document: markdownDoc(), content: '# Hi\n' });

    const snapshot = session.getSnapshot();
    assert.strictEqual(snapshot.modeIntent, 'source');
    assert.strictEqual(snapshot.resolvedMode, 'source');
  });

  it('prefers a persisted per-file intent over the pre-open click', () => {
    const session = createViewerSession();

    session.dispatch({ type: 'toggle-mode-intent' });
    session.dispatch({
      type: 'open-document',
      document: markdownDoc(),
      content: '# Hi\n',
      persistedState: { modeIntent: 'rendered' },
    });

    assert.strictEqual(session.getSnapshot().modeIntent, 'rendered');
  });

  it('keeps the intent per document once a document is loaded', () => {
    const session = createViewerSession();

    session.dispatch({ type: 'open-document', document: markdownDoc('file:///tmp/a.md'), content: '# A\n' });
    session.dispatch({ type: 'toggle-mode-intent' });
    assert.strictEqual(session.getSnapshot().modeIntent, 'source');

    session.dispatch({ type: 'open-document', document: markdownDoc('file:///tmp/b.md'), content: '# B\n' });
    assert.strictEqual(
      session.getSnapshot().modeIntent,
      'rendered',
      'the next file starts in the default mode',
    );
  });

  it('ignores a source intent for a document that cannot show source view', () => {
    const session = createViewerSession();

    session.dispatch({ type: 'toggle-mode-intent' });
    session.dispatch({ type: 'open-document', document: codeDoc(), content: 'plain\n' });

    assert.strictEqual(session.getSnapshot().resolvedMode, 'code-reading');
  });
});
