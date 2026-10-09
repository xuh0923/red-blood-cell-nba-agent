# CourtVision Agent

红细胞队的 NBA x AWS Hackathon 项目。系统接收一段比赛视频和结构化深度赛场数据，生成可追溯的数据解读、时间轴、画面叠加指令和解说内容，并最终输出带数据可视化的比赛视频。

## 当前能力

- 可在浏览器中选择 MP4、JSON/CSV 深度数据和 JSON 比赛名单，运行持久化的本地视觉任务
- 以 YOLO + BoT-SORT ReID 连续检测球员与篮球，并在播放时同步绘制球员轨迹
- 对连续球衣特征做球队候选聚类，并标出高置信度裁判候选，避免其进入姓名匹配
- 校验比赛名单中的球队、号码、别名和上场时间，为后续号码 OCR 提供姓名约束
- 提供多帧号码 OCR 接口与名单唯一匹配；号码不确定时可在结果页人工确认轨迹，确认来源可追溯
- 展示真实视频、任务进度、关键指标、带时间点的叠加层和分析依据
- 共享并校验 Job、Analysis、Overlay 和外接解说设备协议
- 提供可测试的 Agent 规则分析器与 Bedrock 适配边界
- 生成安全、确定性的 ffmpeg filter script
- CDK 定义 S3、CloudFront、API Gateway、Lambda、DynamoDB 和 Step Functions
- 已部署 Bedrock AgentCore 多模态 Agent，并为 ESP32 解说机器人预留明确接入边界

## 快速开始

环境要求：Node.js 22+、npm 10+、Python 3.11+。视频渲染开发还需要 `ffmpeg`/`ffprobe`。

```powershell
npm install
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r services\vision\requirements.txt
npm run dev
```

打开 `http://127.0.0.1:5173`。`npm run dev` 会同时启动 Web 和本地视觉服务；首次识别会下载约 6 MB 的检测模型。页面中可直接选择训练视频，数据文件不是必需的。

本地视觉结果保存在 `.local-data/jobs/{jobId}`。未确认球员身份时只显示轨迹编号，不会猜测姓名；后续通过比赛名单、号码 OCR 和场上阵容逐步确认。名单格式和可直接复制的模板见 [docs/roster-database-format.md](docs/roster-database-format.md)。

## 验证

```powershell
npm test
npm run test:e2e
npm run typecheck
npm run build
npm run cdk:synth
```

端到端测试默认调用本机 Microsoft Edge，不需要额外下载浏览器。

CDK 部署只允许使用赛事工作 profile 和 `us-east-1`：

```powershell
npm run cdk:deploy -- --profile nba
```

不要执行 `cdk bootstrap`，赛事账号已由主办方完成 bootstrap。

## 目录

```text
apps/web             React 操作台和本地演示工作流
packages/contracts   跨前后端、Agent、渲染器和设备共享的协议
services/api         HTTP API Lambda
services/agent       分析器、Bedrock/AgentCore 适配边界
services/agentcore-runtime  正式多模态 AgentCore Runtime
services/vision      本地连续检测、跟踪与任务持久化服务
services/renderer    ffmpeg 可视化脚本生成器
infra                AWS CDK 基础设施
docs                 架构、规则和开发记录
```

详细设计见 [docs/architecture.md](docs/architecture.md)，外设协议见 [docs/device-integration.md](docs/device-integration.md)。
