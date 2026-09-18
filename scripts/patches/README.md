# scripts/patches/ — vendor 固化插件统一补丁模块（Phase 2a，2026-09-05）

快照注入链全部 vendor 补丁的**唯一入口**。此前补丁散落 `patch-marketplace.mjs`（A-D）与 `patch-undo-mobile.mjs`（E1-E7）两份脚本、双仓各一副本，漂移风险实锤（apk 仓副本曾缺补丁 C/D，云端构建产出缺补丁 APK）——本目录将其统合为一框架。

## 组成

| 文件 | 职责 |
|---|---|
| `apply-patches.mjs` | 唯一 runner：`--check`（门禁验证）/ `--apply`（幂等施加+自验）/ `--list` / `--only` |
| `registry.json` | 补丁登记表：id / 目标文件 / 摘要 / 来源（issue、PRD）/ 幂等标记。与 runner 内 IMPLS **一一对应**，启动时交叉校验，漂移即拒 |
| `data/compat-map.json` | 补丁 D 的兼容性数据（COMPAT_MAP/NOTE）。增补别名只改此文件，`--apply` 对已修补文件做 map 幂等刷新 |
| `README.md` | 本文档 |

## 补丁清单（详见 registry.json）

- **dshmarketplace-plugin 0.1.5**：A pre-execute 守卫（全工具崩溃）、B execPath 安全化（apk#83/#89 bad ELF magic）、C 不可安装置灰（soft：锚点失配仅告警不拒打包）、D 移动兼容徽章 + `mobile:` 过滤（server/client 两侧）、**U2 exact 路由鉴权**（search/install 复用 `connection.requestRejection()`，缺服务也 401）。
- **dsh-undo-savepoint 0.3.8**：E1-E7 移动端裁剪（头部只留快照徽章、移除快捷键行与全局键盘监听、徽章宽度封顶）+ **E8 徽章折叠成小绿点**（2026-09-10 用户定例：360dp 竖屏头部已被模式徽章/打开方式/…/右栏键占满，文字徽章挤标题且更窄处错位；数量与含义挪进 title/aria-label，点击行为不变，20x20 圆形后置 CSS 覆盖胶囊样式——注意 E7 的 marker 串保持不动，改它会让 E7 误判未应用后二次施加失配）+ **U1 `/api/undo` 鉴权**（Host/Origin/浏览器会话或壳侧实时 controlToken，所有读写均在 body/快照操作前失败关闭）。

## 用法

```bash
# 构建门禁（build-apk-013.ps1 / build-apk.mjs 已接入；默认 ensure 语义=缺席即施加）
node scripts/patches/apply-patches.mjs vendor

# 只验证不写（严格门禁）
node scripts/patches/apply-patches.mjs vendor --check

# 列出登记表
node scripts/patches/apply-patches.mjs vendor --list
```

## 新增补丁流程

1. 在 `apply-patches.mjs` 的 `IMPLS` 加实现（`file` / `check(src)` / `apply(src)`；apply 抛错 = 锚点失配拒写）；
2. 在 `registry.json` 加同 id 条目（摘要 + 来源登记）——漏加即启动交叉校验失败；
3. 跑 `--apply` 验证幂等与自验；锚点用**足够长的唯一字符串**（minified 代码短锚点易误伤）；
4. 双仓同步（铁律）：本目录整体镜像到 `dsh-mobile-apk/scripts/patches/`；
5. 两仓 AGENTS.md 更新记录表登记。

## 锚点失效处置

`--apply` 报「锚点未命中」= 上游 minified 代码形态已变：从报错附带的上下文片段人工核对新形态 → 更新 IMPLS 锚点与 registry marker → `--apply` 重放。禁止为了过门禁放松 check 语义。

## 历史

- 2026-09-05 Phase 2a：统合 patch-marketplace.mjs（A/B/C/D）+ patch-undo-mobile.mjs（E1-E7）为本模块，旧脚本删除；双仓 scripts 同版（雷点 10）。
## 2026-09-10 追上游 0.1.5-rc.1 的补丁增减

- **退役 pi-drift-F1**：上游 0.1.5 的 dsh-llm-pi-ai 原生实现了同类容错——
  resolveRouteModels(request, validation) 与 resolveProfiles(providers, validation) 增加
  strict/deferred 双模（写严格、读宽容）：未知 modelOverrides id 记入 modelErrors 诊断而不抛错，
  非严格路径下 PiAiCatalogError 被捕获后只跳过该 provider（0.1.5 lib/index.js:633/646/1051/1086-1099）。
  F1 的三处 invalid() 降级与 skipped 标记失去了锚点，也不应再用补丁覆盖上游的原生行为。
