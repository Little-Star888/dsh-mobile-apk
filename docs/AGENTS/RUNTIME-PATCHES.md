# RUNTIME-PATCHES.md — assets/patched/ 运行时补丁登记

> 职责：`app/src/main/assets/patched/` 逐文件的权威登记（0.13.7fx-1 起 **2 个在册**，0.14.1 起 **3 个在册**：attachment-local、session-persistence-jsonl、fs-local）——消费方 `EngineManager.applyRuntimePatches()`（EngineManager.kt:636），逐文件目标快照路径/作用/来源线索与维护约定。在册字节数与消费方注册行号 2026-09-25 当场 ls/grep 实测（三条资产随 0.14.2 追上游 0.1.7-rc.1 于 2026-09-24 按 rc.1 快照重建，见 §7.4）；退役批次见 §5。

## 1. 机制（EngineManager.kt）

- **路径速查**：快照解压根 = `filesDir`（usr/ + home/）；dshPkgs = `usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai`（EngineManager.kt:925）；资产源 = APK 内 `assets/patched/`，经 `context.assets.open(asset)` 读取。
- **触发时机**：每次 `startEngine` 前调用（EngineManager.kt:1030 调用 ⇒ :924 `applyRuntimePatches`）——首启解压后、以及每次快照刷新/重解压后自动重施加（幂等）。
- **覆盖式全量替换**：`applyAssetPatch`（:938）把 asset 字节整文件写入目标，**非 delta/非行级补丁**——asset 即目标文件的完整修改版拷贝。
- **内容指纹判定**：目标已存在且字节与 asset 完全一致（contentEquals，:952）才跳过；不用固定 marker 字符串——v1→v2 升级时旧 marker 曾导致更新后的 asset 被误跳过（注释实锤）。快照刷新覆盖目标后指纹失配 → 自动重施加。
- **目标包缺席即跳过**：目标父目录不存在时不落补丁（宁缺毋滥不留死覆盖）。
- ~~hashAdaptive~~（0.13.7fx-1 随 web-frontend-index.html 退役，理由见 §8）：曾用于让 patched 模板跟随引擎 dist 的 content-hash bundle 名；`adaptIndexHashes` 已随 asset 一起删除。
- 另有 append 式辅助 `applyAssetPatchAppend`（:964，marker 幂等追加，历史上用于 cordis.patch.yml 场景）——当前无调用方，仅保留备用。

## 2. 文件逐项登记

目标根 = 快照内 `usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`（dshPkgs，EngineManager.kt:925）。asset 字节数与注册行号 2026-09-25 ls/grep 实测。

| asset 文件（字节） | 目标快照路径（注册行） | 状态 | 作用 / 来源线索 |
|---|---|---|---|
| attachment-local-index.js（**47,937**，2026-09-24 按 0.1.7-rc.1 快照重建） | dsh-attachment-local/lib/index.js（:926） | 生效 | 0.13.7 重出（引擎 0.1.5-rc.1）+ 0.14.2 随引擎 0.1.7-rc.1 换代重建（§7.4）+ 0.14.0 review C1：**与构建期 `attach-durable-F2` 逐字节同源**（F2 已扩为三件套：祖先 fsync 守卫 + 两处 link(2)→rename 回退 + unlink ENOENT 容忍）；内含图片归一化 2048 降采样上限（`DEFAULT_NORMALIZED_IMAGE_MAX_DIMENSION = 2048`）。补丁判定走内容指纹而非内嵌标记 |
| session-persistence-jsonl-index.js（**145,247**，2026-09-24 按 0.1.7-rc.1 快照重建） | dsh-session-persistence-jsonl/lib/index.js（:928） | 生效 | 0.13.7 重出 + 0.13.8-b 追加 F5/F7（与构建期同源）+ 0.14.2 随引擎 0.1.7-rc.1 换代重建（§7.4）：两处 link(2) 站点带 EACCES/EPERM/ENOTSUP → rename 回退，发布独占语义由模块级 `dshMobileClaimExclusive/ReleaseClaim` 恢复（O_EXCL 占位 + 失败回收）。**0.14.0 review C1 实锤**：v0.14.0-preview 资产曾是「内联占位 + helper 占位」双占位坏版本（恒 EEXIST 恒 false，旧会话迁移永久失败并留 0 字节毒文件）——修复 = F7 补丁增加 v1→v2 收敛分支 + 本资产从快照重出 + 门禁升级为逐字节比对。行为回归 `scripts/patches/tests/{spj-migration-link-f5,publish-exclusive-reclaim}.test.mjs`（后者支持 `--asset` 直测资产本体） |
| fs-local-index.js（**43,405**，2026-09-24 按 0.1.7-rc.1 快照重建） | dsh-fs-local/lib/index.js（:930） | 生效 | **0.14.1 重新入册**（apk issue #246）：`writeFileAtomic` 的 `createIfAbsent` 发布站点是全包唯一的 `link(2)` 调用，且该分支失败即抛、无任何回退 → Android 应用域恒拒 hardlink ⇒ 真机上 `write` 工具建不了任何新文件（覆盖已存在文件走 `rename`，正常）。与构建期 `fs-local-link-F8` 逐字节同源。**本资产是 0.13.3 退役资产的重新入册**——当年退役理由「上游 0.1.2-rc.1 已原生覆盖 rename 回退」对 `createIfAbsent` 站点不成立（0.1.5-rc.1 实测：全文仅此一处 `link` 调用，`EACCES`/`EPERM`/`ENOTSUP` 无任何处理）。补丁判定走内容指纹而非内嵌标记。行为回归 `scripts/patches/tests/fs-local-link-f8.test.mjs`（支持 `--asset` 直测资产本体） |

