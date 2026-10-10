# CourtVision 优化方案

## 结论

当前仓库已经有一条可演示的闭环：上传视频、保存任务、连续视觉、AgentCore、作品展示和共享数据契约都能串起来。主要问题不在服务数量，而在三个事实链没有闭合：

1. **视觉链只完成了通用目标检测，没有完成篮球语义识别。** YOLO11n 使用 COCO 的 `person`/`sports ball` 类别，随后用颜色聚类和简单 IoU 关联猜测球队与轨迹。它能画框，但不能稳定回答“这是哪位球员、篮球在哪里、这一回合发生了什么”。
2. **媒体链把 S3 原视频当成网页播放器资源。** 云端作品返回 S3 预签名下载地址，CloudFront 只代理 Web 桶和 API，没有代理媒体桶，也没有转码、HLS/DASH、封面或 CDN 缓存策略。首帧、拖动和多人访问都会受源视频编码和 S3 往返影响。
3. **分析链把未知格式的原始文件和少量关键帧直接交给模型。** 本地分析只是把固定演示分析中的三个数替换掉；云端 AgentCore 读取最多 180,000 个字符的原始数据、6 张关键帧和压缩轨迹摘要，没有统一事件模型、时间对齐或可计算的指标层，因此很难生成可复核的战术结论。

这三个问题需要分别建设“篮球视觉层”“媒体交付层”和“确定性数据层”，再让 AgentCore 只负责解释已经有证据的数据。

## 现状证据

### 视觉识别

- [services/vision/main.py](../services/vision/main.py) 的默认 `TARGET_FPS=10`、`MODEL_SIZE=640`、模型为 `yolo11n.pt`，检测类别固定为 COCO 的 `classes=[0, 32]`。模型没有篮球场、球员、裁判或球衣号码的专用类别。
- 处理循环仍然逐帧 `capture.read()`，只在 stride 后运行推理；每隔约 1.5 秒同步启动一次 Tesseract 子进程。CPU 环境下，这会同时拉长任务时间并放大 OCR 阻塞。
- `assign_teams()` 仅用上衣区域的亮度、饱和度和对比度做两类无监督 k-means。聚类标签没有球队真值，也没有镜头切换、光照变化和遮挡处理。
- `referee_candidate()` 是基于灰度和对比度的启发式规则，不能排除观众、教练或场边工作人员。无论本地还是云端，通用 `person` 都会被放入球员集合。
- 云端 [services/api/src/vision-handler.ts](../services/api/src/vision-handler.ts) 使用 Rekognition `StartLabelDetection/GetLabelDetection`，再在 [services/api/src/rekognition-tracking.ts](../services/api/src/rekognition-tracking.ts) 中按相邻时间点 IoU 关联。关联阈值、1.5 秒失活时间和贪心匹配无法处理镜头切换、交叉遮挡和重新入场。
- 现有本地结果可直接量化问题：21.54 秒片段有 216 个采样帧，但产生约 45–48 条轨迹；另一批 22.87 秒片段产生 48–56 条轨迹。篮球只在 0–2 个采样帧出现，身份确认通常为 0 条，说明主要问题是 ID switch、误检和球检测召回率，而不是前端绘制。

### 视频加载和播放

- [services/api/src/handler.ts](../services/api/src/handler.ts) 的 `signDownload()` 直接给 S3 `GetObject` 生成预签名 URL。
- [infra/lib/courtvision-stack.ts](../infra/lib/courtvision-stack.ts) 的 CloudFront Distribution 只有 Web 桶默认源和 `/api/*` 行为，没有媒体桶源或 `/media/*` 行为。
- [apps/web/src/App.tsx](../apps/web/src/App.tsx) 直接使用 `<video src={videoUrl}>`，没有 `preload` 策略、poster、媒体缓存策略或自适应码率。用户点击作品后才开始从原始 MP4 取数据。
- 云端流程在上传前先对完整视频计算 SHA-256，再顺序抽取 6 次 seek 关键帧；这会让大文件在真正上传前经历一次完整读取，浏览器内存和磁盘缓存压力也较高。
- 原始视频同时承担分析输入和播放输入。分析需要原片，播放通常只需要可快进的低码率派生版本，两者没有分离。

