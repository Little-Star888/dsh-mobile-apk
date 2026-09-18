# 0.14.0 发布说明（versionCode 39）

覆盖安装 **v0.14.0-preview (vc38)**；全新安装请选对应 ABI 包（真机 arm64 / 模拟器 x86_64）。

> **vc 已轮换**：上一版预览用掉了 vc38，本版为 **vc39**——同 code 无法覆盖安装。

本版把上一版标注为**实验特性、未接入产品路径**的两项做到**可用线**：

- **虚拟屏**：从「P0 探针 1/6 绿、刻意不接入默认路径、状态端点 404」→ **完整可用**
  （建屏 / 拉起第三方 App / 截图 / 语义树 ref 操作 / 坐标输入 / 适配 / 会话隔离 / 空闲回收 / 手动关机）；
- **AI 浏览器**：从「引擎侧就绪、壳侧宿主未落地、面板只读、下拉 disabled」→ **完整可用**
  （隔离宿主 WebView / CSS 视口 / PC-手机身份 / 多页签 / 快照 ref / 滚动避让 / 错误页）。

另交付**附件入口分流**（issue #215）、**Shizuku 特权通道时序修复**、**快照升级健壮性**。

---

## 特性一：虚拟屏（本版重点）

**让第三方 App 在独立屏幕上运行，不挤占用户前台。**

### 能力

| 能力 | 说明 |
|---|---|
| 建屏 / 销毁 | Shizuku 特权通道；幂等；单实例上限 1 块；**序号复用**（从 1 起找最小未占用号） |
| **拉起第三方 App** | 经壳侧 Shizuku UserService 的 `am start --display <id> -n <component>`，第三方 App 真正跑在虚拟屏上 |
| 截图 | `android_screenshot { screenId }` 两条通道都落到目标 displayId，分辨率锚点用**该屏自身像素** |
| 语义树 + ref 操作 | `android_ui_dump` / `android_ui_click` 传 `screenId` 即在虚拟屏上作业 |
| 坐标输入 | 绝对 `x/y` + `screenId`（经 `input -d <displayId>`，真实屏不受影响） |
| 等比适配 | 按**内容宽高比** letterbox 居中，不拉伸、不偏边 |
| 面板 | 右侧栏「虚拟屏」Tab：编号切换、状态、手动关机按钮 |
| 退后台浮窗 | 只读浮窗，短边 30%-50%、角缩放、贴边内滑收起、叉=收起不销毁 |
| 会话隔离 | 资源全局唯一 + 归属只管呈现 + **销毁不设锁**（任何会话都能关，避免创建者消失后无人能关） |
| 空闲回收 | 10 分钟无操作自动回收（vd op 入口 + 前台每 2 分钟扫描） |

### 本版实测打通的关键路径

**「跨屏拉起」四条候选路径，实测只有一条成立**——本版把唯一可行路径做通：

| # | 路径 | 实测结论 |
|---|---|---|
| 1 | `monkey --display` | **无此选项**（monkey 没有屏幕维度） |
| 2 | shell `am start --display` | **不稳**（时成时败） |
| 3 | 进程内 `setLaunchDisplayId` | **被拒**：`SafeActivityOptions.checkPermissions` 拒绝（连 owner 本人也拒） |
| 4 | **Shizuku UserService + `am start --display <id> -n <component>`** | **成立** ✅（固定 argv，组件名先由 `cmd package resolve-activity` 解析） |

### 修掉的真缺陷（均已登记坑位）

- **`screenId` 对模型不可发现**：该参数此前**无 description**（出于 wire 预算考虑），设备会话实录证明
  模型看到无说明的字符串参数会**直接忽略**——于是 `android_app_launch` 把 App 拉到真实屏，
  整轮都在错误前提下排查。现补最小 description + 工具描述跨屏指引 + **兜底主动提示**
  （有活跃虚拟屏时当场告知别名与用法，不指望模型事后读文档）。
- **对虚拟屏截图抓的是真实屏**：ADB 回落路径**完全忽略 `screenId`**（无参 `screencap` 只抓 display 0），
  模型拿到真实屏画面却以为在看虚拟屏——**静默错误答案**，比直接报错更有害。现两条通道都认屏幕。
- **ref 寻址三重根因**：① 重定位的根与建树时不是同一棵（窗口按 active/focused 排序会换树）→ 建树时**钉住窗口 id**；
  ② `getChild` 是活视图片段，dump 后列表复用 → 建树时**保留节点句柄**直接复用，且不用 `refresh()` 做门槛；
  ③ `UI_CACHE_TTL=30s` 太短（审计实测 dump→click 间隔 57s）→ 连续 6 轮 dump/过期死循环，放宽到 **10 分钟**。
- **点击生效校验假报失败**：比对的两个 gen 不同源（配置代次 vs 快照代次）→ 不再传该 gen，
  并把「校验不可靠」与「点击落空」文案分开（对模型的下一步含义完全不同）。
