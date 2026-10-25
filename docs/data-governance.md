# 数据治理与事实边界

## 两类数据，两个责任边界

| 数据层 | 可以输出什么 | 不可以输出什么 |
| --- | --- | --- |
| 结构化事实层 | 比分、命中/出手、犯规、名单、球员资料、官网深度指标 | 没有来源的比赛结论 |
| 视觉候选层 | 处理帧数、目标候选帧数、轨迹数量、号码 OCR 候选 | 姓名、球队、得分、命中、犯规等比赛事实 |

YOLO 的框分数只表示“该画面区域像 COCO 类别中的 person 或 sports ball”。它不表示“这个人是谁”、不表示“这个球员的数据正确”，更不表示比赛统计可信。因此产品不向观众展示平均框分数，也不把它命名为事实置信度。

## 统计 JSON 来源字段

比赛统计采用 `GameStatsTimeline`，在顶层填写 `provenance`。示例中的链接、日期、标注人必须是真实信息；不要为了通过校验虚构它们。

```json
{
  "version": "1.0",
  "gameId": "真实比赛唯一标识",
  "source": "NBA 官网 Box Score 与 Play-by-Play 的人工标注",
  "isDemo": false,
  "provenance": {
    "sourceType": "nba-official-manual",
    "publisher": "NBA Official",
    "sourceUrls": ["https://www.nba.com/game/真实比赛页面"],
    "annotatedBy": "Team28",
    "annotatedAt": "2026-10-23",
    "verifiedAt": "2026-10-23",
    "datasetVersion": "v1.0",
    "recordCount": 1,
    "notes": "人工核对后写入，不使用模型补全。"
  },
  "snapshots": []
}
```

`snapshots` 必须至少含一条有效快照。上面的空数组仅用于说明字段结构，不能直接导入。

`sourceType` 的含义：

- `nba-official-manual`：源于 NBA 官网，并由团队人工标注、复核和 JSON 化。
- `official-structured`：其他明确官方提供的结构化数据。
- `user-structured`：用户上传的结构化资料，来源尚未完整核验。
- `demo`：界面示例，绝不用于比赛结论。

## 可视化的视觉证据

视觉服务会记录下列可审计计数：

- `processedFrameCount`：实际送入视觉模型的处理帧数。
- `playerVisibleFrameCount`：至少保留一个场内人物候选的帧数。
- `ballVisibleFrameCount`：经时序过滤后保留篮球候选的帧数。
- `trackCount`：通过最低持续时长过滤后的球员轨迹数。
- `identifiedTrackCount` 与 `ocrIdentityCount`：与名单唯一匹配的轨迹数和其中 OCR 匹配数。

这些数字用于复核视觉覆盖范围，而不是衡量比赛结果的真实性。遮挡、转播切镜、回放画面都会影响它们；没有足够证据时，姓名与统计应保持未确认或空态。