- **保留并已对齐 0.1.5 锚点**：attach-durable-F2（祖先 fsync 守卫）、boot-pending-G1（3 处）、
  pi-toolcall-G2（4 处）——均在 0.1.5-rc.1 产物上验证命中。
- **新增 flock-android-F3**（scope=engine）：0.1.5 的 dsh-session-persistence-jsonl 新增
  `@deepseek-ai/node-addon-system/flock` 会话目录写锁，该包只发布 darwin/linux 预编译
  （optionalDependencies 无 android）→ Android 上 tryLockExclusive() 抛 ERR_FLOCK_UNSUPPORTED_PLATFORM，
  整树 boot 都进不去。口径按上游自己的 browser-worker 先例 stub 为立即成功（单进程宿主，
  进程内写声明已排除写者），一次性告警。同包的 landlock-run 无替代（Android 走 shell-termux 写面栅栏）。
- **新增 atomic-stale-lock-F4**（scope=engine）：`dsh-atomic-write.withFileLock` 的 `<file>.lock`
  走 `wx` 建立、只在 `finally` 释放——进程被硬杀（划掉应用 / OOM / force-stop / 看门狗重启）即残留，
  之后每次写该文件都等到 deadline 抛错（实测：残留 `.credentials.yaml.lock` 让 boot 直接失败）。
  上游把孤儿锁回收定义为 operator action，Android 应用私有目录没有 operator 可达 → 补丁在超时点做
  一次受控回收：锁记录的 pid 已消失（`process.kill(pid,0)` ESRCH）且锁内容二次核验一致才删，
  每次获取最多回收一次；读取失败/内容非 pid/核验不一致/任何异常一律不动锁。
  行为回归 `node scripts/patches/tests/atomic-stale-lock.test.mjs`（fixture = 0.1.5-rc.1 产物）。

## 2026-09-14 启动性能批（N2 / A4 / A3，scope=engine）

- **新增 perf-compile-cache-flush-N2**（目标 `@deepseek-ai/dsh/lib/bin.js`）：Node 只在进程正常退出时
  写 `NODE_COMPILE_CACHE`（v24 文档），而壳侧停引擎是有界宽限的 SIGTERM→SIGKILL、系统还会整进程
  回收——设备实测编译缓存自 09-12 23:07 后零新增/零改写，09-14 三次快照刷新后换掉的模块每次冷启
  都重新编译。补丁在入口 bin.js 周期 flush（40s 首刷 + 5min）+ exit 兜底；不注册信号处理，不改
  任何命令的退出语义。回归 `scripts/patches/tests/compile-cache-flush-n2.test.mjs`。
- **新增 combo-lazy-A4**（目标 `dsh-client-modules/lib/index.js`）：装配期每次 `internal/plugin`
  事件都触发 `flush()` → `compose()` 对整张客户端插件表全量重算（0.13.8 实测单次 1.8-3.1s、
  启动期 9-14 次、占 LISTEN 墙钟 88%）。补丁把首个图读者之前的 flush 收敛为「只标脏」，
  唯一一次全量 compose 发生在 `graph()`/index-inject/bundle 路由首次读取；图已存在后的运行期
  变更与 HMR `rebuilt()` 仍即时重算。回归 `scripts/patches/tests/combo-lazy-a4.test.mjs`。
- **新增 combo-cache-A3**（同目标文件，`requires: combo-lazy-A4`）：identity combo 的 source 与
  section map 与 rev 无关、对同一份 bundle 字节恒定，构建期由 `scripts/lib/combo-precompute.mjs`
  预计算（键 = sha256(client.js)），运行时按表读取；未命中/损坏/id 不符一律回退现场生成（fail-open，
  并计数/上报）。注入段的 4 条 client.js 由两条构建链补算为 `client-combos.inject.json`，
  经 `inject-all.py --combo-cache-delta` 合入 tar；覆盖门禁 `scripts/check-combo-cache.mjs`。
  字节等价回归 `scripts/patches/tests/combo-cache-a3.test.mjs`（命中/缺席/篡改/id 不符/批路径五向）。
  fixture = 0.1.5-rc.1 产物（`tests/fixtures/dsh-client-modules-0.1.5-rc.1/`、`tests/fixtures/dsh-root-0.1.5-rc.1/`）。
