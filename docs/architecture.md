# 本地系统架构

## 目标

系统在一台开发机上完成“视频 + 比赛资料 -> 连续视觉跟踪 -> 可视化分析结果”的闭环。浏览器负责素材选择、结果展示和交互；本地 FastAPI 服务负责视频任务和视觉推理；TypeScript 规则分析器负责从已加载资料生成可追溯事件。

## 数据流

```text
浏览器
  | multipart 视频 / JSON / CSV
  v
本地视觉服务 :8787
  | YOLO + BoT-SORT + OCR
  v
.local-data/jobs/{jobId}
  | tracking.json + job.json
  v
浏览器同步视频时间、球员框、篮球、雷达和统计面板
  |
  +--> 本地规则分析器：资料字段 -> 结构化事件 / 解说 / 证据
```

## 模块边界

- `apps/web`：React 操作台、视频播放、跟踪叠加、球场雷达、统计、问答和身份确认。
- `services/vision`：FastAPI 本地任务服务，执行 YOLO 检测、BoT-SORT 跟踪、球衣特征、可选 OCR 和结果持久化。
- `services/agent`：无网络的确定性分析器，只读取用户上传的结构化资料，不推断缺失指标。
- `packages/contracts`：跨模块共享的 Zod 契约和类型。
- `services/renderer`：生成安全的 ffmpeg 可视化脚本参数。
- `docs`：架构、数据格式和变更记录。

## 真实性边界

视觉跟踪输出的是画面中的轨迹和检测置信度，不等于官方球员身份或比赛统计。只有名单、号码 OCR 或人工确认提供足够证据时才显示姓名；没有资料的指标保持空态。没有球场标定时，不能把视频框直接当成标准球场坐标。

## 本地任务生命周期

1. Web 将视频和可选资料以 multipart 请求发送到本地服务。
2. 服务创建 UUID 任务并保存到 `.local-data/jobs/{id}/input`。
3. 后台线程持续写入状态、进度和 `tracking.json`。
4. Web 轮询任务状态，完成后读取跟踪结果，并按视频时间同步显示。
5. 身份确认通过本地接口写回任务，不依赖外部数据库。

## 静态作品展示

`apps/web/public/showcase` 包含可提交的本地展示产物：视频、分析 JSON、跟踪 JSON、统计 JSON 和 manifest。根路径只读取这些静态文件，不启动识别、不访问网络服务；`scripts/prepare-showcase.mjs` 可从本地完成任务重新生成它们。

## 已移除的边界

当前版本不包含 AWS SDK、CDK、S3、DynamoDB、CloudFront、API Gateway、Step Functions、Bedrock/AgentCore、云端轮询或外接设备模块。若未来重新引入远端能力，应在独立适配层中实现，并保证本地路径可独立运行。
