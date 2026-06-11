# ARENA STRIKE relay server (phase 1)

ルームコード方式のオンライン対戦リレーサーバー。各クライアントが送る `PLAYER_STATE` を
保持し、20tick/s で `WORLD_STATE` をブロードキャストする中継方式（権威物理はフェーズ2）。

## ローカル起動

```bash
cd ~/game2-server
npm install
npm run dev          # tsx watch。ws://localhost:8080 で待受
```

- ヘルスチェック: `curl http://localhost:8080/health` → `ok`
- クライアント（~/game2）は既定で `ws://localhost:8080` に接続する。

## ビルド・本番起動

```bash
npm run build        # tsc → dist/
npm run start        # node dist/index.js（PORT は環境変数、既定8080）
```

## Railway デプロイ（別サービス）

1. このフォルダを GitHub の新規リポジトリへ push する（`git init` 済み）。
2. Railway で New Project → Deploy from GitHub repo → このリポジトリを選択。
3. `railway.toml` の設定（build: `npm run build` / start: `npm run start` /
   healthcheck `/health`）が自動で使われる。Railway が割り当てる `PORT` を読む。
4. 発行された公開URLの WebSocket（`wss://<your-app>.up.railway.app`）を、
   ~/game2 側のビルド時環境変数 `VITE_WS_URL` に設定する。
   （Vite なので `VITE_WS_URL=wss://... npm run build` のように渡す）

## メッセージ仕様

`src/netTypes.ts` を参照。クライアント側 `~/game2/src/online/netTypes.ts` と同一内容。
