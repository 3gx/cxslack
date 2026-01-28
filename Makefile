.PHONY: setup setup-tools verify-tools test test-watch test-coverage sdk-test all-test dev build start clean help

help:
	@echo "Available commands:"
	@echo "  make setup         - Install npm dependencies"
	@echo "  make setup-tools   - Verify native dependencies"
	@echo "  make verify-tools  - Verify all dependencies"
	@echo "  make dev           - Development server"
	@echo "  make build         - Build TypeScript"
	@echo "  make start         - Run production server"
	@echo "  make test          - Run unit tests (parallel)"
	@echo "  make sdk-test      - Run App-Server live tests"
	@echo "  make all-test      - Run all tests"
	@echo "  make clean         - Remove build artifacts"

# Install all dependencies
setup:
	npm install

# Verify native tools/dependencies
setup-tools:
	@echo "Verifying Codex CLI is installed..."
	@which codex || (echo "ERROR: Codex CLI not found. Install from https://github.com/openai/codex" && exit 1)
	@codex --version
	@echo "Done!"

# Verify native tools are installed
verify-tools:
	@echo "Verifying dependencies..."
	@echo ""
	@echo "1. Checking Node.js..."
	@node --version || (echo "ERROR: Node.js not found" && exit 1)
	@echo "   OK"
	@echo ""
	@echo "2. Checking npm..."
	@npm --version || (echo "ERROR: npm not found" && exit 1)
	@echo "   OK"
	@echo ""
	@echo "3. Checking Codex CLI..."
	@which codex || (echo "ERROR: Codex CLI not found" && exit 1)
	@codex --version
	@echo "   OK"
	@echo ""
	@echo "All checks passed!"

# Run unit/mock tests (excludes live SDK tests)
# Configure parallel workers with JOBS=n (default 4)
JOBS ?= 4
test:
	npx vitest run --exclude='src/__tests__/sdk-live/**' --maxWorkers=$(JOBS)

# Run all tests (unit + live SDK)
all-test:
	npm run test:all

# Run tests in watch mode
test-watch:
	npm run test:watch

# Run tests with coverage
test-coverage:
	npm run test:coverage

# Run SDK live tests in parallel (default 4 workers, configure with SDKJOBS=n)
# Uses --silent to suppress console.log, 90s timeout
SDKJOBS ?= 4
sdk-test:
	npx vitest run src/__tests__/sdk-live/ --silent --testTimeout=90000 --maxWorkers=$(SDKJOBS)

# Development server
dev:
	npm run dev

# Build TypeScript
build:
	npm run build

# Start production server
start:
	npm run start

# Clean build artifacts
clean:
	rm -rf dist coverage
