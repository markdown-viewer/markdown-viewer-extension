/**
 * Relay routing contract: `__target`.
 *
 * Every platform that hosts more than one listener on one message bus (Chrome's
 * service worker + offscreen document, Firefox's background page, the mobile app's
 * display WebView + hidden render WebView + Dart host services) needs the same
 * thing: a field the receiver can filter on. `src/messaging/routing.ts` names the
 * targets and the two predicates; these cases pin the properties the surfaces rely
 * on:
 *
 *   - the hint lives *outside* the payload, so forwarding never rewrites a message;
 *   - an unaddressed message is never "for" a surface (guessing is how two surfaces
 *     answer the same request);
 *   - the two historical literals are unchanged, because a Chrome or Firefox build
 *     already sends them and both sides of a release are not deployed together;
 *   - on a shared bus, exactly one surface answers.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RenderChannel } from '../../../src/messaging/channels/render-channel';
import { RenderTarget, getRenderTarget, isTargetedAt } from '../../../src/messaging/routing';
import type { MessageTransport, TransportMeta, Unsubscribe } from '../../../src/messaging/transports/transport';

/** A synchronous in-memory bus: everyone registered hears every message. */
class MemoryBus {
  private readonly endpoints = new Map<string, (message: unknown, meta?: TransportMeta) => void>();

  register(name: string, deliver: (message: unknown, meta?: TransportMeta) => void): Unsubscribe {
    this.endpoints.set(name, deliver);
    return () => this.endpoints.delete(name);
  }

  send(from: string, message: unknown): void {
    for (const [name, deliver] of [...this.endpoints]) {
      if (name === from) {
        continue;
      }
      deliver(message, { raw: { from } });
    }
  }

  transportFor(name: string): MessageTransport {
    return {
      send: (message: unknown) => {
        this.send(name, message);
      },
      onMessage: (handler) => this.register(name, handler),
    };
  }
}

describe('routing: the __target hint', () => {
  it('reads the hint only from objects that carry a string', () => {
    assert.equal(getRenderTarget({ __target: 'offscreen' }), 'offscreen');
    assert.equal(getRenderTarget({ __target: 42 }), undefined);
    assert.equal(getRenderTarget({}), undefined);
    assert.equal(getRenderTarget(null), undefined);
    assert.equal(getRenderTarget('{"__target":"offscreen"}'), undefined, 'a raw string is not a parsed message');
  });

  it('never treats an unaddressed message as addressed', () => {
    assert.equal(isTargetedAt({ type: 'PING' }, RenderTarget.RenderView), false);
    assert.equal(isTargetedAt({ type: 'PING', __target: RenderTarget.RenderView }, RenderTarget.RenderView), true);
    assert.equal(isTargetedAt({ type: 'PING', __target: RenderTarget.Display }, RenderTarget.RenderView), false);
  });

  it('keeps the literals Chrome and Firefox already send', () => {
    // Both platforms build and ship separately from the host page that answers
    // them, so these strings are wire format, not an internal detail.
    assert.deepEqual(RenderTarget, {
      Offscreen: 'offscreen',
      BackgroundRender: 'background-render',
      RenderView: 'render-view',
      Display: 'display',
      Host: 'host',
    });
  });
});

describe('routing: envelopes on a shared bus', () => {
  it('carries the target next to the payload, and adds no key when there is none', async () => {
    const wire: Array<Record<string, unknown>> = [];
    const transport: MessageTransport = {
      send: (message: unknown) => {
        wire.push(message as Record<string, unknown>);
      },
      onMessage: () => () => {},
    };
    const channel = new RenderChannel(transport, { source: 'mobile-parent' });
    const payload = { renderType: 'mermaid', input: 'graph TD; A-->B' };

    void channel.send('RENDER_DIAGRAM', payload, { target: RenderTarget.RenderView, timeoutMs: 20 }).catch(() => {});
    void channel.post('SET_THEME_CONFIG', { config: {} }, { target: RenderTarget.RenderView });
    void channel.post('PING', {});

    assert.equal(wire.length, 3);
    assert.equal(wire[0].__target, 'render-view');
    assert.deepEqual(wire[0].payload, payload, 'the payload must be forwarded untouched');
    assert.equal(wire[0].source, 'mobile-parent');
    assert.equal(wire[1].__target, 'render-view');
    // No target, no key: a message that predates routing stays byte-identical.
    assert.equal('__target' in wire[2], false);
  });

  it('lets exactly one of several surfaces answer', async () => {
    const bus = new MemoryBus();
    const parent = new RenderChannel(bus.transportFor('parent'), { source: 'parent', timeoutMs: 100 });
    const surface = new RenderChannel(bus.transportFor('render-view'), {
      source: 'mobile-render-view',
      acceptRequest: (message) => isTargetedAt(message, RenderTarget.RenderView),
    });
    const otherSurface = new RenderChannel(bus.transportFor('offscreen'), {
      source: 'offscreen',
      acceptRequest: (message) => isTargetedAt(message, RenderTarget.Offscreen),
    });

    surface.handle('RENDER_DIAGRAM', async (payload) => ({ answered: 'render-view', payload }));
    otherSurface.handle('RENDER_DIAGRAM', async () => ({ answered: 'offscreen' }));

    const answer = (await parent.send(
      'RENDER_DIAGRAM',
      { renderType: 'mermaid' },
      { target: RenderTarget.RenderView },
    )) as { answered: string; payload: unknown };

    assert.equal(answer.answered, 'render-view');
    assert.deepEqual(answer.payload, { renderType: 'mermaid' });

    // The other surface still answers its own target, and nobody answers an
    // unaddressed request (there is nothing that says who should).
    const other = (await parent.send('RENDER_DIAGRAM', {}, { target: RenderTarget.Offscreen })) as { answered: string };
    assert.equal(other.answered, 'offscreen');
    await assert.rejects(
      parent.send('RENDER_DIAGRAM', {}, { timeoutMs: 50 }),
      /Message timeout: RENDER_DIAGRAM/,
    );
  });
});
