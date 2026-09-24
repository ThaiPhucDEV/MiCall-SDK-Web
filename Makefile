.PHONY: help version clean build build-packages build-iife pack deploy publish release

# Tự động trích xuất version hiện tại từ packages/sdk-web/package.json
VERSION := $(shell node -p "require('./packages/sdk-web/package.json').version")

# Lệnh hiển thị trợ giúp khi gõ `make`
help:
	@echo "================================================================"
	@echo "   MiCall SDK Web (@mitek/webrtc) - Build & Deploy Management"
	@echo "================================================================"
	@echo "  make version      : Xem version hiện tại của SDK"
	@echo "  make clean        : Xóa sạch thư mục dist và file nén .tgz tạm"
	@echo "  make build        : Build an toàn (Đã bật Minify, Tắt Sourcemap)"
	@echo "  make pack         : Đóng gói ra file .tgz (chuẩn phân phối nội bộ)"
	@echo "  make deploy       : Build -> Git add -> Commit -> Tag -> Push Git"
	@echo "  make publish      : Build -> Publish trực tiếp lên NPM Registry"
	@echo "================================================================"

# In ra version hiện tại
version:
	@echo "Version hiện tại: $(VERSION)"

# 1. Dọn dẹp các thư mục build cũ
clean:
	@echo ">>> Đang dọn dẹp các bản build và file tạm..."
	rm -rf packages/*/dist packages/*/*.tgz *.tgz
	@echo "✔ Đã dọn dẹp sạch sẽ!"

# 2. Build toàn bộ packages (Bảo mật: Minified, Sourcemap OFF)
build-packages:
	pnpm build:packages

# 3. Build bundle IIFE (Bảo mật: Minified, Sourcemap OFF)
build-iife:
	pnpm build:iife

# 4. Gộp toàn bộ quá trình build (tự động clean trước khi build)
build: clean build-packages build-iife
	@echo "✔ Build hoàn tất thành công! (Bảo mật: Minified ON, Sourcemap OFF)"

# 5. Đóng gói ra file .tgz chuẩn NPM để gửi khách hàng hoặc upload GitHub Releases
pack: build
	@echo ">>> Đang đóng gói package @mitek/webrtc..."
	pnpm --filter @mitek/webrtc pack
	@echo "✔ Đã tạo file: mitek-webrtc-$(VERSION).tgz"

# 6. Deploy lên Git (Build -> Add -> Commit -> Tag -> Push)
deploy: build
	@echo ">>> Bắt đầu deploy version: v$(VERSION)..."
	git add .
	git commit -m "chore(release): bump version to $(VERSION)" || echo "ℹ Không có thay đổi mới để commit."
	@if git rev-parse "v$(VERSION)" >/dev/null 2>&1; then \
		echo "⚠ Tag v$(VERSION) đã tồn tại. Bỏ qua bước tạo tag."; \
	else \
		git tag -a "v$(VERSION)" -m "Release version $(VERSION)"; \
		echo "✔ Đã tạo Git Tag: v$(VERSION)"; \
	fi
	@echo ">>> Đang push code và tag lên GitHub..."
	git push origin main --follow-tags
	@echo "✔ Deploy thành công phiên bản v$(VERSION) lên GitHub!"

# 7. Publish trực tiếp lên NPM Registry (yêu cầu chạy 'npm login' trước đó)
publish: build
	@echo ">>> Đang publish @mitek/webrtc v$(VERSION) lên NPM Registry..."
	pnpm --filter @mitek/webrtc publish --no-git-checks
	@echo "✔ Đã publish thành công lên NPM! Bất kỳ ai cũng có thể: npm i @mitek/webrtc"

# Alias cho lệnh deploy
release: deploy