### 数据分析

- [apps/web/src/demo-workflow.ts](../apps/web/src/demo-workflow.ts) 的 `createDemoAnalysis()` 只查找 `xfg`、`gravity` 和 `winImpact` 三个别名，然后替换固定 `demoAnalysis` 的三个指标；没有按时间产生事件。
- 同文件的 CSV 解析是 `row.split(",")`，不支持引号、逗号转义、换行字段、BOM 和类型转换。
- [services/agentcore-runtime/src/main.ts](../services/agentcore-runtime/src/main.ts) 把数据当作未定义文本读取并截断到 180,000 字符；AgentCore 只收到 6 张关键帧、轨迹摘要和原文，没有统一的投篮/回合/球员指标结构。
- `stats` 在契约中是可选字段，但上传和 Step Functions 没有把比赛资料解析成 `GameStatsTimeline` 的步骤，因此云端统计面板经常只能显示空态。
- `askAgent()` 在前端通过关键词分支生成固定答案，云端模式的“AgentCore 已连接”并不代表问答请求真的调用了 AgentCore 或数据工具。
- `analysisSchema` 没有强制事件排序、事件证据引用、指标范围与数据来源 ID。模型一次输出不符合契约时，整个分析任务会失败，没有局部修复或重试。

## 目标架构

```text
S3 原始视频/资料
        |
        +--> MediaConvert 或 ECS ffmpeg
        |       +--> HLS/CMAF + poster + 低码率 MP4 -> CloudFront /media/*
        |
        +--> Step Functions
                +--> 资料标准化 Lambda -> canonical game context
                +--> 视觉任务 -> SageMaker Async/GPU 或 ECS GPU
                |       +--> player / ball / referee detections
                |       +--> BoT-SORT/ByteTrack + camera-cut 分段
                |       +--> jersey OCR + roster matching
                |       +--> court homography（质量不足则明确未标定）
                |       `--> tracking.v2 + quality metrics
                +--> 事件与统计计算 Lambda -> stats timeline + evidence index
                +--> AgentCore -> 只读取 canonical context、证据和关键帧
                `--> 校验器/渲染器 -> analysis.v2、音频和成片
```

S3 原片保留为事实源，派生播放文件单独存储。DynamoDB 只保存任务状态、版本和索引；大 JSON、轨迹、关键帧和分析结果放 S3。CloudFront 对 `/media/*`、`/frames/*` 和静态 Web 使用不同缓存策略，下载 URL 改为 CloudFront 签名 URL 或签名 Cookie。

## 视觉改造

### 第一阶段：先把结果变得可信

1. 新增 `VisionProvider` 接口，统一输出 `tracking.v2`，保留 `provider`、模型版本、检测置信度、轨迹生命周期、镜头段、质量指标和每个字段的来源。Rekognition 只作为回退或人员粗检测，不再把通用 Person 直接标成球员。
2. 训练或微调篮球专用检测器，至少包含 `player`、`ball`、`referee`、`rim`/`backboard`。训练集需要覆盖远景、近景、回放、遮挡、不同球衣、观众和裁判。模型优先使用 SageMaker Async Inference 或带 GPU 的 ECS 任务；模型权重放 S3/ECR，不放 Git。
3. 用球场 ROI 和底线/边线区域过滤观众与场边人员。检测器在较低频率运行，跟踪器在中间帧更新；遇到场景切换时结束当前 track segment，不能把前后镜头强行连接。
4. 用带门控的 Hungarian 匹配或成熟 tracker 的 cost matrix 替换单一 IoU 贪心：综合 IoU、中心距离、速度、外观 embedding、类别和时间间隔。设置 `tentative/confirmed/lost/terminated` 生命周期，并输出 `idSwitches`、track length、平均检测置信度和遮挡时间。
5. 篮球单独评估 recall。球是小目标，不能依赖 COCO 的 `sports ball` 标签；采用高分辨率球检测、局部放大、运动先验和轨迹平滑。没有球坐标时，前端保持空态，不能把最近一次位置当作当前球。

### 身份、球队和球场

