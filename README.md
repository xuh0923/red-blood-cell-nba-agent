# CourtVision Agent

红细胞队 Team28 的 NBA 视频分析项目。系统采用本地精确识别与 AWS 托管处理并存的混合架构：本地使用 YOLO + BoT-SORT，线上使用 S3、Rekognition Video、MediaConvert、DynamoDB 和 CloudFront 完成直传、连续视觉基线、播放优化与作品发布。

## 当前能力

- 浏览器上传 MP4/MOV 与可选 JSON/CSV 比赛资料
- 本地视觉服务连续检测球员、篮球并同步绘制跟踪框和球场雷达
- 支持名单约束、号码 OCR 接口和本地人工身份确认
- 从资料中读取 xFG、引力、胜负影响和比赛统计；缺失字段保持空态，不编造数据
- 本地规则分析器生成结构化事件、证据、解说提示和结果页问答
- `public/showcase` 提供不依赖后端的静态作品展示
- 大视频通过 8 MiB 分片、4 路并发直传 S3；失败只重传当前分片
- MediaConvert 生成 fast-start 1080p MP4，CloudFront 支持缓存、拖动和范围请求
- 深度数据、训练视频、轨迹与分析结果持久化在 S3，DynamoDB 只保存任务索引

## 快速开始

环境要求：Node.js 22+、npm 10+、Python 3.11+、ffmpeg/ffprobe。

```powershell
npm install
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r services\vision\requirements.txt
npm run dev
```

打开 `http://127.0.0.1:5173`，进入“素材导入”上传视频。`npm run dev` 会同时启动 React 前端和本地视觉服务；首次识别会下载 YOLO 模型。任务文件保存在 `.local-data/jobs/{jobId}`。

本地根路径读取 `apps/web/public/showcase`；部署后的根路径优先读取 AWS 作品库，失败时自动回退到静态展示。需要更新本地展示内容时运行：

```powershell
npm run showcase:prepare -- --job <本地任务UUID> --analysis <分析JSON路径>
```

## 验证

```powershell
npm run typecheck
npm test
npm run build
npm run test:e2e
```

本地测试不需要 AWS 凭证。部署前另运行 `$env:AWS_PROFILE="nba"; npm run synth` 检查基础设施模板。

## 目录

```text
apps/web             React 操作台、作品展示和本地工作流
packages/contracts   跨前端、视觉和分析器共享的数据契约
services/vision      Python 本地检测、跟踪、OCR 和任务服务
services/api         AWS 上传、任务、连续视觉与转码 Lambda
services/agent       确定性本地规则分析器
services/renderer    ffmpeg 可视化脚本生成器
infra                AWS CDK 基础设施
docs                 架构、数据格式和开发记录
```

## 协作约束

- 修改前执行 `git status --short`，阅读相关代码、测试和文档，不覆盖他人的未提交修改。
- TypeScript 使用严格模式、2 空格缩进、双引号、分号；禁止用 `any` 绕过类型检查。
- 共享数据结构只在 `packages/contracts` 定义；复杂转换放入独立模块，不堆在 JSX 中。
- 不得编造比分、球员姓名、命中结果或比赛统计；缺失数据必须显示“暂无数据”“未确认”等明确状态。
- AWS 能力必须经 `services/api` 适配层接入；本地模式必须保持无凭证可运行，禁止恢复外接设备模块。
- 改动后按影响范围运行 `npm run typecheck`、`npm test`、`npm run build` 和相关端到端测试。
- 提交信息统一使用：`git commit -m "【问题】问题描述【修改】修改内容"`。

详细架构见 [docs/architecture.md](docs/architecture.md)，名单格式见 [docs/roster-database-format.md](docs/roster-database-format.md)。
