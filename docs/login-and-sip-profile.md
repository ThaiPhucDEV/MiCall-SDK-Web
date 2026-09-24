# Login API và SIP profile

`@mitek/webrtc` cung cấp API client tương thích luồng `loginCti` của MiCall SDK Mobile Flutter. Login và SIP registration vẫn là hai giai đoạn riêng: Login API trả profile, sau đó host tạo SDK và gọi `start()` để REGISTER.

```ts
import {
  MiCallApiClient,
  createMiCallConfigFromSipAccount,
  createMiCallSDK,
} from '@mitek/webrtc';

const api = new MiCallApiClient();
const session = await api.login({ email, password });
const sipConfig = createMiCallConfigFromSipAccount(session.sipAccount);

const sdk = await createMiCallSDK({
  ...sipConfig,
  ui: { defaultCallScreen: true },
});

sdk.on('registrationStateChanged', ({ state }) => {
  if (state === 'registered') showSoftphone();
});

await sdk.start();
```

## Decode contract

`success.data` được decode theo đúng thứ tự:

1. Base64 + UTF-8 decode ba vòng.
2. Split bằng separator `b6aed9ab7cdf85432c321757b4d48153`.
3. Chỉ lấy sáu segment đầu và Base64 + UTF-8 decode từng segment.
4. Map thành `domain`, `port`, `proxy`, `extension`, `password`, `transport`.

Decoder giới hạn kích thước profile và số segment, reject UTF-8/Base64 lỗi và chỉ trả error message an toàn. Đây là encoding/obfuscation để tương thích backend, không phải encryption.

## SIP mapping

| Web SDK config               | SIP account                |
| ---------------------------- | -------------------------- |
| `sip.wssServer`              | `wss://{proxy}:{port}/wss` |
| `sip.uri`                    | `sip:{extension}@{domain}` |
| `sip.authorizationUsername`  | `extension`                |
| `sip.authorizationPassword`  | `password`                 |
| `sip.displayName`            | `extension`                |
| `sip.registerExpiresSeconds` | `600` mặc định             |
| `rtc.iceServers[0].urls`     | `transport`                |
| TURN username                | `extension`                |
| TURN credential              | `password`                 |

## Browser boundary

Mobile SIP stack có thể đặt WebSocket `Origin` và `Host`; browser JavaScript không được phép thay đổi hai header này. Browser tự gửi page origin, vì vậy PBX/WSS reverse proxy phải allow origin của Web app.

PushKit/FCM Contact parameter không áp dụng cho Web SDK. DTMF vẫn tuân theo Web contract: RTP RFC 2833/4733 trước, SIP INFO là fallback.

## Session data và bảo mật

Login session còn có thể chứa `accessToken`, `deviceRegistrationSecret` và `userLogId`. SDK parse và trả các field này để host dùng cho API lifecycle sau này, nhưng không tự persist hoặc log chúng. `createMiCallConfigFromSipAccount()` chỉ dùng SIP account, không đưa token/device secret vào signaling.

Production phải dùng HTTPS. Nếu host không muốn browser gọi trực tiếp MiCall API, backend host có thể proxy Login API; response `success.data` vẫn dùng cùng decoder.
