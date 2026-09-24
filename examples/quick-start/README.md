# MiCall SDK Web quick-start

Example chỉ giữ luồng tích hợp chính:

```text
email/password
  → POST /api-portal/api/v1/loginCti
  → Vite proxy chuyển đến https://api-portal-02.mipbx.vn/api/v1/loginCti
  → decode SIP profile
  → createMiCallSDK()
  → SIP REGISTER
  → gọi và nhận cuộc gọi bằng default call screen
```

## Chạy example

Từ thư mục `micall-sdk-web`:

```bash
pnpm example
```

Sau đó mở URL do Vite hiển thị, nhập tài khoản và bấm **Đăng nhập**. Khi trạng thái
`Registration` là `registered`, nhập extension đích và bấm **Gọi**.

Không mở trực tiếp `index.html`: Vite dev server cung cấp proxy `/api-portal` để tránh
trình duyệt chặn cross-origin request.

## Khi tích hợp vào host app

Vite proxy chỉ phục vụ local development. Host app ở production cần reverse proxy cùng origin,
ví dụ:

```text
https://your-app.example.com/api-portal/api/v1/loginCti
  → https://api-portal-02.mipbx.vn/api/v1/loginCti
```

Không log hoặc lưu email, password, access token, SIP password và TURN credential vào browser
storage. Example xóa password input ngay sau khi Login API hoàn tất.

Nút **Bật chuông & thông báo** thực hiện hai thao tác trong cùng một user gesture:

- Mở khóa ringtone/call audio theo autoplay policy. Quick-start không truyền `ringtoneUrl`, qua đó
  kiểm chứng ringtone MP3 mặc định được đóng gói cùng SDK.
- Yêu cầu quyền Web Notifications. Khi incoming call đến trong tab đang `hidden`, system
  notification cho phép người dùng click để focus lại tab và thao tác trên default Call Screen.

Browser không cho JavaScript tự động chuyển người dùng sang tab MiCall. Cơ chế này chỉ là best
effort khi runtime của tab còn hoạt động, không thể đánh thức tab đã freeze/discard/đóng như
native push notification.

Browser tự quản lý WebSocket `Origin` và `Host`; PBX phải cho phép origin của Web app.