已退役资产（不在 `assets/patched/`，`applyAssetPatch` 注册行同步移除，勿再引用）：`primitives-index.js`、`fs-local-index.js`（0.13.3 批退役，d377abc——link(2) 回退族改由构建期补丁承担；**0.14.1 已重新入册，见 §2 的 fs-local-index.js 行与 §7.1 的 `fs-local-link-F8`**——退役时该回退并未真正落到构建期补丁，`createIfAbsent` 站点成了覆盖空洞）；`web-frontend-index.html`（0.13.7fx-1 退役，§8）；`llm-deepseek-index.js`（rc.2 起遗留死资产，随重出批删除）。

## 3. 维护约定（硬约束）

1. **全量替换非 delta**：asset 必须是目标文件的完整拷贝（在原文件基础上改后整体入库）；不允许只存 diff 片段或手写残缺文件——applyAssetPatch 直接 writeBytes 整写，半截文件 = 引擎启动即崩。
2. **更新需随上游引擎对齐**：三个在册 asset 对应 2026-09-24 按 dsh 0.1.7-rc.1 快照重建的包版本（三条全部与旧资产不同源，见 §7.4）。升级快照内引擎版本时必须：① 逐文件核对上游是否已原生包含同等修复（能删则删，llm-deepseek/rc8 为先例）；② 重出 asset 从对应版本包文件改起，不从旧 asset 迭代；③ 与构建期同源补丁（F2/F5）**两处必须同源**，否则互相回退。
3. **禁止随手重生成**：内容指纹机制意味着 asset 与目标「看起来差不多但字节不同」就会触发重写——不得用本地构建产物/不同 minify 形态随手替换 asset；改动须走完整链路验证（引擎起得来、市场/会话/附件功能实测）。
4. **新增补丁**：applyAssetPatch 注册新条目 + 本表登记；优先评估上游新版本是否已修复（能不补则不补）。

## 4. 施加结果验证方法

- **日志锚点**（LogCollector/logcat，EngineManager.kt 内 Log.i/Log.w/Log.e）：
  - `runtime patch applied/updated: <asset> -> <target>`（:956）= 本次实际写入；
  - `runtime patch skipped (target package absent): <asset>`（:943）= 目标包被上游裁掉，按 §3-4 评估；
  - `runtime patch asset missing: <asset>`（:949）= asset 缺失（打包遗漏，需查 APK assets）；
  - `index hash adaptation failed; keeping bundled patch`（hashAdaptive 已于 0.13.7fx-1 随 web-frontend-index.html 退役，见 §8；该日志行不再产生）。
- **产物抽验**：从 APK 内 assets/patched/ 取出与快照解压树目标文件做字节比对（contentEquals 同一判定）；发布链可用 `tar -xO` 抽验快照内目标文件（AGENTS.md 惯例）。
- **行为抽验**：剪贴板复制（primitives）、附件上传图片（attachment 2048 上限）、WebView 沉浸式与老内核插件列表（web-frontend）、会话持久化/文件工具（fs-local、session-persistence-jsonl）。

## 5. 机制演进史（改动前先读，防止重蹈）

| 事件 | 教训 / 产物 |
|---|---|
| v1→v2 asset 更新被跳过 | 固定 marker 字符串在目标文件更新后仍命中 → 新 asset 永不落盘；改为内容指纹判定（:404-405、:432-434） |
| 2026-08-23 前端审核 CRITICAL#4 | 引擎升级换 bundle hash → patched 模板旧引用 404 白屏；加 hashAdaptive（:435-438、:471-490） |
| v0.12.4（rc8）迁移批 | onImagePicked/describeImage/bundle-hardening/textzoom 四补丁删除（上游 rc.8 原生覆盖 + textzoom 功能取消）；textzoom 桥方法保留（:413-416） |
| rc.1 → rc.2 链路 | rc.1 丢 rename 回退 → fs-local/session-persistence-jsonl 两补丁补回；rc.2 原生捆绑 vision-exp → llm-deepseek 补丁退役为遗留资产（:399-425） |
| 0.14.1 文件写工具链路 | `write` 工具在 Android 上**建不了新文件**（`createIfAbsent` 的 `link(2)` 无回退，apk issue #246）→ fs-local 重新入册 + 构建期 `fs-local-link-F8`。教训：退役理由「上游已原生覆盖」必须**逐站点**核对，不能按文件整体判定——上游把回退加在替换路径上，而新增的独占创建路径又裸用了 `link(2)` |
| 目标包缺席语义 | 上游裁包（如某版本依赖图变动）时跳过而非报错/硬写，避免死覆盖（:440-446） |