- 号码识别独立成异步阶段，只对大、清晰、近似正面的 crop 做 OCR；先做透视校正、去背景和多候选读取，再按 track、时间窗口和名单进行投票。OCR、名单和人工确认分别记录来源，任何一项不足都显示 `Txx`。
- 球队分配先用名单和球衣颜色的有监督校准，颜色只作为辅助证据。聚类结果不能直接命名球队，也不能作为球员姓名依据。
- 由至少四组非退化球场点计算 homography，使用检测框底边中点近似地面接触点。镜头段、相机运动和质量阈值必须记录；未通过质量检查就不输出 `courtPosition`。前端雷达只展示有标定来源的坐标。
- 建立一套带真值的小样本回归集，至少包含固定远景、快速平移、遮挡、近景、回放和比分牌变化。每次模型或 tracker 修改都测 `person precision/recall`、`ball recall`、`IDF1`、`ID switch/分钟`、号码准确率和身份确认率。

## 视频交付改造

1. 上传流程保留 multipart，但把完整 SHA-256 从上传前移到分片上传过程，或使用 S3 checksum/服务端校验；不要为了查重在浏览器先完整读取一次大视频。digest 仍作为幂等键。
2. 任务启动后先用 MediaConvert（编码不兼容时）或 ECS ffmpeg 生成：HLS/CMAF 多码率、360p 预览 MP4、poster 和关键帧。原视频只供视觉任务读取。
3. CloudFront 增加媒体桶 Origin Access Control 和 `/media/*` 行为，开启 Range 请求、压缩和合适的 `Cache-Control`。API 返回 CloudFront 签名 URL/Cookie，不再返回 S3 直链。静态页面、JSON 结果和视频使用不同 TTL；结果 JSON 可以短缓存并带 ETag。
4. 播放器初始使用 poster 和 `preload="metadata"`，进入播放时才拉取合适码率；支持 `canplay`、`waiting`、`stalled`、`error` 指标。没有 HLS 支持的浏览器使用低码率 MP4 回退。切换作品时销毁旧媒体源和对象 URL。
5. 关键帧抽取改为服务端从解码后的派生文件按事件时间生成，或浏览器只在需要时并发抽取；不要连续 seek 六次阻塞主线程。关键帧应带 `sourceEventId` 和质量分数，Agent 读取最有信息量的帧。

建议观测：首字节时间、首帧时间、`canplay` 时间、首播前下载字节、拖动到可播放时间、卡顿次数/分钟、Range 命中率和 CDN 命中率。目标是首帧 p95 < 2 秒、拖动后 p95 < 1.5 秒、CDN 命中率 > 90%。

## 数据和 Agent 改造

### 标准化输入

新增资料标准化 Lambda 和共享契约，至少定义：

- `GameIdentity`：gameId、日期、两队、来源和确认状态；
- `PlayEvent`：事件时间、类型、球员、球队、结果、原始行 ID；
- `ShotEvent`：位置、距离、投篮类型、命中结果、xFG、来源；
- `PlayerMetricSnapshot`：xFG、on/off-ball gravity、win impact 及时间窗口；
- `GameStatsTimeline`：按视频时间映射的比分、命中率、篮板、犯规和效率快照；
- `EvidenceRef`：`sourceFile`、JSONPath/CSV 行号、时间范围、哈希和质量。

JSON 用 Zod 解析，CSV 使用支持引号和 BOM 的解析器；所有数值、百分比、时间和单位在进入 Agent 前完成归一化。无效行进入 warnings 和死信对象，不能静默丢弃。

### 确定性计算先于模型

从标准化事件计算 eFG%、TS%、xFG 与实际命中差、失误率、回合效率、领先变化、引力变化和事件窗口。每个指标保存公式、输入事件 ID 和置信度。只有真正有数据的指标才进入 `Analysis`，不存在时显示缺失，不用演示 fixture 补齐。

比赛身份用比分牌 OCR、球队/球员/号码、名单、文件元数据和官方比赛目录做多证据确认；`confirmed` 后才加载官方 Box Score/Play-by-Play。没有确认就保留 `ambiguous/unconfirmed`，并在 UI 中显示原因。

### AgentCore 只做解释

把 Agent 输入改成有限大小的 `analysis_context.json`：

