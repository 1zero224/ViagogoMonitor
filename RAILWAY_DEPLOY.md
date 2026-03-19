# Viagogo Inventory Monitor 部署上线文档

本文档面向当前仓库的实际实现，覆盖以下内容：

- 部署架构与运行方式
- Supabase 侧准备
- 飞书机器人侧准备
- Railway 部署步骤
- 环境变量配置
- 定时任务配置
- 首次上线验证
- 常见故障排查
- 回滚与变更建议

当前文档基于仓库现状编写。当前系统使用的是：

- Supabase 持久化
- 飞书机器人 Webhook 告警
- `puppeteer-real-browser`
- Dockerfile 构建
- Railway 外部调度的一次性 runner 模式

## 1. 系统架构

### 1.1 运行模型

本项目不是常驻 Web 服务，而是一次性执行的抓取任务：

1. 进程启动
2. 加载配置
3. 读取监控目标
4. 打开 Viagogo 页面并抓取 `index-data`
5. 生成 inventory snapshot
6. 从 Supabase 读取上一份 snapshot
7. 计算 diff
8. 写入当前 snapshot
9. 发送飞书机器人告警
10. 进程退出

这意味着上线时应该把它当成“可重复触发的任务”，而不是“长期监听的 API 服务”。

### 1.2 目标来源

支持两种目标模式：

#### 直连模式

通过环境变量或命令行直接指定 Viagogo 事件 URL：

- `EVENT_URLS`
- `node index.js --url "..."`

适合：

- 首次上线验证
- 单个演出快速试跑
- 不想依赖 `vgg_links` 初始化的场景

#### 数据库模式

从 `vgg_links` 读取目标。

适合：

- 多目标持续运行
- 需要用 `artist` / `country` 做过滤
- 已有目标管理流程

## 2. 上线前准备

### 2.1 Git 仓库与代码版本

建议上线前确认：

1. 目标分支已经包含当前 inventory monitor 改造
2. `npm test` 本地通过
3. [docs/supabase-schema.sql](./docs/supabase-schema.sql) 已经在目标 Supabase 项目执行

### 2.2 外部依赖

部署前需要准备：

- 一个可用的 Supabase 项目
- 一个可写入目标表的 `SUPABASE_ANON_KEY`
- 一个可用的飞书群机器人 Webhook
- 一个可访问 Viagogo 的 Railway 运行环境

### 2.3 Node / 容器前提

仓库要求：

- Node.js `>=20`

但 Railway 当前使用 Dockerfile 构建，所以实际上生产运行依赖由 [Dockerfile](./Dockerfile) 提供：

- `node:20-bullseye-slim`
- Chromium
- Xvfb
- Linux 浏览器运行所需系统库

## 3. Supabase 侧准备

### 3.1 必须已有的表

当前实现假设数据库中已有：

- `public.vgg_links`

原因：

- 数据库模式要从 `vgg_links` 读取目标
- 兼容缓存会写回 `vgg_links.previousprices`
- [docs/supabase-schema.sql](./docs/supabase-schema.sql) 里的 `vgg_inventory_snapshots.link_id` 外键依赖 `vgg_links.id`

如果 `public.vgg_links` 不存在，运行 schema 时会失败。

### 3.2 执行 schema

在 Supabase 控制台中：

1. 打开项目
2. 进入 `SQL Editor`
3. 新建一个 query
4. 复制 [docs/supabase-schema.sql](./docs/supabase-schema.sql) 全部内容
5. 点击 `Run`

它会创建：

- `public.vgg_inventory_snapshots`
- `public.vgg_inventory_diffs`
- 相应索引

### 3.3 建表后验证

执行下面的 SQL：

```sql
select tablename
from pg_tables
where schemaname = 'public'
  and tablename in ('vgg_inventory_snapshots', 'vgg_inventory_diffs', 'vgg_links');
```

预期结果：

- 至少能看到 `vgg_links`
- 能看到 `vgg_inventory_snapshots`
- 能看到 `vgg_inventory_diffs`

### 3.4 建议检查字段

数据库模式下，建议确认 `vgg_links` 至少具备这些字段：

- `id`
- `url`
- `name`
- `artist`
- `country`
- `location`
- `date`
- `imageUrl`
- `previousprices`
- `last_checked`