## 6. 与协调仓 scripts/patches/ 的分工边界

**协调仓 `scripts/patches/`（apply-patches.mjs + registry.json + data/compat-map.json）是快照注入链的构建期补丁框架**，按 `scope` 分两路：
- `scope: vendor` 打 vendor 固化插件（dshmarketplace-plugin A-D + **U2 exact-route browser-session 鉴权**、dsh-undo-savepoint E1-E8 + **U1 `/api/undo` connection/token 鉴权与 no-store**），在 `build-apk-013.ps1` 阶段施加；对应行为回归在 `scripts/patches/tests/{undo-route-auth,market-route-auth}.test.mjs`。
- `scripts/check-api-route-auth.mjs` 与 `api-route-auth-policy.json` 不属于运行时 asset：它们扫描所有 mobile-owned WebServer registration source，要求 protected guard 或窄公开白名单，并在本地/云端/CI/发布链接线。file-incoming 的 queue、claim、content、complete、clean 五个 exact route 均属于 protected 面；content 只接受进程内 ticket，不能返回源绝对路径。
- `scope: engine` 打引擎树内上游包（当前全量 15 条以 §7.1 表为准，2026-09-25 现数 `scripts/patches/registry.json`：narb-android-N1 / attach-durable-F2 / **fs-local-link-F8** / flock-android-F3 / atomic-stale-lock-F4 / spj-migration-link-F5 / publish-exclusive-F7 / reference-drill-F6 / pi-toolcall-G2 / perf-compile-cache-flush-N2 / combo-lazy-A4 / combo-probe-P1 / boot-third-party-isolation-G3 / arkweb-resource-protocol-H1 / external-draft-conversation-seam-J1），在 `build-snapshot-013.mjs` 0f 步施加并逐个复查 marker（N1 与 A4/G3 的 0.14.2 重锚见 §7.4；同批撤销 5 条已不在册）。

**与本节 assets/patched/ 的分界**：同一份引擎文件的修复若能在构建期落地（随发行快照固化），优先走 `scope: engine`；运行时 asset 只承担「必须每次启动前覆盖」或「与引擎版本无关的壳侧定制」（见 §3-2）。已退役：pi-drift-F1（上游 0.1.5 原生 strict/deferred 校验）。**assets/patched/ 是设备端运行时补丁**——壳在每次引擎启动前对快照内上游引擎包做覆盖。两者层不同、目标不同、幂等机制不同（构建期 = registry 幂等标记；运行时 = 内容指纹），勿混用；构建期补丁登记见协调仓 scripts/patches/README.md 与 registry.json。

## 7. 0.13.7 重出（引擎 0.1.5-rc.1，2026-09-10）

约定不变（§3-2）：**从对应版本包文件改起，不从旧 asset 迭代**。生成器：协调仓
`.tmp-upgrade/rebuild-runtime-patches-015.mjs`（锚点缺失即抛错，绝不写半成品）。

| asset | 目标 | 本次 delta（相对 0.1.5-rc.1 原文件） |
|---|---|---|
| `attachment-local-index.js` | `dsh-attachment-local/lib/index.js` | F2 祖先 fsync 守卫（`ensureDurableDirectory` 里的 `syncDirectory(parent)`；与 `scripts/patches/` 构建期补丁同源）+ **两处** link(2)→rename 回退（`publishImmutableAlias` 的 `source`、`publishStagedObject` 的 `staged.path`——0.1.5 变量名已变，旧锚点 `temporary/target` 失效）+ `publishStagedObject` 主链 `unlink(staged.path)` 容忍 ENOENT |
| `session-persistence-jsonl-index.js` | `dsh-session-persistence-jsonl/lib/index.js` | import 行加 `rename` + **两处** link(2) 站点（`link(tmp, finalPath)` 的 materialize 站 + `publishCurrentExclusive` 的发布站）在 EACCES/EPERM/ENOTSUP 时改走 rename 回退（0.1.5 锚点仍在）。0.13.8-b 追加：`unlink` 导入 + 模块级小函数 `dshMobileClaimExclusive()` / `dshMobileReleaseClaim()`，两站共用（O_EXCL 占位独占 + rename 失败回收占位），与构建期 F7 同源 |
| `web-frontend-index.html` | `dist/index.html`（hashAdaptive） | 与 0.1.5 dist 模板同源；资产里的 hash 由壳侧 `adaptIndexHashes` 跟随引擎改写，无需人工维护 |
| ~~`llm-deepseek-index.js`~~ | — | **删除**：无 `applyAssetPatch` 调用点（rc.2 原生含 vision 后已成死资产，39KB） |