- **原生覆盖层强行遮盖聊天**：可见性判据漏了「侧栏已收起」（收起只隐藏面板、DOM 保活，旧判据仍算 visible）。
- **序号无限膨胀**：旧实现单调递增且从不回收，实测 `virtual-1→2→3`；上限 1 块时界面显示「虚拟屏 3」
  却切不回更早那块。
- **`FLAG_OWN_CONTENT_ONLY` 不能去掉**（修正我自己上一版的错误修法）：缺它系统按「镜像」处理并索要
  投屏权限，`create` 直接抛 `SecurityException`。该 flag 是非系统应用建屏的**必备条件**。

---

## 特性二：AI 浏览器（本版重点）

**侧栏里的隔离 WebView 工作台：AI 可开页签、多网页同时管理；人打开即可同时查看多个页签。**

> 设计口径：**UI 是给人的，AI 走工具直接读信息。** 因此 AI 侧不做「模拟人点页面」，
> 而是经快照 / ref / 工具控制多网页。

### 能力

| 能力 | 说明 |
|---|---|
| 隔离宿主 | 独立的第二个 WebView，**与主 UI 完全隔离**；页面拿不到 `androidBridge` |
| **分辨率 = CSS 视口** | document-start 注入 `width=<cssW>` + 物理矩形等比 letterbox；`window.innerWidth` 精确等于请求值（实测 390×843±1 / 1280×721±1） |
| **PC / 手机身份** | UA-CH 走能力门；WebView 110 的 degraded 如实上报，不假装完整 |
| 多页签 | AI 可开多个页签并同时管理；人打开侧栏即可查看 |
| 快照 / 点击 / 输入 / 滚动 | `browser_snapshot` 渲染每行 ref（可点目标），配合 click/type/scroll 闭环 |
| 滚动避让 | 原生 `onScrollChanged` + 200ms 轮询，到顶必现 |
| 错误页 | Edge 式（标题 + 主机 + `ERR_*` + 刷新） |
| 关闭即销毁 | 不恢复、不持久化 |
| 会话隔离 | 每会话独立 Workspace（移除单向归属锁 `bindOwner`/`requireOwner`） |

### 修掉的真缺陷（均已登记坑位）

- **侧栏收起时视口塌成 0x0**：此前可见性用 `View.GONE`，WebView 停在建页时的 1×1，
  导致 `innerWidth/innerHeight = 0`、html 矩形 0x0 —— 模型侧读页面**全线残废**
  （B 站 191 个可交互元素几乎全被 `r.width < 1` 判掉）。
  改为**一律 `INVISIBLE` 而非 `GONE`**（保留布局）+ `layoutDetached()` 按「上次舞台尺寸 → 分辨率档 →
  主 UI WebView → 640×960」给非退化矩形。实测 **0x0 → 450×800**。
- **`browser_snapshot` 只报计数不给目标**：模型拿不到可点 ref。现渲染每行 ref；
  节点 ≤3 时显式提示「换 `linux-desktop` 身份档」（同一 URL 实测 1-2 → **135 节点**）。
- **`browser_open` 身份/视口恒报 `browser-not-created`**：改为先置后开。
- **错误页被自身 `about:blank` 事件覆盖**。
- **`setInitialScale` 在 API 36 SDK stub 中已移除**（javap 实证）→ 改由 document-start 注入实现；
  身份/分辨率变化时重建 WebView（每实例只注册一次）。

---

## 特性三：附件入口分流（issue #215）

- **回形针上拉菜单**（DSH 原生视觉，不是系统 action sheet）：点回形针出「上传附件 / 上传图片」两项。
- **单击即出**：此前上游 `Tooltip` 的气泡 `<span role="tooltip">` 会插在按钮与隐藏 `input` 之间，
  而查找逻辑只认 `nextElementSibling`，于是 hover 后判定「这不是回形针」→ **不拦截点击** →
  事件冒泡到上游按钮直接开原生 picker（用户感知就是「要点两下」）。改为**结构判定**，不再依赖兄弟顺序。
- **两项走两个界面**：此前壳侧为修「空 accept → DocumentsUI 受限『近期的图片』视图」把**相册分支整个删掉**，
  所有类型一律 SAF —— 适配层把 accept 正确设成图片类型也**没人看**，两个入口打开同一界面
  （用户原话「俩控件跳转都是跳到了文件 picker 而不是一个文件一个相册」）。
  现按声明分流：**显式图片类型 → 系统相册**（`PickMultipleVisualMedia`，API 33+ 系统照片选择器，
  更低版本回落 `ACTION_GET_CONTENT` 图片类型）；空 / 扩展名 / 含非图片 → 原 SAF 分支不动。

---

## 特性四：Shizuku 特权通道时序修复

- **「第一次必失败、第二次必成功」不是抖动，是 latch 时序的确定结果**：
  `ensureBound()` 只 await 一片 4s 就返回，而 `Shizuku.bindUserService` 实测约 **5s** 才回调；
  且 `bindLatch` 是**一次性**对象、回调后从不清空 —— 首次必然超时，次次调用拿到已放行的 latch 立即返回。
  设备会话里 agent 据此判定特权通道不可靠、转投 Termux 通道，又撞上该通道缺陷，**两个缺陷串联把整条链路打崩**。
  修法：总预算内**循环等待** + 三条路径都**清空 `bindLatch`** + 把 `connecting`（可重试瞬时态）与
  `not-bound`（需排查）**拆成两个 code**，文案分别给「请直接重试」与「去设置页排查」。
