# opencli-plugin-jimeng-video

为 [opencli](https://github.com/jackwener/opencli) 增加 **即梦AI（jimeng.jianying.com）视频生成** 能力。
opencli 内置的 `jimeng` 只支持文生图；本插件在同一个 `jimeng` 命名空间下新增：

| 命令 | 说明 |
|------|------|
| `opencli jimeng video <prompt>` | 上传图片/视频/音频素材 → 输入提示词（@ 引用素材，与网页端一致）→ 设置模型/比例/时长/数量 → 提交 → 等待 → 下载 mp4 |
| `opencli jimeng video-status <record_id>` | 查询任务状态 / 等待完成 / 下载；`--save` 导入素材库（不消耗积分） |
| `opencli jimeng video-list` | 列出最近的视频任务及 record_id（`--keyword` 过滤，`--save` 批量导入素材库；不消耗积分） |
| `opencli jimeng library [open|init|status|stop]` | 素材库：打开管理页面 / 设置目录 / 状态 / 停止本地服务 |
| `opencli jimeng bridge [start|status|stop|token|definition|jobs]` | 桥接服务：让 [ArcReel](https://github.com/ArcReel/ArcReel) 等工具通过 HTTP API 使用即梦网页账号（会员积分）生成视频 |

## 原理

完全驱动真实网页 UI，保证提交内容与人工操作一致：

- **素材上传**：Chrome 通过 CDP 把本地文件读入隐藏 `<input type=file>`，再向「参考内容」区域派发真实 `drop` 事件（等同拖拽上传，支持大视频，无 base64 体积限制），等待上传与审核完成。
- **@ 引用**：上传素材插入与 @ 弹窗选择完全相同的 `referenceMentionTag{id}` 节点；资产库「主体」通过真实 @ 弹窗选择。
- **参数**：通过页面上的下拉/弹层选择模型、参考模式、比例、分辨率、时长、数量。
- **结果**：点击「生成」后从页面自身的网络响应中拿到 `history_record_id`，再轮询 `get_asset_list` 拿到视频地址。提交只点击一次，绝不自动重试。

## 安装

```bash
npm i -g @jackwener/opencli   # 需要 opencli >= 2.0.3，并在 Chrome 安装 opencli 扩展
opencli plugin install github:Carlos-Zen/opencli-plugin-jimeng-video
opencli jimeng --help          # 出现 video / video-status 即成功

# 升级
opencli plugin update jimeng-video
```

前提：`opencli doctor` 显示扩展已连接，并已在 Chrome 中登录即梦（`opencli jimeng whoami`）。

## 用法

```bash
# 先 dry-run：上传素材、填好提示词与参数、截图，但不点生成（不消耗积分）
opencli jimeng video "@图片1 中的女孩模仿 @视频1 的动作跳舞，音色参考 @音频1" \
  --files girl.png,dance.mp4,voice.mp3 --model "Seedance 2.0 mini" \
  --ratio 9:16 --duration 5 --dry-run --screenshot preview.png

# 正式生成并下载
opencli jimeng video "@图片1 中的女孩模仿 @视频1 的动作跳舞" \
  --files girl.png,dance.mp4 --model "Seedance 2.0 mini" --ratio 9:16 --duration 5 \
  --max-credits 60 --output ./videos

# 只提交不等待，稍后查询/下载
opencli jimeng video "..." --files a.png --wait false
opencli jimeng video-status <record_id> --wait --output ./videos
```

### 提示词中的 @ 引用语法

| 写法 | 含义 |
|------|------|
| `@图片1` `@视频2` `@音频1` | `--files` 中第 N 个图片/视频/音频（按顺序计数） |
| `@素材3` | `--files` 中第 3 个文件（不区分类型） |
| `@[名称]` | 标签为「名称」的素材：上传文件名（不含扩展名），或资产库中的主体 |
| `@@` | 字面量 `@` |
| 换行 | 新段落（与网页端回车换段一致） |

即梦用 **文件名（不含扩展名）** 作为 @ 标签，所以同一次上传的文件名不能重复。

### 主要参数

| 参数 | 默认 | 说明 |
|------|------|------|
| `--files` | | 素材路径，逗号分隔，最多 12 个 |
| `--model` | 保持当前 | 如 `Seedance 2.0 mini`、`Seedance 2.5 Flash`、`即梦 Seedance 2.5` |
| `--mode` | `全能参考` | `全能参考` / `首尾帧`（files 依次为首帧、尾帧，不支持 @）/ 其它网页模式 |
| `--ratio` `--resolution` | 保持当前 | `21:9 16:9 4:3 1:1 3:4 9:16` / `720p` 等（取决于模型） |
| `--duration` `--count` | 保持当前 | 秒数（受模型范围约束）/ 1-4 |
| `--workspace` | `new` | `new` 新会话，或会话 ID（URL 中的 workspace=）或侧边栏会话标题 |
| `--wait` | `true` | 等待生成完成 |
| `--timeout` | `1200` | 总超时秒数 |
| `--output` | | 下载 mp4 的目录 |
| `--dry-run` | `false` | 只填写不提交 |
| `--max-credits` | `0` | 预计积分超过该值则拒绝提交 |
| `--screenshot` | | 提交前截图 |

返回字段：`status`(dry-run/submitted/succeeded/failed/timeout)、`record_id`、`workspace_id`、`model`、`mode`、`ratio_resolution`、`duration`、`credits`、`prompt`（@ 引用以 `@[标签]` 显示）、`video_url`、`file`。

## 素材库

每次 `jimeng video` 生成成功后，视频会**自动存入素材库**并按上下文整理标注，同时在管理页展示：
已打开的管理页会实时出现新视频（NEW 标记 + 提示）；没有打开时会自动用浏览器打开。

```bash
opencli jimeng library init --dir D:/即梦素材库   # 设置素材库目录（默认 ~/Videos/JimengLibrary）
opencli jimeng library                          # 打开管理页面（http://127.0.0.1:17890）
opencli jimeng library status                   # 目录、数量、占用空间、服务状态
opencli jimeng video-list -f table              # 查看历史任务的 record_id
opencli jimeng video-list --limit 50 --save     # 批量导入最近 50 个历史视频
opencli jimeng video-status <record_id> --save  # 导入单个历史视频
opencli jimeng video "..." --project 艾灸毯广告 --tags 第一版,竖屏   # 指定项目与标签
```

**自动整理**：按「项目 / 生成时间_标题_任务ID」建文件夹；标题从提示词提取；自动标签包含模型、参考模式、比例、分辨率、
时长、参考类型（图片/视频/音频/主体参考或文生视频）及引用的主体；上传的参考素材按内容去重保存到 `refs/`，
管理页可直接查看每个视频用了哪些素材。项目默认取 `--project`，其次是 `--workspace` 指定的会话标题，否则「未分类」。

**管理页**（固定的一个本地页面 + 常驻本地服务，只监听 127.0.0.1，数据都在素材库目录）：
- 网格预览，鼠标悬停即播放；按项目、标签、收藏、评分筛选，全文搜索（标题/提示词/标签/备注/任务ID）
- 详情页：播放、编辑标题/项目/标签/备注、评分、收藏、查看提示词与参考素材、打开所在文件夹、复制路径/提示词
- 移除 = **归档**：移到 `archive/`，可撤销、可在「已归档」中恢复；只有已归档的才能永久删除
- 多选（Ctrl/Shift+单击、Ctrl+A）批量归档、移到项目、加标签、收藏；快捷键 ←/→ 切换、Del 移除、F 收藏、1-5 评分

**目录规范**（素材库根目录内也会自动生成 README.md 说明）：

```
library.json                              素材库标识与版本（schema: jimeng-video-library v1）
videos/<项目>/<生成时间>_<标题>_<任务ID>-<序号>/
    video.mp4  cover.jpg  meta.json       视频、封面、标注与生成上下文
archive/<项目>/<同名文件夹>/                已移除（归档）的素材，结构相同
refs/<sha1>.<扩展名>                        参考素材（去重共享）
.system/server.json server.log activity.jsonl   服务状态、日志、操作记录
```

每个视频的全部信息都在自己的 `meta.json` 里，没有中心数据库：拷贝/备份整个目录即可迁移；
在资源管理器里手工把文件夹移到别的 `<项目>/` 下，管理页刷新后同样能识别。

相关参数：`video` 的 `--save`（默认 true）、`--library`、`--project`、`--tags`、`--title`、`--open-ui`（默认 true）。

## 接入 ArcReel（桥接服务）

[ArcReel](https://github.com/ArcReel/ArcReel) 负责分镜、资产一致性、审核与剪映导出，生成环节通过本插件的桥接服务
落到即梦网页，消耗的是你的即梦会员积分，而不是火山方舟 API 额度。

```
ArcReel (Docker) ──HTTP──▶ opencli jimeng bridge (本机 127.0.0.1:17891) ──▶ opencli jimeng video ──▶ 即梦网页
                ◀── 视频文件 ──  （同时存入素材库，项目 ArcReel）
```

**1. 启动桥接服务**

```bash
opencli jimeng bridge start --max-credits 60      # 单个任务预计超过 60 积分则拒绝提交（0=不限）
opencli jimeng bridge token                       # 查看令牌（填到 ArcReel 的 API Key）
opencli jimeng bridge definition --out jimeng-web-bridge.json   # 导出 ArcReel 端点定义
```

**2. 在 ArcReel 中添加供应商**

一条命令完成（导入端点定义、创建供应商和模型；可重复执行，已存在则更新）：

```bash
opencli jimeng bridge arcreel --arcreel-env <ArcReel 的 deploy/.env>   # 从 .env 读取管理员账号密码
# 可选：--models "即梦 Seedance 2.0 Fast VIP,即梦 Seedance 2.0 mini" --durations 4-15 --resolution 720p
```

也可以在 ArcReel「设置 → 自定义供应商」手动添加：

- 新建端点定义：粘贴 [`arcreel/jimeng-web-bridge.json`](arcreel/jimeng-web-bridge.json)（已通过 ArcReel 校验器）。
  也可以不建定义，直接选内置的「V2 Video Generations」，但它最多只传 4 张参考图、不传参考音频。
- Base URL：`http://host.docker.internal:17891`；API Key：上一步的令牌。
- 模型：填即梦网页上显示的模型名，例如 `即梦 Seedance 2.0 Fast VIP`、`即梦 Seedance 2.0 mini`；
  可选时长按该模型填（如 4-15 秒），分辨率 `720p`。
- 把该供应商设为项目的视频生成供应商即可。

**行为说明**

- 提示词原样传递：ArcReel 生成的 `<角色>@图片N`、`@音频N` 与即梦网页的 @ 引用完全一致；参考图按顺序上传。
  没有对应素材的 @ 引用会降为纯文字。
- 只有首帧/尾帧时自动使用即梦「首尾帧」模式；既有参考图又有首帧时，首帧作为额外参考图并在提示词开头注明。
- 网页操作全局串行：一个任务提交完才提交下一个（每次约 15–30 秒），生成本身在即梦端并行；
  提交时会弹出即梦窗口，请保持可见。
- 积分保护：所有请求需令牌；相同请求 30 分钟内重复提交返回原任务；提交途中服务重启的任务直接判失败，
  绝不自动重交；`--max-credits` 限制单任务积分。
- 生成结果自动存入素材库（项目 `ArcReel`，带参考素材），可在 `opencli jimeng library` 中管理。
- 排障：`opencli jimeng bridge jobs` 看最近任务；日志在 `<素材库>/.system/bridge/bridge.log`。
- 免费联调：`opencli jimeng bridge start --replay-record <已有record_id>`，网页只 dry-run 不提交，
  用该已有任务的视频作为结果返回，可以不花积分跑通 ArcReel 全流程。

## 注意

- 命令默认在前台窗口运行：即梦的视频素材处理与 @ 弹窗依赖页面可见；如果 opencli 打开的即梦窗口被其它窗口完全遮挡/最小化，视频素材上传会卡住（会给出明确提示）。
- `video_url` 是带签名的临时链接，请及时用 `--output` 或 `video-status --output` 下载。