校验：三份资产均 `node --check`（ESM）通过；标记串 grep `dsh-mobile link->rename fallback`（两处）、
`dsh-mobile durable-walk guard`、`already consumed the staged file`；0.13.8-b 追加
`dsh-mobile exclusive publish (F7)` / `dshMobileClaimExclusive`（asset 重出后必须在场）。

**构建期**引擎补丁的锚点与行为回归：`build-snapshot-013.mjs` 0f 步施加后逐个复查 registry marker
（缺席即拒打包），F4 另有常驻行为测试 `node scripts/patches/tests/atomic-stale-lock.test.mjs`
（fixture = 0.1.5-rc.1 产物；`.deploy-tmp/` 下的临时预检脚本不入库，勿再引用）。

### 7.1 同时落在构建期的引擎树补丁（scope=engine，不走 assets/patched/）

- **reference-drill-F6（2026-09-11，apk #163）**：`dsh-client-ui-reference/lib/client.js` 的 `onPick` 判定由
  `fileKind === "directory" && action === "drill"` 改为 `... || document.documentElement.hasAttribute("data-dsh-mobile-form")`——
  手机上点目录行行体 = 下钻进子目录（上游只把下钻绑在行尾 chevron/Tab 上，手机上点不到，用户侧表现为「@ 只能选到第一层」）；
  桌面无 form 标记，行为逐字不变。多选勾选框由注入层 `ReferenceMenuEnhancer` 负责。