如果你的表结构与此不一致，需要先对齐再上线。

## 4. 飞书机器人侧准备

### 4.1 创建群机器人

你需要一个飞书群机器人，并拿到它的自定义机器人 Webhook 地址。

当前实现只需要 Webhook URL，不需要单独的 Bot Token / Channel ID。

### 4.2 当前实现使用的变量

必填变量：

- `FEISHU_BOT_WEBHOOK_URL`

兼容别名：

- `FEISHU_WEBHOOK_URL`

代码优先读取 `FEISHU_BOT_WEBHOOK_URL`，如果没有再回退到 `FEISHU_WEBHOOK_URL`。

### 4.3 最小验证

在上线前建议先确认：

- Webhook 地址是完整 URL
- 群机器人处于可用状态
- 该群允许机器人发消息

## 5. Railway 部署方案

### 5.1 为什么推荐 Railway

当前仓库已经具备：

- [Dockerfile](./Dockerfile)
- [railway.json](./railway.json)
- 一次性任务模型

很适合 Railway 的：

- Dockerfile 构建
- 手动部署
- Cron Job 调度

### 5.2 当前 Railway 配置

[railway.json](./railway.json) 当前定义了：

- 使用 Dockerfile 构建
- 启动命令为：

```bash
xvfb-run --auto-servernum --server-args=-screen 0 1920x1080x24 node index.js
```

这和 [Dockerfile](./Dockerfile) 里的浏览器运行方式保持一致，避免 Linux 下直接裸跑 `node index.js` 时缺少虚拟显示环境。

### 5.3 新建 Railway 项目

1. 登录 Railway
2. 点击 `New Project`
3. 选择 `Deploy from GitHub repo`
4. 选择当前仓库
5. 等待 Railway 读取仓库配置

### 5.4 首次部署建议

第一次上线建议不要直接接生产多目标数据库模式，而是：

1. 先用直连模式
2. 先只监控 1 个事件 URL
3. 先关闭不必要的 diff 持久化
4. 先人工观察 1 到 3 次运行日志

原因很简单：

- 反爬是否稳定需要 live 验证
- 飞书机器人 Webhook 是否可用需要 live 验证
- Supabase 表权限需要 live 验证

## 6. 环境变量配置

在 Railway 的 `Variables` 页面配置。