```json
{
  "video": {"durationSeconds": 21.54},
  "windows": [{"id": "play-42", "start": 8.1, "end": 10.4,
    "metrics": [{"name": "xFG", "value": 0.42, "source": "shots.csv:18"}],
    "evidence": ["frame://...", "play://play-42"]}],
  "trackingQuality": {"idf1": 0.81, "ballRecall": 0.76},
  "warnings": []
}
```

AgentCore 负责选择 3–5 个最有解释力的窗口、写简短解读和解说，不负责从原始 CSV 猜指标。使用结构化输出/工具调用，输出后由 Lambda 做 schema、时间范围、指标单位、证据引用和字数校验；失败时只重试该阶段或回退到确定性摘要，不让整条任务丢失。

问答应调用一个明确的 `get_current_context`/`get_stats_snapshot` 工具。若处于本地模式，界面写“基于已加载数据”；若处于云端模式，只有真实请求成功才显示 AgentCore 在线。

## AWS 落地顺序

### P0：先解决评审当天最明显的问题（1–2 天）

1. CloudFront 增加媒体 Origin 和签名播放 URL，先生成低码率 MP4；原视频保留回退。
2. 把云端作品的问答状态改为真实能力，去掉“已连接”的静态暗示；没有统计就显示空态。
3. 增加标准化 JSON/CSV 解析、`GameStatsTimeline` 生成和证据引用；本地演示数据必须显式标注。
4. 在 UI 保持未标定雷达空态，删除任何由 bbox 中心伪造球场坐标的路径。
5. 建立一条 3 个固定视频片段的基准脚本，记录首帧、播放和视觉指标，作为之后所有改动的门槛。

### P1：解决识别和分析质量（3–5 天）

1. 上篮球专用检测器、相机切段、稳定 tracker 和球检测；Rekognition 仅作 fallback。
2. 上号码 OCR 的质量筛选、名单约束和人工复核；输出 IDF1、ID switch、ball recall 和身份确认率。
3. 把确定性事件窗口和统计快照接入 AgentCore；加入输出校验、重试和 `analysis_context.json`。
4. 把任务轮询改成 Step Functions 状态事件/SQS 通知；视觉长任务拆成可恢复分片，避免单 Lambda 10 分钟边界。

### P2：提高稳定性和产品完成度（1 周左右）

1. 分镜头 homography、球员落点和真正有来源的传球/投篮轨迹。
2. MediaConvert 多码率 HLS、字幕/Polly 音频合成和最终渲染产物。
3. DynamoDB 增加 `status + updatedAt`、`inputDigest` GSI，消除作品页和查重的全表 Scan；S3 `/storage` 接口分页。
4. CloudWatch Dashboard、X-Ray、Step Functions 重试/DLQ、模型成本和证据可追溯报表。

## 验收门槛

### 视觉

- 远景片段球员轨迹数量接近场上人数，ID switch < 1 次/分钟；`IDF1`、球 recall、号码准确率和身份确认率都有基准记录。
- 误检的观众、教练和裁判不能进入球员统计；没有置信度和来源的姓名只能显示轨迹 ID。
- 无 homography 时雷达明确显示未标定；有标定时用固定点 fixture 验证篮圈、中线和边界。

### 视频

- 1440p/1080p 原片、非 16:9、慢网和多人访问都支持 Range；首帧 p95 < 2 秒，拖动可播放 p95 < 1.5 秒。
- 切换作品后不会继续请求旧视频；视频、关键帧、分析 JSON 的 CDN 缓存和失效策略可观测。

### 数据和分析

- 每个显示指标都能回到原始文件行、事件 ID 或官方 API；没有来源的字段不显示。
- 相同输入重复运行产生相同的确定性统计和事件窗口；模型只改变语言表达，不改变基础数字。
- Agent 输出不在视频时长之外、不引用不存在的球员、不把视觉框当作球场坐标；解析失败有局部回退和可读 warning。

### 工程

- 通过 `npm run typecheck`、`npm test`、`npm run build` 和相关 Playwright 用例。
- 增加视觉回归、视频性能和数据契约测试；不要用示例 fixture 冒充正式比赛结果。
- 部署前只做 `cdk synth` 和 staging 验证，生产部署仍遵守 `us-east-1`、赛事 profile 和最小 IAM 约束。