| 补丁 | 目标包 | 本次动作 |
|---|---|---|
| `attach-durable-F2` | `dsh-attachment-local/lib/index.js` | 与运行时 asset **同源**：附件祖先 fsync 对 Android 应用私有祖先（`/data/user/0`）EACCES 即止步。构建期补丁服务发布快照，运行时 asset 服务「快照刷新后重施加」——两者内容一致才不会互相回退 |
| `flock-android-F3` | `node-addon-system/lib/flock.js` | 0.1.5 新增的会话写锁只有 darwin/linux 预编译 → Android 上 `ERR_FLOCK_UNSUPPORTED_PLATFORM` 让整树 boot 失败；按上游 browser-worker 先例 stub 为立即成功（单进程宿主）+ 一次性告警 |
| `atomic-stale-lock-F4` | `dsh-atomic-write/lib/index.js` | 孤儿 `<file>.lock` 回收（pid 已消失 + 二次核验一致才删，每次获取最多一次）；行为回归 `node scripts/patches/tests/atomic-stale-lock.test.mjs` |
| `fs-local-link-F8` | `dsh-fs-local/lib/index.js` | 文件写工具 `createIfAbsent` 发布的 `link(2)` 回退（apk issue #246）：Android 应用域恒拒 hardlink ⇒ `write` 工具建不了新文件。`EACCES`/`EPERM`/`ENOTSUP` 时改用 **O_EXCL 占位 + rename** 等价实现 no-replace（**不能裸用 rename**——那会静默覆盖并发创建者的文件，丢掉 `link` 的独占语义）：输家仍得 `EEXIST` 与同一 `cannot overwrite existing` 拒绝文案；`rename` 失败回收占位，防 0 字节残留让之后每次创建都输掉占位竞争。运行时 asset `fs-local-index.js` 与之**同源**。行为回归 `node scripts/patches/tests/fs-local-link-f8.test.mjs`（fixture = 0.1.5-rc.1 产物） |
| `spj-migration-link-F5` | `dsh-session-persistence-jsonl/lib/index.js` | 会话迁移发布（publishCurrentExclusive，v0→v3 必经）与 materialize 两处 link(2) 在 Android SELinux 拒 hardlink（EACCES/EPERM/ENOTSUP）时改用模块顶层 rename（apk #154）；运行时 asset `session-persistence-jsonl-index.js` 与之**同源**。行为回归 `node scripts/patches/tests/spj-migration-link-f5.test.mjs`（fixture = 0.1.5-rc.1 产物） |
| `publish-exclusive-F7` | `dsh-session-persistence-jsonl/lib/index.js` | 发布独占语义找回：F5 的 rename 回退会**静默替换**已存在目标 → O_EXCL 原子占位抽成模块级小函数，F5 两站共用（publish 站输家 return false；materialize 站输家抛 EEXIST），rename 失败一律 unlink 回收占位（防 0 字节残留让之后每次发布都输掉竞争）。依赖 F5，行为回归 `node scripts/patches/tests/publish-exclusive-reclaim.test.mjs`（apk #170 / FX-207.1+207.2） |
| ~~`boot-pending-G1`~~（0.14.2 撤销，不在册） | `dsh-app-boot/lib/index.js` | 非官方包 pending 降级为告警并继续启动（第三方插件 inject 了 client-only 服务 → 永久 pending → 整树 boot 失败）；FAILED 与官方包 pending 仍致命（0.13.5 W1b / apk #126 P3）。**0.14.2 追 0.1.7-rc.1 时撤销**：`requiredStartupEntryIds` 与本方行面无交集（要修的场景不存在），且 `const failures = [];` 锚点会误匹配 `auditStartupEntries` 的同名声明——维持「严禁重锚」；boot 期容错唯一真源改为 `boot-third-party-isolation-G3` |
| `pi-toolcall-G2` | `@earendil-works/pi-ai/dist/api/openai-completions.js` | 流式 tool_call 空名止血：出口丢弃空名调用（连其 tool result）+ arguments 保证非空；累加器把缺 index/id 的续块合并进唯一在途调用（0.13.5 W2 / apk #124） |
| ~~`perf-patch-reload-N1`~~（0.14.2 撤销，不在册） | `dsh-app-boot/lib/index.js` | 性能 A1：web 模板 `patchReload` 默认 live→startup（Android 无 live reload 收益，坑 19），并把 installation-owned 当前元组下**已显式写入**的旧默认 live 归一化（上游只在键缺失时写回模板默认，存量升级永不归一化）。**0.14.2 追 0.1.7-rc.1 时撤销**：rc.1 全仓 `patchReload` 零命中（源码 + 产物），reload 链改为常驻但空转的 `dsh-client-hmr`——机制整条消失，补丁无面可打；写半边 `scripts/lib/profile-seed.mjs` 同步由「seed 死键」改为「剥死键 + 断言 bundles 非空」 |
| `arkweb-resource-protocol-H1` | `dsh-client-resources/lib/client.js` | ArkWeb（HarmonyOS）令 `dsh-resource://<type>/...` 丢 hostname → 上游 `protocolOf()` 取不到 file provider、文件预览报资源服务不可用（apk #221）；补丁按地址文法局部恢复 type，标准 URL 与其他 scheme 行为不变。回归 `node scripts/patches/tests/arkweb-resource-protocol.test.mjs`；**仍需真实 ArkWeb + Chromium 设备验收** |
| `external-draft-conversation-seam-J1` | `dsh-client-ui-conversation/lib/client.js` | 外部文件草稿：向 ConversationController 补受控 `addFiles(sessionId, files)` seam，复用既有 `createDrafts` / InputHub `shell.addAttachments` / refusal release——不创建第二条上传路径、不自动发送、路径不进页面/模型。回归 `node scripts/patches/tests/external-draft-conversation-seam.test.mjs` |
| `perf-compile-cache-flush-N2` | `dsh/lib/bin.js` | 启动性能：Node 只在正常退出写 `NODE_COMPILE_CACHE`，而壳侧停引擎是有界宽限的 SIGTERM→SIGKILL、系统可整进程回收 → 换树后的新条目永远写不进去（设备实测 09-12 23:07 后零新增）。入口周期 flush（40s 首刷 + 5min）+ `exit` 兜底；不注册信号处理，不改任何命令退出语义。回归 `node scripts/patches/tests/compile-cache-flush-n2.test.mjs` |
| `combo-lazy-A4` | `dsh-client-modules/lib/index.js` | 启动性能：装配期每次 `internal/plugin` 都触发 flush → `compose()` 全表重建（0.13.8 实测 9-14 次、单次 1.8-3.1s、占 LISTEN 墙钟 88%）。首个图读者（`graph()`/index-inject/bundle 路由）之前 flush 只置脏，全量 compose 收敛为一次；图就绪后的运行期变更与 HMR `rebuilt()` 仍即时重算。回归 `node scripts/patches/tests/combo-lazy-a4.test.mjs`。**0.14.2 重锚**（0.1.7-rc.1）：`bundleResource` 变 `async` 方法、薄壳 `serveBundle` 不再是读图点 ⇒ 改在 `this.ensureComposed()` 处插桩 |
| `narb-android-N1` | `node-addon-require-builtin/lib/index.js` | Android 无预编译 `node-addon-require-builtin` 绑定（npm 无 `-android-x64` 产物，上游 support-matrix 明写 has no published platform package）：0.1.7-rc.1 的 `dsh-app-boot` 新增该依赖（0.1.5 夹具零命中），real 设备 `boot-fail.log` 连记 4 轮 `host preparation failed / No usable native binding found for node-addon-require-builtin-android-x64` ⇒ 引擎 boot 期硬崩。修法：`createEntryApi` 顶层调用包 try/catch（失败即 `api = undefined` + 一次性告警），三个导出函数在 `api` 缺席时回落 `require(moduleId)`——壳侧本就以 `--expose-internals` 起 node（EngineManager.kt:1036 argv 第二项），该 flag 恰好暴露 rc.1 `internalModules()` 需要的五个 `internal/modules/*`，与内置模块同一实现，不是「假装成功」。行为回归 `node scripts/patches/tests/narb-native-fallback-n1.test.mjs`（11 项，含 `--expose-internals` 子进程真跑回落） |
| `combo-probe-P1` | `dsh-client-modules/lib/index.js` | `requires: combo-lazy-A4`：把 compose 探针送进产品内，收口 `t_compose_total` 恒 -1（42/42 恒 -1）。在 `compose()` 返回处打印 `[perf] compose #N at=… dur=…` 与 `[perf] TOTAL calls=… totalMs=…`（字段恒在场，无值写 -1）；只主线程安装（worker 的 calls=0 TOTAL 不得冒充真读数）；不新增快照成员、壳侧解析器零改动。`provenance` 见 `scripts/patches/registry.json` 的 `combo-probe-P1` |
| `boot-third-party-isolation-G3` | `dsh-app-boot/lib/index.js` | 第三方插件 boot 期失败隔离：`boot()` 经隔离式挂载器挂 root include，失败条目若属**用户自装**（非 `@deepseek-ai/*` / `@dsh-android/*` / 出货具名插件）则加 `disabled:true` 后重试并点名列出被跳过的插件；官方/出厂插件失败、不可识别失败、或超过上限 8 个仍响亮失败。真因：用户自装插件 import 期抛错在 `mountRootInclude` 就抛出，`boot-pending-G1` 的锚点 `assertEntriesActivated` 结构上不可达。真源见 `scripts/patches/registry.json` 的 `boot-third-party-isolation-G3`；回归 `node scripts/patches/tests/boot-third-party-isolation-g3.test.mjs` |


