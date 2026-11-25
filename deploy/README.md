# サーバへの配置(https://live.masteren.cloud)

## 構成
```
利用者 ──HTTPS──▶ Nginx(サーバに直接インストール済み。証明書は Let's Encrypt)
                    │  127.0.0.1:8010
                    ▼
              ┌ Docker(deploy/compose.yml) ───────────┐
              │ app      FastAPI(uvicorn 1プロセス)   │
              │ db       MySQL 8.4(外に公開しない)    │
              │ voicevox VOICEVOX ENGINE(外に公開しない)│
              └─────────────────────────────────────┘
```
- Nginx はサーバにもともとあるものを使い、サイト設定を1つ追加するだけ(ほかのサイトと同居)。
- アプリのポートは `127.0.0.1` にだけ公開し、外から直接は届かない。
- 秘密情報はサーバの `/opt/ai-live-commerce/.env` だけに置く(Git に入れない)。

| ファイル | 役割 |
|---|---|
| `../Dockerfile` | アプリのイメージ |
| `compose.yml` | アプリ・MySQL・VOICEVOX をまとめて起動 |
| `env.example` | サーバの `.env` の見本 |
| `nginx/live.masteren.cloud.conf` | Nginx のサイト設定(WebSocket を通す) |
| `deploy.sh` | Mac からサーバへ送って起動し直す |

## 初回だけ
1. DNS に `live` の A レコード(サーバの IP)を追加する
2. サーバに `/opt/ai-live-commerce/.env` を作る(`env.example` を見本に。パスワードは `openssl rand -hex 24`)
3. 証明書を取る:サーバ全体で1枚(`masteren.cloud`。主ドメイン・www・fridge・tavern・live を含む)
   `sudo certbot certonly --nginx --cert-name masteren.cloud -d masteren.cloud -d www.masteren.cloud -d fridge.masteren.cloud -d tavern.masteren.cloud -d live.masteren.cloud`
   (サブドメインを増やすときは、同じコマンドに `-d` を足して実行し直す)
4. `nginx/live.masteren.cloud.conf` を `/etc/nginx/sites-available/` に置き、`sites-enabled/` にリンク → `sudo nginx -t && sudo systemctl reload nginx`

## 更新するとき(毎回)
```bash
git commit ...           # 送るのはコミット済みの内容だけ
./deploy/deploy.sh       # コードを送り、コンテナを作り直す。DB と音声キャッシュはボリュームに残る
```
3D モデル(`app/static/models/custom/host.vrm`)は作者の許可を得て非商用に限り Git に入れている。`deploy.sh` が手元のファイルをサーバの `/opt/ai-live-commerce/models/host.vrm` へ送り(内容が変わったときだけ)、コンテナには読み取り専用で見せる。サーバにないときは pixiv のサンプルモデルで表示される。

## よく使うコマンド(サーバで)
```bash
cd /opt/ai-live-commerce/src/deploy
docker compose --env-file ../../.env -f compose.yml ps          # 状態
docker compose --env-file ../../.env -f compose.yml logs -f app # ログ
docker stats --no-stream                                         # メモリ・CPU
```

## 注意
- 2026-11-16 に masteren.online から masteren.cloud へ移った。旧ドメインは停止(Nginx の設定のバックアップはサーバの /etc/nginx.bak.2026-11-16)。
- `name: ai-live-commerce-server` は開発用の docker-compose.yml と分けるため。同じ名前にすると、ローカルで試したときに開発用の DB とボリュームを共有してしまう(実際に一度起きた)。
- `docker compose down -v` はデータ(DB・音声)を消すので使わない。
- 公開版は OpenAI を使うので、OpenAI の管理画面で月ごとの利用上限を設定しておく。
