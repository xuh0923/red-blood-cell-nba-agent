# 开发记录

## 2026-10-09 - 名单身份确认闭环

- 新增可选 Tesseract 多帧球衣号码 OCR：单帧读数不会直接命名，必须经过投票和名单唯一匹配。
- 新增“身份”校验页和本地任务写回接口；人工映射会标记为 `manual`，与 OCR 推断清晰区分。
- Tracking 契约加入身份来源和可供校验的精简名单候选。

## 2026-10-09 - 轨迹稳定性与名单输入

- 使用带外观 ReID 和全局相机运动补偿的 BoT-SORT 替换基础 ByteTrack 配置。
- 新增连续球衣特征和保守的裁判候选规则；裁判候选不进入球队聚类和姓名匹配。
- 新增独立比赛名单 JSON 上传、后端校验和 Tracking v1 名单摘要。
- 新增名单共享契约、可复制 JSON 模板及整理说明。
- 使用训练视频和模板名单完成真实本地任务验证。

## 2026-10-09 - 本地连续视觉第一版

- 新增 FastAPI 本地任务服务，视频和任务状态持久化到 `.local-data`。
- 新增 YOLO 球员/篮球检测与 ByteTrack 连续跟踪，默认按约 10 FPS 分析。
- 新增球衣区域颜色采样与双方球队候选聚类。
- 新增 Tracking v1 共享契约，包含归一化坐标、轨迹摘要和身份置信度。
- Web 本地模式改为真实后台任务，并按视频时间绘制球员框与篮球标记。
- 未确认身份时只显示轨迹编号；姓名识别留给名单、号码 OCR 和阵容约束阶段。
- Python 依赖放入项目 `.venv`，避免系统 Python 与 Anaconda 包冲突。

## 2026-10-08 - 第一版工程骨架

- 建立 npm/TypeScript monorepo。
- 新增 React 操作台、本地视频与数据选择、进度、视频叠加、事件时间轴、依据页和设备预听。
- 新增 Analysis、Job、Metric、DeviceEvent 共享 Zod 契约。
- 新增确定性本地分析器和 Bedrock 分析适配器；本地结果不会标记成 AgentCore。
- 新增 ffmpeg filter script 与命令参数生成器。
- 新增创建任务、预签名上传、查询和启动工作流 API。
- 新增 S3、CloudFront、DynamoDB、API Gateway、Lambda 和 Step Functions CDK 定义。
- Step Functions 保留显式 AgentCore 集成边界，尚未部署正式 AgentCore/Fargate 流水线。
- 只读分析已有 ESP32-S3 项目并确定第一版使用安全 WebSocket；未修改固件。
- 增加 Playwright 桌面完整流程与 390px 手机布局测试，均使用本机 Edge。
- `npm audit` 的应用与测试依赖问题已清除；当前仍有一个来自最新版 `aws-cdk-lib` 内置依赖 `brace-expansion@5.0.9` 的上游告警，本项目不向不可信输入开放该构建工具。

## 2026-10-08 - AgentCore 多模态识别

- 浏览器从真实视频均匀抽取 6 张带时间点的 JPEG 关键帧。
- 上传 API 为视频、数据和关键帧分别生成 S3 预签名 URL。
- 部署正式 Bedrock AgentCore Node.js 22 Runtime，由 Claude Sonnet 4.6 同时分析关键帧和数据。
- Step Functions 调用分析 Worker，结果通过 Zod 契约校验后写入 DynamoDB 和 S3。
- CloudFront 同源代理 `/api/*`，Web 可以轮询真实任务状态。
- 使用 `训练_弗拉格2月1日.mp4` 完成真实云端冒烟测试，端到端耗时约 1.9 分钟。
- 正式地址：`https://dm5e0p6unaw5h.cloudfront.net`。