镜像纪律（0.13.8 PR-A1 起）：本仓 `scripts/patches/**` 是协调仓权威源的**逐字节镜像**（云端
自包含构建检出本仓），`scripts/check-patch-mirror.mjs` 在两仓 CI 与构建链强制比对——
改补丁必须双树同批，单边演进即拒打包/拒合并（apk #171 的教训）。

F3/F4 只影响引擎内部（无 WebView/壳侧定制面），快照固化即可，无需运行时 asset 每次启动重写；F2 的
运行时侧由既有 attachment asset 承担——**两处必须同源**。

### 7.2 0.13.8-b：F7 资产重出 + A1 出厂 profile seed（2026-09-12）

**F7 资产重出（已完成 2026-09-12）**：F7 进了构建期快照，但
`session-persistence-jsonl-index.js` 是**每次启动整文件覆盖**的运行时 asset → 不重出就等于没修。
**当前状态：已重出，138,025 B，sha256 `BDAEF25C049368BB2415D8DADD14A2A2BE8ADB0DECDE0BE59961149415B7CA33`；**
`node scripts/check-runtime-assets.mjs x86_64 --require` = 核对组合 3 / SKIP=0；asset 内
`dshMobileClaimExclusive` 3 处（1 定义 + 2 站调用）、`dshMobileReleaseClaim` 2 处、materialize marker 1 处，`node --check` 通过。
重出前的只读重演记录（留档，防再犯）：

- 重出前 asset 字节 = **136,136**（更早的 §2 表内记 138,991 亦失真）；施加 F7 后 = **138,025**；
- **两路同源已核**：把「当前 asset」与「快照 tar 里抽出的同名文件」分别只施加 F7，输出**字节一致**
  （sha256 `BDAEF25C049368BB2415D8DADD14A2A2BE8ADB0DECDE0BE59961149415B7CA33`）。

重出步骤（临时根，勿直接改产品代码）：

```powershell
$root = '.deploy-tmp\asset-regen'
$dst = Join-Path $root 'usr\lib\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-session-persistence-jsonl\lib'
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item 'dsh-mobile-apk\app\src\main\assets\patched\session-persistence-jsonl-index.js' (Join-Path $dst 'index.js') -Force
node scripts\patches\apply-patches.mjs $root --apply --scope engine --only publish-exclusive-F7
Copy-Item (Join-Path $dst 'index.js') 'dsh-mobile-apk\app\src\main\assets\patched\session-persistence-jsonl-index.js' -Force
```

重出后核对：`node scripts/check-runtime-assets.mjs x86_64 --require`（组合数 3、SKIP=0）与
`Select-String -Path <asset> -Pattern 'dshMobileClaimExclusive' | Measure-Object`（= 3：1 定义 + 2 站调用）。
**门禁盲区（已登记）**：`check-runtime-assets.mjs` 只比 registry marker，而 F7 的 marker 未随本次收紧 →
陈旧 asset 仍会 PASS；建议随重出把 F7 的 registry marker 收紧为 `dsh-mobile exclusive materialize (F7)`。

### 7.3 0.14.0 review C1：资产「逐字节同源」判据与重出手册修订（2026-09-15）

**背景**：v0.14.0-preview 发布包的 `session-persistence-jsonl-index.js`（138,025 B，`BDAEF25C…`）是
F7 v1 双占位形态（内联 `open("wx")` 占位后又调 helper 占位 → 同一路径恒 EEXIST → `publishCurrentExclusive`
恒 false）。旧判据只比 marker，两个 marker 在场 → 门禁全绿；`publish-exclusive-reclaim.test.mjs` 又只对
合成 fixture 施加补丁，测不到已分叉的资产本体。

**修订后的口径（三件套）**：

