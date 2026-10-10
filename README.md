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
- 根路径为 Team28 的预生成评审展示页；上传流程仅在“新建分析”工作台中触发
- 底部比赛数据面板按进攻、防守、效率、比赛状态分 Tab 读取 `GameStatsTimeline`，缺失数据会隐藏而不会由视觉模型猜测
- 导入视频后会提取比分牌 OCR 作为 `videoEvidence`，结合深度数据候选比赛进行身份匹配；未达到多证据确认阈值时不会填充官方比赛统计

## 快速开始

环境要求：Node.js 22+、npm 10+、Python 3.11+。视频渲染开发还需要 `ffmpeg`/`ffprobe`。

```powershell
npm install
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r services\vision\requirements.txt
npm run dev
```

打开 `http://127.0.0.1:5173`。`npm run dev` 会同时启动 Web 和本地视觉服务；首次识别会下载约 6 MB 的检测模型。页面中可直接选择训练视频，数据文件不是必需的。

评审展示页读取预生成的作品产物，不会在页面打开后才开始分析。工作台入口为右上角“新建分析”，也可以直接打开 `http://127.0.0.1:5173/?workspace=1`。准备最终展示产物的方法见 [docs/showcase-publishing.md](docs/showcase-publishing.md)。

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

## 协作与代码约束

本项目由 Team28「红细胞队」共同开发，所有成员和 AI 助手必须遵守以下规则。

### 修改前

- 修改前先执行 `git status --short`。
- 先阅读相关代码、测试和 `docs/architecture.md`。
- 不得覆盖、撤销或重置他人未提交的修改。
- 使用 `apply_patch` 修改源码，不直接用脚本重写文件。

### 架构边界

- `apps/web`：React 前端和交互页面。
- `packages/contracts`：共享数据契约和类型，跨模块数据必须从这里定义。
- `services/vision`：Python 本地视觉检测、跟踪和 OCR。
- `services/agent`：分析规则和模型适配。
- `services/agentcore-runtime`：AWS AgentCore Runtime。
- `services/renderer`：视频叠加和 ffmpeg 脚本生成。
- `infra`：AWS CDK 基础设施。
- `docs`：架构、数据格式和开发记录。

禁止在不同模块之间复制定义相同的数据结构，禁止让前端直接依赖 AWS SDK 或数据库。

### TypeScript 和 React

- 使用 TypeScript 严格模式，禁止使用 `any` 绕过类型检查。
- 使用 2 个空格缩进、双引号、分号和 LF 换行。
- 变量、函数使用 `camelCase`，组件和类型使用 `PascalCase`。
- 复杂数据转换放入独立函数或模块，不在 JSX 中堆积业务逻辑。
- 组件保持单一职责，页面、视频、雷达、统计和问答功能分开维护。
- 优先复用现有组件、工具函数和依赖，不随意引入新框架。
- 所有异步监听器、动画帧、Observer 和临时 URL 必须在组件卸载时清理。

### 数据真实性

- 不得编造比分、球员姓名、命中结果或比赛统计。
- 不得从 `label` 中猜测球衣号码；未确认身份时使用 `T07` 等轨迹编号。
- 没有球场标定时，不得把视频检测框直接当作球场坐标。
- 示例数据必须明确显示“示例数据”。
- 缺失数据必须显示“暂无数据”“未确认”或其他明确空态。
- `0` 是有效数据，不得与缺失值混淆；过期帧不得伪装成当前实时帧。

### AWS 和安全

- AWS 默认区域为 `us-east-1`，只能使用赛事提供的 profile。
- 密钥、Token、账号信息、ARN 和私有配置不得写入代码或提交 Git。
- IAM 遵循最小权限原则，CDK 只负责基础设施，不写业务逻辑。
- 未经确认不得执行生产部署或调用付费模型。
- AWS 不可用时，本地模式仍应能够开发和测试。

### 测试要求

代码修改后根据影响范围执行：

```powershell
npm run typecheck
npm test
npm run test:e2e
npm run build
```

前端修改至少检查桌面端、移动端、视频、时间轴、雷达、统计和空数据状态。修改数据契约、视觉算法或 AWS 基础设施时，必须补充对应测试或验证。

### Git 协作

项目最多维护两个长期分支：

- `main`：稳定版本，仅合并已经验证通过的代码。
- `dev`：日常开发分支；如果任务很小，可以直接在 `dev` 完成。

提交前检查：

```powershell
git status
git diff
git diff --check
```

提交信息统一使用：

```powershell
git commit -m "【问题】问题描述【修改】修改内容"
```

示例：

```powershell
git commit -m "【问题】雷达球员位置与视频不一致【修改】统一使用 NBA 球场世界坐标"
```

每次提交只解决一个相对完整的问题；不得提交密钥、模型权重、原始视频、临时截图和构建产物。不得使用 `git reset --hard` 或 `git checkout --` 覆盖他人修改。

### AI 助手要求

所有 AI 助手必须遵守现有架构和数据契约，不得擅自删除或回退用户代码，不得编造业务数据，不得未经授权部署 AWS 或调用付费服务。修改后必须运行相关测试，并说明修改文件、验证结果和已知限制。
