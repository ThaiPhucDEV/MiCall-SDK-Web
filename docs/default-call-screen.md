# Default Call Screen

Default Call Screen là Web Component Lit opt-in dùng cùng snapshot/event contract với headless SDK. Package không tự đăng ký custom element khi import và không import SIP.js.

```ts
const sdk = await createMiCallSDK({
  ...config,
  ui: {
    defaultCallScreen: true,
    loggingEnabled: false,
    tagName: 'micall-call-screen',
    theme: {
      '--micall-color-primary': '#2563eb',
    },
    slots: {
      'brand-logo': 'Acme Voice',
      footer: 'Internal support line',
    },
  },
});
```

`ui.loggingEnabled` bật/tắt log của Call Screen với prefix `[MiCall:UI]`. Giá trị mặc định là
`true` để giữ tương thích với cảnh báo UI ở các phiên bản trước; đặt `false` nếu host không muốn
ghi log UI ra browser console.

Host cũng có thể bật/tắt trong runtime cho Call Screen hiện tại:

```ts
const callScreen = sdk.getCallScreen();
if (callScreen !== undefined) {
  callScreen.element.logger.enabled = false;
}
```

UI có view incoming, outgoing, active và ended; mini-bar; mute, hold, DTMF, blind transfer, audio device switcher và Unlock Audio. Chỉ báo bốn cột đo chất lượng media WebRTC: xanh là ổn định, cam là trung bình, đỏ là yếu và xám khi chưa đủ dữ liệu. Tổng lưu lượng audio nhận và gửi được hiển thị ngay dưới cột sóng theo KB/s. `Escape` chỉ thu nhỏ, không hangup.

Khi nhận cuộc gọi, UI đọc trạng thái quyền Microphone nếu browser hỗ trợ Permissions API.
Nút **Nghe** thực hiện microphone preflight trong user gesture và chỉ accept SIP sau khi lấy quyền
thành công. Nếu quyền đang ở trạng thái `prompt`, browser sẽ hiện permission dialog. Nếu người
dùng đã chọn `Block`, browser có thể không hiện lại dialog; UI giữ cuộc gọi ở trạng thái ringing
và hướng dẫn bật Microphone trong Site Settings rồi bấm **Nghe** lại. Stream dùng để kiểm tra
quyền được stop ngay và không được dùng làm media stream của cuộc gọi.

Khi tab đang `hidden` và quyền Web Notifications đã được host cấp, incoming call tạo một
system notification không chứa số điện thoại hoặc caller identity. Bấm notification sẽ yêu cầu
browser focus lại tab và mở Call Screen. Component không tự gọi
`Notification.requestPermission()` vì browser yêu cầu thao tác chủ động của người dùng.

```ts
// Gọi trực tiếp từ click/tap handler do host quản lý.
await Notification.requestPermission();
```

## Lifecycle

```ts
const callScreen = sdk.getCallScreen();
callScreen?.hide(); // chỉ ẩn UI
callScreen?.show(); // đồng bộ snapshot rồi hiện lại
callScreen?.unmount(); // gỡ DOM, không hangup
callScreen?.mount(); // mount lại vào target cũ/body
callScreen?.destroy(); // cleanup listener/timer/node của UI
```

`sdk.destroy()` tự destroy handle đã attach. Duplicate handle trên cùng SDK instance bị bỏ và cleanup, không tạo overlay thứ hai.

## Theme và isolation

Internal UI nằm trong Shadow DOM, dùng `:host { all: initial }` và không inject CSS vào `document.head`. Host có thể đặt CSS custom properties `--micall-*`; `ui.theme` được apply inline và có precedence cao hơn CSS host thông thường.

Nếu dùng `mountTarget` tùy chỉnh, kiểm tra `overflow`, `transform` và stacking context của target. Shadow DOM không thể bảo vệ custom-element host trước CSS cố ý nhắm trực tiếp vào tag hoặc browser top layer.

## Accessibility

- Controls có accessible label, focus-visible state và keyboard operation.
- Incoming call đưa focus vào dialog; khi đóng/ẩn UI sẽ restore focus nếu target cũ còn tồn tại.
- Tab được giữ trong expanded call controls; `Escape` chuyển sang mini-bar.
- Animation tắt gần như hoàn toàn khi `prefers-reduced-motion: reduce`.
- Reconnect, hold, audio unlock, device empty, error và ended state được thông báo qua live region/status phù hợp.