- **Termux 通道不可能跑通 `am start --display`**：Termux 的 `$PREFIX/bin/am` 在 exec 前显式
  `unset LD_LIBRARY_PATH LD_PRELOAD`，之后任何 Termux 二进制都以链接失败收场（报错文案却是「库不存在」），
  且 Termux 的 `am` 本身也不支持 `--display`。跨屏拉起只有壳侧 Shizuku 一条路。
  同批修掉**报错风暴**：同一句重复 40+ 次、文本互相交错、回执 25 KB 全是乱码 → 按行折叠并标注次数。

---

## 特性五：快照升级健壮性

- **清理阶段逐项容错**：模拟器异常掉线把解压打断，留下 `.snapshot-stage/home`，其内部元数据损坏
  （`ls` 看是空的、`rm -rf` 与 `rmdir` 连 root 都删不掉）。旧 `deletePath` 遇到它就抛异常 →
  刷新失败 → **回滚走同一方法、同样失败** → 残留永远存在 → **之后每次启动都失败**，用户只能清应用数据。
  现改为：① 能删的删掉、删不掉的如实上报并继续；② 清理后复查，仍有残留就把整个 stage
  **改名挪开**（改名只动父目录项、不碰坏子项，更易成功），再用干净目录继续。
- **换树仍是单事务**：解压到 staging → 校验完整 → 整体换入；中断可回滚，
  且**从不触碰用户数据**（会话 / 附件 / 设置 / 凭据 / 工作区）。
- 覆盖安装后请**等待首次解压完成**（快照指纹翻转），期间勿强杀应用。

---

## 修复的历史 issue

- **#214 / #228 / #230（v0.13.8 启动失败、白屏 `Failed to load plugins`）**：
  `cordis.patch.yml` 的合并规则是「以 live 内容为基，只追加缺失的工厂块」。
  ≤0.13.6 升级上来的设备残留 `- id: ui-layout` + `disabled: true`，该行**永不被纠正**
  → 根服务 `layout` 不激活 → **13 条客户端插件全部 pending** → 白屏。
  干净安装因此复现不了（整树替换）。修法：每版本一次的**自愈**，清退役行并落 `.pre-<版本>.bak`。
- **#215（上传图片）**：见「特性三」。
- **#221（侧栏文件预览「文件资源服务不可用」）**：根因是**上游**资源模型把 URL authority 当协议键，
  而鸿蒙 ArkWeb 对非特殊 scheme **不填 authority**（`dsh-resource://file/...` 的 hostname 实测为空串）
  → `protocolOf()` 返回 undefined → 预览恒渲染 `resourceUnavailable`。属上游行为，本版记入已知限制。

---

## 验收证据

| 检查 | 结果 |
|---|---|
| 离线门禁（聚合入口 `check-release-gates.mjs --run`） | 全绿 |
| Kotlin 单测 | **269 项，0 失败，1 跳过** |
| 插件单测 | bridge 82 / manage 62 / vdisplay 12 全通过 |
| 移动 UI 单测 | 180 项全通过 |
| 双 ABI 构建 | `BUILD_EXIT=0`，被拒 ABI 0 |
| 模拟器端到端（附件） | 回形针**单击**出菜单；附件 → DocumentsUI；图片 → `PhotoPickerActivity`（照片 / 相册） |
| 模拟器端到端（虚拟屏） | 建屏 → 跨屏拉起 → 截图认屏 → 深层 ref 一次点中 → 主题切换 |

## 已知限制

- **插件市场**：绝大多数第三方插件在手机端不一定可用（移动端与桌面端在 WebView 内核 / 文件系统 /
  权限模型 / 运行环境差异大），以可用性验证与反馈为主，暂不建议作为生产依赖。
- **虚拟屏**：上限 1 块；跨屏拉起仅经 Shizuku 通道可行，需用户安装、启动并授权 Shizuku。
- **鸿蒙 ArkWeb（#221）**：侧栏文件预览受上游 URL authority 解析行为影响，待上游或兼容层修复。
- **`-Fast` 档产物禁发布**（`DSH_INJECT_PRESET=1` 体积增大，仅 dev 装机）。

## 资产

| 资产 | 说明 |
|---|---|
| `dsh-mobile-apk-v0.14.0-arm64.apk` | arm64 真机 |
| `dsh-mobile-apk-v0.14.0-x86_64.apk` | x86_64 模拟器 / 设备 |
| `snapshot-{arm64,x86_64}.tar.xz`(+.sha256) | 注入后运行时快照（与 APK 内嵌同源） |
| `dsh-android-*.tgz` ×8 | 插件包（可单独更新） |

**ABI 必须与设备匹配**（node ELF `EM_X86_64` vs `EM_AARCH64`，不匹配引擎启动即崩）。
