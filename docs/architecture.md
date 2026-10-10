# 混合系统架构

## 目标

系统保留可独立运行的本地精确识别，同时用少量 AWS 托管服务承担大文件存储、线上视觉基线、播放转码与公开分发。AgentCore 不在视频主链路中，避免模型网络等待阻塞上传和识别。

## 数据流

```text
浏览器 --4 路分片直传--> S3 原始视频与资料
  |                         |
  |                         +--> Rekognition Video -> tracking.json
  |                         +--> MediaConvert -> fast-start 1080p MP4
  |                         +--> CloudFront -> 清晰、可拖动的公开播放
  +--> API Gateway/Lambda -> DynamoDB 任务状态

本地模式：浏览器 -> FastAPI -> YOLO + BoT-SORT + OCR -> .local-data
```

## 模块边界

- `apps/web`：React 操作台、视频播放、跟踪叠加、球场雷达、统计、问答和身份确认。
- `services/vision`：FastAPI 本地任务服务，执行 YOLO 检测、BoT-SORT 跟踪、球衣特征、可选 OCR 和结果持久化。
- `services/api`：生成 S3 预签名分片、启动 Rekognition/MediaConvert、维护任务状态。
- `infra`：用 CDK 声明 S3、CloudFront、DynamoDB、Lambda、Step Functions 与事件回调。
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

## AWS 使用边界

S3 保存原视频、深度数据、关键帧、轨迹、分析结果和播放版；DynamoDB 不保存大 JSON。Rekognition 是通用云端基线，不能可靠命名 NBA 球员；具体姓名仍需球衣号码、多帧投票和名单约束。进攻路线必须先做球场线检测、单应性标定和相机运动补偿，未标定时不把画面坐标伪装成球场坐标。AgentCore 资源暂时保留兼容性，但不进入上传、识别、转码主流程。外接设备模块继续禁止。

## 2026-10-10：最小 AWS 托管链路

- 恢复浏览器到 S3 的 Multipart Upload，超过 16 MiB 使用 8 MiB 分片和 4 路并发。
- Step Functions 只编排 Rekognition 连续视觉、确定性资料分析和 MediaConvert，不再等待 AgentCore。
- MediaConvert 输出 fast-start 1080p H.264/AAC MP4，CloudFront 通过私有 S3 OAC 分发 `media/*`。
- EventBridge 在转码完成后更新 DynamoDB，公开页面只播放已完成媒体，不边分析边卡住播放器。
- 原视频以 SHA-256 命名去重；深度数据、训练视频和结果长期保留，仅自动清理未完成分片。
