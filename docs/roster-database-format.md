# 比赛名单数据库格式

视觉服务将比赛名单作为独立 JSON 文件上传。该文件的职责是把号码、球队和场上时间约束为有限的姓名候选；它不替代视频识别，也不需要存放长篇球员简介。

模板见 [roster.example.json](examples/roster.example.json)。

## 必填字段

| 字段 | 含义 | 示例 |
|---|---|---|
| `version` | 固定为 `1.0` | `"1.0"` |
| `gameId` | 比赛的稳定标识 | `2026-dal-hou-001` |
| `teams[].teamCode` | 球队短代码 | `DAL` |
| `teams[].teamName` | 球队名称 | `Dallas Mavericks` |
| `players[].playerId` | 全场唯一的稳定球员 ID | 官方数据 ID 或自定义 ID |
| `players[].name` | 前端显示姓名 | `Cooper Flagg` |
| `players[].jerseyNumber` | 本场球衣号码，保留为字符串 | `32` |

`aliases` 和 `activeIntervals` 是推荐字段。`activeIntervals` 用秒描述球员可能在场的片段，能够在号码被遮挡时减少错误姓名候选。

```json
{
  "version": "1.0",
  "gameId": "2026-dal-hou-001",
  "teams": [
    {
      "teamCode": "DAL",
      "teamName": "Dallas Mavericks",
      "players": [
        {
          "playerId": "1630000",
          "name": "Example Player",
          "jerseyNumber": "7",
          "aliases": ["E. Player"],
          "activeIntervals": [{ "startSeconds": 0, "endSeconds": 22.9 }]
        }
      ]
    }
  ]
}
```

## 文件选择

JSON 是运行时首选格式，因为字段层级清楚、号码可以保留为字符串、可保存同一球员的别名和在场区间，也能被系统严格校验。推荐你最终整理为每场比赛一个 JSON 文件。

CSV 可以用于手工整理。建议列为 `gameId,teamCode,teamName,playerId,name,jerseyNumber,startSeconds,endSeconds`，之后导出为 JSON。系统后续会增加 CSV 导入器。

PDF、Word、TXT 可以作为资料来源，但不建议直接上传给识别流水线：表格结构和号码字段会因排版丢失，系统无法稳定判断一条信息属于哪名球员。长篇球员简介对于从远景视频识别姓名帮助很小；号码、球队和当时在场阵容才是身份确认所需的核心数据。

## 身份确认规则

只有满足以下条件之一才显示姓名：

1. 连续多帧号码 OCR 与同队名单中的唯一号码匹配。
2. 号码、球队和 `activeIntervals` 同时一致。
3. 后续人工确认的轨迹映射与名单一致。

否则界面显示球队候选或轨迹编号，并保留低置信度状态。

## 自动与人工确认

本地视觉服务会在机器已安装 Tesseract 时，对同一轨迹最多 8 个球衣区域做号码 OCR 投票。至少 3 次读数一致、投票比例达到 60%，并且该号码在本场完整名单中唯一时，系统才会以 `OCR` 来源显示姓名。

若远景、遮挡或转身导致号码不足以自动确认，可在结果页的“身份”标签中选择正确的名单球员。该操作会保存为 `manual` 来源和 100% 身份置信度，绝不会被包装成自动识别结果。Windows 上可选安装 `UB-Mannheim.TesseractOCR`，或通过 `COURTVISION_TESSERACT_PATH` 指向 `tesseract.exe`；未配置时流程照常运行，只跳过自动号码读取。
