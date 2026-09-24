# Host integration

MiCall chạy trong browser. Ngôn ngữ backend chỉ cần render HTML hoặc phục vụ JavaScript; PHP, Java/JSP, .NET/Razor và Python không cần adapter SIP riêng.

## Integration matrix

| Host                          | Entry                       | Event API                        | UI                                |
| ----------------------------- | --------------------------- | -------------------------------- | --------------------------------- |
| TypeScript/ESM                | `@mitek/webrtc`             | `sdk.on()` và `sdk.events`       | Opt-in qua `ui.defaultCallScreen` |
| Plain HTML                    | IIFE bundle                 | `sdk.events`                     | Opt-in giống ESM                  |
| PHP/JSP/Razor/Python template | IIFE bundle được host serve | `sdk.events`                     | Opt-in giống ESM                  |
| React                         | ESM + `@micall/react`       | `useMiCall()` hoặc SDK trực tiếp | Web Component hoặc UI của host    |
| Vue                           | ESM + `@micall/vue`         | `useMiCall()` hoặc SDK trực tiếp | Web Component hoặc UI của host    |

Mọi host dùng cùng `MiCallBrowserSDK`; adapter React/Vue chỉ đồng bộ snapshot theo lifecycle và không tạo state machine khác.

## ESM

```ts
import { createMiCallSDK } from '@mitek/webrtc';

const config = await fetch('/api/micall/runtime-config', {
  credentials: 'same-origin',
}).then((response) => response.json());

const sdk = await createMiCallSDK({
  ...config,
  ui: { defaultCallScreen: true },
  incomingHeaders: { allowlist: ['X-Tenant-Id', 'X-Ticket-Number'] },
});

const unsubscribe = sdk.on('incomingCall', ({ snapshot }) => {
  console.info(
    snapshot.remoteIdentity,
    snapshot.remoteAddress,
    snapshot.metadata['x-ticket-number'],
  );
});

await sdk.start();

// Khi host logout hoặc root unmount:
unsubscribe();
await sdk.destroy();
```

Headless mode là mặc định: bỏ `ui` hoặc đặt `defaultCallScreen: false`. Vì call-screen được dynamic import, headless consumer không tải Lit ở runtime.

Nếu dùng Login API giống SDK Mobile, host gọi `MiCallApiClient.login()`, map bằng `createMiCallConfigFromSipAccount()` rồi mới tạo SDK. Xem [Login API và SIP profile](login-and-sip-profile.md).

## Plain HTML / IIFE

Sau `pnpm build:iife`, deploy file `.iife.js` trong `packages/sdk-web/dist/iife/` như static asset. Có thể đổi tên asset trong pipeline deploy.

```html
<script src="/assets/micall-sdk-web.iife.js"></script>
<button id="unlock-audio">Bật âm thanh</button>
<script>
  let sdk;

  async function startMiCall() {
    const config = await fetch('/api/micall/runtime-config', {
      credentials: 'same-origin',
    }).then((response) => response.json());

    sdk = await globalThis.MiCall.createMiCallSDK({
      ...config,
      ui: { defaultCallScreen: true },
    });

    sdk.events.addEventListener('micall:registration-state-changed', (event) => {
      console.info('Registration:', event.detail.state);
    });
    sdk.events.addEventListener('micall:incoming-call', (event) => {
      console.info('Incoming:', event.detail.callId, event.detail.snapshot.metadata);
    });
    sdk.events.addEventListener('micall:call-ended', (event) => {
      console.info('Ended:', event.detail.reason);
    });
    sdk.events.addEventListener('micall:error', (event) => {
      console.error(event.detail.code, event.detail.message);
    });

    await sdk.start();
  }

  document.querySelector('#unlock-audio').addEventListener('click', async () => {
    console.info(await sdk?.unlockAudio());
  });

  startMiCall();
</script>
```

IIFE chỉ tạo `globalThis.MiCall.createMiCallSDK`. Nếu `globalThis.MiCall` đã thuộc implementation không tương thích, bundle dừng với lỗi rõ ràng thay vì overwrite namespace.

## PHP template

```php
<script src="<?= htmlspecialchars(asset_url('micall-sdk-web.iife.js'), ENT_QUOTES) ?>"></script>
<script>
  // Endpoint yêu cầu session đã đăng nhập và trả credential ngắn hạn.
  const micallConfigEndpoint = <?= json_encode('/api/micall/runtime-config', JSON_HEX_TAG) ?>;
</script>
<script src="/assets/init-micall.js"></script>
```

## Java / JSP

```jsp
<script src="<c:url value='/assets/micall-sdk-web.iife.js' />"></script>
<script>
  const micallConfigEndpoint = '<c:url value="/api/micall/runtime-config" />';
</script>
<script src="<c:url value='/assets/init-micall.js' />"></script>
```

## .NET / Razor

```cshtml
<script src="@Url.Content("~/assets/micall-sdk-web.iife.js")"></script>
<script>
  const micallConfigEndpoint = @Html.Raw(System.Text.Json.JsonSerializer.Serialize(
    Url.Content("~/api/micall/runtime-config")));
</script>
<script src="@Url.Content("~/assets/init-micall.js")"></script>
```

## Python template (Jinja)

```jinja2
<script src="{{ url_for('static', filename='micall-sdk-web.iife.js') }}"></script>
<script>
  const micallConfigEndpoint = {{ url_for('micall_runtime_config') | tojson }};
</script>
<script src="{{ url_for('static', filename='init-micall.js') }}"></script>
```

Trong bốn template trên, `/assets/init-micall.js` dùng nguyên logic Plain HTML/IIFE và thay URL `fetch()` bằng `micallConfigEndpoint`. Backend không xử lý SIP session trong SDK và không cần hiểu event contract ngoài JSON API cấp runtime config.

## React

```tsx
import { useMiCall } from '@micall/react';
import type { MiCallBrowserSDK } from '@mitek/webrtc';

export function PhoneStatus({ sdk }: { sdk: MiCallBrowserSDK }) {
  const { snapshot } = useMiCall(sdk);
  return <output>{snapshot.registrationState}</output>;
}
```

## Vue

```ts
import { useMiCall } from '@micall/vue';

const { snapshot } = useMiCall(sdk);
// template: {{ snapshot.registrationState }}
```

`useMiCall()` tự unsubscribe khi React component unmount hoặc Vue effect scope dispose. Việc `sdk.destroy()` vẫn thuộc ownership của component/service đã tạo SDK.

## Security và lifecycle

- Chỉ chạy production trên HTTPS và kết nối PBX bằng WSS có certificate hợp lệ.
- Không render long-lived SIP password vào HTML, log, URL hoặc browser storage. Ưu tiên authenticated endpoint cấp credential ngắn hạn và giữ trong memory.
- Gắn listener trước `sdk.start()` để không bỏ lỡ registration transition; dùng `sdk.getSnapshot()` nếu attach muộn.
- Gọi `sdk.destroy()` khi logout hoặc host root unmount. `hide()`/`unmount()` Call Screen không kết thúc cuộc gọi.
- Custom `mountTarget` có thể bị ảnh hưởng bởi `overflow`, `transform` và stacking context của host; mặc định mount vào `document.body`.
- `connect-src` trong CSP phải cho phép WSS PBX và endpoint cấu hình; `media-src` phải cho phép ringtone URL nếu dùng asset ngoài origin.
- Background incoming call chỉ best-effort khi page còn sống. Tab bị freeze/discard, mobile background và browser đóng không được đảm bảo.