1. **判据 = 资产 ↔ 快照同路径文件逐字节一致**（`check-runtime-assets.mjs`）：sha256 双方打印、不同即红；
   并对资产本体跑行为回归（`publish-exclusive-reclaim.test.mjs --asset <asset>`）。
2. **重出手册（取代 §7.2 的「旧资产上叠补丁」路径）**：
   ```powershell
   # 从当次构建的快照 tar 直接抽出（不经过任何中间资产；两层同源由字节比对守）
   node .deploy-tmp/regen-assets.mjs   # 临时脚本：tar -xJOf <member> > assets/patched/<asset>
   node scripts/check-runtime-assets.mjs x86_64 --require
   ```
   行尾：`.gitattributes` 已给 `app/src/main/assets/patched/*.js` 加 `-text`（autocrlf 不再把 LF 检出成
   CRLF，否则逐字节门禁在别的机器必假红且引擎每次启动都触发整文件覆盖）。
3. **补丁侧收敛**：`publish-exclusive-F7` 的 `check` 显式排除 v1 形态（`const claim = await open(currentPath, "wx")`），
   `apply` 先整体切除旧内联块（含多余缩进，保证收敛输出与快照构建逐字节一致）再走 v2 注入——任何树上的
   v1 残留都会被修复而不是被判为「已应用」。

**构建期同步扩充**：`attach-durable-F2` 由「祖先 fsync 守卫」扩为三件套（+ 两处 link(2)→rename 回退 +
unlink ENOENT 容忍），与 attachment 资产逐字节同源——此前这三处 delta 只在运行时资产里，快照缺，逐字节
判据上线后会直接判红。

**A1 出厂 profile seed（性能 §7.2 A1）**：出厂 `home/.dsh/profiles/{web,headless}/package.json` 由
构建链 `scripts/lib/profile-seed.mjs` 写入 `dsh.profile.patchReload = "startup"`（`build-snapshot-013.mjs`
在 settings seed 之后调用；dev 档用 `DSH_PROFILE_PATCH_RELOAD=live` 覆写）；存量升级由引擎树补丁
`perf-patch-reload-N1` 归一化。归档后 `check-perf-instrumentation.mjs --require` 复核产物内该键值
（P-AC-01：发布档 startup / dev 档 live）。

### 7.4 0.14.2 追上游 0.1.7-rc.1：三条运行时资产按 rc.1 快照重建 + 构建期补丁重锚（2026-09-24/25）

**引擎换代 = 三条运行时资产全部重出，这是硬动作不是可选项。** 资产是「每次启动整文件覆盖」的运行时补丁，
与构建期同源补丁必须逐字节一致（§3-2、§7.3 三件套）；引擎从 0.1.5-rc.1 换到 0.1.7-rc.1 后旧资产与
新风树不同源，沿用等于把上一代修复盖上新一代文件。

| asset | 重建前字节 | 重建后字节（2026-09-25 ls 实测） | 依据 |
|---|---|---|---|
| `attachment-local-index.js` | 47,321 | **47,937** | 从 0.1.7-rc.1 快照 tar 直接抽出 |
| `session-persistence-jsonl-index.js` | 137,514 | **145,247** | 同上 |
| `fs-local-index.js` | 41,407 | **43,405** | 同上 |

重建提交 `fix(assets): 运行时补丁资产按 rc.1 快照重建（三条全部不同源，引擎换代后必做）`（apk 侧 22815f8）。
门禁 `node scripts/check-runtime-assets.mjs x86_64 --require` 按 §7.3 的「资产 ↔ 快照同路径文件逐字节一致」
口径核验，不是只比 marker。

**构建期补丁面（`scope: engine`，0.14.2 现数 15 条，见 §7.1）**：

- **新增 `narb-android-N1`**：见 §7.1 行。npm 上 `node-addon-require-builtin` 只发 darwin/linux/win32，
  无 android 产物 ⇒ 回落 `require(moduleId)`；壳侧本就以 `--expose-internals` 起 node
  （`EngineManager.kt:1036` argv 第二项），该 flag 恰好暴露 rc.1 `internalModules()` 需要的五个
  `internal/modules/*`。设备实测证据是 `boot-fail.log` 连记 4 轮
  `No usable native binding found for node-addon-require-builtin-android-x64`（引擎 boot 期硬崩，
  不是「静默禁用插件」）。fixture 与回归见 §7.1 行。
- **重锚 3 条**：`combo-lazy-A4`（`bundleResource` 变 `async` 方法 ⇒ 改插 `this.ensureComposed()`）、
  `boot-third-party-isolation-G3`（`mountRootInclude(..., binName)` 第 5 参漂移，`binName` 一路透传）、
  `perf-compile-cache-flush-N2`（根包不再 `import { readFileSync } from "node:fs"`，锚改末条顶层 import）。
  唯一可信锚点判据 = `node scripts/probe-engine-anchors.mjs`（按 overlay 的 (包名, 版本) 回读构建期同一批
  未打补丁 tgz）；**不要用 stage 目录**（本轮实测它停在 0.1.2-rc.1），**也不要用测试夹具**（0.1.5 时代写死在
  目录名里，真树断 9 条而 16 个补丁测试全绿）。