### 6.1 必填变量

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your_supabase_anon_key
FEISHU_BOT_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/your-webhook-token
```

### 6.2 推荐默认值

```env
MONITOR_MODE=inventory
ALERT_ON_STOCK_APPEAR=true
ALERT_ON_STOCK_DROP=true
ALERT_ON_PRICE_CHANGE=false
MIN_TICKET_DELTA=1
MAX_DIFF_ITEMS_IN_ALERT=10
WRITE_PREVIOUSPRICES_CACHE=true
PERSIST_DIFFS=false
DUMP_RAW_PAYLOAD_ON_FAILURE=false
```

### 6.3 直连模式示例

如果你要先做单事件试跑：

```env
EVENT_URLS=https://www.viagogo.com/Concert-Tickets/Rock/E-159436715?quantity=2
```

这个模式下可以暂时不依赖 `vgg_links` 读取目标，但历史表和飞书告警仍然会照常工作。

### 6.4 数据库模式示例

如果你要从 `vgg_links` 读取：

```env
MONITOR_MODE=inventory
ARTIST_FILTER=
COUNTRY_FILTER=
EVENT_URLS=
```

说明：

- `EVENT_URLS` 为空时，程序会走数据库模式
- `ARTIST_FILTER` / `COUNTRY_FILTER` 可空
- 如果填写过滤器，会只抓取匹配的 `vgg_links`

### 6.5 调优变量

以下变量只在你有明确需要时再调：

```env
NAVIGATION_TIMEOUT_MS=80000
JSON_INTERCEPT_TIMEOUT_MS=15000
SECTION_MAP_TIMEOUT_MS=15000
BETWEEN_TARGET_DELAY_MIN_MS=10000
BETWEEN_TARGET_DELAY_MAX_MS=20000
RAW_PAYLOAD_DUMP_DIR=./debug-payloads
```

建议：

- 不要一上来就把 timeout 调得很小
- 不要一开始就把抓取间隔调得过于密集

## 7. 目标配置策略

### 7.1 推荐上线顺序

建议按这个顺序上线：

1. 单 URL 直连模式
2. 单条 `vgg_links` 数据库模式
3. 多条 `vgg_links`
4. 打开 `PERSIST_DIFFS=true`

### 7.2 `vgg_links` 最小样例

数据库模式建议至少有一条可用数据，且 `url` 不为空。

如果你需要自己插入一条测试数据，逻辑上至少应包含：

- `url`
- `name`
- 可选的 `artist`
- 可选的 `country`
- 可选的 `location`
- 可选的 `date`
- 可选的 `imageUrl`

### 7.3 何时使用直连模式

以下场景优先直连模式：

- 首次验证部署链路
- 排查某个具体演出是否抓得到
- 想隔离 `vgg_links` 数据质量问题

## 8. 定时任务配置

### 8.1 运行原则

当前进程是一次性任务，所以定时调度应交给 Railway Cron Job 或其他外部调度器。

不要在代码里再套一层常驻循环。

### 8.2 Railway Cron Job 配置

在 Railway 中：

1. 点击 `New`
2. 选择 `Cron`
3. 绑定到当前服务
4. 计划表达式按频率配置

推荐频率：

- `*/10 * * * *`
  - 每 10 分钟一次
  - 推荐作为初始生产值
- `*/5 * * * *`
  - 每 5 分钟一次
  - 只在确认 Viagogo 侧稳定时再使用
- `0 * * * *`
  - 每小时一次
  - 适合低频观察

### 8.3 频率选择建议

如果目标数量较少：

- 从 `*/10 * * * *` 开始

如果目标数量较多：

- 先从 `0 * * * *` 或 `*/15 * * * *` 开始

原因：

- 浏览器抓取成本高于普通 API 轮询
- Viagogo 反爬行为不可预测
- 多目标高频运行会放大失败率

## 9. 首次上线流程

### 9.1 推荐最小上线流程

1. 在 Supabase 执行 schema
2. 在 Railway 创建项目
3. 配置 3 个必填变量
4. 额外设置一个 `EVENT_URLS`
5. 手动触发一次部署或一次运行
6. 检查 Railway 日志
7. 检查 Supabase 新表是否写入数据
8. 检查飞书群是否收到告警

### 9.2 首次上线时的预期行为

第一次成功运行时：

- 会写入 `vgg_inventory_snapshots`
- 如果没有上一份 snapshot，通常**不会发送 inventory alert**

这是正常行为，不是故障。

因为当前逻辑只有在“存在 previous snapshot 且 diff 非空”时才发飞书告警。

### 9.3 第二次运行验证

建议至少跑两次：

- 第一次：建立 baseline snapshot
- 第二次：验证 previous snapshot 读取、diff 计算、告警过滤链路

## 10. 上线验收清单

上线完成后，至少验证以下项目：

### 10.1 Railway

- 构建成功
- 启动成功
- 日志里没有缺失环境变量错误
- 日志里没有浏览器启动失败

### 10.2 Supabase

- `vgg_inventory_snapshots` 有新增行
- 如果启用了 `PERSIST_DIFFS=true`，`vgg_inventory_diffs` 有新增行
- 数据库模式下，`vgg_links.last_checked` 有更新
- 数据库模式下，`vgg_links.previousprices` 有更新

### 10.3 飞书机器人

- Webhook 配置正确
- 有变化时能收到 grouped alert 文本消息

### 10.4 业务逻辑

- 同一快照重复运行时不会重复发相同告警
- 无上一份 snapshot 时不会误发告警
- 目标 URL 不可用时会明确报错，不会静默当成“无变化”

## 11. 运行后检查 SQL

### 11.1 检查最近快照

```sql
select id, event_id, event_url, captured_at, source
from public.vgg_inventory_snapshots
order by captured_at desc
limit 20;
```

### 11.2 检查最近 diff

```sql
select id, event_id, captured_at, change_count, alert_sent
from public.vgg_inventory_diffs
order by captured_at desc
limit 20;
```

### 11.3 检查数据库模式缓存回写

```sql
select id, url, last_checked, previousprices
from public.vgg_links
order by last_checked desc nulls last
limit 20;
```

## 12. 常见故障排查

### 12.1 缺失环境变量

日志特征：

- `Missing required environment variables`

处理：

- 检查 `SUPABASE_URL`
- 检查 `SUPABASE_ANON_KEY`

### 12.2 `index-data intercept timeout`

含义：

- 页面打开了，但在超时时间内没有成功截获包含 `#index-data` 的 HTML

