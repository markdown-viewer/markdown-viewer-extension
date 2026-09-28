// Suite group: render-surface relay protocol (mobile hidden render WebView).
//
// Two layers, both device-free:
//   1. the framing layer (`src/messaging/relay-chunking.ts`) — the bound that
//      keeps a diagram result from being dropped by Android's Binder-sized
//      JavaScript bridge, plus the `__target` routing table the surfaces
//      address each other with;
//   2. the browser contract for the built render surface, which needs
//      `npm run build:mobile` (the suite skips, loudly, when the bundle is
//      missing so it cannot pass by accident).
import './chunking.test.ts';
import './routing.test.ts';
import './surface-relay.test.ts';
