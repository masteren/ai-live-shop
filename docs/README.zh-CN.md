# AIライブショップ(AI 直播商店)

[日本語](../README.md) | 中文

AI 主播「花奈」在直播中用语音和表情回答评论，观众可以直接下单购买。面向日本市场的直播带货 Web 应用 + iOS 应用。

**公开网址:** https://live.masteren.cloud

<p>
  <img src="images/web_live_2.png" alt="Web 版直播画面" width="62%">
  <img src="images/ios_live_2.png" alt="iOS 版直播画面" width="18%">
  <img src="images/ios_products.png" alt="iOS 版商品列表" width="18%">
</p>

## 功能
- **AI 主播**：用 LLM（OpenAI / Claude）回答评论。价格和库存与数据库核对，不一致时切换为规则回答
- **语音・3D 形象**：配合 VOICEVOX 的语音，three-vrm 形象做口型、表情和眨眼
- **直播**：WebSocket 实时推送评论、在线人数、自动重连
- **电商**：商品 → 购物车 → 支付（模拟）→ 订单。购买会在直播中播报
- **管理后台**：商品和库存管理、销售统计
- **iOS 应用**：SwiftUI，使用同一套 API

## 技术
| | |
|---|---|
| 后端 | Python 3.12 / FastAPI / SQLAlchemy 2.0（async）/ Alembic |
| 数据库 | MySQL 8.4（测试用 SQLite，CI 两种都跑） |
| 前端 | HTML / CSS / JavaScript、three.js + three-vrm |
| iOS | SwiftUI / URLSession / Keychain |
| 部署 | Docker Compose、Nginx、Let's Encrypt |
| 测试 | pytest 123 个、E2E 41 个、XCUITest、GitHub Actions |

## 设计上的考虑
1. **防止并发下单超卖**：用带条件的 UPDATE 扣库存。并发测试发现 SQLite 下行锁不生效、5 人都能买到，据此修正
2. **认证**：Web 用 HttpOnly Cookie + CSRF 令牌，iOS 用 Bearer 令牌。密码用 PBKDF2（60 万次）
3. **不轻信 LLM 的输出**：回答里的金额、折扣率、库存与数据库核对（实际出现过折扣率说错）
4. **外部服务挂了直播也不停**：没有 LLM 就用规则回答，VOICEVOX 停了就只显示文字

## 启动
```bash
python3.12 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
docker compose up -d db
uvicorn app.main:app --reload
```
http://127.0.0.1:8000 （管理后台 `/admin`）。没有 LLM 的密钥也能运行。

测试：`pip install -r requirements-dev.txt && pytest`

## 素材
- 3D 模型：[DeepSeek蓝色大肥鱼](https://www.aplaybox.com/details/model/PIuLwHuG6mKr)（作者 [喜欢看雨OvO](https://space.bilibili.com/135840826)）。因禁止二次配布，仓库中不包含模型文件；没有时使用 pixiv 的 [VRM 示例模型](https://vrm.dev/licenses/1.0/)
- 语音：[VOICEVOX](https://voicevox.hiroshiba.jp/)（ずんだもん）