处理顺序：

1. 先确认目标 URL 是否有效
2. 再检查 Viagogo 是否返回了挑战页
3. 必要时调大 `JSON_INTERCEPT_TIMEOUT_MS`
4. 必要时开启 `DUMP_RAW_PAYLOAD_ON_FAILURE=true`

### 12.3 `Missing venueConfiguration or rowPopupData`

含义：

- 抓到的 payload 结构和当前 parser 假设不一致

处理：

1. 开启 `DUMP_RAW_PAYLOAD_ON_FAILURE=true`
2. 复跑单 URL
3. 分析 dump 出来的 payload
4. 再修 parser

### 12.4 飞书告警发送失败

现象：

- 运行继续
- 但不会发通知

处理：

- 检查 `FEISHU_BOT_WEBHOOK_URL`
- 检查 Webhook 是否仍然有效
- 检查飞书群机器人是否被禁用

### 12.5 历史快照写入失败

现象：

- 日志里会提示 snapshot insert 失败

处理：

- 检查 Supabase RLS / policy
- 检查 `SUPABASE_ANON_KEY` 是否有对应表写权限
- 检查 `vgg_inventory_snapshots` 是否已创建

### 12.6 数据库模式下读不到目标

现象：

- 日志显示 `No targets found`

处理：

- 检查 `vgg_links` 是否有数据
- 检查 `url` 是否为空
- 检查 `ARTIST_FILTER` / `COUNTRY_FILTER` 是否过窄
- 检查是否误设置了 `EVENT_URLS`

## 13. 回滚策略

### 13.1 文档与配置回滚

如果只是 Railway 变量或 cron 频率配置错误：

- 直接改回旧变量
- 不需要改数据库结构

### 13.2 代码回滚

如果上线后发现抓取逻辑不稳定：

1. 回滚到上一个稳定镜像或上一个稳定 commit
2. 保留 `vgg_inventory_snapshots` 表
3. 继续用已有快照做诊断

因为历史表是追加写入，保留它通常比删除它更有价值。

### 13.3 不建议的做法

不要在没有备份和验证的情况下：

- 删除 `vgg_links`
- 删除 `vgg_inventory_snapshots`
- 删除 `vgg_inventory_diffs`
- 清空 `previousprices`

## 14. 生产建议

### 14.1 第一阶段建议

生产初期建议：

- 使用直连模式或极少量数据库目标
- `PERSIST_DIFFS=false`
- `ALERT_ON_PRICE_CHANGE=false`
- Cron 频率从 10 分钟起步

### 14.2 第二阶段建议

稳定后再考虑：

- 打开 `PERSIST_DIFFS=true`
- 扩大 `vgg_links` 目标数
- 缩短 Cron 间隔
- 打开 `DUMP_RAW_PAYLOAD_ON_FAILURE=true` 仅用于问题排查

### 14.3 监控重点

重点看三类日志：

- 浏览器/页面抓取失败
- Supabase 写入失败
- 飞书告警发送失败

因为这三类问题分别对应：

- 上游反爬
- 持久化失败
- 告警出口失败

## 15. 推荐上线顺序总结

最稳妥的上线顺序是：

1. 先执行 [docs/supabase-schema.sql](./docs/supabase-schema.sql)
2. 再部署 Railway 服务
3. 先配置最小必需变量
4. 先用 `EVENT_URLS` 做单 URL 验证
5. 再切到 `vgg_links` 数据库模式
6. 最后再提高频率、扩大目标数、打开可选 diff 持久化

如果你只是想最快跑通一次，最小闭环是：

1. Supabase 建表
2. 配置 3 个必填变量
3. 配置一个 `EVENT_URLS`
4. 手动运行一次
5. 看 Railway 日志、Supabase 快照表、飞书群三处结果
