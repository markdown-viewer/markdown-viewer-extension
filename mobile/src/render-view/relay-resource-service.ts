/**
 * Render-surface resource access.
 *
 * The render surface cannot read files or extension assets itself (iOS gives a
 * WKWebView read access only to the directory it was loaded from, and Android
 * blocks file:// reads from a file:// page), so every resource request goes to
 * the host through the relay — the same shape Chrome's offscreen document gets
 * for free by sharing the extension origin.
 */

import type { RenderChannel } from '../../../src/messaging/channels/render-channel';
import { RenderTarget } from '../../../src/messaging/routing';
import type { ResourceService } from '../../../src/services';

type RelayChannel = Pick<RenderChannel, 'send'>;

export class RelayResourceService implements ResourceService {
  constructor(private readonly channel: RelayChannel) {}

  getURL(path: string): string {
    // No direct URL exists across the relay: callers must go through fetch().
    return path;
  }

  async fetch(path: string): Promise<string> {
    const response = (await this.channel.send(
      'FETCH_ASSET',
      { path },
      { target: RenderTarget.Host },
    )) as { content?: string } | string;

    if (typeof response === 'string') {
      return response;
    }
    if (response && typeof response.content === 'string') {
      return response.content;
    }
    throw new Error(`Resource fetch returned no content: ${path}`);
  }
}
