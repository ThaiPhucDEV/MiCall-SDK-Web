.PHONY: help version build build-packages build-iife deploy release

# Tự động đọc version từ packages/sdk-web/package.json
VERSION := $(shell node -p "require('./packages/sdk-web/package.json').version")

# Lệnh mặc định khi gõ 'make'
help:
	@echo "=========================================="
	@echo "  MiCall SDK Web - Build & Deploy Tool"
	@echo "=========================================="
	@echo "  make version          : Xem version hiện tại của SDK"
	@echo "  make build            : Build packages (ESM) + Bundle IIFE"
	@echo "  make deploy           : Build -> Git add -> Commit -> Tag -> Push"
	@echo "=========================================="

# Xem version hiện tại
version:
	@echo "Version hiện tại của SDK: $(VERSION)"

# 1. Build toàn bộ packages
build-packages:
	pnpm build:packages

# 2. Build bundle IIFE
build-iife:
	pnpm build:iife

# 3. Gộp cả 2 bước build
build: build-packages build-iife
	@echo "✔ Build hoàn tất thành công cho version $(VERSION)!"

# 4. Deploy: tự động build, commit với version hiện tại, đánh tag và push lên Git
deploy: build
	@echo ">>> Bắt đầu deploy version: v$(VERSION)..."
	git add .
	git commit -m "chore(release): bump version to $(VERSION)" || echo "ℹ Không có thay đổi mới để commit."
	@if git rev-parse "v$(VERSION)" >/dev/null 2>&1; then \
		echo "⚠ Tag v$(VERSION) đã tồn tại trên máy. Bỏ qua bước tạo tag."; \
	else \
		git tag -a "v$(VERSION)" -m "Release version $(VERSION)"; \
		echo "✔ Đã tạo Git Tag: v$(VERSION)"; \
	fi
	@echo ">>> Đang push code và tag lên GitHub..."
	git push origin main --follow-tags
	@echo "✔ Deploy thành công phiên bản v$(VERSION) lên GitHub!"

# Alias cho lệnh deploy
release: deploy
