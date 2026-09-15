# vendor/dsh-undo-savepoint — 移动端适配固化副本

> 上游：[lire1131/dsh-undo-savepoint](https://github.com/lire1131/dsh-undo-savepoint) `0.3.8`
> 移动端差异包括 `lib/client.js` 的移动端裁剪，以及 `lib/index.js` 的 U1 路由鉴权补丁（由 `scripts/patches/apply-patches.mjs` 管理，见本文档差异表）。
> 本副本是快照注入链的固定来源（`scripts/build-apk-013.ps1` 注入源 = `vendor/dsh-undo-savepoint`），
> 构建前由统一补丁 runner 与 #222 路由门禁共同校验，非目标版本或缺少安全补丁拒绝打包。

## 为什么 vendor（而非直接注入上游 clone）

1. 上游 `lib/client.js` 是编译产物（无 src 仓库面），移动端裁剪只能改成品文件；
   为「可重现 + 可门禁」，将裁剪版成品固化进 vendor（与 `vendor/dshmarketplace-plugin` 同模式）。
2. `.deploy-tmp/dsh-undo-savepoint`（上游 git clone）不入库、易变；vendor 是唯一可追溯来源。

## 与上游的差异（PATCHES.md 同文件）

全部在 `lib/client.js`（0.3.8，52,802B → 48,425B），共 7 处：

| # | 变更 | 上游锚点（0.3.8） | 原因 |
|---|------|------------------|------|
| E1 | 移除会话头部「撤销/恢复/快照」三按钮 | `UndoHeader` 中 `styles.btn+" "+styles.undo/redo/list` 三个 jsx 块 | 产品决策（2026-08-23）：手机头部只留「快照」徽章（快照管理入口）；撤销/恢复在设置页快照分区与快照面板内 |
| E2 | 移除 `KeyBindRow` 函数区域 | `//#region KeyBindRow (settings.general.item)` … `//#endregion` | 快捷键配置组件无用武之地 |
| E3 | 移除 `settings.general.item` 注册块（id `undo-keys`, order 30） | `safe("slots:settings.general.item", …}, KeyBindRow)));` | 手机无键盘；旧版把 Ctrl+Alt+Z/Y 行渲染进通用设置 |
| E4 | 移除全局 `keydown` 监听 | `safe("keyboard", …"dsh-undo-savepoint: keyboard"))` | 快捷键配置被移除后成为死监听 |
| E5 | 移除 `exports.KeyBindRow` | `exports.KeyBindRow = KeyBindRow;` | 清理导出 |
| E6 | 徽章去掉相对时间（只留「已存 N 份快照」） | `stat.latest ? " · " + (relativeTime(stat.latest, t) || "") : ""` | 真机实测：长文本与「Session log」按钮重叠 |
| E7 | `.u_badge` 封顶 `max-width:30vw` + 省略号 | `.u_badge{…gap:5px;white-space:nowrap;flex:none}` | 双保险：极端宽度下截断而非重叠 |
| U1 | `/api/undo` prefix 在 handler 首行执行 Host/Origin、浏览器会话或壳侧实时 controlToken 鉴权；403 不可由 token 绕过，拒绝与成功 JSON 均 `no-store`，且拒绝先于 body 读取、快照枚举和任何写操作 | `dsh-mobile undo route auth (U1)` | apk #222：更长 prefix 绕过 `/api` 信任栅栏；所有读写必须 fail-closed |

保留：头部徽章（`u_badge`，点击打开快照管理面板）、`SnapshotPanel`（快照列表/回滚/删除/手动存档）、
设置页「快照」分区（自动兜底开关、watch 防抖、保留数、自动清理、脱敏模式、目录）。

## 重新 vendor 流程

```bash
# 1) 拉上游 0.3.8（git clone 或 npm pack）
git clone https://github.com/lire1131/dsh-undo-savepoint
# 2) 覆盖本目录（保留 lib/package.json/cordis.patch.yml/LICENSE/README*）
# 3) 应用裁剪（生成 vendor 成品）
node scripts/patch-undo-mobile.mjs vendor/dsh-undo-savepoint/lib/client.js --apply
# 4) 门禁自验
node scripts/patch-undo-mobile.mjs vendor/dsh-undo-savepoint/lib/client.js --check   # 退出 0
```
