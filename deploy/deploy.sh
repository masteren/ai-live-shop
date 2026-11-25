#!/usr/bin/env bash
# Mac からサーバへ配置する:コミット済みのコードを送り、コンテナを作り直す
#   ./deploy/deploy.sh            (接続先は ~/.ssh/config の tencent。別の名前なら第1引数で)
# サーバに GitHub の認証情報を置かないよう、git pull ではなく git archive で送る。
# サーバ側の置き場所は /opt/ai-live-commerce(src/ がコード、.env が秘密情報)
set -euo pipefail
HOST="${1:-tencent}"

cd "$(git rev-parse --show-toplevel)"
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "注意:コミットしていない変更があります(送るのはコミット済みの内容だけです)" >&2
fi
echo "== 送信: $(git log --oneline -1)"
git archive --format=tar --prefix=src.new/ HEAD | ssh "$HOST" 'set -e
  cd /opt/ai-live-commerce
  test -f .env || { echo "/opt/ai-live-commerce/.env がありません(deploy/env.example を見本に作る)" >&2; exit 1; }
  if [ -d src.new ]; then rm -r src.new; fi
  tar -x
  if [ -d src.old ]; then rm -r src.old; fi
  if [ -d src ]; then mv src src.old; fi
  mv src.new src'
# 3D モデルを別に送る(手元にあり、サーバと違うときだけ)
MODEL=app/static/models/custom/host.vrm
ssh "$HOST" 'mkdir -p /opt/ai-live-commerce/models'
if [ -f "$MODEL" ]; then
  if [ "$(shasum -a 256 < "$MODEL" | cut -d' ' -f1)" != "$(ssh "$HOST" 'sha256sum /opt/ai-live-commerce/models/host.vrm 2>/dev/null | cut -d" " -f1')" ]; then
    echo "== 3D モデルを送信"
    scp -q "$MODEL" "$HOST:/opt/ai-live-commerce/models/host.vrm"
  fi
fi
echo "== 起動"
ssh "$HOST" 'cd /opt/ai-live-commerce/src/deploy && docker compose --env-file ../../.env -f compose.yml up -d --build --remove-orphans && docker compose --env-file ../../.env -f compose.yml ps'
