# Developer entry points. `make help` lists them.
.PHONY: help install build test test-deep test-ts fmt lint gas snapshot slither chain history api web check-web demo up down e2e docs

help:
	@grep -E '^[a-z-]+:.*## ' Makefile | awk -F':.*## ' '{printf "  %-12s %s\n", $$1, $$2}'

install: ## install submodules + node workspace
	git submodule update --init --recursive
	pnpm install

build: ## compile contracts and export typed ABIs
	forge build
	node scripts/export-abis.mjs

test: ## all Solidity tests (unit, fuzz, invariant, scenario, ERC-4626 properties)
	forge test

test-deep: ## heavier fuzz/invariant profile
	FOUNDRY_PROFILE=deep forge test

test-ts: ## simulator + backend unit tests + frontend typecheck/build
	pnpm --filter @dnv/simulator test
	pnpm --filter @dnv/backend test
	pnpm --filter @dnv/frontend typecheck
	pnpm --filter @dnv/frontend build

fmt: ## format Solidity
	forge fmt

lint: ## Solidity lint (production code)
	forge lint

gas: ## gas report in isolated-transaction mode
	forge test --match-contract GasBenchmarksTest --gas-report --isolate

snapshot: ## update .gas-snapshot
	forge snapshot --match-contract GasBenchmarksTest --isolate

slither: ## static analysis
	slither . --config-file slither.config.json

chain: ## (re)start the project's Anvil on :8555 and deploy
	./scripts/local-chain.sh

history: ## replay 90 days of synthetic market through the contracts (needs chain + postgres)
	pnpm --filter @dnv/backend exec tsx src/index.ts history 90 6

api: ## run API + indexer + keeper
	pnpm --filter @dnv/backend start

web: ## run the dashboard on :3010 (needs the API)
	pnpm --filter @dnv/frontend dev

check-web: ## browser checks against a running stack: render all 10 pages + drive the depositor flow
	./scripts/check-frontend.sh
	pnpm --filter @dnv/frontend test:e2e

demo: ## the 16-step scripted demo on an isolated chain
	./scripts/demo.sh

up: ## full stack in Docker
	docker compose up --build

down:
	docker compose down -v

e2e: ## end-to-end: fresh chain + history + backend integration tests
	./scripts/e2e.sh

docs: ## regenerate docs/openapi.json
	pnpm --filter @dnv/backend openapi
