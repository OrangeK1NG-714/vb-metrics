# vb-metrics — 统一使用人数看板

一个零依赖的本地看板服务，汇总工作区四个产品（GreenPoly、宠物 MBTI、证件照小程序、FollowMate）的**匿名**使用数据，按项目看每日活跃人数（DAU）、新增和事件数。

只统计聚合的匿名指标：不采集 IP、姓名、邮箱等任何个人信息。各端未配置上报地址时静默 no-op。

## 本地运行

```bash
cd metrics
npm start                 # http://localhost:8787
# 可选：PORT=9000 METRICS_DB=/path/to.sqlite npm start
```

服务默认只监听 `127.0.0.1`。生产环境或显式设置 `METRICS_HOST=0.0.0.0` 时，必须同时设置至少 32 字节的 `METRICS_ADMIN_TOKEN`；看板会要求输入令牌，令牌只保存在当前页面内存中。跨域采集来源使用逗号分隔的 HTTPS origin 配置 `METRICS_ALLOWED_ORIGINS`，反向代理场景才设置 `METRICS_TRUST_PROXY=true`，并必须用防火墙阻止绕过代理直连源站。

```bash
METRICS_HOST=0.0.0.0 \
METRICS_ADMIN_TOKEN='<32+ byte random secret>' \
METRICS_ALLOWED_ORIGINS='https://greenpoly.com,https://pet.example.com' \
npm start
```

数据库默认落在 `metrics/data/metrics.sqlite`（已在 .gitignore 忽略）。

## 测试

```bash
npm test                  # DAU 去重口径、payload 校验、HTTP 端点
```

## 上报协议

各产品 `POST /api/collect`，body：

```json
{ "project": "pet-mbti", "event": "open", "anonId": "<匿名浏览器/设备id>", "props": {} }
```

- `project`：`greenpoly | pet-mbti | id-photo | followmate`（白名单，其它一律 400）
- `event`：任意 ≤64 字符事件名；算「使用人数」用 `open`/`active` 即可
- `anonId`：客户端生成的稳定匿名 ID（Web 存 localStorage，桌面端存本地）——用于去重算人数，**不含任何 PII**
- 兼容 GreenPoly/pet-mbti 现有 analytics 的 `{ siteId, anon_id, properties }` 字段别名

## 接口

- `POST /api/collect` — 收集一条事件
- `GET  /api/summary?days=30` — 按 `(project, 日期)` 聚合的 `{ dau, newUsers, events }`
- `GET  /health`
- `GET  /` — 看板页面

## 口径说明

- **DAU** = 当天去重 `anonId` 数
- **新增** = 首次出现（历史第一天）落在当天的 `anonId`
- **事件数** = 当天原始事件总数
- 「天」按运行机器的本地日历日切分

## 各端接入状态

- ✅ **pet-mbti**：`site-config.js` 指向本地 endpoint，`analytics.js` 已带匿名 anonId
- ✅ **greenpoly**：`src/lib/tracking.ts` 镜像上报，读 `NEXT_PUBLIC_METRICS_ENDPOINT`，未配置则跳过
- ✅ **id-photo**：`server/metricsReporter.js` 后端埋点（process=open、pay/confirm=paid），读 `METRICS_ENDPOINT`，openid 经 hash 不落 PII
- ✅ **followmate**：`telemetry.js` + 托盘「发送匿名使用统计」开关，**默认关闭**，读 `FOLLOWMATE_METRICS_ENDPOINT`

### 各端如何指向看板

| 项目 | 配置位置 | 值 |
|---|---|---|
| pet-mbti | `pet-mbti/site-config.js` → `analytics.endpoint` | `http://localhost:8787/api/collect` |
| greenpoly | 环境变量 `NEXT_PUBLIC_METRICS_ENDPOINT` | `http://localhost:8787/api/collect` |
| id-photo | 环境变量 `METRICS_ENDPOINT`（server） | `http://localhost:8787/api/collect` |
| followmate | 环境变量 `FOLLOWMATE_METRICS_ENDPOINT` + 托盘勾选开启 | `http://localhost:8787/api/collect` |
