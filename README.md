# MiCall SDK Web

Browser SDK cho SIP/WebRTC voice call, được tổ chức dưới dạng pnpm monorepo.

Các package npm dùng ESM. Consumer không có bundler dùng IIFE browser bundle; SDK không công bố CommonJS entry point.

Specification và implementation plan nằm trong [`../docs-dev/`](../docs-dev/).

Tài liệu runtime: [state machine](docs/state-machine.md),
[background support](docs/browser-background-support.md) và
[M2 voice controls](docs/voice-controls.md) và
[host integration](docs/host-integration.md),
[default call screen](docs/default-call-screen.md) và
[login/SIP profile](docs/login-and-sip-profile.md).

## Environment

- Node.js 24.15.0
- pnpm 12.5.1
- TypeScript 6.0.3

## Workspace packages

- `@micall/core`
- `@micall/sipjs-browser`
- `@micall/call-screen`
- `@mitek/webrtc`
- `@micall/react`
- `@micall/vue`

## Quick start

```ts
import { createMiCallSDK } from '@mitek/webrtc';

const sdk = await createMiCallSDK({
  sip: {
    uri: 'sip:1001@pbx.example.com',
    wssServer: 'wss://pbx.example.com/ws',
    authorizationUsername: '1001',
    authorizationPassword: credentialFromAuthenticatedEndpoint,
  },
  incomingHeaders: {
    allowlist: ['X-Tenant-Id', 'X-Ticket-Number'],
  },
  ui: {
    defaultCallScreen: true,
  },
});

sdk.on('incomingCall', ({ callId, snapshot }) => {
  showIncomingCall(callId, snapshot.remoteIdentity, snapshot.metadata);
});

sdk.events.addEventListener('micall:call-ended', (event) => {
  const detail = (event as CustomEvent).detail;
  console.info(detail.callId, detail.reason);
});

await sdk.start();
```

Không hardcode SIP credential trong HTML. Host nên lấy credential ngắn hạn từ authenticated endpoint và chỉ giữ trong memory.

## Runnable apps

```bash
pnpm example
pnpm --filter @micall/playground dev
```

Quick-start có màn hình email/password, gọi `loginCti`, decode SIP profile tương thích Flutter, REGISTER tự động rồi mở softphone. Playground vẫn cho phép nhập SIP config thủ công để debug PBX độc lập với Login API. Cả hai không persist credential.

## Browser và PBX requirements

- Production page phải dùng HTTPS; SIP transport phải là `wss://` với certificate hợp lệ. `localhost` chỉ dành cho development.
- Browser cần WebRTC, WebSocket, microphone permission và secure context. SDK feature-detect audio output selection; browser không có `setSinkId()` vẫn gọi được nhưng không đổi được loa bằng code.
- Ringtone có thể bị Autoplay Policy chặn cho đến khi người dùng bấm **Unlock Audio**.
- PBX test account phải hỗ trợ SIP REGISTER qua WSS, WebRTC audio negotiation, RTP `telephone-event` cho DTMF và SIP INFO fallback nếu cần.
- Blind transfer cần PBX hỗ trợ REFER/NOTIFY theo policy đã mô tả trong tài liệu voice controls.

Không cam kết nhận call như native app khi chạy nền. Đổi tab desktop là best-effort khi page/WSS còn sống; tab frozen/discarded, browser đóng hoặc mobile background không được đảm bảo. Xem [background support](docs/browser-background-support.md).

## Build outputs

```bash
pnpm build
pnpm build:iife
```

IIFE nằm trong `packages/sdk-web/dist/iife/` và expose `globalThis.MiCall.createMiCallSDK`. Namespace có version guard và không overwrite global không tương thích.

## Versioning

Repository dùng Changesets để quản lý Semantic Versioning cho các workspace package.

```bash
pnpm changeset
pnpm version:packages
pnpm release:packages
```

Mỗi thay đổi public API cần có changeset tương ứng. `pnpm version:packages` cập nhật version và changelog; chỉ chạy `pnpm release:packages` sau khi package validation và clean-room consumer test đã pass. Playground và quick-start dùng `workspace:^` để giữ semantic range khi package được đóng gói.
