# dsh-image-rescue

![大图不再被拒收：消息里显示为文件卡片，提示原图已按字节保留，模型拿到路径](assets/screenshot.png)

DeepSeek Harness 会把"超过部署限额"的图片直接拒收：单边超过 8192px、总像素超过 6400 万、
或编码字节超过 20 MiB 时，整条消息发送失败（Web UI 提示：*图片宽高不能超过 8192px，请缩小后重试*）。
对"把 4 张扫描件转成 PDF""把这张长截图里的文字抄出来"这类任务来说，这个限制没有道理：
模型并不需要以视觉方式看完整分辨率，它需要的是**拿到原图**。

这个 Host 插件把拒绝改成"原图救回"：

- 尺寸合规的图片：完全走原有流程，行为不变（先调用原方法，正常消息不会多一次解码）。
- 超限的图片：**原始字节原样**存为通用文件附件（不缩放、不重编码、不裁切、不改色彩配置），
  模型收到该文件的只读路径与一行中文说明；它可以用 `read_image` 查看，也可以直接用
  自己的工具（Python/Pillow、ImageMagick、img2pdf …）按原分辨率处理。
- 被救回的图片在会话里表现为文件附件（文件名保留原扩展名），历史与后续轮次都能复用。
- 超出单条消息图片数量/总字节上限的图片同样按文件保存，不再中断发送。

## 安装

```bash
dsh plugin --profile <profile> add dsh-image-rescue
# 或从本地目录安装
dsh plugin --profile <profile> add /path/to/dsh-image-rescue
```

安装后无需配置。重启 Host（或让插件管理器热加载）即生效。只在 Host 侧工作，
不需要客户端代码，所以桌面版和 Web 版行为一致。

## 已验证

2026-11-12，在运行中的 DSH Desktop（`@deepseek-ai/dsh-desktop-runtime` 0.2.1-rc.2）
上用真实 UI 自动化验证：

| 用例 | 结果 |
|---|---|
| 9000×3000 JPEG（超过 8192 单边上限） | **通过**：不再出现 8192 报错；消息显示为文件卡片 `wide_9000x3000.jpg / JPG 321KB`；会话日志记录 `type:"file"`，`bytes: 328873`；磁盘对象 sha256 与源图一致 |
| 800×600 JPEG（对照） | **通过**：仍然是普通图片附件，与未安装插件时一致 |

此外仓库内 `npm test`（13 项单元测试）与一份针对真实 `@deepseek-ai/dsh-attachment-local`
的集成测试（21 项断言：基线拒收、救回后字节一致、`readFileStream` 校验、损坏图片仍报错、
数量超限救回、卸载后恢复原生行为）全部通过。

## 配置（全部可选）

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 置为 `false` 可临时关闭救回，恢复 DSH 原生行为 |
| `note` | 内置中文一句话 | 每条被救回图片后附带的说明文本模板；`false` 表示不附加任何文本 |

模板占位符：`{name}` 文件名、`{dimensions}` 宽×高（头部可读时）、`{size}` 编码大小、
`{limit}` 当前单边像素上限。

```yaml
- id: image-rescue
  name: dsh-image-rescue
  config:
    note: 'Original kept uncompressed at the path above ({dimensions}, {size}).'
```

## 能救回什么、不能救回什么

救回（原因为尺寸/数量/字节限额）：`IMAGE_DIMENSION_TOO_LARGE`、`IMAGE_TOO_MANY_PIXELS`、
`IMAGE_TOO_LARGE`、`IMAGES_TOO_LARGE`、`TOO_MANY_IMAGES`。

不救回（保持原生行为，照常报错）：损坏的图片字节、声明类型与内容不符、后端根本没有
逐字节文件存储（`ATTACHMENT_FILES_UNSUPPORTED`）——这些是真正需要用户修正的输入问题。

## 代价与限制

- 被救回的图片**不进入视觉通道**：模型看不到缩略图，需要看时它得自己调用 `read_image`
  （DSH 的图片读取工具会自动降采样显示）。这正是"不压缩"的代价，也是本插件的目的。
- 原图字节会完整落盘（内容寻址、只存一份），磁盘占用随之增加；DSH 不自动清理附件。
- 依赖 Host 侧 `ctx.attachments` 的标准服务契约（0.2.x）。若别的插件把 `admitPromptContent`
  整个替换掉且没有链接到本插件，救回不生效。

## 实现

`apply()` 在挂载时包装 `ctx.attachments.admitPromptContent`，并在服务被替换时重新包装；
正常路径直接把调用转发给原实现。拒收发生在逐图片校验时，包装层按图片重新分类：能过的照常
`validateImage` + `saveImage`，超限的走 `saveFile`（该路径本身没有限额），然后把文件块与
说明文本按原顺序交还给 Session Controller。卸载/停用插件时恢复原方法。

## English

DeepSeek Harness rejects a whole prompt when any image exceeds its vision limits
(>8192 px per side, >64 MP, >20 MiB encoded), which blocks ordinary jobs like
"turn these four scans into a PDF". This Host-only plugin turns the rejection into
rescue: compliant images are admitted exactly as before; oversized ones are stored
**byte-for-byte** as generic file attachments (no resize, no re-encode), and the
model receives the read-only path so it can `read_image` them or convert them at
full resolution with its own tools.

Install with `dsh plugin --profile <name> add dsh-image-rescue`. Optional config:
`enabled` (default `true`) and `note` (default a short Chinese line; `false` disables it).
Corrupt or mismatched images still fail exactly as before — only
size/count/byte limits are rescued.

## License

MIT