- **撤销 5 条**（各带「收益是否还在」的证据，不是「锚点找不到就删」）：`perf-patch-reload-N1`（rc.1 全仓
  `patchReload` 零命中，机制整条消失）、`boot-pending-G1`（场景不存在 + 锚点会误匹配同名声明，严禁重锚）、
  `combo-single-lazy-A5`（上游已原生满足且取舍更温和）、`combo-cache-A3`（同机同批 rc.1 字节实测：上游
  boot 路径 44 ms vs A3 查表 129 ms，**净亏**）、`combo-parallel-C3`（分片对象随 A3 一起消失）。
  连带清掉写半边：`scripts/lib/combo-precompute.mjs`、`inject-all.py --combo-cache-delta`、
  两条构建链的 precompute 调用；`scripts/check-combo-cache.mjs` 反向改造成「死缓存回流门禁」。

**引擎 overlay 追版**（`scripts/snapshot-config/engine-overlay.json`，2026-09-25 现数）：
`vendorTop` 17 → **36** 条（+19：`execa` 及其依赖闭包、`@sec-ant/readable-stream`、
`@sindresorhus/merge-streams`、`get-stream`、`human-signals`、`is-plain-obj`、`is-stream`、
`is-unicode-supported`、`npm-run-path`、`parse-ms`、`pretty-ms`、`signal-exit`、
`strip-final-newline`、`unicorn-magic`、`which-command`、`yoctocolors` 等）；
`@deepseek-ai/cosmokit` **1.8.3 → 1.8.5**；补登记 `@xterm/headless` **6.0.0** 与
`@xterm/addon-serialize` **0.14.0**（嵌套段 `nested` 仍 5 条，`packages` 313 条）；
许可清单 `engine-overlay-licenses.json` 41 → **59** 条（新增项全部非 copyleft：MIT/Apache-2.0）。

**profile 显式禁用上游 `office-to-pdf` 行**（`scripts/profile-web.cordis.patch.yml:167`，
`- id: office-to-pdf` + `disabled: true`）：rc.1 的 web-app bundle 新增该行（0.1.5 零命中），它运行时依赖
`@deepseek-ai/libreoffice-kit`，而该依赖在本平台**无条件不可用**——`platformTarget()` 只认
darwin/win32/linux-glibc，Android 下 `process.platform` 为 android ⇒ `resolveEngine()` 落到
`if (platform !== linux) throw new Error(Unsupported LibreOfficeKit host: android-x64)`；152 MB 的
`-wasm` 引擎同样被该 platform 判据挡掉，补依赖买不到任何能力。不禁该行的后果不是缺能力而是
**boot 阶段崩**（`Cannot find package` 指向 `@deepseek-ai/libreoffice-kit`，设备实测）。上游对「没有转换器」的
既定降级路径就是 UI 的 unavailable 指引 ⇒ 禁行 = 用上游自己的降级面。凭据成对：
`scripts/check-engine-overlay.mjs:117` 的 `RUNTIME_MISSING_OK` 登记了同一条
（`@deepseek-ai/libreoffice-kit`，:128），两处必须同进同出；逆转条件 = 出现 Android 上真能跑的引擎实现。

**版本号**：`app/build.gradle.kts:35` `versionCode` 40 → **41**，:40 `versionName` 0.14.1 → **0.14.2**。

## 8. 0.13.7fx-1：web-frontend-index.html 退役（2026-09-11）

**实测（从 0.13.7 发布快照 out/v0.13.7/snapshot-x86_64.tar.xz 抽出对比）**：引擎自带的
usr/.../dsh-web-frontend/dist/index.html 与 asset 除行尾（CRLF vs LF）外逐字相同，bundle 引用
（index-DuF6ti6g.js / index-DPX2bQLO.css）也就是 npm 包 0.1.5-rc.1 发布件自带的那套。
因此运行时那一步只是把同样的内容按 CRLF 再写一遍（写一次后内容指纹才收敛），**没有任何行为增量**。

**退役的直接动因（坑 64）**：adaptIndexHashes 的 hash 字符集 `-([A-Za-z0-9]{8})\.(js|css)` 跟不上
npm 现包的写法（index-Df-65__b.js：带 `-`、9 字符）。一旦引擎 dist 不是这份 asset 对应的构建，
改写失败就原样写回旧引用 → index.html 指向不存在的 bundle（白屏）。补丁的价值此前已随 viewport-fit 消失
（Android WebView 上 env(safe-area-inset-*) 恒 0，系统栏避让已由壳侧 inset 通道承担；ES2022 polyfill
由 dsh-host-web-compat 注入，覆盖面更大）。

**改动面**：删 assets/patched/web-frontend-index.html；EngineManager.applyRuntimePatches() 去掉该行；
applyAssetPatch 去掉 hashAdaptive 形参与 adaptIndexHashes 函数；本文件 §1/§2/§3 同步。
